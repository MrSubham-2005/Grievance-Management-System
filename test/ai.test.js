const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const pool = require('../server/db');
const studentRouter = require('../server/routes/student');
const {
  analyzeComplaint,
  CATEGORIES,
  normalizeCategory,
  findSimilarComplaintFallback,
} = require('../server/ai');

function readDropdownCategories() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'raise_complaint.html'),
    'utf8'
  );
  const selectMatch = html.match(/<select[^>]*id="category"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(selectMatch, 'Category select element must exist');
  return [...selectMatch[1].matchAll(/<option(?:\s+[^>]*)?>([^<]+)<\/option>/g)]
    .map((m) => m[1].replace(/&amp;/g, '&').trim())
    .filter((label) => label !== '-- Select Category --');
}

test('CATEGORIES matches the exact 26 options in raise_complaint.html', () => {
  const htmlCategories = readDropdownCategories();
  assert.equal(CATEGORIES.length, 26);
  assert.deepEqual(CATEGORIES, htmlCategories);
  assert.equal(CATEGORIES.includes('Infrastructure'), false);
  assert.equal(CATEGORIES.includes('Examinations'), false);
  assert.equal(CATEGORIES.includes('Other'), false);
});

test('normalizeCategory validates strictly against the 26 allowed categories', () => {
  assert.equal(normalizeCategory('IT & Network Support'), 'IT & Network Support');
  assert.equal(normalizeCategory('  computer lab '), 'Computer Lab');
  assert.equal(normalizeCategory('Infrastructure'), '');
  assert.equal(normalizeCategory('Other'), '');
  assert.equal(normalizeCategory(''), '');
  assert.equal(normalizeCategory(null), '');
});

test('analyzeComplaint does not force a category when description is empty or insufficient', async () => {
  const empty = await analyzeComplaint('', []);
  assert.deepEqual(empty.issues, []);
  const short = await analyzeComplaint('abc', []);
  assert.deepEqual(short.issues, []);
});

test('analyzeComplaint filters invalid categories and preserves valid ones', async () => {
  const savedFetch = global.fetch;
  const savedKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              spam: false,
              spamReason: '',
              issues: [
                { text: 'bad cat', category: 'Infrastructure', priority: 'High', reason: 'test' },
                { text: 'wifi down', category: 'IT & Network Support', priority: 'High', reason: 'blocks study' },
              ],
              duplicateOf: '',
              duplicateReason: '',
              verdict: 'WiFi needs IT support.',
            }),
          }],
        },
      }],
    }),
  });
  try {
    const res = await analyzeComplaint('WiFi is not working in computer lab', []);
    assert.equal(res.issues.length, 1);
    assert.equal(res.issues[0].category, 'IT & Network Support');
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
  }
});

test('analyzeComplaint returns similarity score for semantic duplicates', async () => {
  const savedFetch = global.fetch;
  const savedKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              spam: false,
              spamReason: '',
              issues: [
                { text: 'Water pipe leaking', category: 'Plumbing', priority: 'High', reason: 'leak' },
              ],
              duplicateOf: 'CMP-0042',
              duplicateReason: 'Both complaints describe water leakage in the washroom.',
              similarity: 92,
              verdict: 'Similar open plumbing complaint found.',
            }),
          }],
        },
      }],
    }),
  });
  try {
    const res = await analyzeComplaint('Water leaking continuously in 2nd floor bathroom', [
      { complaint_id: 'CMP-0042', category: 'Plumbing', description: 'Leaking water pipe in washroom' },
    ]);
    assert.equal(res.duplicateOf, 'CMP-0042');
    assert.equal(res.similarity, 92);
    assert.equal(res.duplicateReason, 'Both complaints describe water leakage in the washroom.');
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
  }
});

