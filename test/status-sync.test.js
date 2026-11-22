const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const pool = require('../server/db');
const adminRouter = require('../server/routes/admin');
const staffRouter = require('../server/routes/staff');
const studentRouter = require('../server/routes/student');

function createRoleTestServer(mountPath, router, sessionObj) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = sessionObj;
    next();
  });
  app.use(mountPath, router);
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

test('GET /api/admin/dashboard computes disjoint status counts summing to totalComplaints', async () => {
  const origQuery = pool.query;
  const queries = [];
  pool.query = async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM public.complaint') && sql.includes('FILTER')) {
      assert.match(sql, /FILTER\s*\(\s*WHERE\s+LOWER\(status\)\s*=\s*'pending'\s*\)/i);
      assert.match(sql, /FILTER\s*\(\s*WHERE\s+LOWER\(status\)\s*=\s*'assigned'\s*\)/i);
      assert.match(sql, /FILTER\s*\(\s*WHERE\s+LOWER\(status\)\s*=\s*'in progress'\s*\)/i);
      assert.match(sql, /FILTER\s*\(\s*WHERE\s+LOWER\(status\)\s*=\s*'resolved'\s*\)/i);
      assert.doesNotMatch(sql, /assigned_staff_id IS NOT NULL/i);
      return { rows: [{ pending: 2, assigned: 1, in_progress: 3, resolved: 4, total: 10 }] };
    }
    if (sql.includes('FROM staff_request')) {
      return { rows: [{ students: 5, staff: 8, pending_staff: 1 }] };
    }
    return {
      rows: [
        {
          complaint_id: 'CMP-0010',
          student_name: 'Subham Dash',
          student_id: 'STU-0001',
          category: 'Library',
          description: 'Need quiet zone',
          priority: 'High',
          status: 'Assigned',
          created_at: '2026-11-11T10:00:00.000Z',
        },
      ],
    };
  };

  try {
    await withServer(
      createRoleTestServer('/api/admin', adminRouter, { admin: { id: 'ADM-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/dashboard`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const data = await res.json();
        assert.equal(data.pendingComplaints, 2);
        assert.equal(data.assignedComplaints, 1);
        assert.equal(data.inProgressComplaints, 3);
        assert.equal(data.resolvedComplaints, 4);
        assert.equal(data.totalComplaints, 10);
        assert.equal(
          data.pendingComplaints +
            data.assignedComplaints +
            data.inProgressComplaints +
            data.resolvedComplaints,
          data.totalComplaints
        );
        assert.equal(data.recentComplaints[0].status, 'Assigned');
        assert.equal(data.recentComplaints[0].priority, 'High');
        assert.equal(data.recentComplaints[0].studentId, 'STU-0001');
        assert.equal(data.recentComplaints[0].date, '2026-11-11');
      }
    );
  } finally {
    pool.query = origQuery;
  }
});

