// routes/video.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict'

const express = require('express')
const { spawn } = require('child_process')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const { poolPromise, sql } = require('../db')
const FFMPEG_PATH = require('ffmpeg-static')

const router = express.Router()

// ─── Config ───────────────────────────────────────────────────────────────
const DB_FIRST_CHUNK = Number(process.env.DB_FIRST_CHUNK_BYTES) || 256 * 1024
const DB_CHUNK_SIZE =
  Number(process.env.STREAM_CHUNK_SIZE_BYTES) || 4 * 1024 * 1024
const DB_PREFETCH_AHEAD = Number(process.env.DB_PREFETCH_AHEAD) || 2
const MP4_FRAG_SIZE = Number(process.env.MP4_FRAG_SIZE_BYTES) || 256 * 1024

const VIDEO_CACHE_DIR =
  process.env.VIDEO_CACHE_DIR || path.join(os.tmpdir(), 'video-cache')
const CACHE_ENABLED = process.env.VIDEO_CACHE !== 'false'

const USE_COPY_CODEC = process.env.VIDEO_COPY_CODEC === 'true'

const metaCache = new Map()
const META_TTL_MS = 10 * 60 * 1000

const inProgressTranscodes = new Map()

// ─── Token validation ─────────────────────────────────────────────────────
function validateVideoToken (req) {
  const vt = req.query.vt
  if (!vt)
    return {
      error: 'No video token provided. Call /auth/video-token first.',
      status: 401
    }

  try {
    const decoded = jwt.verify(vt, process.env.JWT_SECRET)
    if (decoded.type !== 'video')
      return { error: 'Invalid token type.', status: 403 }

    const urlInvoice = decodeURIComponent(req.params.invoiceNumber).trim()
    const tokenInvoice = decoded.invoiceNumber?.trim()
    if (urlInvoice !== tokenInvoice)
      return { error: 'Token does not match this video.', status: 403 }

    return { user: decoded }
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return {
        error: 'Video link has expired. Please generate a new one.',
        status: 401
      }
    return { error: 'Invalid video token.', status: 403 }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────
async function fetchVideoMeta (invoiceNumber, storeNumber) {
  const key = `${invoiceNumber}:${storeNumber}`
  const cached = metaCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.meta

  const pool = await poolPromise
  const result = await pool
    .request()
    .input('invoiceNumber', sql.VarChar(50), invoiceNumber)
    .input('storeNumber', sql.VarChar(20), storeNumber).query(`
      SELECT TOP 1
        InvoiceNumber,
        VideoName,
        DATALENGTH(VideoBinary) AS VideoSize
      FROM PickUpConfirmationInfo
      WHERE InvoiceNumber = @invoiceNumber
        AND StoreNumber   = @storeNumber
    `)

  const meta = result.recordset[0] || null
  if (meta) metaCache.set(key, { meta, expiresAt: Date.now() + META_TTL_MS })
  return meta
}

async function fetchVideoChunk ({ invoiceNumber, start, length }) {
  const pool = await poolPromise
  const result = await pool
    .request()
    .input('invoiceNumber', sql.VarChar(50), invoiceNumber)
    .input('start', sql.Int, start + 1) // SUBSTRING is 1-indexed
    .input('length', sql.Int, length).query(`
      SELECT TOP 1 SUBSTRING(VideoBinary, @start, @length) AS VideoChunk
      FROM PickUpConfirmationInfo
      WHERE InvoiceNumber = @invoiceNumber
    `)
  const chunk = result.recordset[0]?.VideoChunk
  if (!chunk) return Buffer.alloc(0)
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

// ─── DB → ffmpeg stdin pump (two-tier chunk size + N-ahead prefetch) ──────
function pumpDbToFfmpegStdin ({ invoiceNumber, size, stdin, prefetchedFirst }) {
  return new Promise(async (resolve, reject) => {
    stdin.on('error', err => {
      if (err.code !== 'EPIPE') reject(err)
      else resolve()
    })

    const queue = []
    let nextStart = 0

    function enqueue (start, isFirst = false) {
      const maxLen = isFirst ? DB_FIRST_CHUNK : DB_CHUNK_SIZE
      const length = Math.min(size - start, maxLen)
      if (length <= 0) return 0
      queue.push({
        promise:
          isFirst && prefetchedFirst
            ? prefetchedFirst
            : fetchVideoChunk({ invoiceNumber, start, length })
      })
      return length
    }

    nextStart += enqueue(0, true)
    for (let i = 0; i < DB_PREFETCH_AHEAD && nextStart < size; i++) {
      nextStart += enqueue(nextStart)
    }

    try {
      while (queue.length > 0) {
        const { promise } = queue.shift()
        if (nextStart < size) nextStart += enqueue(nextStart)

        const chunk = await promise
        if (!chunk.length) break

        const ok = stdin.write(chunk)
        if (!ok) await new Promise(res => stdin.once('drain', res))
      }
      stdin.end()
      resolve()
    } catch (err) {
      stdin.destroy(err)
      reject(err)
    }
  })
}

// ─── PATH A: Serve directly from disk cache ───────────────────────────────
async function serveFromCache (req, res, invoiceNumber, forceDownload) {
  const filePath = cachePath(invoiceNumber)
  let fileSize
  try {
    fileSize = (await fsp.stat(filePath)).size
  } catch {
    return false // cache miss
  }

  const etag = `"${invoiceNumber}-${fileSize}"`

  // Conditional request — client already has this file
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304)
    res.end()
    return true
  }

  const rangeHeader = req.headers.range
  const disposition = forceDownload
    ? `attachment; filename="${encodeURIComponent(invoiceNumber)}.mp4"`
    : 'inline'

  const baseHeaders = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
    'Content-Disposition': disposition
  }

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` })
      res.end()
      return true
    }

    const start = parseInt(match[1], 10)
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
    const clampEnd = Math.min(end, fileSize - 1)
    const chunkSize = clampEnd - start + 1

    if (start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` })
      res.end()
      return true
    }

    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${clampEnd}/${fileSize}`,
      'Content-Length': chunkSize
    })
    fs.createReadStream(filePath, { start, end: clampEnd }).pipe(res)
  } else {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': fileSize })
    fs.createReadStream(filePath).pipe(res)
  }

  return true
}

// ─── PATH B/C: Transcode, tee to cache, stream to client ─────────────────
async function transcodeStream ({
  req,
  res,
  invoiceNumber,
  meta,
  forceDownload
}) {
  await fsp.mkdir(VIDEO_CACHE_DIR, { recursive: true })

  const tmpPath = cachePath(invoiceNumber) + '.tmp'
  const finalPath = cachePath(invoiceNumber)

  // Clean up any stale temp file from a previous crashed transcode
  await fsp.unlink(tmpPath).catch(() => {})

  const cacheWriter = CACHE_ENABLED ? fs.createWriteStream(tmpPath) : null

  // Pre-fetch first chunk in parallel with ffmpeg spawn
  const prefetchedFirst = fetchVideoChunk({
    invoiceNumber,
    start: 0,
    length: Math.min(meta.VideoSize, DB_FIRST_CHUNK)
  })

  return new Promise(resolve => {
    // Build ffmpeg args — copy mode skips re-encoding entirely if source is H264
    const codecArgs = USE_COPY_CODEC
      ? ['-vcodec', 'copy', '-acodec', 'copy']
      : [
          '-vcodec',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '26',
          '-tune',
          'zerolatency',
          '-g',
          '48',
          '-threads',
          '0',
          '-acodec',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '44100'
        ]

    const ffmpeg = spawn(FFMPEG_PATH, [
      '-loglevel',
      'error',
      '-probesize',
      USE_COPY_CODEC ? '200000' : '50000',
      '-analyzeduration',
      '0',
      '-i',
      'pipe:0',
      ...codecArgs,
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_size',
      String(MP4_FRAG_SIZE),
      '-f',
      'mp4',
      'pipe:1'
    ])

    let spawnFailed = false

    const cleanup = async success => {
      if (!success) {
        if (cacheWriter) {
          cacheWriter.destroy()
          await fsp.unlink(tmpPath).catch(() => {})
        }
      }
    }

    ffmpeg.on('error', async err => {
      spawnFailed = true
      console.error('ffmpeg spawn error:', err.message)
      await cleanup(false)
      if (!res.headersSent)
        res.status(500).json({ error: 'ffmpeg failed to start' })
      else res.end()
      resolve()
    })

    let ffmpegStderr = ''
    ffmpeg.stderr.on('data', d => {
      const line = d.toString()
      if (!line.includes('Broken pipe') && !line.includes('Error closing file'))
        ffmpegStderr += line
    })

    ffmpeg.on('spawn', () => {
      if (spawnFailed) return

      const disposition = forceDownload
        ? `attachment; filename="${encodeURIComponent(invoiceNumber)}.mp4"`
        : 'inline'

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': disposition
      })

      res.on('close', () => {
        if (!ffmpeg.killed) ffmpeg.kill('SIGTERM')
      })

      Promise.all([
        pumpDbToFfmpegStdin({
          invoiceNumber,
          size: meta.VideoSize,
          stdin: ffmpeg.stdin,
          prefetchedFirst
        }),
        teeToResponseAndCache({ stdout: ffmpeg.stdout, res, cacheWriter })
      ]).catch(async err => {
        console.error('Pipeline error:', err.message)
        if (!ffmpeg.killed) ffmpeg.kill('SIGTERM')
        await cleanup(false)
      })
    })

    ffmpeg.on('close', async code => {
      const clientDisconnected = code === 255 || code === null
      const success = code === 0

      if (!success && !clientDisconnected) {
        console.error(`ffmpeg exited ${code}:\n${ffmpegStderr}`)
      }

      if (success && cacheWriter && CACHE_ENABLED) {
        // Finalize cache — atomic rename prevents partial files being served
        await new Promise(done => cacheWriter.end(done))
        try {
          await fsp.rename(tmpPath, finalPath)
          console.log(`[CACHED] ${invoiceNumber} → ${finalPath}`)
        } catch (err) {
          console.error('Cache finalize error:', err.message)
          await fsp.unlink(tmpPath).catch(() => {})
        }
      } else {
        await cleanup(false)
      }

      if (!res.writableEnded) res.end()
      resolve()
    })
  })
}

// Write ffmpeg output to BOTH the HTTP response and the cache file at the same time.
function teeToResponseAndCache ({ stdout, res, cacheWriter }) {
  return new Promise((resolve, reject) => {
    let firstChunk = true

    stdout.on('data', chunk => {
      if (firstChunk) {
        console.timeEnd('ttfb')
        firstChunk = false
      }

      // Write to disk cache
      if (cacheWriter && !cacheWriter.destroyed) cacheWriter.write(chunk)

      // Write to HTTP response with backpressure
      const ok = res.write(chunk)
      if (!ok) {
        stdout.pause()
        res.once('drain', () => stdout.resume())
      }
    })

    stdout.on('end', resolve)
    stdout.on('error', reject)
    res.on('close', () => {
      stdout.destroy()
      resolve()
    })
  })
}

// ─── Cache path helper ────────────────────────────────────────────────────
function cachePath (invoiceNumber) {
  // Sanitize to prevent path traversal
  const safe = String(invoiceNumber).replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(VIDEO_CACHE_DIR, `${safe}.mp4`)
}

// ─── Main request handler ─────────────────────────────────────────────────
async function handleVideoRequest (req, res, forceDownload) {
  const auth = validateVideoToken(req)
  if (auth.error) return res.status(auth.status).json({ error: auth.error })

  const invoiceNumber = decodeURIComponent(req.params.invoiceNumber).trim()

  // ── PATH A: Serve from cache (zero SQL, zero ffmpeg) ──────────────────
  if (CACHE_ENABLED) {
    const served = await serveFromCache(req, res, invoiceNumber, forceDownload)
    if (served) {
      console.log(`[HIT]  ${invoiceNumber}`)
      return
    }
  }

  // ── PATH C: Same video currently being transcoded — wait for it ────────
  if (inProgressTranscodes.has(invoiceNumber)) {
    console.log(`[WAIT] ${invoiceNumber} — transcode in progress, waiting…`)
    await inProgressTranscodes.get(invoiceNumber)
    const served = await serveFromCache(req, res, invoiceNumber, forceDownload)
    if (served) return
    // If cache still missing (e.g. transcode failed) fall through to re-transcode
  }

  // ── PATH B: Cache miss — fetch metadata and transcode ──────────────────
  console.time('fetchVideoMeta')
  const meta = await fetchVideoMeta(invoiceNumber, auth.user.storeNumber)
  console.timeEnd('fetchVideoMeta')

  if (!meta || !meta.VideoSize)
    return res.status(404).json({ error: 'Video not found' })

  console.log(
    `[MISS] ${invoiceNumber} — ${(meta.VideoSize / 1024 / 1024).toFixed(2)} MB`
  )
  console.time('ttfb')

  // Register in-progress transcode so concurrent requests wait instead of duplicating
  let resolveTranscode
  const transcodePromise = new Promise(r => {
    resolveTranscode = r
  })
  inProgressTranscodes.set(invoiceNumber, transcodePromise)

  try {
    await transcodeStream({ req, res, invoiceNumber, meta, forceDownload })
  } finally {
    inProgressTranscodes.delete(invoiceNumber)
    resolveTranscode()
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────
router.get('/:invoiceNumber', async (req, res) => {
  try {
    await handleVideoRequest(req, res, false)
  } catch (error) {
    if (error instanceof sql.RequestError) console.error('SQL error:', error)
    else console.error('Server error:', error)
    if (!res.headersSent)
      res.status(500).json({ error: 'Failed to stream video' })
  }
})

module.exports = router
