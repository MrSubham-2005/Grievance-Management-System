const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const pool = require('../server/db');
const app = require('../server/app');
const authRouter = require('../server/routes/auth');
const studentRouter = require('../server/routes/student');

function createAuthTestServer() {
  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      name: 'gms.sid',
    })
  );
  testApp.use('/api/auth', authRouter);
  return testApp;
}

function createStudentTestServer(studentSession) {
  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      name: 'gms.sid',
    })
  );
  testApp.use((req, res, next) => {
    if (studentSession) {
      req.session.student = studentSession;
    }
    next();
  });
  testApp.use('/api/student', studentRouter);
  return testApp;
}

async function withServer(appToRun, fn) {
  const server = http.createServer(appToRun);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/auth/admin/signup is rejected with 404 and does not trigger registration', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/admin/signup`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /No such endpoint: GET \/api\/auth\/admin\/signup/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('nextId generates hyphenated ADM-0009 and STU-0003 formats', async () => {
  const adminDb = {
    async query(sql, params) {
      assert.match(sql, /SUBSTRING\(admin_id FROM '\(\[0-9\]\+\)\$'\)/);
      assert.deepEqual(params, ['^ADM-?[0-9]+$']);
      return { rows: [{ n: 8 }] };
    },
  };
  assert.equal(await authRouter.nextId('admin', 'admin_id', 'ADM', adminDb), 'ADM-0009');

  const studentDb = {
    async query(sql, params) {
      assert.match(sql, /SUBSTRING\(student_id FROM '\(\[0-9\]\+\)\$'\)/);
      assert.deepEqual(params, ['^STU-?[0-9]+$']);
      return { rows: [{ n: 2 }] };
    },
  };
  assert.equal(await authRouter.nextId('student', 'student_id', 'STU', studentDb), 'STU-0003');
});

