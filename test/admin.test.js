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

test('GET /api/admin/staff-for-category matches department with TRIM(UPPER), preserves Active filter, and sorts by pending ASC, total ASC, staff_name', async () => {
  const origQuery = pool.query;

  const mockStaff = [
    // Eligible Hostel staff (varied casing, leading/trailing whitespace, varied workloads)
    { staff_id: 'STF-0001', staff_name: 'Zara Patel', department: 'Hostel', status: 'Active' },          // pending 0, total 4 (4 resolved)
    { staff_id: 'STF-0002', staff_name: 'Vikram Das', department: '  hostel  ', status: 'Active' },      // pending 0, total 1 (1 resolved)
    { staff_id: 'STF-0003', staff_name: 'Ananya Sen', department: 'HOSTEL', status: 'Active' },          // pending 1, total 2
    { staff_id: 'STF-0004', staff_name: 'Bhaskar Roy', department: 'HoStEl ', status: 'Active' },        // pending 1, total 2 (tie with Ananya -> name order)
    { staff_id: 'STF-0005', staff_name: 'Deepak Nair', department: ' Hostel', status: 'Active' },        // pending 1, total 5
    { staff_id: 'STF-0006', staff_name: 'Arjun Mehta', department: 'Hostel', status: 'Active' },         // pending 2, total 2
    // Ineligible Hostel staff (Inactive / Pending)
    { staff_id: 'STF-0007', staff_name: 'Inactive Hostel', department: 'Hostel', status: 'Inactive' },
    { staff_id: 'STF-0008', staff_name: 'Pending Hostel', department: 'Hostel', status: 'Pending' },
    // Different department (Active)
    { staff_id: 'STF-0009', staff_name: 'Library Staff', department: 'Library', status: 'Active' },
  ];

  const mockComplaints = [
    // Zara: 0 pending, 4 total (all resolved, mixed case)
    { complaint_id: 'CMP-1', assigned_staff_id: 'STF-0001', status: 'Resolved' },
    { complaint_id: 'CMP-2', assigned_staff_id: 'STF-0001', status: 'resolved' },
    { complaint_id: 'CMP-3', assigned_staff_id: 'STF-0001', status: 'Resolved' },
    { complaint_id: 'CMP-4', assigned_staff_id: 'STF-0001', status: 'Resolved' },
    // Vikram: 0 pending, 1 total
    { complaint_id: 'CMP-5', assigned_staff_id: 'STF-0002', status: 'Resolved' },
    // Ananya: 1 pending (Assigned), 2 total
    { complaint_id: 'CMP-6', assigned_staff_id: 'STF-0003', status: 'Assigned' },
    { complaint_id: 'CMP-7', assigned_staff_id: 'STF-0003', status: 'Resolved' },
    // Bhaskar: 1 pending (In Progress), 2 total
    { complaint_id: 'CMP-8', assigned_staff_id: 'STF-0004', status: 'In Progress' },
    { complaint_id: 'CMP-9', assigned_staff_id: 'STF-0004', status: 'Resolved' },
    // Deepak: 1 pending (in progress lowercase), 5 total
    { complaint_id: 'CMP-10', assigned_staff_id: 'STF-0005', status: 'in progress' },
    { complaint_id: 'CMP-11', assigned_staff_id: 'STF-0005', status: 'Resolved' },
    { complaint_id: 'CMP-12', assigned_staff_id: 'STF-0005', status: 'Resolved' },
    { complaint_id: 'CMP-13', assigned_staff_id: 'STF-0005', status: 'Resolved' },
    { complaint_id: 'CMP-14', assigned_staff_id: 'STF-0005', status: 'Resolved' },
    // Arjun: 2 pending (Assigned + In Progress), 2 total
    { complaint_id: 'CMP-15', assigned_staff_id: 'STF-0006', status: 'Assigned' },
    { complaint_id: 'CMP-16', assigned_staff_id: 'STF-0006', status: 'In Progress' },
  ];

  let queryCount = 0;
  pool.query = async (sql, params = []) => {
    queryCount += 1;
    // Verify exact JSP parity SQL clauses
    assert.match(sql, /TRIM\(UPPER\(s\.department\)\)\s*=\s*TRIM\(UPPER\(\$1\)\)/);
    assert.match(sql, /s\.status\s*=\s*'Active'/);
    assert.match(sql, /FILTER\s*\(WHERE LOWER\(c\.status\) IN \('assigned',\s*'in progress'\)\)::int AS pending/);
    assert.match(sql, /COUNT\(c\.complaint_id\)::int AS total/);
    assert.match(sql, /ORDER BY pending ASC,\s*total ASC,\s*s\.staff_name ASC,\s*s\.staff_id ASC/);

    const targetDept = String(params[0] || '').trim().toUpperCase();
    const matched = mockStaff
      .filter((s) => s.status === 'Active' && String(s.department || '').trim().toUpperCase() === targetDept)
      .map((s) => {
        const assigned = mockComplaints.filter((c) => c.assigned_staff_id === s.staff_id);
        const pending = assigned.filter((c) => ['assigned', 'in progress'].includes(String(c.status || '').toLowerCase())).length;
        return {
          staff_id: s.staff_id,
          staff_name: s.staff_name,
          total: assigned.length,
          pending,
        };
      })
      .sort((a, b) => (
        a.pending - b.pending
        || a.total - b.total
        || a.staff_name.localeCompare(b.staff_name)
        || a.staff_id.localeCompare(b.staff_id)
      ));

    return { rows: matched };
  };

  const server = http.createServer(createAdminTestServer());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // 1, 2, 3, 4, 5, 6, 7: Mixed-case & whitespace query matches Hostel staff only, excludes Inactive/Pending/other depts,
    // and orders by pending ASC, total ASC, staff_name ASC
    const res = await fetch(`${baseUrl}/api/admin/staff-for-category?category=${encodeURIComponent('  hOsTeL  ')}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.staff, [
      { staffId: 'STF-0002', staffName: 'Vikram Das', total: 1, pending: 0 },
      { staffId: 'STF-0001', staffName: 'Zara Patel', total: 4, pending: 0 },
      { staffId: 'STF-0003', staffName: 'Ananya Sen', total: 2, pending: 1 },
      { staffId: 'STF-0004', staffName: 'Bhaskar Roy', total: 2, pending: 1 },
      { staffId: 'STF-0005', staffName: 'Deepak Nair', total: 5, pending: 1 },
      { staffId: 'STF-0006', staffName: 'Arjun Mehta', total: 2, pending: 2 },
    ]);

    // 8a: Department with no eligible staff returns empty list
    const noneRes = await fetch(`${baseUrl}/api/admin/staff-for-category?category=Transport`);
    assert.equal(noneRes.status, 200);
    assert.deepEqual(await noneRes.json(), { staff: [] });

    // 8b: Missing or whitespace-only category returns empty list without hitting DB
    const countBeforeEmpty = queryCount;
    const emptyRes = await fetch(`${baseUrl}/api/admin/staff-for-category?category=${encodeURIComponent('   ')}`);
    assert.equal(emptyRes.status, 200);
    assert.deepEqual(await emptyRes.json(), { staff: [] });
    assert.equal(queryCount, countBeforeEmpty);
  } finally {
    pool.query = origQuery;
    await new Promise((r) => server.close(r));
  }
});

test('GET /api/admin/staff-for-category requires admin authorization and rejects unauthenticated callers with 401', async () => {
  const unauthApp = express();
  unauthApp.use(express.json());
  unauthApp.use((req, _res, next) => {
    req.session = {};
    next();
  });
  unauthApp.use('/api/admin', adminRouter);

  const server = http.createServer(unauthApp);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/staff-for-category?category=Hostel`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.redirect, '/HTML/ADMIN/admin_login.html');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('students.html renders XSS payloads strictly as text without innerHTML and preserves normal rendering, search, pagination, and status toggle', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'students.html'), 'utf8');

  // Verify no innerHTML assignments remain in students.html
  assert.doesNotMatch(html, /\.innerHTML\b/, 'students.html must not use innerHTML');

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2, 'Expected main inline script and status-form submit script in students.html');

  // Minimal DOM implementation that forbids innerHTML and tracks actual child node trees
  function createNode(tagName, id = null) {
    const listeners = {};
    const children = [];
    let text = '';
    const node = {
      tagName: String(tagName).toUpperCase(),
      id,
      className: '',
      value: '',
      name: '',
      type: '',
      method: '',
      disabled: false,
      colSpan: 1,
      style: {},
      dataset: {},
      children,
      classList: {
        toggle() {},
        remove() {},
        contains(cls) {
          return String(node.className || '').split(/\s+/).includes(cls);
        },
      },
      get innerHTML() {
        throw new Error('Reading innerHTML is disallowed in safe DOM test');
      },
      set innerHTML(_val) {
        throw new Error('Assigning innerHTML is disallowed (XSS vector)');
      },
      get textContent() {
        if (children.length === 0) return text;
        return children.map((c) => c.textContent).join('');
      },
      set textContent(val) {
        children.length = 0;
        text = val === null || val === undefined ? '' : String(val);
      },
      appendChild(child) {
        children.push(child);
        return child;
      },
      contains() { return false; },
      addEventListener(type, fn) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      dispatch(type, evt = {}) {
        (listeners[type] || []).forEach((fn) => fn.call(node, evt));
      },
      querySelector(sel) {
        const nameMatch = sel.match(/^\[name=([^\]]+)\]$/);
        const stack = [...children];
        while (stack.length) {
          const cur = stack.shift();
          if (nameMatch && cur.name === nameMatch[1]) return cur;
          if (cur.children && cur.children.length) stack.unshift(...cur.children);
        }
        return null;
      },
    };
    return node;
  }

  function createTextNode(value) {
    return {
      tagName: '#TEXT',
      textContent: String(value),
      children: [],
    };
  }

  function collectTags(node, out = []) {
    out.push(node.tagName);
    for (const c of node.children || []) collectTags(c, out);
    return out;
  }

  const elements = {
    profileTrigger: createNode('div', 'profileTrigger'),
    profileDropdown: createNode('div', 'profileDropdown'),
    adminName: createNode('h4', 'adminName'),
    adminMobile: createNode('span', 'adminMobile'),
    adminEmail: createNode('span', 'adminEmail'),
    allStudentsData: createNode('tbody', 'allStudentsData'),
    pageInfo: createNode('span', 'pageInfo'),
    prevBtn: createNode('button', 'prevBtn'),
    nextBtn: createNode('button', 'nextBtn'),
    adminSearchInput: createNode('input', 'adminSearchInput'),
  };

  const xssName = '<img src=x onerror=alert(1)>';
  const xssEmail = 'attacker+<script>alert(1)</script>@gmail.com';
  const xssMobile = '<svg onload=alert(1)>';
  const xssId = 'STU-" onfocus=alert(1) autofocus="';
  const xssStatus = '<script>alert(1)</script>';
  const xssAdminEmail = 'admin+<img src=x onerror=alert(1)>@gmail.com';

  const fixtureStudents = [
    {
      studentId: xssId,
      studentName: xssName,
      mobile: xssMobile,
      email: xssEmail,
      totalComplaint: 3,
      pending: 1,
      assigned: 1,
      inProgress: 0,
      resolved: 1,
      status: xssStatus,
    },
    {
      studentId: 'STU-0001',
      studentName: 'Subham Kumar Dash',
      mobile: '9876543210',
      email: 'subham@gmail.com',
      totalComplaint: 5,
      pending: 1,
      assigned: 2,
      inProgress: 1,
      resolved: 1,
      status: 'Active',
    },
    { studentId: 'STU-0002', studentName: 'Devi Prasad', mobile: '9123456780', email: 'devi@gmail.com', totalComplaint: 2, pending: 0, assigned: 0, inProgress: 1, resolved: 1, status: 'Active' },
    { studentId: 'STU-0003', studentName: 'Riya Sen', mobile: '9123456781', email: 'riya@gmail.com', totalComplaint: 1, pending: 1, assigned: 0, inProgress: 0, resolved: 0, status: 'Blocked' },
    { studentId: 'STU-0004', studentName: 'Karan Verma', mobile: '9123456782', email: 'karan@gmail.com', totalComplaint: 0, pending: 0, assigned: 0, inProgress: 0, resolved: 0, status: 'Active' },
    { studentId: 'STU-0005', studentName: 'Meera Nair', mobile: '9123456783', email: 'meera@gmail.com', totalComplaint: 4, pending: 2, assigned: 1, inProgress: 1, resolved: 0, status: 'Active' },
    { studentId: 'STU-0006', studentName: 'Anil Das', mobile: '9123456784', email: 'anil@gmail.com', totalComplaint: 1, pending: 0, assigned: 0, inProgress: 0, resolved: 1, status: 'Active' },
  ];

  const docListeners = {};
  const gmsPostCalls = [];
  const alerts = [];
  let reloadCount = 0;

  const sandbox = {
    console,
    URLSearchParams,
    alert(msg) { alerts.push(msg); },
    document: {
      title: 'Manage Students - GMS',
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => createNode(tag),
      createTextNode: (val) => createTextNode(val),
      addEventListener(type, fn) {
        docListeners[type] = docListeners[type] || [];
        docListeners[type].push(fn);
      },
    },
    window: {
      location: {
        search: '',
        pathname: '/HTML/ADMIN/students.html',
        reload() { reloadCount += 1; },
      },
      history: { replaceState() {} },
    },
    fetch(url) {
      if (url === '/api/admin/profile') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ adminName: 'Super Admin', mobile: '9000000000', email: xssAdminEmail }),
        });
      }
      if (url === '/api/admin/students') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ students: fixtureStudents }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    },
    GMS: {
      post(url, body) {
        gmsPostCalls.push({ url, body });
        return Promise.resolve({ ok: true, message: 'Status updated.' });
      },
    },
  };

  vm.runInNewContext(scripts[0], sandbox);
  vm.runInNewContext(scripts[1], sandbox);
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // 1. Admin email renders safely with <wbr> and ZERO injected <img>/<script> tags
  const adminEmailTags = collectTags(elements.adminEmail);
  assert.deepEqual(adminEmailTags, ['SPAN', '#TEXT', 'WBR', '#TEXT']);
  assert.equal(elements.adminEmail.textContent, xssAdminEmail);

  // 2. Table body contains ZERO injected <img>, <script>, or <svg> elements anywhere
  const tbodyTags = collectTags(elements.allStudentsData);
  assert.ok(!tbodyTags.includes('IMG'), 'Injected <img> payload must not create IMG elements');
  assert.ok(!tbodyTags.includes('SCRIPT'), 'Injected <script> payload must not create SCRIPT elements');
  assert.ok(!tbodyTags.includes('SVG'), 'Injected <svg> payload must not create SVG elements');

  // 3. First row preserves literal XSS strings as textContent and safe hidden input value
  assert.equal(elements.allStudentsData.children.length, 6);
  const xssRow = elements.allStudentsData.children[0];
  assert.equal(xssRow.children[0].textContent, xssId);
  assert.equal(xssRow.children[1].textContent, xssName);
  assert.equal(xssRow.children[2].textContent, xssMobile);
  assert.equal(xssRow.children[3].textContent, xssEmail);
  assert.equal(xssRow.children[9].children[0].textContent, xssStatus);
  assert.equal(xssRow.children[9].children[0].className, 'badge badge-inactive');
  const xssForm = xssRow.children[10].children[0];
  assert.equal(xssForm.querySelector('[name=student_id]').value, xssId);

  // 4. Normal student row renders formatted mobile, counts, active badge, and Inactive button
  const normalRow = elements.allStudentsData.children[1];
  assert.equal(normalRow.children[0].textContent, 'STU-0001');
  assert.equal(normalRow.children[1].textContent, 'Subham Kumar Dash');
  assert.equal(normalRow.children[2].textContent, '987-654-3210');
  assert.equal(normalRow.children[3].textContent, 'subham@gmail.com');
  assert.equal(normalRow.children[4].textContent, '5');
  assert.equal(normalRow.children[5].textContent, '1');
  assert.equal(normalRow.children[6].textContent, '2');
  assert.equal(normalRow.children[7].textContent, '1');
  assert.equal(normalRow.children[8].textContent, '1');
  assert.equal(normalRow.children[9].children[0].textContent, 'Active');
  assert.equal(normalRow.children[9].children[0].className, 'badge badge-active');
  const normalForm = normalRow.children[10].children[0];
  const normalBtn = normalForm.children[1];
  assert.equal(normalBtn.value, 'inactive');
  assert.equal(normalBtn.textContent.trim(), 'Inactive');

  // 5. Pagination works across 7 students (6 on page 1, 1 on page 2)
  assert.equal(elements.pageInfo.textContent, 'Page 1 of 2');
  assert.equal(elements.prevBtn.disabled, true);
  assert.equal(elements.nextBtn.disabled, false);

  elements.nextBtn.dispatch('click');
  assert.equal(elements.allStudentsData.children.length, 1);
  assert.equal(elements.allStudentsData.children[0].children[0].textContent, 'STU-0006');
  assert.equal(elements.pageInfo.textContent, 'Page 2 of 2');
  assert.equal(elements.prevBtn.disabled, false);
  assert.equal(elements.nextBtn.disabled, true);

  elements.prevBtn.dispatch('click');
  assert.equal(elements.allStudentsData.children.length, 6);
  assert.equal(elements.pageInfo.textContent, 'Page 1 of 2');

  // 6. Search filtering & empty state work cleanly
  elements.adminSearchInput.value = 'subham';
  elements.adminSearchInput.dispatch('keyup');
  assert.equal(elements.allStudentsData.children.length, 1);
  assert.equal(elements.allStudentsData.children[0].children[0].textContent, 'STU-0001');
  assert.equal(elements.pageInfo.textContent, 'Page 1 of 1');

  elements.adminSearchInput.value = 'nonexistent-xyz';
  elements.adminSearchInput.dispatch('keyup');
  assert.equal(elements.allStudentsData.children.length, 1);
  assert.equal(elements.allStudentsData.children[0].children[0].textContent, 'No Students Found');

  // 7. Status toggle submission safely URL-encodes student_id and posts expected action
  let prevented = false;
  (docListeners.submit || []).forEach((fn) => fn({
    target: xssForm,
    submitter: xssForm.children[1],
    preventDefault() { prevented = true; },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(gmsPostCalls)), [
    {
      url: `/api/admin/students/${encodeURIComponent(xssId)}/status`,
      body: { action: 'active' },
    },
  ]);
  assert.deepEqual(alerts, ['Status updated.']);
  assert.equal(reloadCount, 1);
});

