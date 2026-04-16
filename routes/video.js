// const express = require('express');
// const { spawn } = require('child_process');
// const { poolPromise, sql } = require('../db');
// const FFMPEG_PATH = require('ffmpeg-static');

// const router = express.Router();

// const DB_CHUNK_SIZE = Number(process.env.STREAM_CHUNK_SIZE_BYTES) || 512 * 1024; // 512KB DB read chunks
// const MP4_FRAGMENT_SIZE = 256 * 1024; // 256KB per MP4 fragment

// function parseInvoiceNumber(value) {
//   if (!value || typeof value !== 'string') return null;
//   const trimmed = value.trim();
//   if (!trimmed) return null;
//   return trimmed;
// }

// async function fetchVideoMeta(invoiceNumber) {
//   const pool = await poolPromise;
//   const result = await pool
//     .request()
//     .input('invoiceNumber', sql.VarChar, invoiceNumber)
//     .query(`
//       SELECT TOP 1
//         InvoiceNumber,
//         VideoName,
//         DATALENGTH(VideoBinary) AS VideoSize
//       FROM PickUpConfirmationInfo
//       WHERE InvoiceNumber = @invoiceNumber
//     `);

//   return result.recordset[0] || null;
// }

// async function fetchVideoChunk({ invoiceNumber, start, length }) {
//   const pool = await poolPromise;
//   const result = await pool
//     .request()
//     .input('invoiceNumber', sql.VarChar, invoiceNumber)
//     .input('start', sql.Int, start + 1) // SQL SUBSTRING is 1-indexed
//     .input('length', sql.Int, length)
//     .query(`
//       SELECT TOP 1
//         SUBSTRING(VideoBinary, @start, @length) AS VideoChunk
//       FROM PickUpConfirmationInfo
//       WHERE InvoiceNumber = @invoiceNumber
//     `);

//   const chunk = result.recordset[0]?.VideoChunk;
//   if (!chunk) return Buffer.alloc(0);
//   return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
// }

// /**
//  * Pumps raw video bytes from SQL DB → ffmpeg stdin, chunk by chunk.
//  *
//  * Backpressure chain:
//  *   DB fetch → ffmpeg stdin → ffmpeg encode → ffmpeg stdout → HTTP response → client
//  *
//  * If the client is slow, the HTTP response buffer fills up, which pauses
//  * ffmpeg stdout reads, which causes ffmpeg's internal output buffer to fill,
//  * which slows down encoding, which slows ffmpeg's consumption of stdin,
//  * which pauses DB reads here via drain. Memory stays flat across the pipeline.
//  */
// function pumpDbToFfmpegStdin({ invoiceNumber, size, stdin }) {
//   return new Promise(async (resolve, reject) => {
//     stdin.on('error', (err) => {
//       // EPIPE = ffmpeg closed its stdin (normal on client disconnect or early exit)
//       if (err.code !== 'EPIPE') reject(err);
//       else resolve();
//     });

//     let position = 0;

//     try {
//       while (position < size) {
//         const bytesLeft = size - position;
//         const chunkLength = Math.min(bytesLeft, DB_CHUNK_SIZE);

//         const chunk = await fetchVideoChunk({
//           invoiceNumber,
//           start: position,
//           length: chunkLength,
//         });

//         if (!chunk.length) break;

//         // Backpressure: pause DB reads until ffmpeg stdin buffer drains
//         const ok = stdin.write(chunk);
//         if (!ok) {
//           await new Promise((res) => stdin.once('drain', res));
//         }

//         position += chunk.length;
//       }

//       stdin.end();
//       resolve();
//     } catch (err) {
//       stdin.destroy(err);
//       reject(err);
//     }
//   });
// }

// /**
//  * Pipes ffmpeg stdout → HTTP response with backpressure.
//  *
//  * When the client is slow, res.write() returns false, which causes us to
//  * pause ffmpeg stdout. ffmpeg's internal output buffer then fills up,
//  * which naturally slows down encoding and DB reads upstream.
//  */
// function pipeFragmentsToResponse({ stdout, res }) {
//   return new Promise((resolve, reject) => {
//     stdout.on('data', (chunk) => {
//       const ok = res.write(chunk);
//       if (!ok) {
//         // Client buffer full — pause ffmpeg output until response drains
//         stdout.pause();
//         res.once('drain', () => stdout.resume());
//       }
//     });