test('Student, Staff and Admin login accept registered email or mobile number with session isolation', async () => {
  const origQuery = pool.query;
  const hash = await bcrypt.hash('CorrectPass123!', 10);

  const mockStudents = [
    { student_id: 'STU-0001', student_name: 'Test Student', email: 'student@example.com', mobile: '8260575858', password: hash, status: 'Active' },
  ];
  const mockStaff = [
    { staff_id: 'STF-0001', staff_name: 'Test Staff', email: 'staff@example.com', mobile: '9938543462', department: 'IT', password: hash, status: 'Active' },
  ];
  const mockAdmin = [
    { admin_id: 'ADM-0001', admin_name: 'Test Admin', email: 'admin@example.com', mobile: '8260487065', password: hash },
  ];

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff_request')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM student') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockStudents.filter(
          (s) => (s.email && s.email.toLowerCase() === String(id).toLowerCase()) || s.mobile === id
        ),
      };
    }
    if (sql.includes('FROM staff') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockStaff.filter(
          (s) => (s.email && s.email.toLowerCase() === String(id).toLowerCase()) || s.mobile === id
        ),
      };
    }
    if (sql.includes('FROM admin') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockAdmin.filter(
          (a) => (a.email && a.email.toLowerCase() === String(id).toLowerCase()) || a.mobile === id
        ),
      };
    }
    return origQuery.call(pool, sql, params);
  };

  try {
    await withServer(createAuthTestServer(), async (baseUrl) => {
      // 1. Student login via Registered Email
      const stuEmailRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'student@example.com', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(stuEmailRes.status, 200);
      const stuEmailData = await stuEmailRes.json();
      assert.equal(stuEmailData.ok, true);
      assert.equal(stuEmailData.redirect, '/HTML/STUDENTS/student_dashboard.html');
      const stuEmailCookie = stuEmailRes.headers.get('set-cookie');
      assert.ok(stuEmailCookie);

      const stuEmailSession = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: stuEmailCookie } })).json();
      assert.deepEqual(stuEmailSession, { student: true, staff: false, admin: false });

      // 2. Student login via Registered Mobile
      const stuMobileRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: '8260575858', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(stuMobileRes.status, 200);
      const stuMobileData = await stuMobileRes.json();
      assert.equal(stuMobileData.ok, true);
      assert.equal(stuMobileData.redirect, '/HTML/STUDENTS/student_dashboard.html');
      const stuMobileCookie = stuMobileRes.headers.get('set-cookie');
      assert.ok(stuMobileCookie);

      const stuMobileSession = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: stuMobileCookie } })).json();
      assert.deepEqual(stuMobileSession, { student: true, staff: false, admin: false });

      // 3. Staff login via Registered Email
      const stfEmailRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'staff@example.com', staffPassword: 'CorrectPass123!' }),
      });
      assert.equal(stfEmailRes.status, 200);
      const stfEmailData = await stfEmailRes.json();
      assert.equal(stfEmailData.ok, true);
      assert.equal(stfEmailData.redirect, '/HTML/STAFF/staff_dashboard.html');
      const stfEmailCookie = stfEmailRes.headers.get('set-cookie');
      assert.ok(stfEmailCookie);

      const stfEmailSession = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: stfEmailCookie } })).json();
      assert.deepEqual(stfEmailSession, { student: false, staff: true, admin: false });

      // 4. Staff login via Registered Mobile
      const stfMobileRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: '9938543462', staffPassword: 'CorrectPass123!' }),
      });
      assert.equal(stfMobileRes.status, 200);
      const stfMobileData = await stfMobileRes.json();
      assert.equal(stfMobileData.ok, true);
      assert.equal(stfMobileData.redirect, '/HTML/STAFF/staff_dashboard.html');
      const stfMobileCookie = stfMobileRes.headers.get('set-cookie');
      assert.ok(stfMobileCookie);

      const stfMobileSession = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: stfMobileCookie } })).json();
      assert.deepEqual(stfMobileSession, { student: false, staff: true, admin: false });

      // 5. Admin login via Registered Email
      const admEmailRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: 'admin@example.com', adminPassword: 'CorrectPass123!' }),
      });
      assert.equal(admEmailRes.status, 200);
      const admEmailData = await admEmailRes.json();
      assert.equal(admEmailData.ok, true);
      assert.equal(admEmailData.redirect, '/HTML/ADMIN/admin_dashboard.html');
      const admEmailCookie = admEmailRes.headers.get('set-cookie');
      assert.ok(admEmailCookie);

      const admEmailSession = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: admEmailCookie } })).json();
      assert.deepEqual(admEmailSession, { student: false, staff: false, admin: true });

      // 6. Admin login via Registered Mobile
      const admMobileRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: '8260487065', adminPassword: 'CorrectPass123!' }),
      });
      assert.equal(admMobileRes.status, 200);
      const admMobileData = await admMobileRes.json();
      assert.equal(admMobileData.ok, true);
      assert.equal(admMobileData.redirect, '/HTML/ADMIN/admin_dashboard.html');
      const admMobileCookie = admMobileRes.headers.get('set-cookie');
      assert.ok(admMobileCookie);

      const admMobileSession = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: admMobileCookie } })).json();
      assert.deepEqual(admMobileSession, { student: false, staff: false, admin: true });
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Login rejects invalid credentials, wrong passwords, unknown identifiers, empty fields, inactive accounts and ambiguous matches', async () => {
  const origQuery = pool.query;
  const hash = await bcrypt.hash('CorrectPass123!', 10);

  const mockStudents = [
    { student_id: 'STU-0001', student_name: 'Active Student', email: 'student@example.com', mobile: '8260575858', password: hash, status: 'Active' },
    { student_id: 'STU-0002', student_name: 'Blocked Student', email: 'blocked@example.com', mobile: '9876543210', password: hash, status: 'Blocked' },
    { student_id: 'STU-0003', student_name: 'Dup Student A', email: 'dupa@example.com', mobile: '7777777777', password: hash, status: 'Active' },
    { student_id: 'STU-0004', student_name: 'Dup Student B', email: 'dupb@example.com', mobile: '7777777777', password: hash, status: 'Active' },
  ];
  const mockStaff = [
    { staff_id: 'STF-0001', staff_name: 'Active Staff', email: 'staff@example.com', mobile: '9938543462', department: 'IT', password: hash, status: 'Active' },
    { staff_id: 'STF-0002', staff_name: 'Pending Staff', email: 'pending@example.com', mobile: '9876543211', department: 'Hostel', password: hash, status: 'Pending' },
  ];
  const mockAdmin = [
    { admin_id: 'ADM-0001', admin_name: 'Active Admin', email: 'admin@example.com', mobile: '8260487065', password: hash },
  ];

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff_request')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM student') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockStudents.filter(
          (s) => (s.email && s.email.toLowerCase() === String(id).toLowerCase()) || s.mobile === id
        ),
      };
    }
    if (sql.includes('FROM staff') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockStaff.filter(
          (s) => (s.email && s.email.toLowerCase() === String(id).toLowerCase()) || s.mobile === id
        ),
      };
    }
    if (sql.includes('FROM admin') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockAdmin.filter(
          (a) => (a.email && a.email.toLowerCase() === String(id).toLowerCase()) || a.mobile === id
        ),
      };
    }
    return origQuery.call(pool, sql, params);
  };

  try {
    await withServer(createAuthTestServer(), async (baseUrl) => {
      // Empty fields
      const emptyRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: '', studentPassword: '' }),
      });
      assert.equal(emptyRes.status, 400);
      assert.equal((await emptyRes.json()).error, 'Enter your email and password.');

      // Empty password
      const emptyPwRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'student@example.com', studentPassword: '' }),
      });
      assert.equal(emptyPwRes.status, 400);
      assert.equal((await emptyPwRes.json()).error, 'Enter your email and password.');

      // Wrong password
      const wrongPwRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'student@example.com', studentPassword: 'WrongPassword!' }),
      });
      assert.equal(wrongPwRes.status, 401);
      assert.equal((await wrongPwRes.json()).error, 'Email or password is incorrect.');

      // Unknown email
      const unknownEmailRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'unknown@example.com', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(unknownEmailRes.status, 401);
      assert.equal((await unknownEmailRes.json()).error, 'Email or password is incorrect.');

      // Unknown mobile number
      const unknownMobileRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: '9999999999', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(unknownMobileRes.status, 401);
      assert.equal((await unknownMobileRes.json()).error, 'Email or password is incorrect.');

      // Inactive / Blocked student account
      const blockedStuRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'blocked@example.com', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(blockedStuRes.status, 403);
      assert.equal((await blockedStuRes.json()).error, 'This student account is blocked. Contact the admin.');

      // Inactive / Pending staff account
      const pendingStaffRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'pending@example.com', staffPassword: 'CorrectPass123!' }),
      });
      assert.equal(pendingStaffRes.status, 403);
      assert.equal((await pendingStaffRes.json()).error, 'Your staff account is not active. Wait for admin approval.');

      // Role isolation: student credentials posted to staff and admin login
      const stuToStaffRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'student@example.com', staffPassword: 'CorrectPass123!' }),
      });
      assert.equal(stuToStaffRes.status, 401);

      const stuToAdminRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: 'student@example.com', adminPassword: 'CorrectPass123!' }),
      });
      assert.equal(stuToAdminRes.status, 401);

      // Ambiguous account matching: duplicate mobile across accounts with identical password
      const dupRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: '7777777777', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(dupRes.status, 401);
      assert.equal((await dupRes.json()).error, 'Email or password is incorrect.');
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Student, Staff, and Admin login HTML pages have text input for Mobile No / Email', () => {
  const studentHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'student_login.html'), 'utf8');
  assert.match(studentHtml, /<input[^>]+type="text"[^>]+id="studentEmail"/i);
  assert.match(studentHtml, /<label[^>]+for="studentEmail"[^>]*class="floating-label"[^>]*>\s*Mobile No \/ Email\s*<\/label>/i);

  const staffHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'staff_login.html'), 'utf8');
  assert.match(staffHtml, /<input[^>]+type="text"[^>]+id="staffEmail"/i);
  assert.match(staffHtml, /<label[^>]+for="staffEmail"[^>]*class="floating-label"[^>]*>\s*Mobile No \/ Email\s*<\/label>/i);

  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'ADMIN', 'admin_login.html'), 'utf8');
  assert.match(adminHtml, /<input[^>]+type="text"[^>]+id="adminEmail"/i);
  assert.match(adminHtml, /<label[^>]+for="adminEmail"[^>]*class="floating-label"[^>]*>\s*Mobile No \/ Email\s*<\/label>/i);
});

