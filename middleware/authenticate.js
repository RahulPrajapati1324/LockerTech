// const jwt = require('jsonwebtoken');


// middleware/authenticate.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs old version:
//
//   1. Token type guard — rejects ?vt= video tokens used on protected routes.
//      Old code accepted ANY valid JWT. Now only tokens with type:"session"
//      are accepted here. Video tokens (type:"video") are only valid on
//      the /video route via validateVideoToken() inside routes/video.js.
//
//   2. req.user shape is now explicit: { username, storeNumber }
//      instead of forwarding the entire decoded payload.
//
//   3. Minor: cleaner Bearer extraction with optional chaining.
//
// Everything else is identical — same 401/403 behaviour, same JWT_SECRET.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Only accept session tokens — not short-lived video tokens
    if (decoded.type !== 'session') {
      return res.status(403).json({ error: 'Invalid token type.' });
    }

    req.user = {
      username:    decoded.username,
      storeNumber: decoded.storeNumber,
    };

    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired. Please log in again.' });
    }
    return res.status(403).json({ error: 'Invalid token.' });
  }
}

module.exports = authenticate;

// function authenticate(req, res, next) {
//   const authHeader = req.headers['authorization'];
//   const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

//   if (!token) {
//     return res.status(401).json({ error: 'Access denied. No token provided.' });
//   }

//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     req.user = decoded;
//     next();
//   } catch (error) {
//     if (error.name === 'TokenExpiredError') {
//       return res.status(401).json({ error: 'Token has expired. Please log in again.' });
//     }
//     return res.status(403).json({ error: 'Invalid token.' });
//   }
// }

// module.exports = authenticate;