//     stdout.on('end', resolve);
//     stdout.on('error', reject);

//     // Client disconnected — stop consuming ffmpeg output
//     res.on('close', () => {
//       stdout.destroy();
//       resolve();
//     });
//   });
// }

// async function transcodeToMp4AndStream({ res, invoiceNumber, meta, forceDownload }) {
//   return new Promise((resolve) => {
//     const ffmpeg = spawn(FFMPEG_PATH, [
//       '-loglevel', 'error',

//       // ── Input ──────────────────────────────────────────────────────────
//       '-i', 'pipe:0',              // read raw source video from stdin

//       // ── Video codec ────────────────────────────────────────────────────
//       '-vcodec', 'libx264',
//       '-preset', 'veryfast',       // fast encode = lower CPU per frame
//       '-crf', '26',                // quality: lower = better (18–28 range; 26 suits streaming)
//       '-tune', 'zerolatency',      // minimize encoder buffering → fragments arrive sooner
//       '-g', '48',                  // keyframe every 48 frames (~2s at 24fps)

//       // ── Audio codec ────────────────────────────────────────────────────
//       '-acodec', 'aac',
//       '-b:a', '128k',
//       '-ar', '44100',              // normalize sample rate for compatibility

//       // ── Fragmented MP4 output ──────────────────────────────────────────
//       //   frag_keyframe     → new fragment at every keyframe
//       //   empty_moov        → write moov box immediately so browser can start playing
//       //   default_base_moof → each fragment is fully self-contained (needed for streaming)
//       '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
//       '-frag_size', String(MP4_FRAGMENT_SIZE), // fragment size as separate option
//       '-f', 'mp4',

//       'pipe:1',                    // write fragmented MP4 fragments to stdout
//     ]);

//     let spawnFailed = false;

//     ffmpeg.on('error', (err) => {
//       spawnFailed = true;
//       console.error('ffmpeg spawn error:', err.message);
//       if (!res.headersSent) {
//         res.status(500).json({ error: 'ffmpeg failed to start' });
//       } else {
//         res.end();
//       }
//       resolve();
//     });

//     let ffmpegStderr = '';
//     ffmpeg.stderr.on('data', (d) => {
//       const line = d.toString();
//       // Ignore broken pipe messages — these are client disconnects, not real errors
//       if (!line.includes('Broken pipe') && !line.includes('Error closing file')) {
//         ffmpegStderr += line;
//       }
//     });

//     ffmpeg.on('spawn', () => {
//       if (spawnFailed) return;

//       // ── Response headers ───────────────────────────────────────────────
//       // No Content-Length — output size is unknown for live transcode.
//       // Node automatically uses Transfer-Encoding: chunked in this case.
//       res.writeHead(200, {
//         'Content-Type': 'video/mp4',
//         'Cache-Control': 'no-cache, no-store',
//         'X-Content-Type-Options': 'nosniff',
//         ...(forceDownload
//           ? { 'Content-Disposition': `attachment; filename="${invoiceNumber}.mp4"` }
//           : { 'Content-Disposition': 'inline' }),
//       });

//       // Kill ffmpeg immediately when the client disconnects
//       res.on('close', () => {
//         if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
//       });

//       // ── Start both ends of the pipeline concurrently ───────────────────
//       Promise.all([
//         pumpDbToFfmpegStdin({
//           invoiceNumber,
//           size: meta.VideoSize,
//           stdin: ffmpeg.stdin,
//         }),
//         pipeFragmentsToResponse({
//           stdout: ffmpeg.stdout,
//           res,
//         }),
//       ]).catch((err) => {
//         console.error('Streaming pipeline error:', err.message);
//         if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
//       });
//     });

//     ffmpeg.on('close', (code) => {
//       // Code 255 = broken pipe = client disconnected — not a real error
//       // Code null = killed by SIGTERM (our own res.on('close') handler) — also fine
//       const isClientDisconnect = code === 255 || code === null;

//       if (code !== 0 && !isClientDisconnect) {
//         console.error(`ffmpeg exited with code ${code}:\n${ffmpegStderr}`);
//       }