test('POST /api/admin/complaints/assign sets status=Assigned, stores metadata, and commits with timeline event', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const txQueries = [];
  let released = false;

  pool.query = async (sql) => {
    if (sql.includes('WHERE complaint_id = ANY')) return { rows: [{ complaint_id: 'CMP-0002' }] };
    if (sql.includes('FROM staff WHERE staff_id')) return { rows: [{ staff_name: 'Rakesh Sharma', department: 'Cafeteria', status: 'Active' }] };
    throw new Error(`Unexpected pool.query: ${sql}`);
  };
  pool.connect = async () => ({
    query: async (sql, params) => {
      txQueries.push({ sql: sql.trim(), params });
      if (sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ complaint_id: 'CMP-0002', status: 'Pending', assigned_staff_id: null }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => { released = true; },
  });

  try {
    await withServer(
      createRoleTestServer('/api/admin', adminRouter, { admin: { id: 'ADM-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/complaints/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ complaint_id: 'CMP-0002', staff_id: 'STF-0001' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(txQueries[0].sql, 'BEGIN');
        const updateCall = txQueries.find((q) => q.sql.startsWith('UPDATE complaint'));
        assert.ok(updateCall);
        assert.match(updateCall.sql, /status = 'Assigned'/);
        assert.deepEqual(updateCall.params, ['STF-0001', 'ADM-0001', 'CMP-0002']);
        const eventCall = txQueries.find((q) => q.sql.includes('INSERT INTO complaint_event'));
        assert.ok(eventCall);
        assert.equal(eventCall.params[1], 'assigned');
        assert.equal(txQueries[txQueries.length - 1].sql, 'COMMIT');
        assert.equal(released, true);
      }
    );
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('POST /api/admin/complaints/assign rejects non-Pending complaints with 409 and rolls back', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const txOps = [];

  pool.query = async (sql) => {
    if (sql.includes('WHERE complaint_id = ANY')) return { rows: [{ complaint_id: 'CMP-0001' }] };
    if (sql.includes('FROM staff WHERE staff_id')) return { rows: [{ staff_name: 'Rakesh Sharma', department: 'IT', status: 'Active' }] };
    return { rows: [] };
  };
  pool.connect = async () => ({
    query: async (sql) => {
      txOps.push(sql.trim());
      if (sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ complaint_id: 'CMP-0001', status: 'Assigned', assigned_staff_id: 'STF-0001' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  });

  try {
    await withServer(
      createRoleTestServer('/api/admin', adminRouter, { admin: { id: 'ADM-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/complaints/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ complaint_id: 'CMP-0001', staff_id: 'STF-0002' }),
        });
        assert.equal(res.status, 409);
        assert.equal(txOps[0], 'BEGIN');
        assert.equal(txOps[txOps.length - 1], 'ROLLBACK');
        assert.equal(txOps.some((s) => s.startsWith('UPDATE complaint')), false);
      }
    );
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('POST /api/staff/complaints/:id/status enforces Assigned -> In Progress -> Resolved inside transactions', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;

  let currentDbStatus = 'Assigned';
  let txLog = [];

  pool.query = async (sql) => {
    if (sql.includes('WHERE complaint_id = ANY')) return { rows: [{ complaint_id: 'CMP-0001' }] };
    throw new Error(`Unexpected pool.query: ${sql}`);
  };
  pool.connect = async () => ({
    query: async (sql, params) => {
      txLog.push({ sql: sql.trim(), params });
      if (sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ complaint_id: 'CMP-0001', status: currentDbStatus, assigned_staff_id: 'STF-0001' }] };
      }
      if (sql.startsWith('UPDATE complaint')) {
        currentDbStatus = params[0];
        return {
          rowCount: 1,
          rows: [{
            complaint_id: 'CMP-0001',
            status: currentDbStatus,
            resolution: null,
            updated_at: '2026-11-11T14:30:00.000Z',
          }],
        };
      }
      if (sql.includes('FROM complaint c')) {
        return { rows: [{ email: '', student_name: 'Deviprasad', staff_name: 'Rakesh Sharma' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => {},
  });

  try {
    await withServer(
      createRoleTestServer('/api/staff', staffRouter, { staff: { id: 'STF-0001' } }),
      async (baseUrl) => {
        // Direct Assigned -> Resolved must be rejected
        const jumpRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'Resolved', resolution: 'Fixed router issue' }),
        });
        assert.equal(jumpRes.status, 409);
        assert.equal(currentDbStatus, 'Assigned');
        assert.equal(txLog[txLog.length - 1].sql, 'ROLLBACK');

        // Assigned -> In Progress succeeds transactionally
        txLog = [];
        const startRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'In Progress' }),
        });
        assert.equal(startRes.status, 200);
        assert.equal(currentDbStatus, 'In Progress');
        assert.equal(txLog[0].sql, 'BEGIN');
        assert.ok(txLog.some((q) => q.sql.includes('INSERT INTO complaint_event') && q.params[1] === 'status'));
        assert.equal(txLog[txLog.length - 1].sql, 'COMMIT');

        // Duplicate In Progress -> In Progress rejected
        txLog = [];
        const dupRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'In Progress' }),
        });
        assert.equal(dupRes.status, 409);
        assert.equal(txLog[txLog.length - 1].sql, 'ROLLBACK');

        // In Progress -> Resolved succeeds transactionally
        txLog = [];
        const resolveRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'Resolved' }),
        });
        assert.equal(resolveRes.status, 200);
        const resolveBody = await resolveRes.json();
        assert.equal(resolveBody.status, 'Resolved');
        assert.ok(txLog.some((q) => q.sql.includes('INSERT INTO complaint_event') && q.params[1] === 'resolved'));
        assert.equal(txLog[txLog.length - 1].sql, 'COMMIT');

        // Resolved -> In Progress rejected
        txLog = [];
        const revertRes = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'In Progress' }),
        });
        assert.equal(revertRes.status, 409);
        assert.equal(txLog[txLog.length - 1].sql, 'ROLLBACK');
      }
    );
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('POST /api/staff/complaints/:id/status rolls back complaint update if timeline event fails', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const ops = [];

  pool.query = async (sql) => {
    if (sql.includes('WHERE complaint_id = ANY')) return { rows: [{ complaint_id: 'CMP-0001' }] };
    return { rows: [] };
  };
  pool.connect = async () => ({
    query: async (sql) => {
      ops.push(sql.trim());
      if (sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ complaint_id: 'CMP-0001', status: 'Assigned', assigned_staff_id: 'STF-0001' }] };
      if (sql.startsWith('UPDATE complaint')) return { rowCount: 1, rows: [{ complaint_id: 'CMP-0001', status: 'In Progress', resolution: null }] };
      if (sql.includes('INSERT INTO complaint_event')) throw new Error('timeline write failed');
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  });

  try {
    await withServer(
      createRoleTestServer('/api/staff', staffRouter, { staff: { id: 'STF-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'In Progress' }),
        });
        assert.equal(res.status, 500);
        assert.equal(ops[0], 'BEGIN');
        assert.equal(ops[ops.length - 1], 'ROLLBACK');
      }
    );
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('Role checks block signed-in students from admin assign and staff status endpoints', async () => {
  const studentSession = { student: { id: 'STU-0001' } };
  await withServer(
    createRoleTestServer('/api/admin', adminRouter, studentSession),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/complaints/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complaint_id: 'CMP-0002', staff_id: 'STF-0001' }),
      });
      assert.equal(res.status, 401);
    }
  );
  await withServer(
    createRoleTestServer('/api/staff', staffRouter, studentSession),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/staff/complaints/CMP-0001/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'In Progress' }),
      });
      assert.equal(res.status, 401);
    }
  );
});

