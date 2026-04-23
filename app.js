// app.js
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config()
const express = require('express')
const { poolPromise } = require('./db')
const authRouter = require('./routes/auth')
const pickupRouter = require('./routes/pickup')
const videoRouter = require('./routes/video')
const authenticate = require('./middleware/authenticate')

const app = express()
const port = Number(process.env.PORT) || 3000

app.disable('x-powered-by')

// Trust the first proxy so req.ip is the real client IP (needed for rate limiting)
app.set('trust proxy', 1)

// ─── CORS ─────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS is a comma-separated list of permitted origins.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin

  if (
    !origin ||
    ALLOWED_ORIGINS.includes(origin) ||
    ALLOWED_ORIGINS.includes('*')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Range'
  )
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Range, Accept-Ranges, Content-Length, Content-Type'
  )
  res.setHeader('Access-Control-Allow-Credentials', 'true')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

app.use(express.json({ limit: '1mb' }))

// Liveness check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' })
})

app.use('/auth', authRouter)
app.use('/pickup', authenticate, pickupRouter)
app.use('/video', videoRouter) // auth handled

app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(port, () => {
  console.log(`Video API listening on port ${port}`)
})
