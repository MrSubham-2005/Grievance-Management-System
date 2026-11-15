const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const pool = require('../server/db');
const studentRouter = require('../server/routes/student');

function createStudentServer(getSession) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = getSession(req);
    next();
  });
  app.use('/api/student', studentRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createStatefulJoinDb(initialComplaints, initialMembers) {
  const complaints = new Map(initialComplaints.map((c) => [c.complaint_id, { ...c }]));
  const members = initialMembers.map((m) => ({ ...m }));
  let lockChain = Promise.resolve();
  let releaseLock = null;
  let timelineEvents = 0;

  const distinctNonOwnerCount = (complaintId) => {
    const comp = complaints.get(complaintId);
    if (!comp) return 0;
    return new Set(
      members
        .filter((m) => m.complaint_id === complaintId && m.student_id !== comp.student_id)
        .map((m) => m.student_id)
    ).size;
  };

  const handleQuery = async (sql, params = [], inTx = false) => {
    const trimmed = sql.trim();
    if (trimmed === 'BEGIN') {
      const prev = lockChain;
      let nextRelease;
      lockChain = new Promise((res) => {
        nextRelease = res;
      });
      await prev;
      releaseLock = nextRelease;
      return { rowCount: 0, rows: [] };
    }
    if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      if (releaseLock) {
        const rel = releaseLock;
        releaseLock = null;
        rel();
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('WHERE complaint_id = ANY')) {
      const found = params[0].find((id) => complaints.has(id));
      return { rows: found ? [{ complaint_id: found }] : [] };
    }
    if (sql.includes('FROM public.complaint') && sql.includes('FOR UPDATE')) {
      const c = complaints.get(params[0]);
      return c ? { rowCount: 1, rows: [{ ...c }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('AS already_joined FROM public.complaint_member')) {
      const count = members.filter((m) => m.complaint_id === params[0] && m.student_id === params[1]).length;
      return { rowCount: 1, rows: [{ already_joined: count }] };
    }
    if (sql.includes('INSERT INTO public.complaint_member')) {
      const [cid, sid] = params;
      if (members.some((m) => m.complaint_id === cid && m.student_id === sid)) {
        const err = new Error('duplicate key value violates unique constraint "complaint_member_pkey"');
        err.code = '23505';
        throw err;
      }
      members.push({ complaint_id: cid, student_id: sid });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('AS join_count')) {
      return { rowCount: 1, rows: [{ join_count: distinctNonOwnerCount(params[0]) }] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 0, rows: [] };
    if (sql.includes('SUBSTRING') && sql.includes('AS n')) {
      return { rowCount: 1, rows: [{ n: complaints.size }] };
    }
    if (sql.includes('INSERT INTO complaint (')) {
      const [complaint_id, student_id, category, description, priority] = params;
      complaints.set(complaint_id, { complaint_id, student_id, category, description, priority, status: 'Pending' });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('INSERT INTO complaint_event')) {
      timelineEvents += 1;
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('FROM public.complaint c') && sql.includes('AS reported_by')) {
      const [cid, sid] = params;
      const c = complaints.get(cid);
      if (!c) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [
          {
            ...c,
            reported_by: distinctNonOwnerCount(cid),
            already_joined: members.some((m) => m.complaint_id === cid && m.student_id === sid && m.student_id !== c.student_id),
          },
        ],
      };
    }
    throw new Error(`Unexpected query (${inTx ? 'tx' : 'pool'}): ${sql}`);
  };

  return {
    complaints,
    members,
    getTimelineEvents: () => timelineEvents,
    distinctNonOwnerCount,
    query: (sql, params) => handleQuery(sql, params, false),
    connect: async () => ({
      query: (sql, params) => handleQuery(sql, params, true),
      release: () => {
        if (releaseLock) {
          const rel = releaseLock;
          releaseLock = null;
          rel();
        }
      },
    }),
  };
}

test('Complaint join rules: single join, duplicate rejection, owner check before membership, concurrency, and multi-student joins', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const db = createStatefulJoinDb(
    [
      { complaint_id: 'CMP-0001', student_id: 'STU-0002', category: 'Hostel', description: 'Water tank leak on floor 2', status: 'Pending' },
      { complaint_id: 'CMP-0002', student_id: 'STU-0002', category: 'Hostel', description: 'Broken corridor lock', status: 'Assigned' },
    ],
    [
      // Simulate dirty legacy owner row inside complaint_member for CMP-0002 to prove owner check runs BEFORE membership check.
      { complaint_id: 'CMP-0002', student_id: 'STU-0002' },
    ]
  );
  pool.query = db.query;
  pool.connect = db.connect;

  try {
    const app = createStudentServer((req) => ({ student: { id: req.headers['x-student-id'] } }));
    await withServer(app, async (baseUrl) => {
      // 1. Student A (STU-0001) joins Student B's (STU-0002) complaint successfully
      const join1 = await fetch(`${baseUrl}/api/student/complaints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-student-id': 'STU-0001' },
        body: JSON.stringify({ joinComplaint: 'true', existingComplaintId: 'CMP-0001' }),
      });
      assert.equal(join1.status, 201);
      const join1Body = await join1.json();
      assert.equal(join1Body.joined, true);
      assert.equal(join1Body.reportedBy, 1);
      assert.equal(join1Body.message, 'You have successfully joined this complaint.');

      // 2. Student A tries to join the same complaint again -> 409, count stays 1
      const dupJoin = await fetch(`${baseUrl}/api/student/complaints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-student-id': 'STU-0001' },
        body: JSON.stringify({ joinComplaint: 'true', existingComplaintId: 'CMP-0001' }),
      });
      assert.equal(dupJoin.status, 409);
      const dupBody = await dupJoin.json();
      assert.equal(dupBody.error, 'You have already joined this complaint.');
      assert.equal(db.distinctNonOwnerCount('CMP-0001'), 1);

      // 3. Original owner tries to join own complaint (CMP-0001 and dirty CMP-0002) -> creator popup takes precedence
      for (const targetId of ['CMP-0001', 'CMP-0002']) {
        const ownerJoin = await fetch(`${baseUrl}/api/student/complaints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-student-id': 'STU-0002' },
          body: JSON.stringify({ joinComplaint: 'true', existingComplaintId: targetId }),
        });
        assert.equal(ownerJoin.status, 409);
        const ownerBody = await ownerJoin.json();
        assert.equal(ownerBody.error, 'You are the original creator of this complaint.');
      }
      assert.equal(db.members.filter((m) => m.complaint_id === 'CMP-0001' && m.student_id === 'STU-0002').length, 0);

      // 4. Two simultaneous join requests from Student C (STU-0003) create exactly one membership
      const [simA, simB] = await Promise.all([
        fetch(`${baseUrl}/api/student/complaints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-student-id': 'STU-0003' },
          body: JSON.stringify({ joinComplaint: 'true', existingComplaintId: 'CMP-0001' }),
        }),
        fetch(`${baseUrl}/api/student/complaints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-student-id': 'STU-0003' },
          body: JSON.stringify({ joinComplaint: 'true', existingComplaintId: 'CMP-0001' }),
        }),
      ]);
      const statuses = [simA.status, simB.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [201, 409]);
      const bodies = await Promise.all([simA.json(), simB.json()]);
      assert.ok(bodies.some((b) => b.message === 'You have successfully joined this complaint.'));
      assert.ok(bodies.some((b) => b.error === 'You have already joined this complaint.'));
      assert.equal(db.members.filter((m) => m.complaint_id === 'CMP-0001' && m.student_id === 'STU-0003').length, 1);

      // 5. Different students can join once each -> STU-0004 also joins cleanly -> count = 3
      const join4 = await fetch(`${baseUrl}/api/student/complaints/CMP-0001/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-student-id': 'STU-0004' },
      });
      assert.equal(join4.status, 201);
      assert.equal((await join4.json()).reportedBy, 3);
      assert.equal(db.distinctNonOwnerCount('CMP-0001'), 3);

      // 6. Creating a new complaint does NOT insert the owner into complaint_member
      const raiseRes = await fetch(`${baseUrl}/api/student/complaints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-student-id': 'STU-0005' },
        body: JSON.stringify({
          category: 'Hostel',
          description: 'Corridor emergency light stays off at night.',
          priority: 'High',
        }),
      });
      assert.equal(raiseRes.status, 201);
      const { complaintId: createdId } = await raiseRes.json();
      assert.equal(db.members.some((m) => m.complaint_id === createdId), false);
      assert.equal(db.distinctNonOwnerCount(createdId), 0);
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('POST /api/student/complaints join handles PostgreSQL 23505 duplicate-key error cleanly', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const ops = [];

  pool.query = async (sql) => {
    if (sql.includes('WHERE complaint_id = ANY')) return { rows: [{ complaint_id: 'CMP-0003' }] };
    if (sql.includes('AS join_count')) return { rows: [{ join_count: 1 }] };
    throw new Error(`Unexpected pool.query: ${sql}`);
  };
  pool.connect = async () => ({
    query: async (sql) => {
      ops.push(sql.trim());
      if (sql.trim() === 'BEGIN' || sql.trim() === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ complaint_id: 'CMP-0003', student_id: 'STU-0002', status: 'Pending' }] };
      }
      if (sql.includes('AS already_joined FROM public.complaint_member')) return { rowCount: 1, rows: [{ already_joined: 0 }] };
      if (sql.includes('INSERT INTO public.complaint_member')) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      throw new Error(`Unexpected client.query: ${sql}`);
    },
    release: () => {},
  });

  try {
    await withServer(createStudentServer(() => ({ student: { id: 'STU-0001' } })), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/student/complaints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joinComplaint: 'true', existingComplaintId: 'CMP-0003' }),
      });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error, 'You have already joined this complaint.');
      assert.equal(body.reportedBy, 1);
      assert.equal(ops[0], 'BEGIN');
      assert.equal(ops[ops.length - 1], 'ROLLBACK');
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('raise_complaint.html uses native modal dialog, defers validation to Join click, and preserves count on rejection', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'raise_complaint.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'CSS', 'style.css'), 'utf8');

  assert.match(html, /<dialog\s+id="duplicatePopup"\s+class="duplicate-popup"\s+closedby="any"\s+aria-labelledby="duplicatePopupTitle">/);
  assert.doesNotMatch(html, /<dialog[^>]*role="dialog"/);
  assert.doesNotMatch(html, /<dialog[^>]*aria-modal/);
  assert.match(html, /duplicatePopup\.showModal\(\)/);
  assert.doesNotMatch(html, /duplicateState/);
  assert.match(html, /if\s*\(!isJoinAttempt\)\s*\{\s*closeDuplicatePopup\("error"\);\s*\}/);
  assert.match(html, /alert\(error\.message\s*\|\|\s*"Unable to process your request\. Please try again\."\);/);

  assert.match(css, /dialog\.duplicate-popup:modal\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.match(css, /dialog\.duplicate-popup::backdrop\s*\{[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*contain/);
});

test('student.js validates owner before existing membership on join and enforces distinct non-owner join counts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'student.js'), 'utf8');
  const ownerIdx = src.indexOf('if (row.student_id === studentId)');
  const memberIdx = src.indexOf('AS already_joined FROM public.complaint_member');
  const insertIdx = src.indexOf('INSERT INTO public.complaint_member');
  assert.ok(ownerIdx !== -1 && memberIdx !== -1 && insertIdx !== -1);
  assert.ok(ownerIdx < memberIdx && memberIdx < insertIdx);
  assert.match(src, /COUNT\(DISTINCT cm\.student_id\)\s*FILTER\s*\(\s*WHERE\s+cm\.student_id\s*<>\s*c\.student_id\s*\)::int\s+AS\s+join_count/i);
  assert.match(src, /COUNT\(DISTINCT m\.student_id\)\s*FILTER\s*\(\s*WHERE\s+m\.student_id\s*<>\s*c\.student_id\s*\)::int\s+AS\s+reported_by/i);
  const memberInserts = src.match(/INSERT INTO\s+(?:public\.)?complaint_member/gi) || [];
  assert.equal(memberInserts.length, 1);
});