test('Staff login HTML handles pending approval with native alert popup and keeps email input intact', () => {
  const staffHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'HTML', 'STAFF', 'staff_login.html'), 'utf8');
  assert.match(staffHtml, /const pendingApprovalMsg\s*=\s*"Your registration request is pending Admin approval\. Please wait until your account is approved\.";/);
  assert.match(staffHtml, /alert\(pendingApprovalMsg\);/);
  assert.match(staffHtml, /passwordError\.innerHTML\s*=\s*"";/);
  assert.match(staffHtml, /passwordInput\.value\s*=\s*"";/);
});

test('Staff login pending approval, inactive status, incorrect password, and identifier lookup', async () => {
  const origQuery = pool.query;
  const hash = await bcrypt.hash('CorrectStaffPass123!', 10);

  const mockStaff = [
    { staff_id: 'STF-0001', staff_name: 'Active Staff', email: 'active_staff@example.com', mobile: '9938543462', department: 'IT', password: hash, status: 'Active' },
    { staff_id: 'STF-0002', staff_name: 'Inactive Staff', email: 'inactive_staff@example.com', mobile: '9938543463', department: 'Hostel', password: hash, status: 'Inactive' },
  ];
  const mockStaffRequests = [
    { request_id: 'REQ-0001', staff_name: 'Pending Email Staff', email: 'pending_req@example.com', mobile: '9888811111', department: 'Academic' },
    { request_id: 'REQ-0002', staff_name: 'Pending Mobile Staff', email: 'mobile_req@example.com', mobile: '9888822222', department: 'Library' },
  ];

  let staffRequestQueryCount = 0;

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff_request') && (sql.includes('LOWER(email) = LOWER($1)') || sql.includes('mobile = $1'))) {
      staffRequestQueryCount += 1;
      const id = params[0];
      const match = mockStaffRequests.some(
        (r) => (r.email && r.email.toLowerCase() === String(id).toLowerCase()) || r.mobile === id
      );
      return { rows: match ? [{ 1: 1 }] : [], rowCount: match ? 1 : 0 };
    }
    if (sql.includes('FROM staff') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockStaff.filter(
          (s) => (s.email && s.email.toLowerCase() === String(id).toLowerCase()) || s.mobile === id
        ),
      };
    }
    return origQuery.call(pool, sql, params);
  };

  try {
    await withServer(createAuthTestServer(), async (baseUrl) => {
      // 1. Active staff with correct password -> successful login (email and mobile)
      const emailSuccess = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'active_staff@example.com', staffPassword: 'CorrectStaffPass123!' }),
      });
      assert.equal(emailSuccess.status, 200);
      const emailSuccessData = await emailSuccess.json();
      assert.equal(emailSuccessData.ok, true);
      assert.equal(emailSuccessData.redirect, '/HTML/STAFF/staff_dashboard.html');

      const mobileSuccess = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: '9938543462', staffPassword: 'CorrectStaffPass123!' }),
      });
      assert.equal(mobileSuccess.status, 200);
      const mobileSuccessData = await mobileSuccess.json();
      assert.equal(mobileSuccessData.ok, true);
      assert.equal(mobileSuccessData.redirect, '/HTML/STAFF/staff_dashboard.html');

      // 2. Identifier absent from staff but present in staff_request (email) -> HTTP 403 and exact message
      const pendingEmailRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'pending_req@example.com', staffPassword: 'AnyPassword123!' }),
      });
      assert.equal(pendingEmailRes.status, 403);
      const pendingEmailData = await pendingEmailRes.json();
      assert.equal(
        pendingEmailData.error,
        'Your registration request is pending Admin approval. Please wait until your account is approved.'
      );

      // 3. Identifier absent from staff but present in staff_request (mobile) -> HTTP 403 and exact message
      const pendingMobileRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: '9888822222', staffPassword: 'AnyPassword123!' }),
      });
      assert.equal(pendingMobileRes.status, 403);
      const pendingMobileData = await pendingMobileRes.json();
      assert.equal(
        pendingMobileData.error,
        'Your registration request is pending Admin approval. Please wait until your account is approved.'
      );

      // 4. Identifier absent from both tables -> generic HTTP 401 error
      const unknownEmailRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'nonexistent@example.com', staffPassword: 'Password123!' }),
      });
      assert.equal(unknownEmailRes.status, 401);
      assert.equal((await unknownEmailRes.json()).error, 'Email or password is incorrect.');

      const unknownMobileRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: '9111111111', staffPassword: 'Password123!' }),
      });
      assert.equal(unknownMobileRes.status, 401);
      assert.equal((await unknownMobileRes.json()).error, 'Email or password is incorrect.');

      // 5. Existing staff with incorrect password -> generic HTTP 401 error, WITHOUT consulting staff_request
      const queriesBeforeWrongPw = staffRequestQueryCount;
      const wrongPwRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'active_staff@example.com', staffPassword: 'WrongPassword!' }),
      });
      assert.equal(wrongPwRes.status, 401);
      assert.equal((await wrongPwRes.json()).error, 'Email or password is incorrect.');
      // Verify staff_request was NOT queried
      assert.equal(staffRequestQueryCount, queriesBeforeWrongPw);

      // 6. Inactive staff -> existing rejection behavior (HTTP 403)
      const inactiveRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'inactive_staff@example.com', staffPassword: 'CorrectStaffPass123!' }),
      });
      assert.equal(inactiveRes.status, 403);
      assert.equal((await inactiveRes.json()).error, 'Your staff account is not active. Wait for admin approval.');
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Student registration duplicate handling: separate email/mobile messages, case-insensitivity, and success', async () => {
  const origConnect = pool.connect;
  const origQuery = pool.query;

  const mockDbStudents = [
    { email: 'existing@example.com', mobile: '9876543210' },
    { email: 'userb@example.com', mobile: '9123456789' },
  ];

  let nextIdCounter = 10;
  pool.connect = async () => {
    return {
      async query(sql, params = []) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT LOWER(email) AS email, mobile FROM student')) {
          const checkEmail = (params[0] || '').toLowerCase();
          const checkMobile = params[1] || '';
          const matched = mockDbStudents.filter(
            (s) => s.email.toLowerCase() === checkEmail || s.mobile === checkMobile
          );
          return { rows: matched, rowCount: matched.length };
        }
        if (sql.includes('SUBSTRING(student_id')) {
          return { rows: [{ n: nextIdCounter }] };
        }
        if (sql.includes('INSERT INTO student')) {
          mockDbStudents.push({ email: params[3].toLowerCase(), mobile: params[2] });
          nextIdCounter++;
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  };

  try {
    await withServer(createAuthTestServer(), async (baseUrl) => {
      // 1. Duplicate email only -> HTTP 409, "Email already registered"
      const dupEmailRes = await fetch(`${baseUrl}/api/auth/student/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: 'Test Student',
          studentMobile: '9999900001',
          studentEmail: 'existing@example.com',
          studentPassword: 'Password123!',
          securityQuestion: 'Pet?',
          securityAnswer: 'Dog',
        }),
      });
      assert.equal(dupEmailRes.status, 409);
      assert.equal((await dupEmailRes.json()).error, 'Email already registered');

      // 2. Duplicate mobile only -> HTTP 409, "Mobile Number already registered"
      const dupMobileRes = await fetch(`${baseUrl}/api/auth/student/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: 'Test Student',
          studentMobile: '9876543210',
          studentEmail: 'unique_user@example.com',
          studentPassword: 'Password123!',
          securityQuestion: 'Pet?',
          securityAnswer: 'Dog',
        }),
      });
      assert.equal(dupMobileRes.status, 409);
      assert.equal((await dupMobileRes.json()).error, 'Mobile Number already registered');

      // 3. Both duplicate (same user) -> HTTP 409, "Email already registered"
      const dupBothRes = await fetch(`${baseUrl}/api/auth/student/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: 'Test Student',
          studentMobile: '9876543210',
          studentEmail: 'existing@example.com',
          studentPassword: 'Password123!',
          securityQuestion: 'Pet?',
          securityAnswer: 'Dog',
        }),
      });
      assert.equal(dupBothRes.status, 409);
      assert.equal((await dupBothRes.json()).error, 'Email already registered');

      // Both duplicate across different users -> HTTP 409, "Email already registered"
      const dupCrossRes = await fetch(`${baseUrl}/api/auth/student/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: 'Test Student',
          studentMobile: '9123456789',
          studentEmail: 'EXISTING@EXAMPLE.COM',
          studentPassword: 'Password123!',
          securityQuestion: 'Pet?',
          securityAnswer: 'Dog',
        }),
      });
      assert.equal(dupCrossRes.status, 409);
      assert.equal((await dupCrossRes.json()).error, 'Email already registered');

      // 4. Email comparison remains case-insensitive
      const dupCaseRes = await fetch(`${baseUrl}/api/auth/student/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: 'Test Student',
          studentMobile: '9999900002',
          studentEmail: 'ExIsTiNg@ExAmPlE.cOm',
          studentPassword: 'Password123!',
          securityQuestion: 'Pet?',
          securityAnswer: 'Dog',
        }),
      });
      assert.equal(dupCaseRes.status, 409);
      assert.equal((await dupCaseRes.json()).error, 'Email already registered');

      // 5. Successful registration still works -> HTTP 201
      const successRes = await fetch(`${baseUrl}/api/auth/student/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: 'Brand New Student',
          studentMobile: '9999900003',
          studentEmail: 'brandnew@example.com',
          studentPassword: 'Password123!',
          securityQuestion: 'City?',
          securityAnswer: 'Paris',
        }),
      });
      assert.equal(successRes.status, 201);
      const successData = await successRes.json();
      assert.equal(successData.ok, true);
      assert.equal(successData.studentId, 'STU-0011');
      assert.equal(successData.redirect, '/HTML/STUDENTS/student_login.html');
    });
  } finally {
    pool.connect = origConnect;
    pool.query = origQuery;
  }
});