//       if (!res.writableEnded) res.end();
//       resolve();
//     });
//   });
// }

// async function handleVideoRequest(req, res, forceDownload) {
//   const invoiceNumber = parseInvoiceNumber(req.params.invoiceNumber);
//   if (!invoiceNumber) {
//     return res.status(400).json({ error: 'Invalid invoiceNumber' });
//   }

//   const meta = await fetchVideoMeta(invoiceNumber);
//   if (!meta || !meta.VideoSize) {
//     return res.status(404).json({ error: 'Video not found' });
//   }

//   await transcodeToMp4AndStream({ res, invoiceNumber, meta, forceDownload });
//   return undefined;
// }

// // Stream endpoint — use directly in <video src="..."> or open in browser
// router.get('/:invoiceNumber', async (req, res) => {
//   try {
//     return await handleVideoRequest(req, res, false);
//   } catch (error) {
//     if (error instanceof sql.RequestError) {
//       console.error('SQL error while streaming video:', error);
//     } else {
//       console.error('Server error while streaming video:', error);
//     }
//     if (res.headersSent) return undefined;
//     return res.status(500).json({ error: 'Failed to stream video' });
//   }
// });
// // Download endpoint — triggers browser Save-As dialog
// router.get('/:invoiceNumber/download', async (req, res) => {
//   try {
//     return await handleVideoRequest(req, res, true);
//   } catch (error) {
//     console.error('Server error while downloading video:', error);
//     if (res.headersSent) return undefined;
//     return res.status(500).json({ error: 'Failed to download video' });
//   }
// });

// module.exports = router;








// routes/video.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs old version:
//
//   Authentication method:
//     OLD → authenticate middleware on app.use('/video', authenticate, videoRouter)
//           required an Authorization: Bearer header — doesn't work in browser
//           tabs or <video src="...">.
//     NEW → ?vt=<videoToken> query param validated inside this file.
//           app.js mounts this router WITHOUT authenticate middleware.
//           The token is issued by POST /auth/video-token (see routes/auth.js).
//
//   fetchVideoMeta now takes storeNumber as a second argument and adds
//     AND StoreNumber = @storeNumber  to the WHERE clause.
//     This ensures vendors can only stream videos from their own store,
//     using the storeNumber embedded in the video token.
//
//   All streaming/ffmpeg/backpressure logic is IDENTICAL to the old version.
//   Only the auth layer and the meta query changed.
//
//   New env var: MP4_FRAG_SIZE_BYTES (optional, defaults to 256KB as before).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express    = require('express');
const { spawn }  = require('child_process');
const jwt        = require('jsonwebtoken');   // NEW — used for ?vt= validation
const { poolPromise, sql } = require('../db');
const FFMPEG_PATH = require('ffmpeg-static');

const router = express.Router();

const DB_CHUNK_SIZE = Number(process.env.STREAM_CHUNK_SIZE_BYTES) || 512 * 1024; // 512 KB
const MP4_FRAG_SIZE = Number(process.env.MP4_FRAG_SIZE_BYTES)    || 256 * 1024; // 256 KB

// ─── Video token validation ───────────────────────────────────────────────
// Returns { user: decodedToken } on success, or { error, status } on failure.
// Called at the top of handleVideoRequest — replaces the old authenticate
// middleware that was applied at the app.js level.
function validateVideoToken(req) {
  const vt = req.query.vt;

  if (!vt) {
    return { error: 'No video token provided. Call /auth/video-token first.', status: 401 };
  }

  try {
    const decoded = jwt.verify(vt, process.env.JWT_SECRET);

    if (decoded.type !== 'video') {
      return { error: 'Invalid token type.', status: 403 };
    }

    // Ensure the token was issued for this specific invoice — prevents token reuse
    const urlInvoice   = decodeURIComponent(req.params.invoiceNumber).trim();
    const tokenInvoice = decoded.invoiceNumber?.trim();

    if (urlInvoice !== tokenInvoice) {
      return { error: 'Token does not match this video.', status: 403 };
    }

    return { user: decoded };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return { error: 'Video link has expired. Please generate a new one.', status: 401 };
    }
    return { error: 'Invalid video token.', status: 403 };
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────
// CHANGED: storeNumber param added so vendors can only access their own videos.
async function fetchVideoMeta(invoiceNumber, storeNumber) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('invoiceNumber', sql.VarChar(50), invoiceNumber)
    .input('storeNumber',   sql.VarChar(20), storeNumber)
    .query(`
      SELECT TOP 1
        InvoiceNumber,
        VideoName,
        DATALENGTH(VideoBinary) AS VideoSize
      FROM PickUpConfirmationInfo
      WHERE InvoiceNumber = @invoiceNumber
        AND StoreNumber   = @storeNumber
    `);

  return result.recordset[0] || null;
}