test('Joining an existing complaint adds membership without modifying complaint status', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const queries = [];
  pool.query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('WHERE complaint_id = ANY')) return { rows: [{ complaint_id: 'CMP-0002' }] };
    throw new Error(`Unexpected pool.query: ${sql}`);
  };
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.trim() === 'BEGIN' || sql.trim() === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM public.complaint') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ complaint_id: 'CMP-0002', student_id: 'STU-0002', status: 'Pending' }] };
      }
      if (sql.includes('AS already_joined FROM public.complaint_member')) return { rowCount: 1, rows: [{ already_joined: 0 }] };
      if (sql.includes('INSERT INTO public.complaint_member')) return { rowCount: 1, rows: [] };
      if (sql.includes('AS join_count')) return { rowCount: 1, rows: [{ join_count: 1 }] };
      throw new Error(`Unexpected client.query: ${sql}`);
    },
    release: () => {},
  });

  try {
    await withServer(
      createRoleTestServer('/api/student', studentRouter, { student: { id: 'STU-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/student/complaints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ joinComplaint: 'true', existingComplaintId: 'CMP-0002' }),
        });
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.joined, true);
        assert.equal(body.reportedBy, 1);
        assert.equal(body.message, 'You have successfully joined this complaint.');
        assert.equal(queries.some((q) => /UPDATE\s+complaint/i.test(q.sql)), false);
      }
    );
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

