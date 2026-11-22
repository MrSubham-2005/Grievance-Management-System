const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const pool = require('../server/db');
const studentRouter = require('../server/routes/student');

function createStudentServer(getStudentSession) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const s = typeof getStudentSession === 'function' ? getStudentSession(req) : getStudentSession;
    req.session = { student: s };
    req.user = s;
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

test('GET /api/student/feedback-options returns resolved complaints and excludes already-rated complaints', async () => {
  const origQuery = pool.query;

  const mockComplaints = [
    { complaint_id: 'CMP-0001', student_id: 'STU-0001', category: 'Hostel', status: 'Resolved', assigned_staff_id: 'STF-0001', staff_name: 'Staff One', updated_at: '2026-11-10T10:00:00Z' },
    { complaint_id: 'CMP-0002', student_id: 'STU-0002', category: 'Library', status: 'Resolved', assigned_staff_id: null, staff_name: null, updated_at: '2026-11-09T10:00:00Z' },
  ];

  pool.query = async (sql, params) => {
    if (sql.includes('SELECT status, student_id FROM student')) {
      return { rows: [{ status: 'Active', student_id: params[0] }] };
    }
    if (sql.includes('FROM public.complaint c') && sql.includes("c.status = 'Resolved'")) {
      assert.deepEqual(params, ['STU-0001']);
      assert.match(sql, /NOT EXISTS\s*\(\s*SELECT 1 FROM feedback f/i);
      return {
        rows: mockComplaints.map((c) => ({
          complaint_id: c.complaint_id,
          category: c.category,
          assigned_staff_id: c.assigned_staff_id,
          staff_name: c.staff_name,
          updated_at: c.updated_at,
        })),
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const app = createStudentServer({ id: 'STU-0001', name: 'Test Student' });
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/student/feedback-options`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.complaints.length, 2);
      assert.equal(data.complaints[0].complaintId, 'CMP-0001');
      assert.equal(data.complaints[0].category, 'Hostel');
      assert.equal(data.complaints[0].staffId, 'STF-0001');
      assert.equal(data.complaints[0].staffName, 'Staff One');

      // Unassigned staff fallback
      assert.equal(data.complaints[1].complaintId, 'CMP-0002');
      assert.equal(data.complaints[1].staffId, '');
      assert.equal(data.complaints[1].staffName, 'Not assigned');
    });
  } finally {
    pool.query = origQuery;
  }
});

test('POST /api/student/feedback stores feedbackCategory, updates staff rating, and prevents duplicate submissions', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;

  const feedbackDb = [];
  let staffRating = 0;

  const complaintsTable = [
    { complaint_id: 'CMP-0001', student_id: 'STU-0001', category: 'Hostel', status: 'Resolved', assigned_staff_id: 'STF-0001' },
    { complaint_id: 'CMP-0002', student_id: 'STU-0002', category: 'Academic', status: 'In Progress', assigned_staff_id: 'STF-0001' },
    { complaint_id: 'CMP-0003', student_id: 'STU-0002', category: 'Cafeteria', status: 'Resolved', assigned_staff_id: null },
  ];
  const membersTable = [
    { complaint_id: 'CMP-0001', student_id: 'STU-0003' }, // Joined member
  ];

  const handleQuery = async (sql, params) => {
    if (sql.includes('SELECT status, student_id FROM student')) {
      return { rows: [{ status: 'Active', student_id: params[0] }] };
    }
    if (sql.includes('WHERE complaint_id = ANY')) {
      const found = params[0].find((id) => complaintsTable.some((c) => c.complaint_id === id));
      return { rows: found ? [{ complaint_id: found }] : [] };
    }
    if (sql.includes('FROM public.complaint c') && sql.includes('c.complaint_id = $1')) {
      const [cid, sid] = params;
      const c = complaintsTable.find((row) => row.complaint_id === cid);
      if (!c) return { rows: [] };
      const isOwner = c.student_id === sid;
      const isMember = membersTable.some((m) => m.complaint_id === cid && m.student_id === sid);
      if (!isOwner && !isMember) return { rows: [] };
      return { rows: [{ ...c }] };
    }
    if (sql.includes('SELECT 1 FROM feedback WHERE complaint_id=$1 AND student_id=$2')) {
      const [cid, sid] = params;
      const exists = feedbackDb.some((f) => f.complaint_id === cid && f.student_id === sid);
      return { rowCount: exists ? 1 : 0, rows: exists ? [{ 1: 1 }] : [] };
    }
    if (sql.includes('SUBSTRING(feedback_id')) {
      return { rows: [{ n: feedbackDb.length }] };
    }
    if (sql.includes('INSERT INTO feedback')) {
      const [feedback_id, complaint_id, student_id, staff_id, category, rating, review] = params;
      feedbackDb.push({ feedback_id, complaint_id, student_id, staff_id, category, rating, review });
      return { rowCount: 1 };
    }
    if (sql.includes('UPDATE staff SET rating')) {
      const [stfId] = params;
      const ratings = feedbackDb.filter((f) => f.staff_id === stfId).map((f) => f.rating);
      const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
      staffRating = Number(avg.toFixed(2));
      return { rowCount: 1 };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  pool.query = (sql, params) => handleQuery(sql, params);
  pool.connect = async () => ({
    query: (sql, params) => handleQuery(sql, params),
    release: () => {},
  });

  try {
    let currentStudent = { id: 'STU-0001', name: 'Owner Student' };
    const app = createStudentServer(() => currentStudent);

    await withServer(app, async (baseUrl) => {
      // 1. Missing complaint_id -> HTTP 400
      const missingComp = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 5, feedbackCategory: 'Staff Behaviour' }),
      });
      assert.equal(missingComp.status, 400);
      assert.equal((await missingComp.json()).error, 'Choose the complaint you are rating.');

      // 2. Invalid ratings -> HTTP 400
      for (const badRating of [0, 6, 3.5, 'five', null]) {
        const res = await fetch(`${baseUrl}/api/student/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ complaint_id: 'CMP-0001', rating: badRating, feedbackCategory: 'Staff Behaviour' }),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Rating must be a whole number from 1 to 5.');
      }

      // 3. Non-existent complaint -> HTTP 404
      const nonExistent = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complaint_id: 'CMP-9999', rating: 5, feedbackCategory: 'Staff Behaviour' }),
      });
      assert.equal(nonExistent.status, 404);

      // 4. Unrelated non-member student -> HTTP 404
      currentStudent = { id: 'STU-0099', name: 'Stranger' };
      const nonMember = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complaint_id: 'CMP-0001', rating: 5, feedbackCategory: 'Staff Behaviour' }),
      });
      assert.equal(nonMember.status, 404);
      assert.match((await nonMember.json()).error, /You are not a member of complaint CMP-0001/);

      // 5. Non-resolved complaint (In Progress) -> HTTP 409
      currentStudent = { id: 'STU-0002', name: 'Academic Student' };
      const nonResolved = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complaint_id: 'CMP-0002', rating: 5, feedbackCategory: 'Response Time' }),
      });
      assert.equal(nonResolved.status, 409);
      assert.equal((await nonResolved.json()).error, 'You can rate a complaint only after it is resolved.');

      // 6. Valid submission by Owner: verifies feedbackCategory is saved in category column!
      currentStudent = { id: 'STU-0001', name: 'Owner Student' };
      const validOwner = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          complaint_id: 'CMP-0001',
          rating: 5,
          feedbackCategory: 'Staff Behaviour',
          'review-message': 'Excellent service and quick fix.',
        }),
      });
      assert.equal(validOwner.status, 201);
      const ownerData = await validOwner.json();
      assert.equal(ownerData.ok, true);
      assert.equal(ownerData.feedbackId, 'FB-0001');

      // Verify the recorded row has feedbackCategory ('Staff Behaviour'), not 'Hostel'
      assert.equal(feedbackDb.length, 1);
      assert.equal(feedbackDb[0].category, 'Staff Behaviour');
      assert.equal(feedbackDb[0].rating, 5);
      assert.equal(feedbackDb[0].staff_id, 'STF-0001');
      assert.equal(staffRating, 5);

      // 7. Duplicate submission by same student -> HTTP 409
      const duplicateRes = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          complaint_id: 'CMP-0001',
          rating: 4,
          feedbackCategory: 'Resolution Quality',
        }),
      });
      assert.equal(duplicateRes.status, 409);
      assert.equal((await duplicateRes.json()).error, 'You have already rated this complaint.');
      assert.equal(feedbackDb.length, 1);

      // 8. Joined member (STU-0003) can also submit feedback for CMP-0001
      currentStudent = { id: 'STU-0003', name: 'Joined Student' };
      const validJoined = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          complaint_id: 'CMP-0001',
          rating: 4,
          feedbackCategory: 'Resolution Quality',
          review: 'Well handled.',
        }),
      });
      assert.equal(validJoined.status, 201);
      assert.equal(feedbackDb.length, 2);
      assert.equal(feedbackDb[1].category, 'Resolution Quality');
      assert.equal(feedbackDb[1].rating, 4);
      // Staff rating updated to average of 5 and 4 = 4.5
      assert.equal(staffRating, 4.5);

      // 9. Feedback on complaint without assigned staff (CMP-0003) -> succeeds without rating update crash
      currentStudent = { id: 'STU-0002', name: 'Cafeteria Owner' };
      const unassignedRes = await fetch(`${baseUrl}/api/student/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          complaint_id: 'CMP-0003',
          rating: 3,
        }),
      });
      assert.equal(unassignedRes.status, 201);
      assert.equal(feedbackDb.length, 3);
      // Fallback to complaint category when feedbackCategory omitted
      assert.equal(feedbackDb[2].category, 'Cafeteria');
      assert.equal(feedbackDb[2].staff_id, null);
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('Feedback HTML template has correct Rating label above star rating', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'feedback.html'), 'utf8');
  assert.match(html, /<label\s+class="form-label">\s*Rating\s*<\/label>/);
  // Ensure the duplicated label was fixed
  const matches = html.match(/<label\s+class="form-label">\s*Primary Evaluation Area\s*<\/label>/g) || [];
  assert.equal(matches.length, 1, 'Only one Primary Evaluation Area label should remain');
});
