const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const pool = require('../server/db');
const staffRouter = require('../server/routes/staff');

function createStaffServer(staffId = 'STF-0001') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { staff: { id: staffId } };
    next();
  });
  app.use('/api/staff', staffRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function createStatefulStaffDb(initialComplaints) {
  const complaints = initialComplaints.map((c) => ({ ...c }));
  const events = [];
  let lockChain = Promise.resolve();

  function matchAll(ids) {
    return complaints.filter((c) => ids.includes(c.complaint_id));
  }

  async function runQuery(sql, params = [], txState = null) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      if (txState && sql === 'COMMIT' && txState.pendingUpdates.length) {
        for (const u of txState.pendingUpdates) {
          const target = complaints.find((c) => c.complaint_id === u.complaint_id);
          if (target) {
            target.status = u.status;
            target.resolution = u.resolution;
            target.updated_at = u.updated_at;
          }
        }
        events.push(...txState.pendingEvents);
        txState.pendingUpdates = [];
        txState.pendingEvents = [];
      }
      if (txState && (sql === 'COMMIT' || sql === 'ROLLBACK')) {
        if (txState.releaseLock) {
          txState.releaseLock();
          txState.releaseLock = null;
        }
        txState.pendingUpdates = [];
        txState.pendingEvents = [];
      }
      return { rowCount: 0, rows: [] };
    }

    if (sql.includes('pg_advisory_xact_lock')) {
      let acquired;
      const next = new Promise((r) => {
        acquired = r;
      });
      const prev = lockChain;
      lockChain = lockChain.then(() => next);
      await prev;
      if (txState) txState.releaseLock = acquired;
      else acquired();
      return { rowCount: 1, rows: [{ pg_advisory_xact_lock: '' }] };
    }

    if (sql.includes('WHERE complaint_id = ANY')) {
      return { rows: matchAll(params[0]).map((c) => ({ complaint_id: c.complaint_id })) };
    }

    if (sql.includes("LOWER(status) = 'in progress'") && sql.includes('complaint_id <> $2')) {
      const [staffId, excludeId] = params;
      const rows = complaints
        .filter(
          (c) =>
            c.assigned_staff_id === staffId &&
            String(c.status).toLowerCase() === 'in progress' &&
            c.complaint_id !== excludeId
        )
        .slice(0, 1)
        .map((c) => ({ complaint_id: c.complaint_id }));
      return { rowCount: rows.length, rows };
    }

    if (sql.includes('WHERE c.assigned_staff_id = $1')) {
      const staffId = params[0];
      const rows = complaints.filter((c) => c.assigned_staff_id === staffId);
      return { rowCount: rows.length, rows };
    }

    if (sql.includes('WHERE c.complaint_id = $1 AND c.assigned_staff_id = $2') && !sql.includes('JOIN staff s ON')) {
      const row = complaints.find((c) => c.complaint_id === params[0] && c.assigned_staff_id === params[1]);
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    }

    if (sql.includes('FOR UPDATE')) {
      const row = complaints.find((c) => c.complaint_id === params[0] && c.assigned_staff_id === params[1]);
      return {
        rowCount: row ? 1 : 0,
        rows: row
          ? [{
              complaint_id: row.complaint_id,
              status: row.status,
            }]
          : [],
      };
    }

    if (sql.startsWith('UPDATE complaint SET')) {
      const [status, actualId, staffId] = params;
      const row = complaints.find((c) => c.complaint_id === actualId && c.assigned_staff_id === staffId);
      if (!row) return { rowCount: 0, rows: [] };
      const updatedAt = '2026-11-12T10:00:00.000Z';
      if (txState) {
        txState.pendingUpdates.push({
          complaint_id: actualId,
          status,
          resolution: row.resolution || null,
          updated_at: updatedAt,
        });
      }
      return {
        rowCount: 1,
        rows: [{
          complaint_id: actualId,
          status,
          resolution: row.resolution || null,
          updated_at: updatedAt,
        }],
      };
    }

    if (sql.includes('INSERT INTO complaint_event')) {
      const ev = { complaint_id: params[0], kind: params[1], message: params[2], actor: params[3] };
      if (txState) txState.pendingEvents.push(ev);
      else events.push(ev);
      return { rowCount: 1, rows: [] };
    }

    if (sql.includes('JOIN staff s ON s.staff_id = c.assigned_staff_id')) {
      return { rows: [{ email: '', student_name: 'Student', staff_name: 'Rakesh Sharma' }] };
    }

    throw new Error(`Unexpected SQL in mock: ${sql}`);
  }

  return {
    complaints,
    events,
    query: (sql, params) => runQuery(sql, params, null),
    connect: async () => {
      const txState = { pendingUpdates: [], pendingEvents: [], releaseLock: null };
      return {
        query: (sql, params) => runQuery(sql, params, txState),
        release: () => {
          if (txState.releaseLock) {
            txState.releaseLock();
            txState.releaseLock = null;
          }
        },
      };
    },
  };
}

test('Staff JSP complaint lifecycle: multiple In Progress allowed, strict transitions, and 404 ownership checks', async () => {
  const db = createStatefulStaffDb([
    {
      complaint_id: 'CMP-0001',
      student_name: 'Deviprasad',
      category: 'WiFi',
      description: 'WiFi drops frequently in block B.',
      priority: 'High',
      status: 'Assigned',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-10T08:00:00.000Z',
      updated_at: '2026-11-10T08:00:00.000Z',
    },
    {
      complaint_id: 'CMP-0002',
      student_name: 'Asha',
      category: 'Hostel',
      description: 'Water heater not working.',
      priority: 'Medium',
      status: 'Assigned',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-11T08:00:00.000Z',
      updated_at: '2026-11-11T08:00:00.000Z',
    },
    {
      complaint_id: 'CMP-0003',
      student_name: 'Rohan',
      category: 'Library',
      description: 'Reading room lamp flickers.',
      priority: 'Low',
      status: 'Assigned',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-12T08:00:00.000Z',
      updated_at: '2026-11-12T08:00:00.000Z',
    },
    {
      complaint_id: 'CMP-0004',
      student_name: 'Meera',
      category: 'WiFi',
      description: 'Another staff member owns this complaint.',
      priority: 'High',
      status: 'Assigned',
      assigned_staff_id: 'STF-0002',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-12T09:00:00.000Z',
      updated_at: '2026-11-12T09:00:00.000Z',
    },
  ]);

  const origQuery = pool.query;
  const origConnect = pool.connect;
  pool.query = db.query;
  pool.connect = db.connect;

  try {
    await withServer(createStaffServer('STF-0001'), async (baseUrl) => {
      // 1. Multiple Assigned complaints are selectable initially
      const listRes1 = await fetch(`${baseUrl}/api/staff/complaints`);
      assert.equal(listRes1.status, 200);
      assert.equal(listRes1.headers.get('cache-control'), 'no-store');
      const listBody1 = await listRes1.json();
      assert.deepEqual(
        listBody1.selectableComplaints.map((c) => c.complaintId),
        ['CMP-0001', 'CMP-0002', 'CMP-0003']
      );

      // 2. Detail endpoint fetches live status + allowedStatuses for Assigned
      const detailRes1 = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001`);
      assert.equal(detailRes1.status, 200);
      const detail1 = await detailRes1.json();
      assert.equal(detail1.currentStatus, 'Assigned');
      assert.equal(detail1.nextStatus, 'In Progress');
      assert.deepEqual(detail1.allowedStatuses, ['In Progress']);
      assert.equal(detail1.canUpdate, true);

      // Missing or invalid status is rejected with 400
      const emptyBodyRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(emptyBodyRes.status, 400);

      const badStatusRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'complaint-status': 'Pending' }),
      });
      assert.equal(badStatusRes.status, 400);

      // Direct Assigned -> Resolved jump is rejected with 409
      const jumpRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'complaint-status': 'Resolved' }),
      });
      assert.equal(jumpRes.status, 409);

      // 3. Starting CMP-0001 transitions Assigned -> In Progress
      const startRes1 = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'complaint-id': 'CMP-0001', 'complaint-status': 'In Progress' }),
      });
      assert.equal(startRes1.status, 200);
      const startBody1 = await startRes1.json();
      assert.equal(startBody1.status, 'In Progress');
      assert.equal(startBody1.previousStatus, 'Assigned');

      // 4. Starting CMP-0001 does NOT lock CMP-0002 or CMP-0003; another In Progress is allowed
      const listRes2 = await fetch(`${baseUrl}/api/staff/complaints`);
      const listBody2 = await listRes2.json();
      assert.deepEqual(
        listBody2.selectableComplaints.map((c) => c.complaintId),
        ['CMP-0001', 'CMP-0002', 'CMP-0003']
      );

      const detail2 = await (await fetch(`${baseUrl}/api/staff/complaints/CMP-0002`)).json();
      assert.equal(detail2.canUpdate, true);
      assert.deepEqual(detail2.allowedStatuses, ['In Progress']);

      const startRes2 = await fetch(`${baseUrl}/api/staff/complaints/CMP-0002/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'In Progress' }),
      });
      assert.equal(startRes2.status, 200);
      assert.equal((await startRes2.json()).status, 'In Progress');

      // 5. Selecting In Progress CMP-0001 offers only Resolved and updates cleanly
      const inProgressDetail = await (await fetch(`${baseUrl}/api/staff/complaints/CMP-0001`)).json();
      assert.equal(inProgressDetail.currentStatus, 'In Progress');
      assert.deepEqual(inProgressDetail.allowedStatuses, ['Resolved']);
      assert.equal(inProgressDetail.canUpdate, true);

      const resolveRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'complaint-status': 'Resolved' }),
      });
      assert.equal(resolveRes.status, 200);
      const resolveBody = await resolveRes.json();
      assert.equal(resolveBody.status, 'Resolved');

      // 6. Resolved CMP-0001 is excluded from dropdown while remaining eligible stay listed
      const listRes3 = await fetch(`${baseUrl}/api/staff/complaints`);
      const listBody3 = await listRes3.json();
      assert.deepEqual(
        listBody3.selectableComplaints.map((c) => c.complaintId),
        ['CMP-0002', 'CMP-0003']
      );

      // 8. Staff cannot inspect or update another staff member's complaint (404)
      const foreignGet = await fetch(`${baseUrl}/api/staff/complaints/CMP-0004`);
      assert.equal(foreignGet.status, 404);
      const foreignPost = await fetch(`${baseUrl}/api/staff/complaints/CMP-0004/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'complaint-status': 'In Progress' }),
      });
      assert.equal(foreignPost.status, 404);

      // 9. Resolved complaints cannot be updated again
      const resolvedDetail = await (await fetch(`${baseUrl}/api/staff/complaints/CMP-0001`)).json();
      assert.equal(resolvedDetail.currentStatus, 'Resolved');
      assert.deepEqual(resolvedDetail.allowedStatuses, []);
      assert.equal(resolvedDetail.canUpdate, false);
      const resolvedPost = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'complaint-status': 'Resolved' }),
      });
      assert.equal(resolvedPost.status, 409);
      assert.ok(db.events.some((ev) => ev.complaint_id === 'CMP-0001' && ev.kind === 'resolved'));
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('Simultaneous POST requests allow starting multiple Assigned complaints for the same staff member', async () => {
  const db = createStatefulStaffDb([
    {
      complaint_id: 'CMP-0001',
      student_name: 'Deviprasad',
      category: 'WiFi',
      description: 'Router down.',
      priority: 'High',
      status: 'Assigned',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-12T08:00:00.000Z',
      updated_at: '2026-11-12T08:00:00.000Z',
    },
    {
      complaint_id: 'CMP-0002',
      student_name: 'Asha',
      category: 'Hostel',
      description: 'Fan broken.',
      priority: 'High',
      status: 'Assigned',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-12T08:05:00.000Z',
      updated_at: '2026-11-12T08:05:00.000Z',
    },
  ]);

  const origQuery = pool.query;
  const origConnect = pool.connect;
  pool.query = db.query;
  pool.connect = db.connect;

  try {
    await withServer(createStaffServer('STF-0001'), async (baseUrl) => {
      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'In Progress' }),
        }),
        fetch(`${baseUrl}/api/staff/complaints/CMP-0002/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'In Progress' }),
        }),
      ]);

      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 200]);
      const inProgressCount = db.complaints.filter((c) => c.status === 'In Progress').length;
      assert.equal(inProgressCount, 2);
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('Staff HTML templates enforce plain Complaint ID, JSP readonly Status field, and remove Queue / AI / Resolution Notes', () => {
  const assignedHtml = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'view_assigned_complaints.html'),
    'utf8'
  );
  assert.doesNotMatch(assignedHtml, /timeline-open/);
  assert.doesNotMatch(assignedHtml, /openTimeline/);
  assert.doesNotMatch(assignedHtml, /cursor:\s*pointer/);
  assert.match(assignedHtml, /<td>\$\{escapeHtml\(c\.complaintId \|\| ""\)\}<\/td>/);

  const updateHtml = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'update_complaint.html'),
    'utf8'
  );
  assert.doesNotMatch(updateHtml, /Only Assigned complaints are listed|locks other Assigned complaints/i);
  assert.doesNotMatch(updateHtml, /workflow-notice|transitionHint|activeQueueHint|nextAction/);
  assert.doesNotMatch(updateHtml, /resolutionNote|Resolution Note/i);
  assert.doesNotMatch(updateHtml, /assignedQueueHeading|Assigned Complaints Queue|assignedQueueBody|renderAssignedQueue/);
  assert.doesNotMatch(updateHtml, /aiAssistant|aiSuggest|aiAnalysis|analyzeComplaint|\/api\/ai\b/i);
  assert.match(updateHtml, /<select[^>]*name="complaint-id"[^>]*id="complaintId"/);
  assert.match(updateHtml, /<input[^>]*id="category"[^>]*readonly/);
  assert.match(updateHtml, /<input[^>]*id="description"[^>]*readonly/);
  assert.match(updateHtml, /<input[^>]*type="text"[^>]*name="complaint-status"[^>]*id="status"[^>]*readonly/);
  assert.doesNotMatch(updateHtml, /<select[^>]*id="status"/);
  assert.match(updateHtml, /statusInput\.value\s*=\s*"In Progress"/);
  assert.match(updateHtml, /statusInput\.value\s*=\s*"Resolved"/);
  assert.doesNotMatch(updateHtml, /form-feedback--success|updated from /i);
  assert.match(updateHtml, /alert\("Complaint Status Updated Successfully"\)/);
  assert.match(updateHtml, /window\.location\.href\s*=\s*"staff_dashboard\.html"/);
  assert.match(updateHtml, /href="staff_dashboard\.html"/);
  assert.match(updateHtml, /\/api\/staff\/complaints\/"\s*\+\s*encodeURIComponent\(id\)/);
  assert.match(updateHtml, /id="submitBtn"/);
});