test('Admin and Staff portal queries and HTML polling templates preserve status synchronization', async () => {
  const origQuery = pool.query;
  pool.query = async (sql) => {
    if (sql.includes('FROM complaint c WHERE c.assigned_staff_id')) {
      return { rows: [{ status: 'assigned', n: 2 }, { status: 'in progress', n: 1 }, { status: 'resolved', n: 1 }] };
    }
    return {
      rows: [
        {
          complaint_id: 'CMP-0005',
          student_id: 'STU-0002',
          student_name: 'Deviprasad Singh',
          category: 'Library',
          description: 'Need more copies of operating systems textbook in reading hall.',
          priority: 'Medium',
          status: 'Pending',
          created_at: '2026-11-11T12:00:00.000Z',
        },
      ],
    };
  };

  try {
    await withServer(
      createRoleTestServer('/api/staff', staffRouter, { staff: { id: 'STF-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/staff/dashboard`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const data = await res.json();
        assert.equal(data.pendingComplaints, 2);
        assert.equal(data.inProgressComplaints, 1);
        assert.equal(data.resolvedComplaints, 1);
        assert.equal(data.totalComplaints, 4);
        assert.equal(data.recentComplaints[0].studentId, 'STU-0002');
        assert.equal(data.recentComplaints[0].studentName, 'Deviprasad Singh');
        assert.equal(data.recentComplaints[0].date, '2026-11-11');
      }
    );
  } finally {
    pool.query = origQuery;
  }

  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'admin_dashboard.html'), 'utf8');
  assert.match(dashHtml, /id="pendingComplaints"/);
  assert.match(dashHtml, /id="assignedComplaints"/);
  assert.match(dashHtml, /id="inProgressComplaints"/);
  assert.match(dashHtml, /id="resolvedComplaints"/);
  assert.match(dashHtml, /cache:\s*"no-store"/);
  assert.match(dashHtml, /setInterval\(refreshDashboard,\s*15000\)/);

  const complaintsHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'view_complaints.html'), 'utf8');
  assert.match(complaintsHtml, /cache:\s*"no-store"/);
  assert.match(complaintsHtml, /setInterval\(/);
  assert.match(complaintsHtml, /visibilitychange/);
  assert.match(complaintsHtml, /badge-assigned/);

  const updateHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'update_complaint.html'), 'utf8');
  assert.doesNotMatch(updateHtml, /id="resolutionNote"|assignedQueueBody|assignedQueueHeading/);
  assert.doesNotMatch(updateHtml, /id="nextAction"|id="transitionHint"|workflow-notice/);
  assert.match(updateHtml, /<input[^>]*name="complaint-status"[^>]*id="status"[^>]*readonly/);
  assert.match(updateHtml, /statusInput\.value\s*=\s*"In Progress"/);
  assert.match(updateHtml, /statusInput\.value\s*=\s*"Resolved"/);
});

