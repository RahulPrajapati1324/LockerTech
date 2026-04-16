// scripts/migrate-passwords.js
// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Run ONCE after STEP_1_run_in_SSMS.sql has been executed.
//
// What it does:
//   Reads every row in Vendors, hashes the plain-text password with bcrypt,
//   and writes the hash back. Rows already hashed (start with "$2b$" or "$2a$")
//   are skipped safely — so this script is safe to re-run.
//
// Usage:
//   node scripts/migrate-passwords.js
//
// After it completes, every Vendor.Password will start with "$2b$12$..."
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const bcrypt = require('bcryptjs');
const sql    = require('mssql');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;

const config = {
  server:   process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port:     Number(process.env.DB_PORT) || 1433,
  options: {
    encrypt:                process.env.DB_ENCRYPT !== 'false',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true',
  },
};

async function migrate() {
  console.log('Connecting to database…');
  const pool = await new sql.ConnectionPool(config).connect();

  try {
    const { recordset: vendors } = await pool
      .request()
      .query('SELECT VendorID, Username, Password FROM Vendors');

    console.log(`Found ${vendors.length} vendor(s).`);

    let skipped = 0;
    let updated = 0;

    for (const vendor of vendors) {
      const pwd = vendor.Password ?? '';

      // Skip rows that are already bcrypt-hashed
      if (pwd.startsWith('$2b$') || pwd.startsWith('$2a$')) {
        console.log(`  [SKIP] ${vendor.Username} — already hashed`);
        skipped++;
        continue;
      }

      if (!pwd) {
        console.warn(`  [WARN] ${vendor.Username} — empty password, skipping`);
        skipped++;
        continue;
      }

      const hash = await bcrypt.hash(pwd, BCRYPT_ROUNDS);

      await pool
        .request()
        .input('hash',     sql.VarChar(72), hash)
        .input('vendorId', sql.Int,         vendor.VendorID)
        .query('UPDATE Vendors SET Password = @hash WHERE VendorID = @vendorId');

      console.log(`  [OK]   ${vendor.Username} — hashed`);
      updated++;
    }

    console.log(`\nMigration complete. Updated: ${updated}  Skipped: ${skipped}`);
  } finally {
    await pool.close();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});