const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const pool = require('../server/db');
const adminRouter = require('../server/routes/admin');

function createAdminTestServer(adminUser = { id: 'ADM-0001', name: 'Prakash Kumar Sahoo', email: 'prakash.sahoo@gmail.com' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: adminUser };
    next();
  });
  app.use('/api/admin', adminRouter);
  return app;
}

test('GET /api/admin/complaints formats supporter counts, Not Assigned, and real assignment metadata', async () => {
  const origQuery = pool.query;
  pool.query = async (sql) => {
    assert.match(sql, /COUNT\(DISTINCT cm\.student_id\) FILTER \(WHERE cm\.student_id <> c\.student_id\)/);
    assert.match(sql, /LEFT JOIN admin aa ON aa\.admin_id = c\.assigned_by/);
    return {
      rows: [
        {
          complaint_id: 'CMP-0001',
          category: 'Library',
          description: 'Need more books',
          status: 'Pending',
          created_at: '2026-11-01T10:00:00.000Z',
          updated_at: '2026-11-01T10:00:00.000Z',
          student_id: 'STU-0001',
          student_name: 'Subham Kumar Dash',
          assigned_staff_id: null,
          staff_name: null,
          assigned_by: null,
          assigned_by_name: null,
          assigned_at: null,
          ai_analysis: null,
          due_at: '2099-01-01T00:00:00.000Z',
          supporter_count: 0,
        },
        {
          complaint_id: 'CMP-0002',
          category: 'Computer Lab',
          description: 'Systems slow',
          status: 'In Progress',
          created_at: '2026-11-02T10:00:00.000Z',
          updated_at: '2026-11-03T12:00:00.000Z',
          student_id: 'STU-0002',
          student_name: 'Deviprasad Singh',
          assigned_staff_id: 'STF-0003',
          staff_name: 'Amit Kumar',
          assigned_by: 'ADM-0002',
          assigned_by_name: 'Bibek Biswal',
          assigned_at: '2026-11-03T08:00:00.000Z',
          ai_analysis: null,
          due_at: '2099-01-01T00:00:00.000Z',
          supporter_count: 1,
        },
        {
          complaint_id: 'CMP-0003',
          category: 'Hostel',
          description: 'Water issue',
          status: 'Pending',
          created_at: '2026-11-04T10:00:00.000Z',
          updated_at: '2026-11-04T10:00:00.000Z',
          student_id: 'STU-0001',
          student_name: 'Subham Kumar Dash',
          assigned_staff_id: null,
          staff_name: null,
          assigned_by: null,
          assigned_by_name: null,
          assigned_at: null,
          ai_analysis: null,
          due_at: '2099-01-01T00:00:00.000Z',
          supporter_count: 5,
        },
      ],
    };
  };

  const server = http.createServer(createAdminTestServer());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/complaints`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.complaints[0].supportedBy, '0 Students');
    assert.equal(data.complaints[0].staffName, 'Not Assigned');
    assert.equal(data.complaints[0].assignedBy, '');
    assert.equal(data.complaints[0].assignedAt, '');
    assert.equal(data.complaints[1].supportedBy, '1 Student');
    assert.equal(data.complaints[1].staffName, 'Amit Kumar');
    assert.equal(data.complaints[1].assignedBy, 'Bibek Biswal');
    assert.equal(data.complaints[1].assignedAt, '2026-11-03');
    assert.equal(data.complaints[2].supportedBy, '5 Students');
  } finally {
    pool.query = origQuery;
    await new Promise((r) => server.close(r));
  }
});

test('GET /api/admin/staff returns admin name via created_by and formatted created_at or Not Available fallback', async () => {
  const origQuery = pool.query;
  let callIndex = 0;
  pool.query = async (sql) => {
    callIndex += 1;
    if (callIndex === 1) {
      assert.match(sql, /LEFT JOIN admin a ON a\.admin_id = s\.created_by/);
      assert.doesNotMatch(sql, /approved_by|approved_at/);
      return {
        rows: [
          {
            staff_id: 'STF-0001',
            staff_name: 'Rakesh Sharma',
            mobile: '9938543462',
            email: 'rakesh12@gmail.com',
            department: 'IT & Network Support',
            rating: '0.00',
            status: 'Active',
            created_by: 'ADM-0001',
            created_at: '2026-07-26T00:00:00.000Z',
            created_by_name: 'Prakash Kumar Sahoo',
            total: 0,
            pending: 0,
            in_progress: 0,
            resolved: 0,
          },
          {
            staff_id: 'STF-0034',
            staff_name: 'Approved Member',
            mobile: '9876543210',
            email: 'approved@gmail.com',
            department: 'Library',
            rating: '0.00',
            status: 'Active',
            created_by: 'ADM-0002',
            created_at: '2026-11-11T09:30:00.000Z',
            created_by_name: 'Bibek Biswal',
            total: 2,
            pending: 1,
            in_progress: 1,
            resolved: 0,
          },
          {
            staff_id: 'STF-0035',
            staff_name: 'Unmatched Record',
            mobile: '9876543211',
            email: 'unmatched@gmail.com',
            department: 'Hostel',
            rating: '0.00',
            status: 'Active',
            created_by: 'ADM-9999',
            created_at: null,
            created_by_name: null,
            total: 0,
            pending: 0,
            in_progress: 0,
            resolved: 0,
          },
        ],
      };
    }
    return { rows: [] };
  };

  const server = http.createServer(createAdminTestServer());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/staff`);
    assert.equal(res.status, 200);
    const data = await res.json();
    const seeded = data.staff.find((s) => s.staffId === 'STF-0001');
    const approved = data.staff.find((s) => s.staffId === 'STF-0034');
    const unmatched = data.staff.find((s) => s.staffId === 'STF-0035');
    assert.equal(seeded.addedBy, 'Prakash Kumar Sahoo');
    assert.equal(seeded.approvedOn, '2026-07-26');
    assert.equal(approved.addedBy, 'Bibek Biswal');
    assert.equal(approved.approvedOn, '2026-11-11');
    assert.equal(unmatched.addedBy, 'Not Available');
    assert.equal(unmatched.approvedOn, 'Not Available');
  } finally {
    pool.query = origQuery;
    await new Promise((r) => server.close(r));
  }
});

test('Admin HTML templates remove robot icon / clickable complaint ID and load gms-tooltip.js', () => {
  const complaintsHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'view_complaints.html'), 'utf8');
  assert.doesNotMatch(complaintsHtml, /fa-robot/);
  assert.doesNotMatch(complaintsHtml, /timeline-open/);
  assert.match(complaintsHtml, /src="\/gms-tooltip\.js"/);
  assert.match(complaintsHtml, /Assigned By/);
  assert.match(complaintsHtml, /Assigned On/);

  const staffHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'staff.html'), 'utf8');
  assert.match(staffHtml, /src="\/gms-tooltip\.js"/);
  assert.match(staffHtml, /Added By/);
  assert.match(staffHtml, /Approved On/);
});
