// db.js
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