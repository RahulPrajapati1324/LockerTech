// const express = require('express')
// const { poolPromise, sql } = require('../db')

// const router = express.Router()

// const DEFAULT_PAGE = 1
// const DEFAULT_PAGE_SIZE = 50
// const MAX_PAGE_SIZE = 200

// function parsePositiveInt (value, fallback) {
//   if (value === undefined) return fallback
//   const parsed = Number.parseInt(value, 10)
//   if (Number.isNaN(parsed) || parsed <= 0) return null
//   return parsed
// }

// // router.get('/list', async (req, res) => {
// //   const page = parsePositiveInt(req.query.page, DEFAULT_PAGE);
// //   const requestedPageSize = parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE);

// //   if (!page || !requestedPageSize) {
// //     return res.status(400).json({ error: 'page and pageSize must be positive integers' });
// //   }

// //   const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
// //   const offset = (page - 1) * pageSize;

// //   try {
// //     const pool = await poolPromise;

// //     const [rowsResult, countResult] = await Promise.all([
// //       pool
// //         .request()
// //         .input('offset', sql.Int, offset)
// //         .input('pageSize', sql.Int, pageSize)
// //         .query(`
// //           SELECT
// //             EntryNumber,
// //             InvoiceNumber,
// //             StoreNumber,
// //             EmployeeID,
// //             CreatedAt
// //           FROM PickUpConfirmationInfo
// //           ORDER BY CreatedAt DESC, EntryNumber DESC
// //           OFFSET @offset ROWS
// //           FETCH NEXT @pageSize ROWS ONLY
// //         `),
// //       pool.request().query('SELECT COUNT(1) AS TotalCount FROM PickUpConfirmationInfo')
// //     ]);

// //     const host = `${req.protocol}://${req.get('host')}`;

// //     const items = rowsResult.recordset.map((row) => ({
// //       entryNumber: row.EntryNumber,
// //       invoiceNumber: row.InvoiceNumber,
// //       storeNumber: row.StoreNumber,
// //       employeeID: row.EmployeeID,
// //       createdAt: row.CreatedAt,
// //       // Frontend can directly bind this URL to <video src="...">.
// //       videoUrl: `${host}/video/${encodeURIComponent(row.InvoiceNumber)}`
// //     }));

// //     const total = countResult.recordset[0]?.TotalCount || 0;
// //     const totalPages = Math.ceil(total / pageSize);

// //     return res.status(200).json({
// //       items,
// //       pagination: {
// //         page,
// //         pageSize,
// //         total,
// //         totalPages,
// //         hasNextPage: page < totalPages,
// //         hasPreviousPage: page > 1
// //       }
// //     });
// //   } catch (error) {
// //     if (error instanceof sql.RequestError) {
// //       console.error('SQL error while listing pickup records', error);
// //     }
// //     console.error('Server error while listing pickup records', error);
// //     return res.status(500).json({ error: 'Failed to fetch pickup list' });
// //   }
// // });

// // Handles both:
// // GET /pickup/list              → all records
// // GET /pickup/list/550300       → filtered by store number

// router.get('/:storeNumber?', async (req, res) => {
//   const page = parsePositiveInt(req.query.page, DEFAULT_PAGE)
//   const requestedPageSize = parsePositiveInt(
//     req.query.pageSize,
//     DEFAULT_PAGE_SIZE
//   )

//   if (!page || !requestedPageSize) {
//     return res
//       .status(400)
//       .json({ error: 'page and pageSize must be positive integers' })
//   }

//   const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE)
//   const offset = (page - 1) * pageSize

//   // Pull storeNumber from URL param (optional)
//   const storeNumber = req.params.storeNumber?.trim() || null

//   try {
//     const pool = await poolPromise

//     const conditions = []

//     if (storeNumber) {
//       conditions.push('StoreNumber = @storeNumber')
//     }

//     conditions.push('CreatedAt >= DATEADD(DAY, -60, GETUTCDATE())')

//     const whereClause = `WHERE ${conditions.join(' AND ')}`

