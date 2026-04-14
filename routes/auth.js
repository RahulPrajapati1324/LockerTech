const express = require('express')
const jwt = require('jsonwebtoken')
const { poolPromise, sql } = require('../db')

const router = express.Router()

router.post('/login', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }

  try {
    const pool = await poolPromise

    const result = await pool
      .request()
      .input('username', sql.VarChar, username.trim())
      .input('password', sql.VarChar, password)
      .query(`
        SELECT Username, StoreNumber
        FROM Vendors
        WHERE Username = @username AND Password = @password
      `)

    const vendor = result.recordset[0]

    if (!vendor) {
      return res.status(401).json({ error: 'Invalid username or password' })
    }

    const token = jwt.sign(
      { 
        username: vendor.Username,
        storeNumber: vendor.StoreNumber   // 👈 added to token
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )

    return res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        username: vendor.Username,
        storeNumber: vendor.StoreNumber   // 👈 added to response
      }
    })

  } catch (error) {
    console.error('Login error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router