test('Student login case-insensitive Active status handling and inactive/blocked account rejection', async () => {
  const origQuery = pool.query;
  const hash = await bcrypt.hash('Secret123!', 10);

  const mockStudents = [
    { student_id: 'STU-1001', student_name: 'Title Case Active', email: 'active_title@example.com', mobile: '9100000001', password: hash, status: 'Active' },
    { student_id: 'STU-1002', student_name: 'Lower Case Active', email: 'active_lower@example.com', mobile: '9100000002', password: hash, status: 'active' },
    { student_id: 'STU-1003', student_name: 'Upper Case Active', email: 'active_upper@example.com', mobile: '9100000003', password: hash, status: 'ACTIVE' },
    { student_id: 'STU-1004', student_name: 'Blocked Student', email: 'blocked_student@example.com', mobile: '9100000004', password: hash, status: 'Blocked' },
    { student_id: 'STU-1005', student_name: 'Inactive Student', email: 'inactive_student@example.com', mobile: '9100000005', password: hash, status: 'Inactive' },
  ];

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM student') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = params[0];
      return {
        rows: mockStudents.filter(
          (s) => (s.email && s.email.toLowerCase() === String(id).toLowerCase()) || s.mobile === id
        ),
      };
    }
    return origQuery.call(pool, sql, params);
  };

  try {
    await withServer(createAuthTestServer(), async (baseUrl) => {
      // 1. 'Active' -> HTTP 200
      const res1 = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'active_title@example.com', studentPassword: 'Secret123!' }),
      });
      assert.equal(res1.status, 200);
      assert.equal((await res1.json()).ok, true);

      // 2. 'active' -> HTTP 200
      const res2 = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'active_lower@example.com', studentPassword: 'Secret123!' }),
      });
      assert.equal(res2.status, 200);
      assert.equal((await res2.json()).ok, true);

      // 3. 'ACTIVE' -> HTTP 200
      const res3 = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'active_upper@example.com', studentPassword: 'Secret123!' }),
      });
      assert.equal(res3.status, 200);
      assert.equal((await res3.json()).ok, true);

      // 4. 'Blocked' -> HTTP 403
      const res4 = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'blocked_student@example.com', studentPassword: 'Secret123!' }),
      });
      assert.equal(res4.status, 403);
      assert.equal((await res4.json()).error, 'This student account is blocked. Contact the admin.');

      // 5. 'Inactive' -> HTTP 403
      const res5 = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'inactive_student@example.com', studentPassword: 'Secret123!' }),
      });
      assert.equal(res5.status, 403);
      assert.equal((await res5.json()).error, 'This student account is blocked. Contact the admin.');
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Student change password validation: same password rejection, wrong current, confirm mismatch, min length, and valid update', async () => {
  const origQuery = pool.query;
  const initialPassword = 'InitialSecretPass123!';
  let storedHash = await bcrypt.hash(initialPassword, 10);
  const studentId = 'STU-9999';

  pool.query = async (sql, params = []) => {
    if (sql.includes('SELECT status, student_id FROM student WHERE student_id = $1')) {
      return { rows: [{ status: 'Active', student_id: params[0] }] };
    }
    if (sql.includes('SELECT password FROM student WHERE student_id = $1')) {
      return { rows: [{ password: storedHash }] };
    }
    if (sql.includes('UPDATE student SET password = $1 WHERE student_id = $2')) {
      storedHash = params[0];
      return { rowCount: 1 };
    }
    return origQuery.call(pool, sql, params);
  };

  try {
    const studentSession = { id: studentId, name: 'Change Pw Student', email: 'pwstudent@example.com' };
    await withServer(createStudentTestServer(studentSession), async (baseUrl) => {
      const hashBeforeTests = storedHash;

      // 1. Same current and new password -> HTTP 400 with exact message
      const sameRes = await fetch(`${baseUrl}/api/student/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_current_password: initialPassword,
          student_new_password: initialPassword,
          student_conform_password: initialPassword,
        }),
      });
      assert.equal(sameRes.status, 400);
      assert.equal((await sameRes.json()).error, 'New Password cannot be the same as Current Password');

      // 6. Verify password hash is completely unchanged after rejected same-password request
      assert.equal(storedHash, hashBeforeTests);

      // 2. Wrong current password -> HTTP 401
      const wrongCurrentRes = await fetch(`${baseUrl}/api/student/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_current_password: 'WrongCurrentPassword!',
          student_new_password: 'BrandNewPassword456!',
          student_conform_password: 'BrandNewPassword456!',
        }),
      });
      assert.equal(wrongCurrentRes.status, 401);
      assert.equal((await wrongCurrentRes.json()).error, 'Your current password is wrong.');
      assert.equal(storedHash, hashBeforeTests);

      // 3. Mismatched confirmation -> HTTP 400
      const mismatchRes = await fetch(`${baseUrl}/api/student/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_current_password: initialPassword,
          student_new_password: 'BrandNewPassword456!',
          student_conform_password: 'MismatchedConfirm789!',
        }),
      });
      assert.equal(mismatchRes.status, 400);
      assert.equal((await mismatchRes.json()).error, 'The new passwords do not match.');
      assert.equal(storedHash, hashBeforeTests);

      // 4. Password shorter than 6 characters -> HTTP 400
      const shortRes = await fetch(`${baseUrl}/api/student/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_current_password: initialPassword,
          student_new_password: '12345',
          student_conform_password: '12345',
        }),
      });
      assert.equal(shortRes.status, 400);
      assert.equal((await shortRes.json()).error, 'Password must be at least 6 characters.');
      assert.equal(storedHash, hashBeforeTests);

      // 5. Valid password change -> HTTP 200
      const newPassword = 'ValidNewSecretPass789!';
      const validRes = await fetch(`${baseUrl}/api/student/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_current_password: initialPassword,
          student_new_password: newPassword,
          student_conform_password: newPassword,
        }),
      });
      assert.equal(validRes.status, 200);
      assert.equal((await validRes.json()).ok, true);

      // Verify the new password hash is stored and verifies against new password
      assert.notEqual(storedHash, hashBeforeTests);
      assert.equal(await bcrypt.compare(newPassword, storedHash), true);
      assert.equal(await bcrypt.compare(initialPassword, storedHash), false);
    });
  } finally {
    pool.query = origQuery;
  }
});
