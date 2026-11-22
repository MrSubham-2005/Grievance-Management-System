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
const staffRouter = require('../server/routes/staff');
const adminRouter = require('../server/routes/admin');

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
      // Empty email field
      const emptyRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: '', studentPassword: '' }),
      });
      assert.equal(emptyRes.status, 400);
      assert.equal((await emptyRes.json()).error, 'Invalid Email');

      // Empty password with valid email
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
      assert.equal((await unknownEmailRes.json()).error, 'Invalid Email');

      // Unknown mobile number
      const unknownMobileRes = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: '9999999999', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(unknownMobileRes.status, 401);
      assert.equal((await unknownMobileRes.json()).error, 'Invalid Mobile Number');

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
      assert.equal((await pendingStaffRes.json()).error, 'Your account has been deactivated by the Admin.');

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

      // 4. Identifier absent from both tables -> exact Invalid Email / Invalid Mobile Number
      const unknownEmailRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'nonexistent@example.com', staffPassword: 'Password123!' }),
      });
      assert.equal(unknownEmailRes.status, 401);
      assert.equal((await unknownEmailRes.json()).error, 'Invalid Email');

      const unknownMobileRes = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: '9111111111', staffPassword: 'Password123!' }),
      });
      assert.equal(unknownMobileRes.status, 401);
      assert.equal((await unknownMobileRes.json()).error, 'Invalid Mobile Number');

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
      assert.equal((await inactiveRes.json()).error, 'Your account has been deactivated by the Admin.');
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

      // 0. Missing, whitespace-only, matching whitespace-only, and non-string inputs -> HTTP 400 without DB update
      const invalidEmptyPayloads = [
        { student_new_password: 'BrandNewPassword456!', student_conform_password: 'BrandNewPassword456!' },
        { student_current_password: initialPassword, student_conform_password: 'BrandNewPassword456!' },
        { student_current_password: initialPassword, student_new_password: 'BrandNewPassword456!' },
        { student_current_password: '      ', student_new_password: 'BrandNewPassword456!', student_conform_password: 'BrandNewPassword456!' },
        { student_current_password: initialPassword, student_new_password: '      ', student_conform_password: 'BrandNewPassword456!' },
        { student_current_password: initialPassword, student_new_password: 'BrandNewPassword456!', student_conform_password: '      ' },
        { student_current_password: initialPassword, student_new_password: '      ', student_conform_password: '      ' },
        { student_current_password: 123456, student_new_password: ['a', 'b', 'c', 'd', 'e', 'f'], student_conform_password: ['a', 'b', 'c', 'd', 'e', 'f'] },
      ];
      for (const payload of invalidEmptyPayloads) {
        const res = await fetch(`${baseUrl}/api/student/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Fill in all three password fields.');
        assert.equal(storedHash, hashBeforeTests);
      }

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

test('Student Forgot Password HTML reveals and copies generated password only after backend verification', async () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'HTML', 'STUDENTS', 'student_forgot_password.html'),
    'utf8'
  );

  assert.ok(html.includes('showRetrievedPassword(d.password)'), 'AJAX success callback must invoke showRetrievedPassword');
  assert.ok(html.includes('passwordGroup.style.display = "block"'), 'Must unhide passwordGroup container');
  assert.ok(html.includes('id="copyPassword"'), 'Must contain copyPassword button');

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Expected inline script block in student_forgot_password.html');

  function makeEl(initial = {}) {
    const listeners = {};
    const classes = new Set();
    return {
      value: '',
      innerHTML: '',
      textContent: '',
      style: {},
      focused: false,
      blurred: false,
      classList: {
        add: (c) => classes.add(c),
        contains: (c) => classes.has(c),
      },
      focus() { this.focused = true; },
      blur() { this.blurred = true; },
      addEventListener(type, fn) { listeners[type] = fn; },
      dispatch(type, evt = {}) { return listeners[type] && listeners[type].call(this, evt); },
      ...initial,
    };
  }

  const passwordGroup = makeEl();
  const elements = {
    gmsLoginForm: makeEl(),
    studentForgotEmail: makeEl({ value: 'student@gmail.com' }),
    studentSecurityQuestion: makeEl({ value: 'What is your favourite color?' }),
    studentSecurityAnswer: makeEl({ value: 'Blue' }),
    studentPassword: makeEl({ closest: () => passwordGroup }),
    copyPassword: makeEl(),
    emailError: makeEl(),
    securityQuestionError: makeEl(),
    securityAnswerError: makeEl(),
    PasswordError: makeEl(),
  };
  const headerH1 = makeEl({ textContent: 'Forgot Password' });
  const subtitle = makeEl({ textContent: 'Enter your email address to reset your password.' });
  const submitBtn = makeEl();

  const selectors = {
    '.form-header h1': headerH1,
    '.subtitle': subtitle,
    '.btn-login': submitBtn,
  };

  let nextPostImpl = () => Promise.reject(new Error('The security question or answer does not match.'));
  const alerts = [];
  const copied = [];
  const notifyCalls = [];

  const sandbox = {
    document: {
      title: 'Student Forgot Password',
      getElementById: (id) => elements[id] || null,
      querySelector: (sel) => selectors[sel] || null,
    },
    window: {
      location: { search: '', pathname: '/HTML/STUDENTS/student_forgot_password.html' },
      history: { replaceState() {} },
    },
    navigator: {
      clipboard: {
        writeText(text) {
          copied.push(text);
          return Promise.resolve();
        },
      },
    },
    URLSearchParams,
    setTimeout: () => 0,
    alert: (msg) => alerts.push(msg),
    GMS: {
      formData: () => ({
        studentEmail: elements.studentForgotEmail.value,
        securityQuestion: elements.studentSecurityQuestion.value,
        securityAnswer: elements.studentSecurityAnswer.value,
      }),
      post: (...args) => nextPostImpl(...args),
      notify(el, message, isError) {
        notifyCalls.push({ el, message, isError });
        if (el) {
          el.textContent = message;
          el.style.display = 'block';
        }
      },
    },
  };

  vm.runInNewContext(scriptMatch[1], sandbox);

  // Initial state: password group must be hidden
  assert.equal(passwordGroup.style.display, 'none');

  // 1. Failed verification must NOT reveal password or unhide passwordGroup
  elements.gmsLoginForm.dispatch('submit', { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(passwordGroup.style.display, 'none');
  assert.equal(elements.studentPassword.value, '');
  assert.equal(alerts.length, 0);
  assert.equal(elements.securityAnswerError.textContent, 'The security question or answer does not match.');

  // 2. Successful verification must reveal generated password, hide submit, notify, alert, and allow copying
  const expectedMsg = 'Your new password is TempPass99. Copy it now, it is shown only once.';
  nextPostImpl = () => Promise.resolve({ ok: true, password: 'TempPass99', message: expectedMsg });

  elements.gmsLoginForm.dispatch('submit', { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(passwordGroup.style.display, 'block');
  assert.equal(passwordGroup.classList.contains('password-success'), true);
  assert.equal(elements.studentPassword.value, 'TempPass99');
  assert.equal(submitBtn.style.display, 'none');
  assert.equal(headerH1.textContent, 'Your Password');
  assert.equal(elements.PasswordError.textContent, expectedMsg);
  assert.deepEqual(alerts, [expectedMsg]);

  // 3. Copy button copies the generated password
  elements.copyPassword.dispatch('click');
  assert.deepEqual(copied, ['TempPass99']);
});

test('Forgot password reset handles NULL/missing security_answer safely and trims case-insensitively', async () => {
  const origQuery = pool.query;
  const accountsByEmail = {
    'valid@gmail.com': { id: 'STU-1001', security_question: 'What is your favourite color?', security_answer: 'Blue' },
    'spaced@gmail.com': { id: 'STU-1002', security_question: 'What is your favourite color?', security_answer: '  Blue  ' },
    'nullans@gmail.com': { id: 'STU-1003', security_question: 'What is your favourite color?', security_answer: null },
    'missingans@gmail.com': { id: 'STU-1004', security_question: 'What is your favourite color?' },
  };
  let failedAttemptInserts = 0;
  let passwordUpdates = 0;

  pool.query = async (sql, params = []) => {
    if (sql.includes('SELECT student_id AS id, security_question, security_answer FROM student')) {
      const acc = accountsByEmail[params[0]];
      return { rows: acc ? [acc] : [] };
    }
    if (sql.includes('FROM reset_attempt')) {
      return { rows: [{ n: 0 }] };
    }
    if (sql.includes('INSERT INTO reset_attempt')) {
      failedAttemptInserts += 1;
      return { rowCount: 1 };
    }
    if (sql.includes('DELETE FROM reset_attempt')) {
      return { rowCount: 1 };
    }
    if (sql.includes('UPDATE student SET password = $1 WHERE student_id = $2')) {
      passwordUpdates += 1;
      return { rowCount: 1 };
    }
    return origQuery.call(pool, sql, params);
  };

  try {
    await withServer(createAuthTestServer(), async (baseUrl) => {
      // 1. Correct stored answer -> HTTP 200 and password updated
      const okRes = await fetch(`${baseUrl}/api/auth/student/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentEmail: 'valid@gmail.com',
          securityQuestion: 'What is your favourite color?',
          securityAnswer: 'blue',
        }),
      });
      assert.equal(okRes.status, 200);
      const okData = await okRes.json();
      assert.equal(okData.ok, true);
      assert.equal(typeof okData.password, 'string');
      assert.ok(okData.password.length >= 8);
      assert.equal(passwordUpdates, 1);

      // 2. Incorrect answer -> HTTP 403, reset_attempt logged, no password updated or revealed
      const wrongRes = await fetch(`${baseUrl}/api/auth/student/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentEmail: 'valid@gmail.com',
          securityQuestion: 'What is your favourite color?',
          securityAnswer: 'Red',
        }),
      });
      assert.equal(wrongRes.status, 403);
      const wrongData = await wrongRes.json();
      assert.equal(wrongData.error, 'The security question or answer does not match. Check them and try again.');
      assert.equal(wrongData.password, undefined);
      assert.equal(failedAttemptInserts, 1);
      assert.equal(passwordUpdates, 1);

      // 3. Stored security_answer is NULL -> HTTP 403 (not HTTP 500), reset_attempt logged, no password updated/revealed
      const nullRes = await fetch(`${baseUrl}/api/auth/student/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentEmail: 'nullans@gmail.com',
          securityQuestion: 'What is your favourite color?',
          securityAnswer: 'Blue',
        }),
      });
      assert.equal(nullRes.status, 403);
      const nullData = await nullRes.json();
      assert.equal(nullData.error, 'The security question or answer does not match. Check them and try again.');
      assert.equal(nullData.password, undefined);
      assert.equal(failedAttemptInserts, 2);
      assert.equal(passwordUpdates, 1);

      // 4. Stored security_answer is missing (undefined) -> HTTP 403 (not HTTP 500), no password updated/revealed
      const missingRes = await fetch(`${baseUrl}/api/auth/student/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentEmail: 'missingans@gmail.com',
          securityQuestion: 'What is your favourite color?',
          securityAnswer: 'Blue',
        }),
      });
      assert.equal(missingRes.status, 403);
      const missingData = await missingRes.json();
      assert.equal(missingData.error, 'The security question or answer does not match. Check them and try again.');
      assert.equal(missingData.password, undefined);
      assert.equal(failedAttemptInserts, 3);
      assert.equal(passwordUpdates, 1);

      // 5. Case-insensitive and whitespace-trimmed comparison succeeds
      const trimRes = await fetch(`${baseUrl}/api/auth/student/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentEmail: 'spaced@gmail.com',
          securityQuestion: 'What is your favourite color?',
          securityAnswer: '  bLuE  ',
        }),
      });
      assert.equal(trimRes.status, 200);
      const trimData = await trimRes.json();
      assert.equal(trimData.ok, true);
      assert.equal(typeof trimData.password, 'string');
      assert.equal(passwordUpdates, 2);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('POST /api/auth/logout destroys Student, Staff and Admin sessions, clears gms.sid cookie, blocks reuse, and isolates other sessions', async () => {
  const origQuery = pool.query;
  const hash = await bcrypt.hash('LogoutPass123!', 10);

  const mockStudents = [
    { student_id: 'STU-2001', student_name: 'Student A', email: 'stua@gmail.com', mobile: '9111111111', password: hash, status: 'Active' },
    { student_id: 'STU-2002', student_name: 'Student B', email: 'stub@gmail.com', mobile: '9222222222', password: hash, status: 'Active' },
  ];
  const mockStaff = [
    { staff_id: 'STF-2001', staff_name: 'Staff A', email: 'stfa@gmail.com', mobile: '9333333333', department: 'Hostel', rating: 4.5, password: hash, status: 'Active' },
  ];
  const mockAdmins = [
    { admin_id: 'ADM-2001', admin_name: 'Admin A', email: 'adma@gmail.com', mobile: '9444444444', password: hash },
  ];

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff_request')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM student') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = String(params[0] || '').toLowerCase();
      return { rows: mockStudents.filter((s) => s.email === id || s.mobile === params[0]) };
    }
    if (sql.includes('FROM staff') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = String(params[0] || '').toLowerCase();
      return { rows: mockStaff.filter((s) => s.email === id || s.mobile === params[0]) };
    }
    if (sql.includes('FROM admin') && sql.includes('LOWER(email) = LOWER($1) OR mobile = $1')) {
      const id = String(params[0] || '').toLowerCase();
      return { rows: mockAdmins.filter((a) => a.email === id || a.mobile === params[0]) };
    }
    if (sql.includes('SELECT status, student_id FROM student WHERE student_id = $1')) {
      const s = mockStudents.find((x) => x.student_id === params[0]);
      return { rows: s ? [{ status: s.status, student_id: s.student_id }] : [] };
    }
    if (sql.includes('SELECT student_id, student_name, mobile, email FROM student WHERE student_id = $1')) {
      const s = mockStudents.find((x) => x.student_id === params[0]);
      return { rows: s ? [s] : [] };
    }
    if (sql.includes('SELECT status, staff_id FROM staff WHERE staff_id = $1')) {
      const s = mockStaff.find((x) => x.staff_id === params[0]);
      return { rows: s ? [{ status: s.status, staff_id: s.staff_id }] : [] };
    }
    if (sql.includes('SELECT staff_id, staff_name, mobile, email, department, rating FROM staff WHERE staff_id = $1')) {
      const s = mockStaff.find((x) => x.staff_id === params[0]);
      return { rows: s ? [s] : [] };
    }
    if (sql.includes('SELECT admin_name, mobile, email FROM admin WHERE admin_id = $1')) {
      const a = mockAdmins.find((x) => x.admin_id === params[0]);
      return { rows: a ? [a] : [] };
    }
    return origQuery.call(pool, sql, params);
  };

  const fullApp = express();
  fullApp.use(express.json());
  fullApp.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      name: 'gms.sid',
      cookie: { httpOnly: true, sameSite: 'lax', secure: false },
    })
  );
  fullApp.use('/api/auth', authRouter);
  fullApp.use('/api/student', studentRouter);
  fullApp.use('/api/staff', staffRouter);
  fullApp.use('/api/admin', adminRouter);

  const cookiePair = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];

  try {
    await withServer(fullApp, async (baseUrl) => {
      // Log in Student A, Student B, Staff A, and Admin A in separate sessions
      const stuALogin = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'stua@gmail.com', studentPassword: 'LogoutPass123!' }),
      });
      assert.equal(stuALogin.status, 200);
      const stuACookie = cookiePair(stuALogin);

      const stuBLogin = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'stub@gmail.com', studentPassword: 'LogoutPass123!' }),
      });
      assert.equal(stuBLogin.status, 200);
      const stuBCookie = cookiePair(stuBLogin);

      const stfALogin = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'stfa@gmail.com', staffPassword: 'LogoutPass123!' }),
      });
      assert.equal(stfALogin.status, 200);
      const stfACookie = cookiePair(stfALogin);

      const admALogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: 'adma@gmail.com', adminPassword: 'LogoutPass123!' }),
      });
      assert.equal(admALogin.status, 200);
      const admACookie = cookiePair(admALogin);

      // Confirm all four sessions work on protected routes before logout
      assert.equal((await fetch(`${baseUrl}/api/student/profile`, { headers: { Cookie: stuACookie } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/student/profile`, { headers: { Cookie: stuBCookie } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/staff/profile`, { headers: { Cookie: stfACookie } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/admin/profile`, { headers: { Cookie: admACookie } })).status, 200);

      // 1. Logout Student A
      const stuLogout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: stuACookie },
      });
      assert.equal(stuLogout.status, 200);
      assert.deepEqual(await stuLogout.json(), { ok: true, redirect: '/Home.html' });
      const stuClearHeader = stuLogout.headers.get('set-cookie') || '';
      assert.match(stuClearHeader, /gms\.sid=;/);
      assert.match(stuClearHeader, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
      assert.match(stuClearHeader, /HttpOnly/i);
      assert.match(stuClearHeader, /SameSite=Lax/i);

      // Reusing Student A's old cookie must report signed out and fail protected API with 401
      const stuASessionAfter = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: stuACookie } })).json();
      assert.deepEqual(stuASessionAfter, { student: false, staff: false, admin: false });
      const stuAProfileAfter = await fetch(`${baseUrl}/api/student/profile`, { headers: { Cookie: stuACookie } });
      assert.equal(stuAProfileAfter.status, 401);
      assert.equal((await stuAProfileAfter.json()).redirect, '/HTML/STUDENTS/student_login.html');

      // Other users' sessions remain completely unaffected
      assert.deepEqual(
        await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: stuBCookie } })).json(),
        { student: true, staff: false, admin: false }
      );
      assert.equal((await fetch(`${baseUrl}/api/student/profile`, { headers: { Cookie: stuBCookie } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/staff/profile`, { headers: { Cookie: stfACookie } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/admin/profile`, { headers: { Cookie: admACookie } })).status, 200);

      // 2. Logout Staff A
      const stfLogout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: stfACookie },
      });
      assert.equal(stfLogout.status, 200);
      assert.deepEqual(await stfLogout.json(), { ok: true, redirect: '/Home.html' });
      assert.match(stfLogout.headers.get('set-cookie') || '', /gms\.sid=;/);
      assert.deepEqual(
        await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: stfACookie } })).json(),
        { student: false, staff: false, admin: false }
      );
      const stfAProfileAfter = await fetch(`${baseUrl}/api/staff/profile`, { headers: { Cookie: stfACookie } });
      assert.equal(stfAProfileAfter.status, 401);
      assert.equal((await stfAProfileAfter.json()).redirect, '/HTML/STAFF/staff_login.html');

      // Admin A and Student B remain valid
      assert.equal((await fetch(`${baseUrl}/api/admin/profile`, { headers: { Cookie: admACookie } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/student/profile`, { headers: { Cookie: stuBCookie } })).status, 200);

      // 3. Logout Admin A
      const admLogout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: admACookie },
      });
      assert.equal(admLogout.status, 200);
      assert.deepEqual(await admLogout.json(), { ok: true, redirect: '/Home.html' });
      assert.match(admLogout.headers.get('set-cookie') || '', /gms\.sid=;/);
      assert.deepEqual(
        await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: admACookie } })).json(),
        { student: false, staff: false, admin: false }
      );
      const admAProfileAfter = await fetch(`${baseUrl}/api/admin/profile`, { headers: { Cookie: admACookie } });
      assert.equal(admAProfileAfter.status, 401);
      assert.equal((await admAProfileAfter.json()).redirect, '/HTML/ADMIN/admin_login.html');

      // Student B still unaffected
      assert.equal((await fetch(`${baseUrl}/api/student/profile`, { headers: { Cookie: stuBCookie } })).status, 200);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('POST /api/auth/logout returns HTTP 500 and does not clear cookie when session destroy fails', async () => {
  const errApp = express();
  errApp.use((req, _res, next) => {
    req.session = {
      destroy(cb) {
        cb(new Error('Simulated session store failure'));
      },
    };
    next();
  });
  errApp.use('/api/auth', authRouter);

  await withServer(errApp, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, undefined);
    assert.equal(body.error, 'Could not sign you out right now. Please try again.');
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

test('All 16 authenticated Student, Staff and Admin portal pages include gms-api.js and a.logout-link', () => {
  const portalPages = [
    // Student (5)
    'web/HTML/STUDENTS/student_dashboard.html',
    'web/HTML/STUDENTS/raise_complaint.html',
    'web/HTML/STUDENTS/view_complaint_status.html',
    'web/HTML/STUDENTS/feedback.html',
    'web/HTML/STUDENTS/student_change_password.html',
    // Staff (4)
    'web/HTML/STAFF/staff_dashboard.html',
    'web/HTML/STAFF/view_assigned_complaints.html',
    'web/HTML/STAFF/update_complaint.html',
    'web/HTML/STAFF/staff_change_password.html',
    // Admin (7)
    'web/HTML/ADMIN/admin_dashboard.html',
    'web/HTML/ADMIN/view_complaints.html',
    'web/HTML/ADMIN/assign_complaint.html',
    'web/HTML/ADMIN/students.html',
    'web/HTML/ADMIN/staff.html',
    'web/HTML/ADMIN/add_staff.html',
    'web/HTML/ADMIN/admin_change_password.html',
  ];

  assert.equal(portalPages.length, 16);
  const root = path.join(__dirname, '..');
  for (const rel of portalPages) {
    const html = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(html, /<script\s+src="\/gms-api\.js"><\/script>/i, `${rel} must load /gms-api.js`);
    assert.match(html, /<a\s+[^>]*class="[^"]*\blogout-link\b[^"]*"[^>]*>/i, `${rel} must have a.logout-link`);
  }
});

test('gms-api.js centralized logout prevents immediate navigation, deduplicates clicks, handles errors, and redirects only after success', async () => {
  const vm = require('node:vm');
  const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'gms-api.js'), 'utf8');

  const docListeners = {};
  const alerts = [];
  const replacedUrls = [];
  const fetchCalls = [];
  let pendingLogoutResolver = null;
  let nextLogoutMode = 'pending-then-fail';

  const logoutAnchor = {
    attrs: {},
    style: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    closest(sel) { return sel === 'a.logout-link' ? logoutAnchor : null; },
  };
  const logoutSpan = {
    closest(sel) { return sel === 'a.logout-link' ? logoutAnchor : null; },
  };
  const regularLink = {
    closest() { return null; },
  };

  const sandbox = {
    document: {
      documentElement: { style: { visibility: '' } },
      addEventListener(type, fn) {
        docListeners[type] = docListeners[type] || [];
        docListeners[type].push(fn);
      },
    },
    window: {
      location: {
        pathname: '/HTML/STUDENTS/student_dashboard.html',
        href: '/HTML/STUDENTS/student_dashboard.html',
        replace(url) { replacedUrls.push(url); },
      },
    },
    alert(msg) { alerts.push(msg); },
    fetch(url, options = {}) {
      fetchCalls.push({ url, options });
      if (url === '/api/auth/session') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ student: true, staff: false, admin: false }),
        });
      }
      if (url === '/api/auth/logout') {
        if (nextLogoutMode === 'pending-then-fail') {
          return new Promise((resolve) => {
            pendingLogoutResolver = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, redirect: '/Home.html' }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    },
  };

  vm.runInNewContext(scriptSrc, sandbox);
  await new Promise((resolve) => setImmediate(resolve));

  // Clicking a non-logout link must NOT call preventDefault or /api/auth/logout
  let regularPrevented = false;
  docListeners.click.forEach((fn) => fn({
    target: regularLink,
    preventDefault() { regularPrevented = true; },
  }));
  assert.equal(regularPrevented, false);
  assert.equal(fetchCalls.filter((c) => c.url === '/api/auth/logout').length, 0);

  // Clicking Logout (via inner <span>) prevents navigation and fires one POST /api/auth/logout with same-origin credentials
  let prevented1 = false;
  docListeners.click.forEach((fn) => fn({
    target: logoutSpan,
    preventDefault() { prevented1 = true; },
  }));
  assert.equal(prevented1, true);
  assert.equal(logoutAnchor.attrs['aria-busy'], 'true');
  assert.equal(logoutAnchor.style.pointerEvents, 'none');

  const logoutRequests1 = fetchCalls.filter((c) => c.url === '/api/auth/logout');
  assert.equal(logoutRequests1.length, 1);
  assert.equal(logoutRequests1[0].options.method, 'POST');
  assert.equal(logoutRequests1[0].options.credentials, 'same-origin');

  // Second rapid click while request is in progress must still preventDefault and NOT send a duplicate request
  let prevented2 = false;
  docListeners.click.forEach((fn) => fn({
    target: logoutAnchor,
    preventDefault() { prevented2 = true; },
  }));
  assert.equal(prevented2, true);
  assert.equal(fetchCalls.filter((c) => c.url === '/api/auth/logout').length, 1);
  assert.deepEqual(replacedUrls, []);

  // Backend failure (HTTP 500) must NOT redirect, must alert error, and must re-enable Logout for retry
  pendingLogoutResolver({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: 'Could not sign you out right now. Please try again.' }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(replacedUrls, []);
  assert.deepEqual(alerts, ['Could not sign you out right now. Please try again.']);
  assert.equal(logoutAnchor.attrs['aria-busy'], undefined);
  assert.equal(logoutAnchor.style.pointerEvents, '');

  // Retry after failure succeeds and redirects to /Home.html
  nextLogoutMode = 'succeed';
  let prevented3 = false;
  docListeners.click.forEach((fn) => fn({
    target: logoutAnchor,
    preventDefault() { prevented3 = true; },
  }));
  assert.equal(prevented3, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls.filter((c) => c.url === '/api/auth/logout').length, 2);
  assert.deepEqual(replacedUrls, ['/Home.html']);
});

