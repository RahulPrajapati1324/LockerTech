const express = require('express')
const { poolPromise, sql } = require('../db')

const router = express.Router()

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

function parsePositiveInt (value, fallback) {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return null
  return parsed
}

// router.get('/list', async (req, res) => {
//   const page = parsePositiveInt(req.query.page, DEFAULT_PAGE);
//   const requestedPageSize = parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE);

//   if (!page || !requestedPageSize) {
//     return res.status(400).json({ error: 'page and pageSize must be positive integers' });
//   }

//   const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
//   const offset = (page - 1) * pageSize;

//   try {
//     const pool = await poolPromise;

//     const [rowsResult, countResult] = await Promise.all([
//       pool
//         .request()
//         .input('offset', sql.Int, offset)
//         .input('pageSize', sql.Int, pageSize)
//         .query(`
//           SELECT
//             EntryNumber,
//             InvoiceNumber,
//             StoreNumber,
//             EmployeeID,
//             CreatedAt
//           FROM PickUpConfirmationInfo
//           ORDER BY CreatedAt DESC, EntryNumber DESC
//           OFFSET @offset ROWS
//           FETCH NEXT @pageSize ROWS ONLY
//         `),
//       pool.request().query('SELECT COUNT(1) AS TotalCount FROM PickUpConfirmationInfo')
//     ]);

//     const host = `${req.protocol}://${req.get('host')}`;

//     const items = rowsResult.recordset.map((row) => ({
//       entryNumber: row.EntryNumber,
//       invoiceNumber: row.InvoiceNumber,
//       storeNumber: row.StoreNumber,
//       employeeID: row.EmployeeID,
//       createdAt: row.CreatedAt,
//       // Frontend can directly bind this URL to <video src="...">.
//       videoUrl: `${host}/video/${encodeURIComponent(row.InvoiceNumber)}`
//     }));

//     const total = countResult.recordset[0]?.TotalCount || 0;
//     const totalPages = Math.ceil(total / pageSize);

//     return res.status(200).json({
//       items,
//       pagination: {
//         page,
//         pageSize,
//         total,
//         totalPages,
//         hasNextPage: page < totalPages,
//         hasPreviousPage: page > 1
//       }
//     });
//   } catch (error) {
//     if (error instanceof sql.RequestError) {
//       console.error('SQL error while listing pickup records', error);
//     }
//     console.error('Server error while listing pickup records', error);
//     return res.status(500).json({ error: 'Failed to fetch pickup list' });
//   }
// });

// Handles both:
// GET /pickup/list              → all records
// GET /pickup/list/550300       → filtered by store number

router.get('/:storeNumber?', async (req, res) => {
  const page = parsePositiveInt(req.query.page, DEFAULT_PAGE)
  const requestedPageSize = parsePositiveInt(
    req.query.pageSize,
    DEFAULT_PAGE_SIZE
  )

  if (!page || !requestedPageSize) {
    return res
      .status(400)
      .json({ error: 'page and pageSize must be positive integers' })
  }

  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE)
  const offset = (page - 1) * pageSize

  // Pull storeNumber from URL param (optional)
  const storeNumber = req.params.storeNumber?.trim() || null

  try {
    const pool = await poolPromise

    const conditions = []

    if (storeNumber) {
      conditions.push('StoreNumber = @storeNumber')
    }

    conditions.push('CreatedAt >= DATEADD(DAY, -60, GETUTCDATE())')

    const whereClause = `WHERE ${conditions.join(' AND ')}`

    const [rowsResult, countResult] = await Promise.all([
      pool
        .request()
        .input('offset', sql.Int, offset)
        .input('pageSize', sql.Int, pageSize)
        .input('storeNumber', sql.VarChar, storeNumber).query(`
          SELECT
            EntryNumber,
            InvoiceNumber,
            StoreNumber,
            EmployeeID,
            CreatedAt
          FROM PickUpConfirmationInfo
          ${whereClause}
          ORDER BY CreatedAt DESC, EntryNumber DESC
          OFFSET @offset ROWS
          FETCH NEXT @pageSize ROWS ONLY
        `),
      pool
        .request()
        .input('storeNumber', sql.VarChar, storeNumber)
        .query(
          `SELECT COUNT(1) AS TotalCount FROM PickUpConfirmationInfo ${whereClause}`
        )
    ])

    const host = `${req.protocol}://${req.get('host')}`

    const items = rowsResult.recordset.map(row => ({
      entryNumber: row.EntryNumber,
      invoiceNumber: row.InvoiceNumber,
      storeNumber: row.StoreNumber,
      employeeID: row.EmployeeID,
      createdAt: row.CreatedAt,
      videoUrl: `${host}/video/${encodeURIComponent(row.InvoiceNumber)}`
    }))

    const total = countResult.recordset[0]?.TotalCount || 0
    const totalPages = Math.ceil(total / pageSize)

    return res.status(200).json({
      items,
      filters: {
        storeNumber: storeNumber || null
      },
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    })
  } catch (error) {
    console.error('Server error while listing pickup records', error)
    return res.status(500).json({ error: 'Failed to fetch pickup list' })
  }
})

module.exports = router