test('GET /api/student/complaints returns exact complaint.status for Owner and Joined rows with no-store', async () => {
  const origQuery = pool.query;
  pool.query = async (sql, params) => {
    assert.match(sql, /SELECT DISTINCT/i);
    assert.match(sql, /LEFT JOIN public\.complaint_member cm ON cm\.complaint_id = c\.complaint_id/i);
    assert.match(sql, /WHERE c\.student_id = \$1\s*OR cm\.student_id = \$1/i);
    assert.deepEqual(params, ['STU-0001']);
    return {
      rows: [
        {
          complaint_id: 'CMP-0001',
          student_id: 'STU-0001',
          category: 'Library',
          description: 'Need AC check',
          priority: 'High',
          status: 'Pending',
          resolution: '',
          created_at: '2026-11-11T09:00:00.000Z',
          updated_at: '2026-11-11T09:00:00.000Z',
          ai_analysis: null,
          due_at: '2099-01-01T00:00:00.000Z',
          assigned_staff_id: 'STF-0002',
          staff_name: 'Priya Das',
        },
        {
          complaint_id: 'CMP-0002',
          student_id: 'STU-0002',
          category: 'IT & Network Support',
          description: 'Lab Wi-Fi issue',
          priority: 'Medium',
          status: 'Assigned',
          resolution: '',
          created_at: '2026-11-11T10:00:00.000Z',
          updated_at: '2026-11-11T10:30:00.000Z',
          ai_analysis: null,
          due_at: '2099-01-01T00:00:00.000Z',
          assigned_staff_id: 'STF-0001',
          staff_name: 'Rakesh Sharma',
        },
      ],
    };
  };

  try {
    await withServer(
      createRoleTestServer('/api/student', studentRouter, { student: { id: 'STU-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/student/complaints`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const data = await res.json();
        assert.equal(data.complaints[0].complaintId, 'CMP-0001');
        assert.equal(data.complaints[0].type, 'Owner');
        // Status must match DB verbatim even when assigned_staff_id is non-null.
        assert.equal(data.complaints[0].status, 'Pending');
        assert.equal(data.complaints[1].complaintId, 'CMP-0002');
        assert.equal(data.complaints[1].type, 'Joined');
        assert.equal(data.complaints[1].status, 'Assigned');
        assert.equal(data.complaints[1].assignedStaff, 'Rakesh Sharma');
      }
    );
  } finally {
    pool.query = origQuery;
  }

  const studentStatusHtml = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'view_complaint_status.html'),
    'utf8'
  );
  assert.match(studentStatusHtml, /<th scope="col">Status<\/th>/);
  assert.match(studentStatusHtml, /cache:\s*"no-store"/);
  assert.match(studentStatusHtml, /badge-pending/);
  assert.match(studentStatusHtml, /badge-assigned/);
  assert.match(studentStatusHtml, /badge-in-progress/);
  assert.match(studentStatusHtml, /badge-resolved/);
  assert.doesNotMatch(studentStatusHtml, /badge-overdue/);
  assert.doesNotMatch(studentStatusHtml, /Overdue/);
  assert.match(studentStatusHtml, /setInterval\(/);
  assert.match(studentStatusHtml, /visibilitychange/);

  const adminComplaintsHtml = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'view_complaints.html'),
    'utf8'
  );
  const staffAssignedHtml = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'view_assigned_complaints.html'),
    'utf8'
  );
  assert.match(adminComplaintsHtml, /badge-overdue/);
  assert.match(staffAssignedHtml, /badge-overdue/);
});

test('GET /api/student/dashboard and all 3 dashboard pages share standardized 8-column global latest 5 complaints', async () => {
  const origQuery = pool.query;
  let queryIndex = 0;
  pool.query = async (sql, params) => {
    queryIndex += 1;
    if (queryIndex === 1) {
      assert.match(sql, /WHERE student_id = \$1/i);
      assert.doesNotMatch(sql, /complaint_member|cm\./i);
      assert.deepEqual(params, ['STU-0001']);
      return { rows: [{ total_complaints: 1, pending_complaints: 1, in_progress_complaints: 0, resolved_complaints: 0 }] };
    }
    assert.match(sql, /LEFT JOIN public\.student s ON s\.student_id = c\.student_id/i);
    assert.match(sql, /ORDER BY c\.created_at DESC, c\.complaint_id DESC\s*LIMIT 5/i);
    assert.doesNotMatch(sql, /WHERE/i);
    assert.equal(params, undefined);
    return {
      rows: [
        {
          complaint_id: 'CMP-0007',
          student_id: 'STU-0007',
          student_name: 'Student Seven',
          category: 'Library',
          description: 'Need cooler water dispenser repaired in reading room wing A.',
          priority: 'High',
          status: 'Pending',
          created_at: '2026-11-11T15:00:00.000Z',
        },
        {
          complaint_id: 'CMP-0006',
          student_id: 'STU-0006',
          student_name: 'Student Six',
          category: 'Hostel',
          description: ' Corridor light flickering.',
          priority: 'Medium',
          status: 'Assigned',
          created_at: '2026-11-11T14:00:00.000Z',
        },
        {
          complaint_id: 'CMP-0005',
          student_id: 'STU-0005',
          student_name: 'Student Five',
          category: 'Cafeteria',
          description: 'Menu prices missing.',
          priority: 'Low',
          status: 'In Progress',
          created_at: '2026-11-11T13:00:00.000Z',
        },
        {
          complaint_id: 'CMP-0004',
          student_id: 'STU-0004',
          student_name: 'Student Four',
          category: 'Accounts',
          description: 'Receipt download failed.',
          priority: 'High',
          status: 'Resolved',
          created_at: '2026-11-11T12:00:00.000Z',
        },
        {
          complaint_id: 'CMP-0003',
          student_id: 'STU-0003',
          student_name: 'Student Three',
          category: 'Transport',
          description: 'Bus delayed.',
          priority: 'Medium',
          status: 'Pending',
          created_at: '2026-11-11T11:00:00.000Z',
        },
      ],
    };
  };

  try {
    await withServer(
      createRoleTestServer('/api/student', studentRouter, { student: { id: 'STU-0001' } }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/student/dashboard`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const data = await res.json();
        assert.equal(data.totalComplaints, 1);
        assert.equal(data.recentComplaints.length, 5);
        assert.deepEqual(Object.keys(data.recentComplaints[0]).sort(), [
          'category',
          'complaintId',
          'date',
          'description',
          'priority',
          'status',
          'studentId',
          'studentName',
        ]);
        assert.equal(data.recentComplaints[0].complaintId, 'CMP-0007');
        assert.equal(data.recentComplaints[0].studentId, 'STU-0007');
        assert.equal(data.recentComplaints[0].studentName, 'Student Seven');
        assert.equal(data.recentComplaints[0].date, '2026-11-11');
        assert.equal(data.recentComplaints[1].status, 'Assigned');
      }
    );
  } finally {
    pool.query = origQuery;
  }

  const dashboardFiles = [
    path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'student_dashboard.html'),
    path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'staff_dashboard.html'),
    path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'admin_dashboard.html'),
  ];
  const expectedHeadPattern =
    /<th scope="col">Complaint ID<\/th>\s*<th scope="col">Student ID<\/th>\s*<th scope="col">Name<\/th>\s*<th scope="col">Category<\/th>\s*<th scope="col">Description<\/th>\s*<th scope="col">Priority<\/th>\s*<th scope="col">Date<\/th>\s*<th scope="col">Status<\/th>/;

  for (const file of dashboardFiles) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, expectedHeadPattern, `Standardized 8 columns missing in ${file}`);
    assert.match(html, /src="\/gms-tooltip\.js"/, `gms-tooltip.js missing in ${file}`);
    assert.match(html, /src="\/gms-recent-complaints\.js"/, `gms-recent-complaints.js missing in ${file}`);
    assert.match(html, /GMSRecentComplaints\.createRefreshRunner/, `createRefreshRunner missing in ${file}`);
    assert.match(html, /cache:\s*"no-store"/, `no-store fetch missing in ${file}`);
    assert.match(html, /visibilitychange/, `visibilitychange refresh missing in ${file}`);
  }

  const sharedJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'gms-recent-complaints.js'), 'utf8');
  assert.match(sharedJs, /colspan="8"/);
  assert.match(sharedJs, /No complaints found\./);
  assert.match(sharedJs, /GMSTooltip\.renderInfoTip/);
  assert.match(sharedJs, /createRefreshRunner/);
  assert.match(sharedJs, /\.slice\(0,\s*5\)/);
});

test('Admin, Staff, and Student dashboard APIs return identical global latest 5 complaint IDs', async () => {
  const { RECENT_COMPLAINTS_SQL } = require('../server/recent-complaints');
  assert.match(RECENT_COMPLAINTS_SQL, /ORDER BY c\.created_at DESC,\s*c\.complaint_id DESC\s*LIMIT 5/i);
  assert.doesNotMatch(RECENT_COMPLAINTS_SQL, /WHERE/i);

  const origQuery = pool.query;
  const globalRows = ['CMP-0008', 'CMP-0007', 'CMP-0006', 'CMP-0005', 'CMP-0004', 'CMP-0003'].map((id, i) => ({
    complaint_id: id,
    student_id: `STU-000${i + 1}`,
    student_name: `Student ${i + 1}`,
    category: 'Hostel',
    description: `Complaint ${id}`,
    priority: 'High',
    status: 'Pending',
    created_at: `2026-11-11T1${5 - i}:00:00.000Z`,
  }));

  pool.query = async (sql, params) => {
    if (/ORDER BY c\.created_at DESC,\s*c\.complaint_id DESC\s*LIMIT 5/i.test(sql)) {
      assert.doesNotMatch(sql, /WHERE/i);
      assert.equal(params, undefined);
      return { rows: globalRows.slice(0, 5) };
    }
    if (/FROM public\.complaint\b/i.test(sql) && /total/i.test(sql)) {
      return { rows: [{ total: 0, pending: 0, assigned: 0, in_progress: 0, resolved: 0 }] };
    }
    if (/pending_staff/i.test(sql)) {
      return { rows: [{ students: 0, staff: 0, pending_staff: 0 }] };
    }
    return { rows: [] };
  };

  try {
    const fetchDash = async (mountPath, router, sessionObj) => withServer(
      createRoleTestServer(mountPath, router, sessionObj),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}${mountPath}/dashboard`);
        assert.equal(res.status, 200);
        return res.json();
      }
    );

    const [adminDash, staffDash, studentDash] = await Promise.all([
      fetchDash('/api/admin', adminRouter, { admin: { id: 'ADM-0001' } }),
      fetchDash('/api/staff', staffRouter, { staff: { id: 'STF-0001' } }),
      fetchDash('/api/student', studentRouter, { student: { id: 'STU-0099' } }),
    ]);

    const expectedIds = ['CMP-0008', 'CMP-0007', 'CMP-0006', 'CMP-0005', 'CMP-0004'];
    assert.deepEqual(adminDash.recentComplaints.map((r) => r.complaintId), expectedIds);
    assert.deepEqual(staffDash.recentComplaints.map((r) => r.complaintId), expectedIds);
    assert.deepEqual(studentDash.recentComplaints.map((r) => r.complaintId), expectedIds);
  } finally {
    pool.query = origQuery;
  }
});