test('Student, Staff, and Admin authentication and lookup validate missing/NULL/empty/unmatched email and mobile with exact messages and DB null safety', async () => {
  const origQuery = pool.query;
  const hash = await bcrypt.hash('CorrectPass123!', 10);

  const mockStudents = [
    { student_id: 'STU-0001', student_name: 'Valid Student', email: 'valid.stu@gmail.com', mobile: '8260575858', password: hash, status: 'Active' },
    { student_id: 'STU-0002', student_name: 'Null Email Stu', email: null, mobile: '8260575859', password: hash, status: 'Active' },
    { student_id: 'STU-0003', student_name: 'Null Mobile Stu', email: 'nullmob.stu@gmail.com', mobile: null, password: hash, status: 'Active' },
  ];

  const mockStaff = [
    { staff_id: 'STF-0001', staff_name: 'Valid Staff', email: 'valid.staff@gmail.com', mobile: '9938543462', department: 'IT', password: hash, status: 'Active' },
    { staff_id: 'STF-0002', staff_name: 'Null Email Staff', email: null, mobile: '9938543463', department: 'IT', password: hash, status: 'Active' },
    { staff_id: 'STF-0003', staff_name: 'Null Mobile Staff', email: 'nullmob.staff@gmail.com', mobile: null, department: 'IT', password: hash, status: 'Active' },
  ];

  const mockStaffRequest = [
    { request_id: 'REQ-0001', staff_name: 'Pending Staff', email: 'pending.staff@gmail.com', mobile: '9938543464', department: 'Hostel' },
  ];

  const mockAdmin = [
    { admin_id: 'ADM-0001', admin_name: 'Valid Admin', email: 'valid.admin@gmail.com', mobile: '8260487065', password: hash },
    { admin_id: 'ADM-0002', admin_name: 'Null Email Admin', email: null, mobile: '8260487066', password: hash },
    { admin_id: 'ADM-0003', admin_name: 'Null Mobile Admin', email: 'nullmob.admin@gmail.com', mobile: null, password: hash },
  ];

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff_request')) {
      const id = String(params[0] || '').toLowerCase();
      const rows = mockStaffRequest.filter(
        (r) => (r.email && r.email.toLowerCase() === id) || (r.mobile && r.mobile === params[0])
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM student')) {
      const id = String(params[0] || '').toLowerCase();
      const rows = mockStudents.filter(
        (s) => (s.email && s.email.toLowerCase() === id) || (s.mobile && s.mobile === params[0])
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM staff')) {
      const id = String(params[0] || '').toLowerCase();
      const rows = mockStaff.filter(
        (s) => (s.email && s.email.toLowerCase() === id) || (s.mobile && s.mobile === params[0])
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM admin')) {
      const id = String(params[0] || '').toLowerCase();
      const rows = mockAdmin.filter(
        (a) => (a.email && a.email.toLowerCase() === id) || (a.mobile && a.mobile === params[0])
      );
      return { rows, rowCount: rows.length };
    }
    return origQuery.call(pool, sql, params);
  };

  try {
    await withServer(createAuthTestServer(), async (baseUrl) => {
      // 1. Student Email validation: missing, empty, NULL, unmatched
      for (const payload of [
        { studentEmail: '', studentPassword: 'any' },
        { email: '', password: 'any' },
        { studentEmail: null, studentPassword: 'any' },
        { email: null, password: 'any' },
        { studentEmail: '   ', studentPassword: 'any' },
        { studentPassword: 'any' },
      ]) {
        const res = await fetch(`${baseUrl}/api/auth/student/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Invalid Email');
      }

      const stuUnmatchedEmail = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'notfound@gmail.com', studentPassword: 'any' }),
      });
      assert.equal(stuUnmatchedEmail.status, 401);
      assert.equal((await stuUnmatchedEmail.json()).error, 'Invalid Email');

      // 2. Student Mobile validation: missing, empty, NULL, unmatched
      for (const payload of [
        { studentMobile: '', studentPassword: 'any' },
        { mobile: '', password: 'any' },
        { studentMobile: null, studentPassword: 'any' },
        { mobile: null, password: 'any' },
        { studentMobile: '   ', studentPassword: 'any' },
      ]) {
        const res = await fetch(`${baseUrl}/api/auth/student/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Invalid Mobile Number');
      }

      const stuUnmatchedMob = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentMobile: '9999999999', studentPassword: 'any' }),
      });
      assert.equal(stuUnmatchedMob.status, 401);
      assert.equal((await stuUnmatchedMob.json()).error, 'Invalid Mobile Number');

      // Also mobile typed into studentEmail input
      const stuUnmatchedMobInEmailInput = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: '9999999999', studentPassword: 'any' }),
      });
      assert.equal(stuUnmatchedMobInEmailInput.status, 401);
      assert.equal((await stuUnmatchedMobInEmailInput.json()).error, 'Invalid Mobile Number');

      // 3. Staff Email and Mobile validation in both staff and staff_request lookup paths
      for (const payload of [
        { staffEmail: '', staffPassword: 'any' },
        { email: '', password: 'any' },
        { staffEmail: null, staffPassword: 'any' },
      ]) {
        const res = await fetch(`${baseUrl}/api/auth/staff/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Invalid Email');
      }

      for (const payload of [
        { staffMobile: '', staffPassword: 'any' },
        { mobile: '', password: 'any' },
        { staffMobile: null, staffPassword: 'any' },
      ]) {
        const res = await fetch(`${baseUrl}/api/auth/staff/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Invalid Mobile Number');
      }

      // Staff Pending approval in staff_request (email)
      const stfPendingEmail = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'pending.staff@gmail.com', staffPassword: 'any' }),
      });
      assert.equal(stfPendingEmail.status, 403);
      assert.equal((await stfPendingEmail.json()).error, 'Your registration request is pending Admin approval. Please wait until your account is approved.');

      // Staff Pending approval in staff_request (mobile)
      const stfPendingMob = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffMobile: '9938543464', staffPassword: 'any' }),
      });
      assert.equal(stfPendingMob.status, 403);
      assert.equal((await stfPendingMob.json()).error, 'Your registration request is pending Admin approval. Please wait until your account is approved.');

      // Staff unmatched in BOTH staff and staff_request
      const stfUnmatchedEmail = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'notfound.staff@gmail.com', staffPassword: 'any' }),
      });
      assert.equal(stfUnmatchedEmail.status, 401);
      assert.equal((await stfUnmatchedEmail.json()).error, 'Invalid Email');

      const stfUnmatchedMob = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffMobile: '9999999999', staffPassword: 'any' }),
      });
      assert.equal(stfUnmatchedMob.status, 401);
      assert.equal((await stfUnmatchedMob.json()).error, 'Invalid Mobile Number');

      // 4. Admin Email and Mobile validation
      for (const payload of [
        { adminEmail: '', adminPassword: 'any' },
        { email: '', password: 'any' },
        { adminEmail: null, adminPassword: 'any' },
      ]) {
        const res = await fetch(`${baseUrl}/api/auth/admin/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Invalid Email');
      }

      for (const payload of [
        { adminMobile: '', adminPassword: 'any' },
        { mobile: '', password: 'any' },
        { adminMobile: null, adminPassword: 'any' },
      ]) {
        const res = await fetch(`${baseUrl}/api/auth/admin/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Invalid Mobile Number');
      }

      const admUnmatchedEmail = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: 'notfound.admin@gmail.com', adminPassword: 'any' }),
      });
      assert.equal(admUnmatchedEmail.status, 401);
      assert.equal((await admUnmatchedEmail.json()).error, 'Invalid Email');

      const admUnmatchedMob = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminMobile: '9999999999', adminPassword: 'any' }),
      });
      assert.equal(admUnmatchedMob.status, 401);
      assert.equal((await admUnmatchedMob.json()).error, 'Invalid Mobile Number');

      // 5. DB Null safety: records with NULL email or NULL mobile in DB do not match or crash
      const stuNullEmailMatch = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'null', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(stuNullEmailMatch.status, 401);
      assert.equal((await stuNullEmailMatch.json()).error, 'Invalid Email');

      // 6. Valid email and mobile login flows still work cleanly
      const stuOkEmail = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentEmail: 'valid.stu@gmail.com', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(stuOkEmail.status, 200);
      assert.equal((await stuOkEmail.json()).ok, true);

      const stuOkMob = await fetch(`${baseUrl}/api/auth/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentMobile: '8260575858', studentPassword: 'CorrectPass123!' }),
      });
      assert.equal(stuOkMob.status, 200);
      assert.equal((await stuOkMob.json()).ok, true);

      const stfOkEmail = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffEmail: 'valid.staff@gmail.com', staffPassword: 'CorrectPass123!' }),
      });
      assert.equal(stfOkEmail.status, 200);
      assert.equal((await stfOkEmail.json()).ok, true);

      const stfOkMob = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffMobile: '9938543462', staffPassword: 'CorrectPass123!' }),
      });
      assert.equal(stfOkMob.status, 200);
      assert.equal((await stfOkMob.json()).ok, true);

      const admOkEmail = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail: 'valid.admin@gmail.com', adminPassword: 'CorrectPass123!' }),
      });
      assert.equal(admOkEmail.status, 200);
      assert.equal((await admOkEmail.json()).ok, true);

      const admOkMob = await fetch(`${baseUrl}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminMobile: '8260487065', adminPassword: 'CorrectPass123!' }),
      });
      assert.equal(admOkMob.status, 200);
      assert.equal((await admOkMob.json()).ok, true);
    });
  } finally {
    pool.query = origQuery;
  }
});

