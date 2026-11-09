// Shared PostgreSQL pool. Reads DATABASE_URL from the environment (.env locally).
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: { rejectUnauthorized: true },
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err.message);
});

module.exports = pool;
