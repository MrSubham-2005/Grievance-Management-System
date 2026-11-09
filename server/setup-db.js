// Creates the schema and a one-time admin signup code on the configured database.
// Run: npm run setup-db. Safe to re-run: the code is only generated if none exists.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to the .env file.');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);

    const existing = await pool.query('SELECT 1 FROM admin_secret WHERE id = 1');
    if (existing.rowCount === 0) {
      const code = crypto.randomBytes(9).toString('base64url');
      const hash = await bcrypt.hash(code, 10);
      await pool.query('INSERT INTO admin_secret (id, secret_code) VALUES (1, $1)', [hash]);
      console.log('Admin signup code (shown once, save it now):');
      console.log(code);
    } else {
      console.log('Schema is ready. Admin signup code already exists.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Database setup failed:', err.message);
  process.exit(1);
});
