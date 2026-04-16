// routes/pickup.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED (storeNumber removed from session token):
//
//   req.user.storeNumber is no longer available (not in JWT).
//   Both routes now fetch storeNumber from the Vendors table using
//   req.user.username at the start of each request.
//
//   Everything else — pagination, columns returned, scoping to last 60 days,
//   the GET /:entryNumber route — is identical.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const { poolPromise, sql } = require('../db');

const router = express.Router();

const DEFAULT_PAGE      = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE     = 200;

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

// ─── Helper: fetch storeNumber from DB by username ────────────────────────
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

// ─── GET /pickup ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const page          = parsePositiveInt(req.query.page, DEFAULT_PAGE);
  const requestedSize = parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE);

  if (!page || !requestedSize) {
    return res.status(400).json({ error: 'page and pageSize must be positive integers' });
  }

  const pageSize = Math.min(requestedSize, MAX_PAGE_SIZE);
  const offset   = (page - 1) * pageSize;

  try {
    // storeNumber not in JWT — fetch from DB using username
    const storeNumber = await getStoreNumber(req.user.username);
    if (!storeNumber) {
      return res.status(403).json({ error: 'Vendor not found.' });
    }

    const pool = await poolPromise;

    const [rowsResult, countResult] = await Promise.all([
      pool
        .request()
        .input('storeNumber', sql.VarChar(20), storeNumber)
        .input('offset',      sql.Int,         offset)
        .input('pageSize',    sql.Int,         pageSize)
        .query(`
          SELECT
            EntryNumber,
            InvoiceNumber,
            StoreNumber,
            EmployeeID,
            ShelfLocation,
            VideoName,
            emailed,
            CreatedAt
          FROM PickUpConfirmationInfo
          WHERE StoreNumber = @storeNumber
            AND CreatedAt  >= DATEADD(DAY, -60, GETUTCDATE())
          ORDER BY CreatedAt DESC, EntryNumber DESC
          OFFSET @offset ROWS
          FETCH NEXT @pageSize ROWS ONLY
        `),

      pool
        .request()
        .input('storeNumber', sql.VarChar(20), storeNumber)
        .query(`
          SELECT COUNT(1) AS TotalCount
          FROM   PickUpConfirmationInfo
          WHERE  StoreNumber = @storeNumber
            AND  CreatedAt  >= DATEADD(DAY, -60, GETUTCDATE())
        `),
    ]);

    const host  = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const items = rowsResult.recordset.map(row => ({
      entryNumber:        row.EntryNumber,
      invoiceNumber:      row.InvoiceNumber,
      storeNumber:        row.StoreNumber,
      employeeID:         row.EmployeeID,
      shelfLocation:      row.ShelfLocation,
      videoName:          row.VideoName,
      emailed:            row.emailed,
      createdAt:          row.CreatedAt,
      videoTokenEndpoint: `${host}/auth/video-token`,
    }));

    const total      = countResult.recordset[0]?.TotalCount || 0;
    const totalPages = Math.ceil(total / pageSize);

    return res.status(200).json({
      storeNumber,
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage:     page < totalPages,
        hasPreviousPage: page > 1,
      },
    });

  } catch (error) {
    console.error('Server error while listing pickup records', error);
    return res.status(500).json({ error: 'Failed to fetch pickup list' });
  }
});

// ─── GET /pickup/:entryNumber ─────────────────────────────────────────────
router.get('/:entryNumber', async (req, res) => {
  const entryNumber = Number.parseInt(req.params.entryNumber, 10);
  if (Number.isNaN(entryNumber)) {
    return res.status(400).json({ error: 'Invalid entryNumber.' });
  }

  try {
    // storeNumber not in JWT — fetch from DB using username
    const storeNumber = await getStoreNumber(req.user.username);
    if (!storeNumber) {
      return res.status(403).json({ error: 'Vendor not found.' });
    }

    const pool = await poolPromise;

    const result = await pool
      .request()
      .input('entryNumber',  sql.Int,         entryNumber)
      .input('storeNumber',  sql.VarChar(20), storeNumber)
      .query(`
        SELECT
          EntryNumber,
          InvoiceNumber,
          StoreNumber,
          EmployeeID,
          ShelfLocation,
          VideoName,
          emailed,
          CreatedAt
        FROM PickUpConfirmationInfo
        WHERE EntryNumber = @entryNumber
          AND StoreNumber = @storeNumber
      `);

    const row = result.recordset[0];
    if (!row) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    const host = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;

    return res.status(200).json({
      entryNumber:        row.EntryNumber,
      invoiceNumber:      row.InvoiceNumber,
      storeNumber:        row.StoreNumber,
      employeeID:         row.EmployeeID,
      shelfLocation:      row.ShelfLocation,
      videoName:          row.VideoName,
      emailed:            row.emailed,
      createdAt:          row.CreatedAt,
      videoTokenEndpoint: `${host}/auth/video-token`,
    });

  } catch (err) {
    console.error('[pickup/single] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch record.' });
  }
});

module.exports = router;