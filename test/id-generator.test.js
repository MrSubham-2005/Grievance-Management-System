const test = require('node:test');
const assert = require('node:assert/strict');
const { nextId, withIdLock } = require('../server/id-generator');

test('nextId starts at 0001 with hyphen for empty student, staff, complaint, and admin tables', async () => {
  const emptyDb = { async query() { return { rows: [{ n: 0 }] }; } };
  assert.equal(await nextId('student', 'student_id', 'STU', emptyDb), 'STU-0001');
  assert.equal(await nextId('staff', 'staff_id', 'STF', emptyDb), 'STF-0001');
  assert.equal(await nextId('complaint', 'complaint_id', 'CMP', emptyDb), 'CMP-0001');
  assert.equal(await nextId('admin', 'admin_id', 'ADM', emptyDb), 'ADM-0001');
});

test('nextId handles negative/zero max safely and increments legacy/hyphenated IDs monotonically', async () => {
  const negDb = { async query() { return { rows: [{ n: -1 }] }; } };
  assert.equal(await nextId('staff', 'staff_id', 'STF', negDb), 'STF-0001');

  const populatedDb = {
    async query(sql, params) {
      assert.match(sql, /FROM staff/);
      assert.deepEqual(params, ['^STF-?[0-9]+$']);
      return { rows: [{ n: 33 }] };
    },
  };
  assert.equal(await nextId('staff', 'staff_id', 'STF', populatedDb), 'STF-0034');
});

test('nextId rejects unsupported table/column combinations', async () => {
  await assert.rejects(() => nextId('student', 'admin_id', 'STU'), /Unsupported ID target/);
});

test('withIdLock executes advisory transaction lock and commits on success / rolls back on failure', async () => {
  const calls = [];
  const makePool = () => ({
    async connect() {
      return {
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows: [] };
        },
        release() {
          calls.push({ released: true });
        },
      };
    },
  });

  const val = await withIdLock(makePool(false), 'student', async (client) => {
    await client.query('INSERT INTO student ...');
    return 'STU-0001';
  });
  assert.equal(val, 'STU-0001');
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[1].params, ['gms-id:student']);
  assert.equal(calls[3].sql, 'COMMIT');
  assert.equal(calls[4].released, true);

  calls.length = 0;
  await assert.rejects(
    () => withIdLock(makePool(true), 'staff', async () => { throw new Error('boom'); }),
    /boom/
  );
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls[2].sql, 'ROLLBACK');
  assert.equal(calls[3].released, true);
});