test('findSimilarComplaintFallback detects semantically similar complaints without false positives', () => {
  const open = [
    { complaint_id: 'CMP-0001', category: 'Plumbing', description: 'Water pipe is leaking in the washroom' },
    { complaint_id: 'CMP-0002', category: 'IT & Network Support', description: 'Wi-Fi connection down in computer lab' },
    { complaint_id: 'CMP-0003', category: 'Hostel', description: 'Broken room door lock in hostel' },
    { complaint_id: 'CMP-0004', category: 'Accounts', description: 'Tuition fee payment receipt not generated' },
  ];

  // 1. Semantic duplicate for plumbing (water/leak/washroom phrasing differences)
  const plumbMatch = findSimilarComplaintFallback(
    'Heavy water leakage from bathroom tap on 2nd floor',
    open,
    'Plumbing'
  );
  assert.ok(plumbMatch);
  assert.equal(plumbMatch.complaintId, 'CMP-0001');
  assert.ok(plumbMatch.similarity >= 70 && plumbMatch.similarity <= 100);
  assert.ok(plumbMatch.reason.length > 0);

  // 2. Semantic duplicate for network (internet vs wifi)
  const netMatch = findSimilarComplaintFallback(
    'Internet is not working in the lab',
    open,
    'IT & Network Support'
  );
  assert.ok(netMatch);
  assert.equal(netMatch.complaintId, 'CMP-0002');
  assert.ok(netMatch.similarity >= 70 && netMatch.similarity <= 100);

  // 3. Completely unrelated complaints must return null (no false positive)
  const unrelatedFood = findSimilarComplaintFallback(
    'Cafeteria food is cold and unhygienic',
    open,
    'Cafeteria'
  );
  assert.equal(unrelatedFood, null);

  const unrelatedExam = findSimilarComplaintFallback(
    'Exam hall ticket date discrepancy',
    open,
    'Examination Cell'
  );
  assert.equal(unrelatedExam, null);

  // 4. Different problems sharing a location token should not be marked duplicate
  const crossLocation = findSimilarComplaintFallback(
    'Light not working in hostel room',
    open,
    'Electrical Maintenance'
  );
  assert.equal(crossLocation, null);
});

test('view_complaint_status.html has plain text Complaint ID, no timeline panel, no openTimeline function, and no overdue badge', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'view_complaint_status.html'),
    'utf8'
  );
  assert.doesNotMatch(html, /id="timelinePanel"/);
  assert.doesNotMatch(html, /openTimeline/);
  assert.doesNotMatch(html, /class="[^"]*timeline-open[^"]*"/);
  assert.doesNotMatch(html, /\/api\/student\/complaints\/\$\{id\}\/timeline/);
  assert.doesNotMatch(html, /badge-overdue/);
  assert.doesNotMatch(html, />\s*Overdue\s*</);
  assert.match(html, /<td>\$\{displayId\}<\/td>/);
});

test('POST /api/student/check-duplicate returns duplicate details or false without erroring', async () => {
  const savedKey = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;

  const origQuery = pool.query;
  const mockComplaints = [
    { complaint_id: 'CMP-0010', category: 'Plumbing', description: 'Water tap leaking continuously in 2nd floor bathroom', status: 'Pending' },
  ];

  pool.query = async (sql, params = []) => {
    if (sql.includes("WHERE status <> 'Resolved'")) {
      return { rows: mockComplaints };
    }
    if (sql.includes('FROM public.complaint c') && sql.includes('AS reported_by')) {
      const match = mockComplaints.find((c) => c.complaint_id === params[0]);
      if (!match) return { rows: [] };
      return {
        rows: [{
          ...match,
          reported_by: 2,
        }],
      };
    }
    return origQuery.call(pool, sql, params);
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.session = { student: { id: 'STU-0001' } };
    next();
  });
  app.use('/api/student', studentRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Description < 10 characters -> 400
    const shortRes = await fetch(`${baseUrl}/api/student/check-duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'short' }),
    });
    assert.equal(shortRes.status, 400);

    // 2. Semantically similar complaint found via fallback -> duplicate: true with full structure
    const dupRes = await fetch(`${baseUrl}/api/student/check-duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'category=Plumbing&description=' + encodeURIComponent('Water pipe leak and dripping tap in washroom'),
    });
    assert.equal(dupRes.status, 200);
    const dupBody = await dupRes.json();
    assert.equal(dupBody.duplicate, true);
    assert.equal(dupBody.complaintId, 'CMP-0010');
    assert.ok(dupBody.similarity >= 70 && dupBody.similarity <= 100);
    assert.equal(dupBody.category, 'Plumbing');
    assert.equal(dupBody.description, 'Water tap leaking continuously in 2nd floor bathroom');
    assert.equal(dupBody.reportedBy, 2);
    assert.equal(dupBody.status, 'Pending');
    assert.ok(typeof dupBody.reason === 'string' && dupBody.reason.length > 0);

    // 3. Unrelated complaint -> duplicate: false
    const noDupRes = await fetch(`${baseUrl}/api/student/check-duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'Cafeteria',
        description: 'Canteen food serving is cold and unhygienic',
      }),
    });
    assert.equal(noDupRes.status, 200);
    const noDupBody = await noDupRes.json();
    assert.deepEqual(noDupBody, { duplicate: false });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    pool.query = origQuery;
    if (savedKey !== undefined) process.env.AI_API_KEY = savedKey;
  }
});
