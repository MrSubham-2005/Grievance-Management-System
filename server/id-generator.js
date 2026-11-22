// Centralized sequential ID allocation and transaction-level advisory locking
// so empty tables start at 0001, legacy/hyphenated IDs stay monotonic, and
// concurrent requests cannot produce duplicate primary keys.
const pool = require('./db');

const ALLOWED_TARGETS = {
  student: { column: 'student_id', prefix: 'STU', hyphen: true },
  staff: { column: 'staff_id', prefix: 'STF', hyphen: true },
  complaint: { column: 'complaint_id', prefix: 'CMP', hyphen: true },
  admin: { column: 'admin_id', prefix: 'ADM', hyphen: true },
  staff_request: { column: 'request_id', prefix: 'REQ', hyphen: true },
  feedback: { column: 'feedback_id', prefix: 'FB', hyphen: true },
};

const HYPHENATED_PREFIXES = new Set(['STU', 'STF', 'CMP', 'ADM', 'REQ', 'FB']);

async function nextId(table, column, prefix, db = pool) {
  const spec = ALLOWED_TARGETS[table];
  if (!spec || spec.column !== column || spec.prefix !== prefix) {
    throw new Error(`Unsupported ID target: ${table}.${column} (${prefix})`);
  }
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(${spec.column} FROM '([0-9]+)$') AS INTEGER)), 0) AS n
     FROM ${table}
     WHERE ${spec.column} ~ $1`,
    [`^${spec.prefix}-?[0-9]+$`]
  );
  const maxExisting = Number(rows[0] && rows[0].n) || 0;
  const nextNumber = Math.max(maxExisting, 0) + 1;
  const sep = HYPHENATED_PREFIXES.has(spec.prefix) ? '-' : '';
  return `${spec.prefix}${sep}${String(nextNumber).padStart(4, '0')}`;
}

async function withIdLock(dbPool, lockKey, callback) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gms-id:${lockKey}`]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { nextId, withIdLock, ALLOWED_TARGETS, HYPHENATED_PREFIXES };
