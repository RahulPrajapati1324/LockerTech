//app.js

require('dotenv').config();
const express = require('express');
const { poolPromise } = require('./db');
const pickupRouter = require('./routes/pickup');
const videoRouter = require('./routes/video');

const authRouter = require('./routes/auth');                
const authenticate = require('./middleware/authenticate'); 

const app = express();
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));


app.use((req, res, next) => {
  // Allow HTML <video> and third-party players to request media cross-origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Liveness check for orchestrators/load balancers.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness check verifies DB connectivity before receiving traffic.
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


app.use('/auth', authRouter);
app.use('/pickup', authenticate, pickupRouter);
app.use('/video', authenticate, videoRouter); 

app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Video API listening on port ${port}`);
});
