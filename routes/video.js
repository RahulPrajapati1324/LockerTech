const express = require('express');
const { spawn } = require('child_process');
const { poolPromise, sql } = require('../db');
const FFMPEG_PATH = require('ffmpeg-static');

const router = express.Router();

const DB_CHUNK_SIZE = Number(process.env.STREAM_CHUNK_SIZE_BYTES) || 512 * 1024; // 512KB DB read chunks
const MP4_FRAGMENT_SIZE = 256 * 1024; // 256KB per MP4 fragment

function parseInvoiceNumber(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

async function fetchVideoMeta(invoiceNumber) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('invoiceNumber', sql.VarChar, invoiceNumber)
    .query(`
      SELECT TOP 1
        InvoiceNumber,
        VideoName,
        DATALENGTH(VideoBinary) AS VideoSize
      FROM PickUpConfirmationInfo
      WHERE InvoiceNumber = @invoiceNumber
    `);

  return result.recordset[0] || null;
}

async function fetchVideoChunk({ invoiceNumber, start, length }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('invoiceNumber', sql.VarChar, invoiceNumber)
    .input('start', sql.Int, start + 1) // SQL SUBSTRING is 1-indexed
    .input('length', sql.Int, length)
    .query(`
      SELECT TOP 1
        SUBSTRING(VideoBinary, @start, @length) AS VideoChunk
      FROM PickUpConfirmationInfo
      WHERE InvoiceNumber = @invoiceNumber
    `);

  const chunk = result.recordset[0]?.VideoChunk;
  if (!chunk) return Buffer.alloc(0);
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/**
 * Pumps raw video bytes from SQL DB → ffmpeg stdin, chunk by chunk.
 *
 * Backpressure chain:
 *   DB fetch → ffmpeg stdin → ffmpeg encode → ffmpeg stdout → HTTP response → client
 *
 * If the client is slow, the HTTP response buffer fills up, which pauses
 * ffmpeg stdout reads, which causes ffmpeg's internal output buffer to fill,
 * which slows down encoding, which slows ffmpeg's consumption of stdin,
 * which pauses DB reads here via drain. Memory stays flat across the pipeline.
 */
function pumpDbToFfmpegStdin({ invoiceNumber, size, stdin }) {
  return new Promise(async (resolve, reject) => {
    stdin.on('error', (err) => {
      // EPIPE = ffmpeg closed its stdin (normal on client disconnect or early exit)
      if (err.code !== 'EPIPE') reject(err);
      else resolve();
    });

    let position = 0;

    try {
      while (position < size) {
        const bytesLeft = size - position;
        const chunkLength = Math.min(bytesLeft, DB_CHUNK_SIZE);

        const chunk = await fetchVideoChunk({
          invoiceNumber,
          start: position,
          length: chunkLength,
        });

        if (!chunk.length) break;

        // Backpressure: pause DB reads until ffmpeg stdin buffer drains
        const ok = stdin.write(chunk);
        if (!ok) {
          await new Promise((res) => stdin.once('drain', res));
        }

        position += chunk.length;
      }

      stdin.end();
      resolve();
    } catch (err) {
      stdin.destroy(err);
      reject(err);
    }
  });
}

/**
 * Pipes ffmpeg stdout → HTTP response with backpressure.
 *
 * When the client is slow, res.write() returns false, which causes us to
 * pause ffmpeg stdout. ffmpeg's internal output buffer then fills up,
 * which naturally slows down encoding and DB reads upstream.
 */
function pipeFragmentsToResponse({ stdout, res }) {
  return new Promise((resolve, reject) => {
    stdout.on('data', (chunk) => {
      const ok = res.write(chunk);
      if (!ok) {
        // Client buffer full — pause ffmpeg output until response drains
        stdout.pause();
        res.once('drain', () => stdout.resume());
      }
    });

    stdout.on('end', resolve);
    stdout.on('error', reject);

    // Client disconnected — stop consuming ffmpeg output
    res.on('close', () => {
      stdout.destroy();
      resolve();
    });
  });
}

async function transcodeToMp4AndStream({ res, invoiceNumber, meta, forceDownload }) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-loglevel', 'error',

      // ── Input ──────────────────────────────────────────────────────────
      '-i', 'pipe:0',              // read raw source video from stdin

      // ── Video codec ────────────────────────────────────────────────────
      '-vcodec', 'libx264',
      '-preset', 'veryfast',       // fast encode = lower CPU per frame
      '-crf', '26',                // quality: lower = better (18–28 range; 26 suits streaming)
      '-tune', 'zerolatency',      // minimize encoder buffering → fragments arrive sooner
      '-g', '48',                  // keyframe every 48 frames (~2s at 24fps)

      // ── Audio codec ────────────────────────────────────────────────────
      '-acodec', 'aac',
      '-b:a', '128k',
      '-ar', '44100',              // normalize sample rate for compatibility

      // ── Fragmented MP4 output ──────────────────────────────────────────
      //   frag_keyframe     → new fragment at every keyframe
      //   empty_moov        → write moov box immediately so browser can start playing
      //   default_base_moof → each fragment is fully self-contained (needed for streaming)
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_size', String(MP4_FRAGMENT_SIZE), // fragment size as separate option
      '-f', 'mp4',

      'pipe:1',                    // write fragmented MP4 fragments to stdout
    ]);

    let spawnFailed = false;

    ffmpeg.on('error', (err) => {
      spawnFailed = true;
      console.error('ffmpeg spawn error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'ffmpeg failed to start' });
      } else {
        res.end();
      }
      resolve();
    });

    let ffmpegStderr = '';
    ffmpeg.stderr.on('data', (d) => {
      const line = d.toString();
      // Ignore broken pipe messages — these are client disconnects, not real errors
      if (!line.includes('Broken pipe') && !line.includes('Error closing file')) {
        ffmpegStderr += line;
      }
    });

    ffmpeg.on('spawn', () => {
      if (spawnFailed) return;

      // ── Response headers ───────────────────────────────────────────────
      // No Content-Length — output size is unknown for live transcode.
      // Node automatically uses Transfer-Encoding: chunked in this case.
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache, no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(forceDownload
          ? { 'Content-Disposition': `attachment; filename="${invoiceNumber}.mp4"` }
          : { 'Content-Disposition': 'inline' }),
      });

      // Kill ffmpeg immediately when the client disconnects
      res.on('close', () => {
        if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
      });

      // ── Start both ends of the pipeline concurrently ───────────────────
      Promise.all([
        pumpDbToFfmpegStdin({
          invoiceNumber,
          size: meta.VideoSize,
          stdin: ffmpeg.stdin,
        }),
        pipeFragmentsToResponse({
          stdout: ffmpeg.stdout,
          res,
        }),
      ]).catch((err) => {
        console.error('Streaming pipeline error:', err.message);
        if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
      });
    });

    ffmpeg.on('close', (code) => {
      // Code 255 = broken pipe = client disconnected — not a real error
      // Code null = killed by SIGTERM (our own res.on('close') handler) — also fine
      const isClientDisconnect = code === 255 || code === null;

      if (code !== 0 && !isClientDisconnect) {
        console.error(`ffmpeg exited with code ${code}:\n${ffmpegStderr}`);
      }

      if (!res.writableEnded) res.end();
      resolve();
    });
  });
}

