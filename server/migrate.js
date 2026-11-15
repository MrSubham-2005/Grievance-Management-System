// Idempotent transactional migration for standardized hyphenated IDs,
// ON UPDATE CASCADE foreign keys, and assignment/approval audit columns.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const pool = require('./db');
const { nextId } = require('./id-generator');

const FK_UPGRADES = [
  ['complaint', 'complaint_student_id_fkey', 'FOREIGN KEY (student_id) REFERENCES student(student_id) ON UPDATE CASCADE'],
  ['complaint', 'complaint_assigned_staff_id_fkey', 'FOREIGN KEY (assigned_staff_id) REFERENCES staff(staff_id) ON UPDATE CASCADE'],
  ['complaint_member', 'complaint_member_complaint_id_fkey', 'FOREIGN KEY (complaint_id) REFERENCES complaint(complaint_id) ON UPDATE CASCADE ON DELETE CASCADE'],
  ['complaint_member', 'complaint_member_student_id_fkey', 'FOREIGN KEY (student_id) REFERENCES student(student_id) ON UPDATE CASCADE'],
  ['complaint_event', 'complaint_event_complaint_id_fkey', 'FOREIGN KEY (complaint_id) REFERENCES complaint(complaint_id) ON UPDATE CASCADE ON DELETE CASCADE'],
  ['feedback', 'feedback_complaint_id_fkey', 'FOREIGN KEY (complaint_id) REFERENCES complaint(complaint_id) ON UPDATE CASCADE'],
  ['feedback', 'feedback_student_id_fkey', 'FOREIGN KEY (student_id) REFERENCES student(student_id) ON UPDATE CASCADE'],
  ['feedback', 'feedback_staff_id_fkey', 'FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON UPDATE CASCADE'],
];

const ID_TARGETS = [
  { table: 'admin', column: 'admin_id', prefix: 'ADM', sessionKey: 'admin' },
  { table: 'student', column: 'student_id', prefix: 'STU', sessionKey: 'student' },
  { table: 'staff', column: 'staff_id', prefix: 'STF', sessionKey: 'staff' },
  { table: 'complaint', column: 'complaint_id', prefix: 'CMP', sessionKey: null },
];

async function updateSessions(client, role, oldId, newId) {
  if (!role) return;
  const { rows } = await client.query('SELECT sid, sess FROM session');
  for (const row of rows) {
    if (row.sess && row.sess[role] && row.sess[role].id === oldId) {
      const updated = { ...row.sess, [role]: { ...row.sess[role], id: newId } };
      await client.query('UPDATE session SET sess = $1 WHERE sid = $2', [updated, row.sid]);
    }
  }
}

async function migrate(dbPool = pool) {
  const client = await dbPool.connect();
  const migrated = [];
  try {
    await client.query('BEGIN');

    // Ensure new metadata columns and ON UPDATE CASCADE definitions exist.
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schemaSql);

    // Simplify staff table to use created_by and created_at as the single source of truth.
    await client.query('ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_approved_by_fkey');
    await client.query('ALTER TABLE staff DROP COLUMN IF EXISTS approved_by');
    await client.query('ALTER TABLE staff DROP COLUMN IF EXISTS approved_at');

    // Clean any duplicate or owner complaint_member rows and guarantee uniqueness on (complaint_id, student_id).
    await client.query(`
      DELETE FROM public.complaint_member a
      USING public.complaint_member b
      WHERE a.ctid < b.ctid
        AND a.complaint_id = b.complaint_id
        AND a.student_id = b.student_id
    `);
    await client.query(`
      DELETE FROM public.complaint_member cm
      USING public.complaint c
      WHERE cm.complaint_id = c.complaint_id
        AND cm.student_id = c.student_id
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_index i
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public'
            AND t.relname = 'complaint_member'
            AND i.indisunique
            AND (
              SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
            ) = ARRAY['complaint_id', 'student_id']
        ) THEN
          CREATE UNIQUE INDEX uq_complaint_member_complaint_student
            ON public.complaint_member (complaint_id, student_id);
        END IF;
      END $$;
    `);

    for (const [table, constraint, clause] of FK_UPGRADES) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
      await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${clause}`);
    }

    // Backfill complaint assignment metadata only where an actual admin 'assigned' event exists.
    await client.query(`
      UPDATE complaint c
      SET assigned_by = e.actor,
          assigned_at = e.created_at
      FROM (
        SELECT DISTINCT ON (ce.complaint_id) ce.complaint_id, ce.actor, ce.created_at
        FROM complaint_event ce
        JOIN admin a ON a.admin_id = ce.actor
        WHERE ce.kind = 'assigned'
        ORDER BY ce.complaint_id, ce.created_at DESC, ce.event_id DESC
      ) e
      WHERE c.complaint_id = e.complaint_id
        AND c.assigned_staff_id IS NOT NULL
        AND c.assigned_by IS NULL
    `);

    // Migrate non-hyphenated or zero-suffixed IDs safely inside the transaction.
    for (const { table, column, prefix, sessionKey } of ID_TARGETS) {
      const pattern = `^${prefix}-[0-9]{4,}$`;
      const zeroPattern = `^${prefix}-?0+$`;
      const { rows } = await client.query(
        `SELECT ${column} AS id
         FROM ${table}
         WHERE ${column} !~ $1 OR ${column} ~ $2
         ORDER BY created_at ASC, ${column} ASC`,
        [pattern, zeroPattern]
      );

      for (const row of rows) {
        const oldId = row.id;
        const match = String(oldId).match(new RegExp(`^${prefix}-?(\\d+)$`, 'i'));
        const num = match ? parseInt(match[1], 10) : 0;
        let newId = num >= 1 ? `${prefix}-${String(num).padStart(4, '0')}` : null;

        if (newId) {
          const conflict = await client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [newId]);
          if (conflict.rowCount) newId = null;
        }
        if (!newId) {
          newId = await nextId(table, column, prefix, client);
        }

        await client.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [newId, oldId]);
        await client.query('UPDATE complaint_event SET actor = $1 WHERE actor = $2', [newId, oldId]);
        if (table === 'admin') {
          await client.query('UPDATE staff SET created_by = $1 WHERE created_by = $2', [newId, oldId]);
        }
        await updateSessions(client, sessionKey, oldId, newId);
        migrated.push({ table, oldId, newId });
      }
    }

    await client.query('COMMIT');
    return migrated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(async (migrated) => {
      console.log('Migration complete:', JSON.stringify(migrated));
      await pool.end();
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrate };
