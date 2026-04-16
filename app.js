// //app.js

// require('dotenv').config();
// const express = require('express');
// const { poolPromise } = require('./db');
// const pickupRouter = require('./routes/pickup');
// const videoRouter = require('./routes/video');

// const authRouter = require('./routes/auth');                
// const authenticate = require('./middleware/authenticate'); 

// const app = express();
// const port = Number(process.env.PORT) || 3000;

// app.disable('x-powered-by');
// app.use(express.json({ limit: '1mb' }));


// app.use((req, res, next) => {
//   // Allow HTML <video> and third-party players to request media cross-origin.
//   res.setHeader('Access-Control-Allow-Origin', '*');
//   res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
//   res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
//   res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

//   if (req.method === 'OPTIONS') {
//     return res.sendStatus(204);
//   }

//   next();
// });

// // Liveness check for orchestrators/load balancers.
// app.get('/health', (_req, res) => {
//   res.status(200).json({ status: 'ok' });
// });

// // Readiness check verifies DB connectivity before receiving traffic.
// app.get('/health/ready', async (_req, res) => {
//   try {
//     const pool = await poolPromise;
//     await pool.request().query('SELECT 1 AS ok');
//     return res.status(200).json({ status: 'ready' });
//   } catch (error) {
//     console.error('Health readiness check failed', error);
//     return res.status(503).json({ status: 'not_ready' });
//   }
// });


// app.use('/auth', authRouter);
// app.use('/pickup', authenticate, pickupRouter);
// app.use('/video',authenticate, videoRouter); 

// app.use((err, _req, res, _next) => {
//   console.error('Unhandled error', err);
//   res.status(500).json({ error: 'Internal server error' });
// });

// app.listen(port, () => {
//   console.log(`Video API listening on port ${port}`);
// });





// app.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs old version:
//
//   1. CORS: wildcard (*) replaced with allowlist from ALLOWED_ORIGINS env var.
//      Old: res.setHeader('Access-Control-Allow-Origin', '*') always.
//      New: only origins in ALLOWED_ORIGINS get the header.
//      Also adds Access-Control-Allow-Credentials: true (needed for auth headers).
//      Set ALLOWED_ORIGINS=https://yourwix.site,http://localhost:3000 in .env.
//      Leave it empty to block all cross-origin requests.
//
//   2. trust proxy: app.set('trust proxy', 1) added so req.ip returns the real
//      client IP (not the load-balancer IP) for the rate-limiter in auth.js.
//
//   3. /video route no longer has authenticate middleware:
//      OLD: app.use('/video', authenticate, videoRouter)
//      NEW: app.use('/video', videoRouter)
//      Auth is now handled inside videoRouter via ?vt= token validation.
//      /pickup and /auth routes are unchanged.
//
// Everything else — health checks, error handler, port, body parser — is identical.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express      = require('express');
const { poolPromise } = require('./db');
const authRouter   = require('./routes/auth');
const pickupRouter = require('./routes/pickup');
const videoRouter  = require('./routes/video');
const authenticate = require('./middleware/authenticate');

const app  = express();
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');

// Trust the first proxy so req.ip is the real client IP (needed for rate limiting)
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS is a comma-separated list of permitted origins.
// Example: ALLOWED_ORIGINS=https://yourwixsite.com,http://localhost:3000
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '1mb' }));

// Liveness check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness check — verifies DB connectivity
app.get('/health/ready', async (_req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request().query('SELECT 1 AS ok');
    return res.status(200).json({ status: 'ready' });
  } catch (error) {
    console.error('Health readiness check failed', error);
    return res.status(503).json({ status: 'not_ready' });
  }
});

app.use('/auth',   authRouter);
app.use('/pickup', authenticate, pickupRouter);
app.use('/video',  videoRouter); // auth handled inside videoRouter via ?vt= token

app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Video API listening on port ${port}`);
});