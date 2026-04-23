// routes/video.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict'

const express = require('express')
const { spawn } = require('child_process')
const jwt = require('jsonwebtoken') // NEW — used for ?vt= validation
const { poolPromise, sql } = require('../db')
// const FFMPEG_PATH = require('ffmpeg-static');
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'

const router = express.Router()

const DB_CHUNK_SIZE =
  Number(process.env.STREAM_CHUNK_SIZE_BYTES) || 4 * 1024 * 1024 // 512 KB
const MP4_FRAG_SIZE = Number(process.env.MP4_FRAG_SIZE_BYTES) || 256 * 1024 // 256 KB

// ─── Video token validation ───────────────────────────────────────────────
function validateVideoToken (req) {
  const vt = req.query.vt

  if (!vt) {
    return {
      error: 'No video token provided. Call /auth/video-token first.',
      status: 401
    }
  }

  try {
    const decoded = jwt.verify(vt, process.env.JWT_SECRET)

    if (decoded.type !== 'video') {
      return { error: 'Invalid token type.', status: 403 }
    }

    // Ensure the token was issued for this specific invoice — prevents token reuse
    const urlInvoice = decodeURIComponent(req.params.invoiceNumber).trim()
    const tokenInvoice = decoded.invoiceNumber?.trim()

    if (urlInvoice !== tokenInvoice) {
      return { error: 'Token does not match this video.', status: 403 }
    }

    return { user: decoded }
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return {
        error: 'Video link has expired. Please generate a new one.',
        status: 401
      }
    }
    return { error: 'Invalid video token.', status: 403 }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────
async function fetchVideoMeta (invoiceNumber, storeNumber) {
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

  return result.recordset[0] || null
}

async function fetchVideoChunk ({ invoiceNumber, start, length }) {
  const pool = await poolPromise
  const result = await pool
    .request()
    .input('invoiceNumber', sql.VarChar(50), invoiceNumber)
    .input('start', sql.Int, start + 1)
    .input('length', sql.Int, length).query(`
      SELECT TOP 1
        SUBSTRING(VideoBinary, @start, @length) AS VideoChunk
      FROM PickUpConfirmationInfo
      WHERE InvoiceNumber = @invoiceNumber
    `)

  const chunk = result.recordset[0]?.VideoChunk
  if (!chunk) return Buffer.alloc(0)
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

function pumpDbToFfmpegStdin ({ invoiceNumber, size, stdin }) {
  return new Promise(async (resolve, reject) => {
    stdin.on('error', err => {
      // EPIPE = ffmpeg closed its stdin (normal on client disconnect)
      if (err.code !== 'EPIPE') reject(err)
      else resolve()
    })

    let position = 0
    let nextChunkPromise = fetchVideoChunk({
      invoiceNumber,
      start: 0,
      length: Math.min(size, DB_CHUNK_SIZE)
    })

    try {
      while (position < size) {
        const chunk = await nextChunkPromise
        if (!chunk.length) break

        const nextPosition = position + chunk.length
        const bytesLeft = size - nextPosition

        // Pre-fetch next chunk WHILE writing current one
        if (bytesLeft > 0) {
          nextChunkPromise = fetchVideoChunk({
            invoiceNumber,
            start: nextPosition,
            length: Math.min(bytesLeft, DB_CHUNK_SIZE)
          })
        }

        const ok = stdin.write(chunk)
        if (!ok) await new Promise(res => stdin.once('drain', res))
        position = nextPosition
      }

      stdin.end()
      resolve()
    } catch (err) {
      stdin.destroy(err)
      reject(err)
    }
  })
}

function pipeFragmentsToResponse ({ stdout, res }) {
  return new Promise((resolve, reject) => {
    stdout.on('data', chunk => {
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

async function transcodeToMp4AndStream ({
  res,
  invoiceNumber,
  meta,
  forceDownload
}) {
  return new Promise(resolve => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-loglevel',
      'error',
      '-i',
      'pipe:0',

      '-vcodec',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-tune',
      'zerolatency',
      '-g',
      '48',

      '-acodec',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',

      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_size',
      String(MP4_FRAG_SIZE),
      '-f',
      'mp4',

      'pipe:1'
    ])

    let spawnFailed = false

    ffmpeg.on('error', err => {
      spawnFailed = true
      console.error('ffmpeg spawn error:', err.message)
      if (!res.headersSent) {
        res.status(500).json({ error: 'ffmpeg failed to start' })
      } else {
        res.end()
      }
      resolve()
    })

    let ffmpegStderr = ''
    ffmpeg.stderr.on('data', d => {
      const line = d.toString()
      if (
        !line.includes('Broken pipe') &&
        !line.includes('Error closing file')
      ) {
        ffmpegStderr += line
      }
    })

    ffmpeg.on('spawn', () => {
      if (spawnFailed) return

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache, no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(forceDownload
          ? {
              'Content-Disposition': `attachment; filename="${encodeURIComponent(
                invoiceNumber
              )}.mp4"`
            }
          : { 'Content-Disposition': 'inline' })
      })

      res.on('close', () => {
        if (!ffmpeg.killed) ffmpeg.kill('SIGTERM')
      })

      Promise.all([
        pumpDbToFfmpegStdin({
          invoiceNumber,
          size: meta.VideoSize,
          stdin: ffmpeg.stdin
        }),
        pipeFragmentsToResponse({
          stdout: ffmpeg.stdout,
          res
        })
      ]).catch(err => {
        console.error('Streaming pipeline error:', err.message)
        if (!ffmpeg.killed) ffmpeg.kill('SIGTERM')
      })
    })

    ffmpeg.on('close', code => {
      const isClientDisconnect = code === 255 || code === null
      if (code !== 0 && !isClientDisconnect) {
        console.error(`ffmpeg exited with code ${code}:\n${ffmpegStderr}`)
      }
      if (!res.writableEnded) res.end()
      resolve()
    })
  })
}

// ─── Shared request handler ───────────────────────────────────────────────
async function handleVideoRequest (req, res, forceDownload) {
  // 1. Validate the video token from ?vt= query param
  const auth = validateVideoToken(req)
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error })
  }

  const invoiceNumber = decodeURIComponent(req.params.invoiceNumber).trim()

  // 2. Fetch metadata — also enforces store ownership via storeNumber
  const meta = await fetchVideoMeta(invoiceNumber, auth.user.storeNumber)
  if (!meta || !meta.VideoSize) {
    return res.status(404).json({ error: 'Video not found' })
  }

  // 3. Stream (identical to old version)
  await transcodeToMp4AndStream({ res, invoiceNumber, meta, forceDownload })
  return undefined
}

// ─── Routes (URLs unchanged) ──────────────────────────────────────────────
router.get('/:invoiceNumber', async (req, res) => {
  try {
    return await handleVideoRequest(req, res, false)
  } catch (error) {
    if (error instanceof sql.RequestError) {
      console.error('SQL error while streaming video:', error)
    } else {
      console.error('Server error while streaming video:', error)
    }
    if (res.headersSent) return undefined
    return res.status(500).json({ error: 'Failed to stream video' })
  }
})

module.exports = router