test('Student dashboard summary cards count only owner complaints and exclude joined complaints', async () => {
  const origQuery = pool.query;

  // Mock complaints in database:
  // STU-0001 owns:
  // - CMP-0001: Assigned
  // - CMP-0002: Pending
  // STU-0002 owns:
  // - CMP-0003: In Progress (joined by STU-0001 in complaint_member)
  // - CMP-0004: Resolved (joined by STU-0001 in complaint_member)
  const complaintsTable = [
    { complaint_id: 'CMP-0001', student_id: 'STU-0001', status: 'Assigned' },
    { complaint_id: 'CMP-0002', student_id: 'STU-0001', status: 'Pending' },
    { complaint_id: 'CMP-0003', student_id: 'STU-0002', status: 'In Progress' },
    { complaint_id: 'CMP-0004', student_id: 'STU-0002', status: 'Resolved' },
  ];

  pool.query = async (sql, params) => {
    if (sql.includes('FROM complaint') && sql.includes('WHERE student_id = $1')) {
      const studentId = params[0];
      assert.equal(studentId, 'STU-0001');
      assert.doesNotMatch(sql, /complaint_member/i);
      const owned = complaintsTable.filter((c) => c.student_id === studentId);
      const total = owned.length;
      const pending = owned.filter((c) => c.status === 'Pending' || c.status === 'Assigned').length;
      const inProgress = owned.filter((c) => c.status === 'In Progress').length;
      const resolved = owned.filter((c) => c.status === 'Resolved').length;
      return {
        rows: [
          {
            total_complaints: total,
            pending_complaints: pending,
            in_progress_complaints: inProgress,
            resolved_complaints: resolved,
          },
        ],
      };
    }
    if (sql.includes('ORDER BY c.created_at DESC')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query in mock: ${sql}`);
  };

  try {
    await withServer(
      createRoleTestServer('/api/student', studentRouter, { student: { id: 'STU-0001' } }),
      async (baseUrl) => {
        // Initial state:
        // STU-0001 owns 1 Assigned, 1 Pending, and joined 2 complaints (In Progress & Resolved)
        // Expected: Total = 2, Pending = 2 (Pending + Assigned), In Progress = 0, Resolved = 0
        const res1 = await fetch(`${baseUrl}/api/student/dashboard`);
        assert.equal(res1.status, 200);
        assert.equal(res1.headers.get('cache-control'), 'no-store');
        const data1 = await res1.json();
        assert.equal(data1.totalComplaints, 2);
        assert.equal(data1.pendingComplaints, 2);
        assert.equal(data1.inProgressComplaints, 0);
        assert.equal(data1.resolvedComplaints, 0);

        // Transition CMP-0002 (owned by STU-0001) from Pending to In Progress
        const ownedPending = complaintsTable.find((c) => c.complaint_id === 'CMP-0002');
        ownedPending.status = 'In Progress';

        const res2 = await fetch(`${baseUrl}/api/student/dashboard`);
        assert.equal(res2.status, 200);
        const data2 = await res2.json();
        assert.equal(data2.totalComplaints, 2);
        assert.equal(data2.pendingComplaints, 1);
        assert.equal(data2.inProgressComplaints, 1);
        assert.equal(data2.resolvedComplaints, 0);

        // Transition CMP-0002 from In Progress to Resolved
        ownedPending.status = 'Resolved';

        const res3 = await fetch(`${baseUrl}/api/student/dashboard`);
        assert.equal(res3.status, 200);
        const data3 = await res3.json();
        assert.equal(data3.totalComplaints, 2);
        assert.equal(data3.pendingComplaints, 1);
        assert.equal(data3.inProgressComplaints, 0);
        assert.equal(data3.resolvedComplaints, 1);

        // Assigned complaint CMP-0001 transitions to In Progress
        const ownedAssigned = complaintsTable.find((c) => c.complaint_id === 'CMP-0001');
        ownedAssigned.status = 'In Progress';

        const res4 = await fetch(`${baseUrl}/api/student/dashboard`);
        assert.equal(res4.status, 200);
        const data4 = await res4.json();
        assert.equal(data4.totalComplaints, 2);
        assert.equal(data4.pendingComplaints, 0);
        assert.equal(data4.inProgressComplaints, 1);
        assert.equal(data4.resolvedComplaints, 1);
      }
    );
  } finally {
    pool.query = origQuery;
  }

  const studentDashHtml = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'student_dashboard.html'),
    'utf8'
  );
  assert.match(studentDashHtml, /studentTotalComplaints/);
  assert.match(studentDashHtml, /studentPendingComplaints/);
  assert.match(studentDashHtml, /studentProgressComplaints/);
  assert.match(studentDashHtml, /studentResolvedComplaints/);
  assert.match(studentDashHtml, /data\.totalComplaints/);
  assert.match(studentDashHtml, /data\.pendingComplaints/);
  assert.match(studentDashHtml, /data\.inProgressComplaints/);
  assert.match(studentDashHtml, /data\.resolvedComplaints/);
});