test('GET /api/admin/students and POST /api/admin/students/:id/status reject unauthenticated requests with 401', async () => {
  const unauthApp = express();
  unauthApp.use(express.json());
  unauthApp.use((req, _res, next) => {
    req.session = {};
    next();
  });
  unauthApp.use('/api/admin', adminRouter);

  const server = http.createServer(unauthApp);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const listRes = await fetch(`${baseUrl}/api/admin/students`);
    assert.equal(listRes.status, 401);
    assert.equal((await listRes.json()).redirect, '/HTML/ADMIN/admin_login.html');

    const statusRes = await fetch(`${baseUrl}/api/admin/students/STU-0001/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'inactive' }),
    });
    assert.equal(statusRes.status, 401);
    assert.equal((await statusRes.json()).redirect, '/HTML/ADMIN/admin_login.html');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('admin_change_password.html hides unused search bar via hide-search-page while preserving navbar, logout, and password form behavior', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'admin_change_password.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'CSS', 'style.css'), 'utf8');

  // 1. Structural & CSS rule verification: body has hide-search-page, navbar-search wraps adminSearchInput, and style.css hides it
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\.\/\.\.\/CSS\/style\.css">/i);
  assert.match(html, /<body\s+class="[^"]*\bhide-search-page\b[^"]*">/i);
  assert.match(html, /<div\s+class="navbar-search">\s*<input[^>]+id="adminSearchInput"[^>]*>\s*<\/div>/is);
  assert.match(css, /\.hide-search-page\s+\.navbar-search\s*\{\s*display\s*:\s*none\s*;\s*\}/i);

  // 2. Navbar, profile dropdown, logout link, gms-api.js, and password form inputs remain intact
  assert.match(html, /id="profileTrigger"/);
  assert.match(html, /id="profileDropdown"/);
  assert.match(html, /<a\s+href="\.\.\/\.\.\/Home\.html"\s+class="logout-link">/i);
  assert.match(html, /<script\s+src="\/gms-api\.js"><\/script>/i);
  assert.match(html, /<form\s+id="passwordForm"\s+action="\/api\/admin\/password"\s+method="POST"/i);
  assert.match(html, /id="admin_current_password"[^>]+name="admin_current_password"/i);
  assert.match(html, /id="admin_new_password"[^>]+name="admin_new_password"/i);
  assert.match(html, /id="admin_conform_password"[^>]+name="admin_conform_password"/i);

  // 3. Execute inline script and form onsubmit handler in VM to verify validation, togglePassword, and submission
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Expected inline script in admin_change_password.html');
  const onsubmitMatch = html.match(/<form\s+id="passwordForm"[^>]*onsubmit="([^"]+)"/i);
  assert.ok(onsubmitMatch, 'Expected onsubmit handler on #passwordForm');

  function makeInput(value = '', type = 'password') {
    const listeners = {};
    return {
      value,
      type,
      style: {},
      textContent: '',
      innerHTML: '',
      addEventListener(evt, fn) { listeners[evt] = fn; },
      dispatch(evt) { if (listeners[evt]) listeners[evt](); },
    };
  }

  const elements = {
    profileDropdown: { classList: { toggle() {}, remove() {} }, contains: () => false },
    adminName: makeInput(),
    adminMobile: makeInput(),
    adminEmail: makeInput(),
    currentError: makeInput(),
    lenError: makeInput(),
    matchError: makeInput(),
    admin_current_password: makeInput(),
    admin_new_password: makeInput(),
    admin_conform_password: makeInput(),
  };

  const alerts = [];
  const postCalls = [];
  const goCalls = [];
  const docListeners = {};

  const sandbox = {
    URLSearchParams,
    alert(msg) { alerts.push(msg); },
    document: {
      title: 'Change Password - GMS Admin',
      getElementById: (id) => elements[id] || null,
      querySelector: (sel) => (sel === '.navbar-profile'
        ? { addEventListener() {}, classList: { toggle() {}, remove() {} }, contains: () => false }
        : null),
      addEventListener(evt, fn) { docListeners[evt] = fn; },
    },
    window: {
      location: { search: '', pathname: '/HTML/ADMIN/admin_change_password.html' },
      history: { replaceState() {} },
    },
    fetch() {
      return Promise.resolve({
        json: () => Promise.resolve({ adminName: 'Super Admin', mobile: '9000000000', email: 'admin@gmail.com' }),
      });
    },
    GMS: {
      formData: () => ({
        admin_current_password: elements.admin_current_password.value,
        admin_new_password: elements.admin_new_password.value,
        admin_conform_password: elements.admin_conform_password.value,
      }),
      post(url, body) {
        postCalls.push({ url, body });
        return Promise.resolve({ ok: true, message: 'Password changed.', redirect: '/HTML/ADMIN/admin_dashboard.html' });
      },
      go(url) { goCalls.push(url); },
    },
  };

  vm.runInNewContext(scriptMatch[1], sandbox);
  if (docListeners.DOMContentLoaded) docListeners.DOMContentLoaded();
  await new Promise((resolve) => setImmediate(resolve));

  // togglePassword flips type between password and text
  const iconClasses = new Set(['fa-eye']);
  const fakeIcon = { classList: { remove: (c) => iconClasses.delete(c), add: (c) => iconClasses.add(c) } };
  sandbox.togglePassword('admin_new_password', fakeIcon);
  assert.equal(elements.admin_new_password.type, 'text');
  assert.equal(iconClasses.has('fa-eye-slash'), true);
  sandbox.togglePassword('admin_new_password', fakeIcon);
  assert.equal(elements.admin_new_password.type, 'password');

  // Short new password rejected with lenError shown
  elements.admin_current_password.value = 'oldpass123';
  elements.admin_new_password.value = '12345';
  elements.admin_conform_password.value = '12345';
  assert.equal(sandbox.validateFrontendForm(), false);
  assert.equal(elements.lenError.style.display, 'block');

  // Mismatched confirm rejected with matchError shown
  elements.admin_new_password.value = 'newpass123';
  elements.admin_conform_password.value = 'different123';
  assert.equal(sandbox.validateFrontendForm(), false);
  assert.equal(elements.matchError.style.display, 'block');

  // Same current and new password rejected
  elements.admin_new_password.value = 'oldpass123';
  elements.admin_conform_password.value = 'oldpass123';
  assert.equal(sandbox.validateFrontendForm(), false);
  assert.equal(alerts[alerts.length - 1], 'New Password cannot be the same as Current Password.');

  // Valid passwords pass validation and submit to POST /api/admin/password
  elements.admin_new_password.value = 'newpass123';
  elements.admin_conform_password.value = 'newpass123';
  const submitRunner = vm.runInNewContext(`(function(event){ ${onsubmitMatch[1]} })`, sandbox);
  let prevented = false;
  submitRunner.call({}, { preventDefault() { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(postCalls)), [
    {
      url: '/api/admin/password',
      body: {
        admin_current_password: 'oldpass123',
        admin_new_password: 'newpass123',
        admin_conform_password: 'newpass123',
      },
    },
  ]);
  assert.deepEqual(goCalls, ['/HTML/ADMIN/admin_dashboard.html']);
});