//     const [rowsResult, countResult] = await Promise.all([
//       pool
//         .request()
//         .input('offset', sql.Int, offset)
//         .input('pageSize', sql.Int, pageSize)
//         .input('storeNumber', sql.VarChar, storeNumber).query(`
//           SELECT
//             EntryNumber,
//             InvoiceNumber,
//             StoreNumber,
//             EmployeeID,
//             CreatedAt
//           FROM PickUpConfirmationInfo
//           ${whereClause}
//           ORDER BY CreatedAt DESC, EntryNumber DESC
//           OFFSET @offset ROWS
//           FETCH NEXT @pageSize ROWS ONLY
//         `),
//       pool
//         .request()
//         .input('storeNumber', sql.VarChar, storeNumber)
//         .query(
//           `SELECT COUNT(1) AS TotalCount FROM PickUpConfirmationInfo ${whereClause}`
//         )
//     ])

//     const host = `${req.protocol}://${req.get('host')}`

//     const items = rowsResult.recordset.map(row => ({
//       entryNumber: row.EntryNumber,
//       invoiceNumber: row.InvoiceNumber,
//       storeNumber: row.StoreNumber,
//       employeeID: row.EmployeeID,
//       createdAt: row.CreatedAt,
//       videoUrl: `${host}/video/${encodeURIComponent(row.InvoiceNumber)}`
//     }))

//     const total = countResult.recordset[0]?.TotalCount || 0
//     const totalPages = Math.ceil(total / pageSize)

//     return res.status(200).json({
//       items,
//       filters: {
//         storeNumber: storeNumber || null
//       },
//       pagination: {
//         page,
//         pageSize,
//         total,
//         totalPages,
//         hasNextPage: page < totalPages,
//         hasPreviousPage: page > 1
//       }
//     })
//   } catch (error) {
//     console.error('Server error while listing pickup records', error)
//     return res.status(500).json({ error: 'Failed to fetch pickup list' })
//   }
// })

// module.exports = router






// routes/pickup.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs old version:
//
//   Route: GET /pickup/:storeNumber?  →  GET /pickup
//     The old route accepted an optional storeNumber URL param, meaning any
//     authenticated vendor could query any store's data.
//     The new route removes the URL param entirely — storeNumber is always
//     taken from req.user.storeNumber (the JWT claim set at login).
//     A vendor can only ever see their own store's records.
//
//   New route: GET /pickup/:entryNumber
//     Fetches a single record by EntryNumber, also scoped to req.user.storeNumber.
//
//   New columns returned: ShelfLocation, VideoName, emailed
//     (newly added to the SELECT — were not in the old response).
//
//   videoUrl replaced by videoTokenEndpoint
//     OLD: videoUrl: `${host}/video/${invoiceNumber}`  (direct, usable as <video src>)
//     NEW: videoTokenEndpoint: `${host}/auth/video-token`  (reference only)
//     The Wix frontend must POST to /auth/video-token to get a real video URL.
//
//   The filters:{} key is removed from the response — storeNumber is now
//   a top-level field in the response body instead.
//
//   All pagination logic is IDENTICAL to the old version.
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

// ─── GET /pickup ──────────────────────────────────────────────────────────
// Returns paginated records scoped to the authenticated vendor's store.
// storeNumber is taken from the JWT — the vendor cannot supply their own.
router.get('/', async (req, res) => {
  const page             = parsePositiveInt(req.query.page, DEFAULT_PAGE);
  const requestedSize    = parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE);

  if (!page || !requestedSize) {
    return res.status(400).json({ error: 'page and pageSize must be positive integers' });
  }

  const pageSize    = Math.min(requestedSize, MAX_PAGE_SIZE);
  const offset      = (page - 1) * pageSize;
  const storeNumber = req.user.storeNumber; // always from JWT, never from URL

  try {
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
      // Call POST /auth/video-token with invoiceNumber to get a playable URL.
      // Direct /video/:invoiceNumber links no longer work without a ?vt= token.
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

// ─── GET /pickup/:entryNumber  (NEW) ─────────────────────────────────────
// Fetch a single record by EntryNumber, scoped to the vendor's store.
router.get('/:entryNumber', async (req, res) => {
  const entryNumber = Number.parseInt(req.params.entryNumber, 10);
  if (Number.isNaN(entryNumber)) {
    return res.status(400).json({ error: 'Invalid entryNumber.' });
  }

  const storeNumber = req.user.storeNumber;

  try {
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