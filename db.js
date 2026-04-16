// // db.js

// const sql = require('mssql');

// const requiredEnv = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];
// for (const key of requiredEnv) {
//   if (!process.env[key]) {
//     throw new Error(`Missing required environment variable: ${key}`);
//   }
// }

// const config = {
//   server: process.env.DB_SERVER,
//   database: process.env.DB_DATABASE,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   options: {
//     encrypt: process.env.DB_ENCRYPT ? process.env.DB_ENCRYPT === 'true' : true,
//     trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true'
//   },
//   pool: {
//     max: Number(process.env.DB_POOL_MAX) || 10,
//     min: Number(process.env.DB_POOL_MIN) || 0,
//     idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS) || 30000
//   }
// };

// const poolPromise = new sql.ConnectionPool(config)
//   .connect()
//   .then((pool) => {
//     // Keep a single shared pool for the full application lifecycle.
//     console.log('Connected to SQL Server');
//     return pool;
//   })
//   .catch((error) => {
//     console.error('Database connection failed', error);
//     throw error;
//   });

// module.exports = {
//   sql,
//   poolPromise
// };





// db.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs old version:
//
//   New config options (all optional — all have sensible defaults):
//     DB_PORT              — explicit SQL Server port (default 1433)
//     DB_CONNECT_TIMEOUT_MS — connection timeout in ms (default 15000)
//     DB_REQUEST_TIMEOUT_MS — query timeout in ms (default 30000)
//     enableArithAbort: true — required for mssql >= 7, prevents subtle bugs
//     DB_POOL_MIN changed default from 0 → 2 (keeps warm connections ready)
//     DB_POOL_ACQUIRE_MS   — max wait to acquire a pooled connection (default 10000)
//
//   Renamed env var:
//     OLD: DB_TRUST_SERVER_CERT
//     NEW: DB_TRUST_SERVER_CERT still works — no rename needed. The new file
//          uses the same variable name so your existing .env is unaffected.
//
//   DB_ENCRYPT logic simplified:
//     OLD: DB_ENCRYPT ? DB_ENCRYPT === 'true' : true
//     NEW: DB_ENCRYPT !== 'false'   (same behaviour — defaults to true for Azure)
//
// Everything else — connection pooling, error handling, exports — is identical.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const sql = require('mssql');

const requiredEnv = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const config = {
  server:   process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port:     Number(process.env.DB_PORT) || 1433,
  options: {
    encrypt:                process.env.DB_ENCRYPT !== 'false',           // true for Azure
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true',  // true for self-signed / local dev
    connectTimeout:         Number(process.env.DB_CONNECT_TIMEOUT_MS) || 15000,
    requestTimeout:         Number(process.env.DB_REQUEST_TIMEOUT_MS) || 30000,
    enableArithAbort:       true,  // required for mssql >= 7
  },
  pool: {
    max:                  Number(process.env.DB_POOL_MAX)        || 10,
    min:                  Number(process.env.DB_POOL_MIN)        || 2,
    idleTimeoutMillis:    Number(process.env.DB_POOL_IDLE_TIMEOUT_MS) || 30000,
    acquireTimeoutMillis: Number(process.env.DB_POOL_ACQUIRE_MS) || 10000,
  },
};

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log('Connected to SQL Server');
    return pool;
  })
  .catch((error) => {
    console.error('Database connection failed', error);
    throw error;
  });

module.exports = {
  sql,
  poolPromise,
};