// UNCHANGED from old version
async function fetchVideoChunk({ invoiceNumber, start, length }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('invoiceNumber', sql.VarChar(50), invoiceNumber)
    .input('start',  sql.Int, start + 1) // SQL SUBSTRING is 1-indexed
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

// UNCHANGED — backpressure pump: DB → ffmpeg stdin
function pumpDbToFfmpegStdin({ invoiceNumber, size, stdin }) {
  return new Promise(async (resolve, reject) => {
    stdin.on('error', (err) => {
      // EPIPE = ffmpeg closed its stdin (normal on client disconnect)
      if (err.code !== 'EPIPE') reject(err);
      else resolve();
    });

    let position = 0;

    try {
      while (position < size) {
        const chunkLength = Math.min(size - position, DB_CHUNK_SIZE);

        const chunk = await fetchVideoChunk({
          invoiceNumber,
          start: position,
          length: chunkLength,
        });

        if (!chunk.length) break;

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

// UNCHANGED — backpressure pipe: ffmpeg stdout → HTTP response
function pipeFragmentsToResponse({ stdout, res }) {
  return new Promise((resolve, reject) => {
    stdout.on('data', (chunk) => {
      const ok = res.write(chunk);
      if (!ok) {
        stdout.pause();
        res.once('drain', () => stdout.resume());
      }
    });

    stdout.on('end', resolve);
    stdout.on('error', reject);

    res.on('close', () => {
      stdout.destroy();
      resolve();
    });
  });
}

// UNCHANGED — ffmpeg transcode + stream
async function transcodeToMp4AndStream({ res, invoiceNumber, meta, forceDownload }) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-loglevel', 'error',
      '-i', 'pipe:0',

      '-vcodec', 'libx264',
      '-preset', 'veryfast',
      '-crf', '26',
      '-tune', 'zerolatency',
      '-g', '48',

      '-acodec', 'aac',
      '-b:a', '128k',
      '-ar', '44100',

      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_size', String(MP4_FRAG_SIZE),
      '-f', 'mp4',

      'pipe:1',
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
      if (!line.includes('Broken pipe') && !line.includes('Error closing file')) {
        ffmpegStderr += line;
      }
    });

    ffmpeg.on('spawn', () => {
      if (spawnFailed) return;

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache, no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(forceDownload
          ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(invoiceNumber)}.mp4"` }
          : { 'Content-Disposition': 'inline' }),
      });

      res.on('close', () => {
        if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
      });

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
      const isClientDisconnect = code === 255 || code === null;
      if (code !== 0 && !isClientDisconnect) {
        console.error(`ffmpeg exited with code ${code}:\n${ffmpegStderr}`);
      }
      if (!res.writableEnded) res.end();
      resolve();
    });
  });
}

// ─── Shared request handler ───────────────────────────────────────────────
// CHANGED: validates ?vt= token instead of relying on authenticate middleware,
//          then scopes the DB lookup to the storeNumber in the token.
async function handleVideoRequest(req, res, forceDownload) {
  // 1. Validate the video token from ?vt= query param
  const auth = validateVideoToken(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const invoiceNumber = decodeURIComponent(req.params.invoiceNumber).trim();

  // 2. Fetch metadata — also enforces store ownership via storeNumber
  const meta = await fetchVideoMeta(invoiceNumber, auth.user.storeNumber);
  if (!meta || !meta.VideoSize) {
    return res.status(404).json({ error: 'Video not found' });
  }

  // 3. Stream (identical to old version)
  await transcodeToMp4AndStream({ res, invoiceNumber, meta, forceDownload });
  return undefined;
}

// ─── Routes (URLs unchanged) ──────────────────────────────────────────────
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