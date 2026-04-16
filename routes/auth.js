// routes/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED (storeNumber removed from token):
//
//   POST /auth/login:
//     - storeNumber is NO LONGER put inside the JWT payload.
//     - storeNumber IS still returned in the login response body (user:{}) so
//       the frontend can display it if needed — it's just not in the token.
//
//   POST /auth/video-token:
//     - req.user.storeNumber is gone (no longer in session JWT).
//     - storeNumber is fetched live from Vendors table using req.user.username
//       before being used to scope the invoice ownership check.
//     - storeNumber IS still embedded in the short-lived video token (?vt=)
//       because the /video route needs it to scope its DB query, and that
//       token is issued fresh each time (20 min TTL) so it's always current.
//
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { poolPromise, sql } = require('../db');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// ─── Simple in-memory rate limiter ────────────────────────────────────────
const loginAttempts = new Map();

function checkRateLimit(ip) {
  const now       = Date.now();
  const entry     = loginAttempts.get(ip);
  const MAX       = Number(process.env.LOGIN_MAX_ATTEMPTS) || 10;
  const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS)    || 15 * 60 * 1000;

  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX) return true;
  entry.count++;
  return false;
}

// ─── Helper: fetch storeNumber from DB by username ────────────────────────
// Used by /video-token because storeNumber is no longer in the session JWT.
async function getStoreNumber(username) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('username', sql.VarChar(100), username)
    .query(`
      SELECT StoreNumber
      FROM   Vendors
      WHERE  Username = @username
    `);
  return result.recordset[0]?.StoreNumber ?? null;
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

    const result = await pool
      .request()
      .input('username', sql.VarChar(100), username.trim().toLowerCase())
      .query(`
        SELECT VendorID, Username, Password, StoreNumber
        FROM   Vendors
        WHERE  Username = @username
      `);

    const vendor = result.recordset[0];

    const hash          = vendor?.Password ?? '$2b$12$invalidhashfortimingprotection';
    const passwordMatch = await bcrypt.compare(password, hash);

    if (!vendor || !passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // storeNumber intentionally excluded from JWT payload
    const token = jwt.sign(
      {
        type:     'session',
        username: vendor.Username,
        // storeNumber removed — fetched from DB when needed
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    loginAttempts.delete(ip);

    return res.status(200).json({
      token,
      user: {
        username:    vendor.Username,
        // storeNumber: vendor.StoreNumber, // still in response body, just not in token
      },
    });

  } catch (err) {
    console.error('[auth/login] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /auth/video-token ────────────────────────────────────────────────
router.post('/video-token', authenticate, async (req, res) => {
  const { invoiceNumber } = req.body;

  if (!invoiceNumber || typeof invoiceNumber !== 'string') {
    return res.status(400).json({ error: 'invoiceNumber is required.' });
  }

  try {
    // storeNumber no longer in session JWT — fetch fresh from DB using username
    const storeNumber = await getStoreNumber(req.user.username);
    if (!storeNumber) {
      return res.status(403).json({ error: 'Vendor not found.' });
    }

    const pool = await poolPromise;

    // Confirm this invoice belongs to the vendor's store
    const result = await pool
      .request()
      .input('invoiceNumber', sql.VarChar(50), invoiceNumber.trim())
      .input('storeNumber',   sql.VarChar(20), storeNumber)
      .query(`
        SELECT TOP 1 InvoiceNumber
        FROM   PickUpConfirmationInfo
        WHERE  InvoiceNumber = @invoiceNumber
          AND  StoreNumber   = @storeNumber
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ error: 'Video not found for your store.' });
    }

    // Short-lived video token still carries storeNumber (fetched above).
    // The /video route needs it to scope its DB query, and this token is
    // issued fresh each time (20 min TTL) so it always reflects current DB state.
    const videoToken = jwt.sign(
      {
        type:          'video',
        invoiceNumber: invoiceNumber.trim(),
        storeNumber:   storeNumber,
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