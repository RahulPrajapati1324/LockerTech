// const express = require('express')
// const jwt = require('jsonwebtoken')
// const { poolPromise, sql } = require('../db')

// const router = express.Router()

// router.post('/login', async (req, res) => {
//   const { username, password } = req.body

//   if (!username || !password) {
//     return res.status(400).json({ error: 'Username and password are required' })
//   }

//   try {
//     const pool = await poolPromise

//     const result = await pool
//       .request()
//       .input('username', sql.VarChar, username.trim())
//       .input('password', sql.VarChar, password)
//       .query(`
//         SELECT Username, StoreNumber
//         FROM Vendors
//         WHERE Username = @username AND Password = @password
//       `)

//     const vendor = result.recordset[0]

//     if (!vendor) {
//       return res.status(401).json({ error: 'Invalid username or password' })
//     }

//     const token = jwt.sign(
//       { 
//         username: vendor.Username,
//         storeNumber: vendor.StoreNumber   // 👈 added to token
//       },
//       process.env.JWT_SECRET,
//       { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
//     )

//     return res.status(200).json({
//       message: 'Login successful',
//       token,
//       user: {
//         username: vendor.Username,
//         storeNumber: vendor.StoreNumber   // 👈 added to response
//       }
//     })

//   } catch (error) {
//     console.error('Login error:', error)
//     return res.status(500).json({ error: 'Internal server error' })
//   }
// })

// module.exports = router




// routes/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs old version:
//
//   POST /auth/login  — same URL, mostly same behaviour, three key differences:
//     1. Passwords are now compared with bcrypt (not plain-text SQL WHERE).
//        The SQL query fetches the row by username only, then bcrypt.compare()
//        checks the password in JS. Run scripts/migrate-passwords.js first.
//     2. JWT payload now includes  type:"session"  so authenticate middleware
//        can distinguish session tokens from short-lived video tokens.
//     3. In-memory rate-limit guard (10 attempts per 15 min per IP).
//        Tune via LOGIN_MAX_ATTEMPTS and LOGIN_WINDOW_MS env vars.
//        The "message" field is removed from the success response (breaking
//        change is intentional — it was never used by the frontend).
//
//   POST /auth/video-token  ← NEW endpoint (does not replace anything)
//     Called by the Wix frontend before opening a video in a new tab.
//     Returns a signed URL with a 20-min token embedded as ?vt=<token>.
//     The /video route validates this token — no Authorization header needed,
//     which is required for <video src="..."> and new-tab navigation.
//
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');         // NEW dependency — npm install bcryptjs
const { poolPromise, sql } = require('../db');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// ─── Simple in-memory rate limiter ────────────────────────────────────────
// Maps IP → { count, resetAt }.  Not shared across processes — swap for
// a Redis-backed limiter (e.g. rate-limiter-flexible) in a multi-instance setup.
const loginAttempts = new Map();

function checkRateLimit(ip) {
  const now         = Date.now();
  const entry       = loginAttempts.get(ip);
  const MAX         = Number(process.env.LOGIN_MAX_ATTEMPTS) || 10;
  const WINDOW_MS   = Number(process.env.LOGIN_WINDOW_MS)    || 15 * 60 * 1000;

  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX) return true;
  entry.count++;
  return false;
}

// ─── POST /auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const ip = req.ip;

  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid input types.' });
  }

  try {
    const pool = await poolPromise;

    // Fetch row by username only — password comparison is done in JS via bcrypt
    const result = await pool
      .request()
      .input('username', sql.VarChar(100), username.trim().toLowerCase())
      .query(`
        SELECT VendorID, Username, Password, StoreNumber
        FROM   Vendors
        WHERE  Username = @username
      `);

    const vendor = result.recordset[0];

    // Always run bcrypt even when the user doesn't exist — prevents timing-based
    // username enumeration (attacker can't tell "no such user" from "wrong password").
    const hash          = vendor?.Password ?? '$2b$12$invalidhashfortimingprotection';
    const passwordMatch = await bcrypt.compare(password, hash);

    if (!vendor || !passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Issue session JWT — type:"session" lets authenticate() reject video tokens
    const token = jwt.sign(
      {
        type:        'session',
        username:    vendor.Username,
        storeNumber: vendor.StoreNumber,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Clear rate-limit counter on successful login
    loginAttempts.delete(ip);

    return res.status(200).json({
      token,
      user: {
        username:    vendor.Username,
        storeNumber: vendor.StoreNumber,
      },
    });

  } catch (err) {
    console.error('[auth/login] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /auth/video-token  (NEW) ────────────────────────────────────────
// Call this BEFORE opening a video URL in a new browser tab or setting
// <video src="...">.  Browsers cannot attach Authorization headers for either
// of those cases, so the /video route accepts a short-lived ?vt= query param
// instead of a header.
//
// Request:   POST /auth/video-token
//            Authorization: Bearer <sessionJWT>
//            Body: { "invoiceNumber": "INV-12345" }
//
// Response:  { "videoUrl": "https://yourapi.com/video/INV-12345?vt=<token>" }
//
// The token expires in 20 minutes (configurable via VIDEO_TOKEN_EXPIRES_IN).
router.post('/video-token', authenticate, async (req, res) => {
  const { invoiceNumber } = req.body;

  if (!invoiceNumber || typeof invoiceNumber !== 'string') {
    return res.status(400).json({ error: 'invoiceNumber is required.' });
  }

  try {
    const pool = await poolPromise;

    // Confirm this invoice belongs to the vendor's own store before issuing token
    const result = await pool
      .request()
      .input('invoiceNumber', sql.VarChar(50), invoiceNumber.trim())
      .input('storeNumber',   sql.VarChar(20), req.user.storeNumber)
      .query(`
        SELECT TOP 1 InvoiceNumber
        FROM   PickUpConfirmationInfo
        WHERE  InvoiceNumber = @invoiceNumber
          AND  StoreNumber   = @storeNumber
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ error: 'Video not found for your store.' });
    }

    const videoToken = jwt.sign(
      {
        type:          'video',
        invoiceNumber: invoiceNumber.trim(),
        storeNumber:   req.user.storeNumber,
        username:      req.user.username,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.VIDEO_TOKEN_EXPIRES_IN || '20m' }
    );

    const host     = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const videoUrl = `${host}/video/${encodeURIComponent(invoiceNumber.trim())}?vt=${videoToken}`;

    return res.status(200).json({ videoUrl });

  } catch (err) {
    console.error('[auth/video-token] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;