test('GET /api/staff/complaints returns studentId, real DB priority without defaults, and view_assigned_complaints matches 8-column order', async () => {
  const db = createStatefulStaffDb([
    {
      complaint_id: 'CMP-0001',
      student_id: 'STU-0001',
      student_name: 'Deviprasad',
      category: 'WiFi',
      description: 'High priority network issue.',
      priority: 'High',
      status: 'Assigned',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-10T08:00:00.000Z',
      updated_at: '2026-11-10T08:00:00.000Z',
    },
    {
      complaint_id: 'CMP-0002',
      student_id: 'STU0002',
      student_name: 'Asha',
      category: 'Hostel',
      description: 'Low priority repair.',
      priority: 'Low',
      status: 'In Progress',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: null,
      due_at: null,
      created_at: '2026-11-11T08:00:00.000Z',
      updated_at: '2026-11-11T08:00:00.000Z',
    },
    {
      complaint_id: 'CMP-0003',
      student_id: 'STU-0003',
      student_name: 'Rohan',
      category: 'Library',
      description: 'Complaint with missing priority in DB.',
      priority: null,
      status: 'Resolved',
      assigned_staff_id: 'STF-0001',
      resolution: null,
      rating: 4,
      due_at: null,
      created_at: '2026-11-12T08:00:00.000Z',
      updated_at: '2026-11-12T08:00:00.000Z',
    },
  ]);

  const origQuery = pool.query;
  const origConnect = pool.connect;
  pool.query = db.query;
  pool.connect = db.connect;

  try {
    await withServer(createStaffServer('STF-0001'), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/staff/complaints`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.complaints.length, 3);
      assert.equal(data.complaints[0].studentId, 'STU-0001');
      assert.equal(data.complaints[0].priority, 'High');
      assert.equal(data.complaints[0].date, '2026-11-10');
      assert.equal(data.complaints[1].studentId, 'STU-0002');
      assert.equal(data.complaints[1].priority, 'Low');
      assert.equal(data.complaints[2].priority, null);
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }

  const assignedHtml = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'view_assigned_complaints.html'),
    'utf8'
  );
  const theadMatch = assignedHtml.match(/<thead>([\s\S]*?)<\/thead>/);
  assert.ok(theadMatch);
  const headers = [...theadMatch[1].matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(headers, [
    'Complaint ID',
    'Student ID',
    'Name',
    'Category',
    'Description',
    'Priority',
    'Date',
    'Status',
  ]);
  assert.match(assignedHtml, /badge-priority-high/);
  assert.match(assignedHtml, /badge-priority-medium/);
  assert.match(assignedHtml, /badge-priority-low/);
  assert.match(assignedHtml, /colspan="8"/);
  assert.match(assignedHtml, /renderPriorityCell\(c\.priority\)/);
  assert.match(assignedHtml, /String\(c\.priority \|\| ""\)\.toLowerCase\(\)\.includes\(keyword\)/);
});
