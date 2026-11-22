// Shared PostgreSQL pool. Reads DATABASE_URL (or TEST_DATABASE_URL in test mode) from environment.
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const isTest = process.env.NODE_ENV === 'test';

let connectionString;
if (isTest) {
  const testUrl = process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL.trim();
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is required when NODE_ENV=test. Silent fallback to DATABASE_URL is disabled.');
  }
  connectionString = testUrl;
} else {
  connectionString = process.env.DATABASE_URL;
}

const pool = new Pool({
  connectionString,
  max: 10,
  ssl: { rejectUnauthorized: true },
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err.message);
});

module.exports = pool;
