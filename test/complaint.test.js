const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatComplaintId,
  complaintIdCandidates,
  resolveComplaintId,
  nextComplaintId,
} = require('../server/complaint-id');

test('formatComplaintId normalizes old and hyphenated IDs to CMP-0001 format', () => {
  assert.equal(formatComplaintId('CMP0001'), 'CMP-0001');
  assert.equal(formatComplaintId('CMP-0001'), 'CMP-0001');
  assert.equal(formatComplaintId('CMP0053'), 'CMP-0053');
  assert.equal(formatComplaintId('CMP-0053'), 'CMP-0053');
  assert.equal(formatComplaintId('cmp12'), 'CMP-0012');
  assert.equal(formatComplaintId('CMP10000'), 'CMP-10000');
  assert.equal(formatComplaintId(''), '');
});

test('complaintIdCandidates builds both hyphenated and legacy ID variants', () => {
  assert.deepEqual(complaintIdCandidates('CMP-0001'), ['CMP-0001', 'CMP0001']);
  assert.deepEqual(complaintIdCandidates('CMP0053'), ['CMP0053', 'CMP-0053']);
  assert.deepEqual(complaintIdCandidates('CMP-1'), ['CMP-1', 'CMP-0001', 'CMP0001', 'CMP1']);
  assert.deepEqual(complaintIdCandidates(''), []);
});

test('resolveComplaintId returns the stored DB primary key without altering it', async () => {
  const seen = [];
  const fakeDb = {
    async query(sql, params) {
      seen.push({ sql, params });
      return { rows: [{ complaint_id: 'CMP0001' }] };
    },
  };
  const resolved = await resolveComplaintId(fakeDb, 'CMP-0001');
  assert.equal(resolved, 'CMP0001');
  assert.ok(seen[0].params[0].includes('CMP0001'));
  assert.ok(seen[0].params[0].includes('CMP-0001'));
});

test('nextComplaintId generates hyphenated CMP-0004 after legacy CMP0003', async () => {
  const fakeDb = {
    async query() {
      return { rows: [{ n: 3 }] };
    },
  };
  const next = await nextComplaintId(fakeDb);
  assert.equal(next, 'CMP-0004');
});
