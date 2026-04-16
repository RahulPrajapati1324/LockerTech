// middleware/authenticate.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED:
//   storeNumber is no longer stored in or read from the JWT.
//   req.user now only carries { username }.
//   Routes that need storeNumber must look it up from the DB using username.
//   (See routes/pickup.js and routes/auth.js for the DB lookup helper.)
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

    // storeNumber is intentionally NOT stored in the token.
    // Routes that need it fetch it live from the DB using username.
    req.user = {
      username: decoded.username,
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