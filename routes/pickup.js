// routes/pickup.js

'use strict'

const express = require('express')
const { poolPromise, sql } = require('../db')

const router = express.Router()

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const DEFAULT_DAYS = 60

function parsePositiveInt (value, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isNaN(n) || n <= 0 ? null : n
}

// ─── Helper: fetch storeNumber from DB by username ────────────────────────
async function getStoreNumber (username) {
  const pool = await poolPromise
  const result = await pool
    .request()
    .input('username', sql.VarChar(100), username).query(`
      SELECT StoreNumber
      FROM   Vendors
      WHERE  Username = @username
    `)
  return result.recordset[0]?.StoreNumber ?? null
}

// ─── Helper: parse & validate the `days` query param ─────────────────────
function parseDays (rawDays) {
  if (rawDays === undefined || rawDays === null) {
    return { days: DEFAULT_DAYS, error: null }
  }

  const n = Number.parseInt(rawDays, 10)

  if (Number.isNaN(n) || n <= 0) {
    return {
      days: null,
      error: "'days' must be a positive integer (e.g. 30, 60, 90)"
    }
  }

  return { days: n, error: null }
}

// ─── GET /pickup ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const page = parsePositiveInt(req.query.page, DEFAULT_PAGE)
  const requestedSize = parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE)

  if (!page || !requestedSize) {
    return res
      .status(400)
      .json({ error: 'page and pageSize must be positive integers' })
  }

  const { days, error: daysError } = parseDays(req.query.days)
  if (daysError) {
    return res.status(400).json({ error: daysError })
  }

  const pageSize = Math.min(requestedSize, MAX_PAGE_SIZE)
  const offset = (page - 1) * pageSize

  try {
    const storeNumber = await getStoreNumber(req.user.username)
    if (!storeNumber) {
      return res.status(403).json({ error: 'Vendor not found.' })
    }

    const pool = await poolPromise

    const [rowsResult, countResult] = await Promise.all([
      pool
        .request()
        .input('storeNumber', sql.VarChar(20), storeNumber)
        .input('days', sql.Int, days)
        .input('offset', sql.Int, offset)
        .input('pageSize', sql.Int, pageSize).query(`
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
            AND CreatedAt  >= DATEADD(DAY, -@days, GETUTCDATE())
          ORDER BY CreatedAt DESC, EntryNumber DESC
          OFFSET @offset ROWS
          FETCH NEXT @pageSize ROWS ONLY
        `),

      pool
        .request()
        .input('storeNumber', sql.VarChar(20), storeNumber)
        .input('days', sql.Int, days).query(`
          SELECT COUNT(1) AS TotalCount
          FROM   PickUpConfirmationInfo
          WHERE  StoreNumber = @storeNumber
            AND  CreatedAt  >= DATEADD(DAY, -@days, GETUTCDATE())
        `)
    ])

    const host =
      process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`
    const items = rowsResult.recordset.map(row => ({
      entryNumber: row.EntryNumber,
      invoiceNumber: row.InvoiceNumber,
      storeNumber: row.StoreNumber,
      employeeID: row.EmployeeID,
      shelfLocation: row.ShelfLocation,
      videoName: row.VideoName,
      emailed: row.emailed,
      createdAt: row.CreatedAt,
      videoTokenEndpoint: `${host}/auth/video-token`
    }))

    const total = countResult.recordset[0]?.TotalCount || 0
    const totalPages = Math.ceil(total / pageSize)

    return res.status(200).json({
      storeNumber,
      filter: { days },
      items,
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