async function handleVideoRequest(req, res, forceDownload) {
  const invoiceNumber = parseInvoiceNumber(req.params.invoiceNumber);
  if (!invoiceNumber) {
    return res.status(400).json({ error: 'Invalid invoiceNumber' });
  }

  const meta = await fetchVideoMeta(invoiceNumber);
  if (!meta || !meta.VideoSize) {
    return res.status(404).json({ error: 'Video not found' });
  }

  await transcodeToMp4AndStream({ res, invoiceNumber, meta, forceDownload });
  return undefined;
}

// Stream endpoint — use directly in <video src="..."> or open in browser
router.get('/:invoiceNumber', async (req, res) => {
  try {
    return await handleVideoRequest(req, res, false);
  } catch (error) {
    if (error instanceof sql.RequestError) {
      console.error('SQL error while streaming video:', error);
    } else {
      console.error('Server error while streaming video:', error);
    }
    if (res.headersSent) return undefined;
    return res.status(500).json({ error: 'Failed to stream video' });
  }
});
// Download endpoint — triggers browser Save-As dialog
router.get('/:invoiceNumber/download', async (req, res) => {
  try {
    return await handleVideoRequest(req, res, true);
  } catch (error) {
    console.error('Server error while downloading video:', error);
    if (res.headersSent) return undefined;
    return res.status(500).json({ error: 'Failed to download video' });
  }
});

module.exports = router;