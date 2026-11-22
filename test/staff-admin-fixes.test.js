const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const pool = require('../server/db');
const authRouter = require('../server/routes/auth');
const staffRouter = require('../server/routes/staff');
const adminRouter = require('../server/routes/admin');
const studentRouter = require('../server/routes/student');
const { requireRole } = require('../server/middleware');

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

// -------------------------------------------------------------
// TEST GROUP A: Staff Change Password
// -------------------------------------------------------------
test('Group A: Staff Change Password - reject same, wrong current, confirm mismatch, min length, and success', async () => {
  const origQuery = pool.query;
  const initialPassword = 'StaffOldPass123!';
  let storedHash = await bcrypt.hash(initialPassword, 10);
  const staffId = 'STF-T001';

  pool.query = async (sql, params = []) => {
    if (sql.includes('SELECT status, staff_id FROM staff WHERE staff_id = $1')) {
      return { rows: [{ status: 'Active', staff_id: staffId }] };
    }
    if (sql.includes('SELECT password FROM staff WHERE staff_id = $1')) {
      return { rows: [{ password: storedHash }] };
    }
    if (sql.includes('UPDATE staff SET password = $1 WHERE staff_id = $2')) {
      storedHash = params[0];
      return { rowCount: 1 };
    }
    return origQuery.call(pool, sql, params);
  };

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use((req, _res, next) => {
    req.session.staff = { id: staffId, name: 'Test Staff', email: 'staff@example.com' };
    next();
  });
  testApp.use('/api/staff', staffRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      const hashBeforeTests = storedHash;

      // 0. Missing, whitespace-only, matching whitespace-only, and non-string inputs -> HTTP 400 without DB update
      const invalidEmptyPayloads = [
        { staff_new_password: 'StaffNewPass123!', staff_conform_password: 'StaffNewPass123!' },
        { staff_current_password: initialPassword, staff_conform_password: 'StaffNewPass123!' },
        { staff_current_password: initialPassword, staff_new_password: 'StaffNewPass123!' },
        { staff_current_password: '      ', staff_new_password: 'StaffNewPass123!', staff_conform_password: 'StaffNewPass123!' },
        { staff_current_password: initialPassword, staff_new_password: '      ', staff_conform_password: 'StaffNewPass123!' },
        { staff_current_password: initialPassword, staff_new_password: 'StaffNewPass123!', staff_conform_password: '      ' },
        { staff_current_password: initialPassword, staff_new_password: '      ', staff_conform_password: '      ' },
        { staff_current_password: 123456, staff_new_password: { bad: true }, staff_conform_password: { bad: true } },
      ];
      for (const payload of invalidEmptyPayloads) {
        const res = await fetch(`${baseUrl}/api/staff/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Fill in all three password fields.');
        assert.equal(storedHash, hashBeforeTests);
      }

      // 1. Same password returns HTTP 400
      const sameRes = await fetch(`${baseUrl}/api/staff/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staff_current_password: initialPassword,
          staff_new_password: initialPassword,
          staff_conform_password: initialPassword,
        }),
      });
      assert.equal(sameRes.status, 400);
      const sameData = await sameRes.json();
      assert.equal(sameData.error, 'New Password cannot be the same as Current Password');
      assert.equal(storedHash, hashBeforeTests);

      // 2. Incorrect current password returns HTTP 401
      const wrongRes = await fetch(`${baseUrl}/api/staff/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staff_current_password: 'WrongPassword123!',
          staff_new_password: 'StaffNewPass123!',
          staff_conform_password: 'StaffNewPass123!',
        }),
      });
      assert.equal(wrongRes.status, 401);
      const wrongData = await wrongRes.json();
      assert.equal(wrongData.error, 'Your current password is wrong.');
      assert.equal(storedHash, hashBeforeTests);

      // 3. New and confirmation mismatch returns HTTP 400
      const mismatchRes = await fetch(`${baseUrl}/api/staff/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staff_current_password: initialPassword,
          staff_new_password: 'StaffNewPass123!',
          staff_conform_password: 'DifferentPass123!',
        }),
      });
      assert.equal(mismatchRes.status, 400);
      const mismatchData = await mismatchRes.json();
      assert.equal(mismatchData.error, 'The new passwords do not match.');
      assert.equal(storedHash, hashBeforeTests);

      // 4. Minimum length < 6 returns HTTP 400
      const shortRes = await fetch(`${baseUrl}/api/staff/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staff_current_password: initialPassword,
          staff_new_password: '123',
          staff_conform_password: '123',
        }),
      });
      assert.equal(shortRes.status, 400);
      const shortData = await shortRes.json();
      assert.equal(shortData.error, 'Password must be at least 6 characters.');
      assert.equal(storedHash, hashBeforeTests);

      // 5. Valid new password succeeds
      const successRes = await fetch(`${baseUrl}/api/staff/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staff_current_password: initialPassword,
          staff_new_password: 'StaffNewPass123!',
          staff_conform_password: 'StaffNewPass123!',
        }),
      });
      assert.equal(successRes.status, 200);
      const successData = await successRes.json();
      assert.equal(successData.ok, true);
      assert.notEqual(storedHash, hashBeforeTests);
      assert.ok(await bcrypt.compare('StaffNewPass123!', storedHash));
    });
  } finally {
    pool.query = origQuery;
  }
});

// -------------------------------------------------------------
// TEST GROUP B: Admin Change Password
// -------------------------------------------------------------
test('Group B: Admin Change Password - reject same, wrong current, confirm mismatch, min length, and success', async () => {
  const origQuery = pool.query;
  const initialPassword = 'AdminOldPass123!';
  let storedHash = await bcrypt.hash(initialPassword, 10);
  const adminId = 'ADM-T001';

  pool.query = async (sql, params = []) => {
    if (sql.includes('SELECT password FROM admin WHERE admin_id = $1')) {
      return { rows: [{ password: storedHash }] };
    }
    if (sql.includes('UPDATE admin SET password = $1 WHERE admin_id = $2')) {
      storedHash = params[0];
      return { rowCount: 1 };
    }
    return origQuery.call(pool, sql, params);
  };

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use((req, _res, next) => {
    req.session.admin = { id: adminId, name: 'Test Admin', email: 'admin@example.com' };
    next();
  });
  testApp.use('/api/admin', adminRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      const hashBeforeTests = storedHash;

      // 0. Missing, whitespace-only, matching whitespace-only, and non-string inputs -> HTTP 400 without DB update
      const invalidEmptyPayloads = [
        { admin_new_password: 'AdminNewPass123!', admin_conform_password: 'AdminNewPass123!' },
        { admin_current_password: initialPassword, admin_conform_password: 'AdminNewPass123!' },
        { admin_current_password: initialPassword, admin_new_password: 'AdminNewPass123!' },
        { admin_current_password: '      ', admin_new_password: 'AdminNewPass123!', admin_conform_password: 'AdminNewPass123!' },
        { admin_current_password: initialPassword, admin_new_password: '      ', admin_conform_password: 'AdminNewPass123!' },
        { admin_current_password: initialPassword, admin_new_password: 'AdminNewPass123!', admin_conform_password: '      ' },
        { admin_current_password: initialPassword, admin_new_password: '      ', admin_conform_password: '      ' },
        { admin_current_password: 123456, admin_new_password: ['a', 'b', 'c', 'd', 'e', 'f'], admin_conform_password: ['a', 'b', 'c', 'd', 'e', 'f'] },
      ];
      for (const payload of invalidEmptyPayloads) {
        const res = await fetch(`${baseUrl}/api/admin/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'Fill in all three password fields.');
        assert.equal(storedHash, hashBeforeTests);
      }

      // 1. Same password returns HTTP 400
      const sameRes = await fetch(`${baseUrl}/api/admin/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_current_password: initialPassword,
          admin_new_password: initialPassword,
          admin_conform_password: initialPassword,
        }),
      });
      assert.equal(sameRes.status, 400);
      const sameData = await sameRes.json();
      assert.equal(sameData.error, 'New Password cannot be the same as Current Password');
      assert.equal(storedHash, hashBeforeTests);

      // 2. Incorrect current password returns HTTP 401
      const wrongRes = await fetch(`${baseUrl}/api/admin/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_current_password: 'WrongPassword123!',
          admin_new_password: 'AdminNewPass123!',
          admin_conform_password: 'AdminNewPass123!',
        }),
      });
      assert.equal(wrongRes.status, 401);
      const wrongData = await wrongRes.json();
      assert.equal(wrongData.error, 'Your current password is wrong.');
      assert.equal(storedHash, hashBeforeTests);

      // 3. Confirmation mismatch returns HTTP 400
      const mismatchRes = await fetch(`${baseUrl}/api/admin/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_current_password: initialPassword,
          admin_new_password: 'AdminNewPass123!',
          admin_conform_password: 'DifferentPass123!',
        }),
      });
      assert.equal(mismatchRes.status, 400);
      const mismatchData = await mismatchRes.json();
      assert.equal(mismatchData.error, 'The new passwords do not match.');
      assert.equal(storedHash, hashBeforeTests);

      // 4. Minimum length < 6 returns HTTP 400
      const shortRes = await fetch(`${baseUrl}/api/admin/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_current_password: initialPassword,
          admin_new_password: '123',
          admin_conform_password: '123',
        }),
      });
      assert.equal(shortRes.status, 400);
      const shortData = await shortRes.json();
      assert.equal(shortData.error, 'New password must be at least 6 characters.');
      assert.equal(storedHash, hashBeforeTests);

      // 5. Valid new password succeeds
      const successRes = await fetch(`${baseUrl}/api/admin/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_current_password: initialPassword,
          admin_new_password: 'AdminNewPass123!',
          admin_conform_password: 'AdminNewPass123!',
        }),
      });
      assert.equal(successRes.status, 200);
      const successData = await successRes.json();
      assert.equal(successData.ok, true);
      assert.notEqual(storedHash, hashBeforeTests);
      assert.ok(await bcrypt.compare('AdminNewPass123!', storedHash));
    });
  } finally {
    pool.query = origQuery;
  }
});

// -------------------------------------------------------------
// TEST GROUP C: Staff Forgot Password
// -------------------------------------------------------------
test('Group C: Staff Forgot Password - approved staff reset, pending request 403, and unknown 404', async () => {
  const origQuery = pool.query;

  pool.query = async (sql, params = []) => {
    // 1. Approved staff lookup
    if (sql.includes('FROM staff WHERE LOWER(email) = $1')) {
      if (params[0] === 'approved@example.com') {
        return { rows: [{ id: 'STF-0010', security_question: 'Color?', security_answer: 'blue' }] };
      }
      return { rows: [] };
    }
    // 2. Pending staff request lookup
    if (sql.includes('FROM staff_request WHERE LOWER(email) = $1')) {
      if (params[0] === 'pending@example.com') {
        return { rowCount: 1, rows: [{ id: 'REQ-0001' }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM reset_attempt')) {
      return { rows: [{ n: 0 }] };
    }
    if (sql.includes('UPDATE staff SET password = $1')) {
      return { rowCount: 1 };
    }
    if (sql.includes('DELETE FROM reset_attempt')) {
      return { rowCount: 0 };
    }
    return origQuery.call(pool, sql, params);
  };

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use('/api/auth', authRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      // 1. Approved staff email succeeds
      const approvedRes = await fetch(`${baseUrl}/api/auth/staff/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffEmail: 'approved@example.com',
          securityQuestion: 'Color?',
          securityAnswer: 'blue',
        }),
      });
      assert.equal(approvedRes.status, 200);
      const approvedData = await approvedRes.json();
      assert.equal(approvedData.ok, true);
      assert.ok(approvedData.password);

      // 2. Pending staff request returns HTTP 403 with exact message
      const pendingRes = await fetch(`${baseUrl}/api/auth/staff/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffEmail: 'pending@example.com',
          securityQuestion: 'Color?',
          securityAnswer: 'blue',
        }),
      });
      assert.equal(pendingRes.status, 403);
      const pendingData = await pendingRes.json();
      assert.equal(
        pendingData.error,
        'Your registration request is pending Admin approval. Please wait until your account is approved.'
      );
      assert.equal(pendingData.password, undefined);

      // 3. Unknown email returns HTTP 404
      const unknownRes = await fetch(`${baseUrl}/api/auth/staff/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffEmail: 'unknown@example.com',
          securityQuestion: 'Color?',
          securityAnswer: 'blue',
        }),
      });
      assert.equal(unknownRes.status, 404);
      const unknownData = await unknownRes.json();
      assert.match(unknownData.error, /No staff member account uses that email/);
    });
  } finally {
    pool.query = origQuery;
  }
});

// -------------------------------------------------------------
// TEST GROUP D: Staff Login Status Casing
// -------------------------------------------------------------
test('Group D: Staff Login Status - case-insensitive Active, inactive/blocked rejected, null rejected', async () => {
  const origQuery = pool.query;
  const password = 'StaffPass123!';
  const hashedPassword = await bcrypt.hash(password, 10);
  let mockStatus = 'Active';

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff WHERE') && (sql.includes('LOWER(email)') || sql.includes('mobile'))) {
      return {
        rowCount: 1,
        rows: [{
          staff_id: 'STF-0010',
          staff_name: 'Status Test Staff',
          mobile: '9876543210',
          email: 'statustest@example.com',
          department: 'Electricity',
          password: hashedPassword,
          status: mockStatus,
        }],
      };
    }
    return origQuery.call(pool, sql, params);
  };

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use('/api/auth', authRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      // 1. 'Active' allows login
      mockStatus = 'Active';
      const r1 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r1.status, 200);

      // 2. 'active' (lowercase) allows login
      mockStatus = 'active';
      const r2 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r2.status, 200);

      // 3. 'ACTIVE' (uppercase) allows login
      mockStatus = 'ACTIVE';
      const r3 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r3.status, 200);

      // 4. 'Inactive' rejected with 403
      mockStatus = 'Inactive';
      const r4 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r4.status, 403);
      assert.equal((await r4.json()).error, 'Your account has been deactivated by the Admin.');

      // 5. 'Blocked' rejected with 403
      mockStatus = 'Blocked';
      const r5 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r5.status, 403);
      assert.equal((await r5.json()).error, 'Your account has been deactivated by the Admin.');

      // 6. null or missing status rejected with 403
      mockStatus = null;
      const r6 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r6.status, 403);
      assert.equal((await r6.json()).error, 'Your account has been deactivated by the Admin.');
    });
  } finally {
    pool.query = origQuery;
  }
});

// -------------------------------------------------------------
// TEST GROUP E: Admin Registration Duplicate Mobile
// -------------------------------------------------------------
test('Group E: Admin Registration Duplicate Mobile - email duplicate, mobile duplicate, and success', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const adminSecretHash = await bcrypt.hash('secret123', 10);

  pool.query = async (sql, params = []) => {
    if (sql.includes('SELECT secret_code FROM admin_secret WHERE id = 1')) {
      return { rowCount: 1, rows: [{ secret_code: adminSecretHash }] };
    }
    return origQuery.call(pool, sql, params);
  };

  pool.connect = async () => ({
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT 1 FROM admin WHERE LOWER(email)=$1')) {
        if (params[0] === 'existing@gmail.com') return { rowCount: 1, rows: [{ 1: 1 }] };
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT 1 FROM admin WHERE mobile=$1')) {
        if (params[0] === '9999999999') return { rowCount: 1, rows: [{ 1: 1 }] };
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SUBSTRING(admin_id')) {
        return { rows: [{ n: 10 }] };
      }
      if (sql.includes('INSERT INTO admin')) {
        return { rowCount: 1 };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  });

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use('/api/auth', authRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      // 1. Existing email rejected with email message
      const emailDupRes = await fetch(`${baseUrl}/api/auth/admin/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminName: 'Admin One',
          adminMobile: '8888888888',
          adminEmail: 'existing@gmail.com',
          adminPassword: 'Password123!',
          secretCode: 'secret123',
          securityQuestion: 'City?',
          securityAnswer: 'Delhi',
        }),
      });
      assert.equal(emailDupRes.status, 409);
      const emailDupData = await emailDupRes.json();
      assert.equal(emailDupData.error, 'An admin with this email already exists. Sign in instead.');

      // 2. Existing mobile rejected with exact message 'Mobile Already Exists'
      const mobileDupRes = await fetch(`${baseUrl}/api/auth/admin/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminName: 'Admin Two',
          adminMobile: '9999999999',
          adminEmail: 'new@gmail.com',
          adminPassword: 'Password123!',
          secretCode: 'secret123',
          securityQuestion: 'City?',
          securityAnswer: 'Delhi',
        }),
      });
      assert.equal(mobileDupRes.status, 409);
      const mobileDupData = await mobileDupRes.json();
      assert.equal(mobileDupData.error, 'Mobile Already Exists');

      // 3. Unique email and mobile can register
      const successRes = await fetch(`${baseUrl}/api/auth/admin/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminName: 'Admin Three',
          adminMobile: '7777777777',
          adminEmail: 'unique@gmail.com',
          adminPassword: 'Password123!',
          secretCode: 'secret123',
          securityQuestion: 'City?',
          securityAnswer: 'Delhi',
        }),
      });
      assert.equal(successRes.status, 201);
      const successData = await successRes.json();
      assert.equal(successData.ok, true);
      assert.ok(successData.adminId);
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

// -------------------------------------------------------------
// TEST GROUP F: Staff Registration Separate Duplicate Messages
// -------------------------------------------------------------
test('Group F: Staff Registration Duplicate Messages - separate errors, priorities, and success', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;

  pool.connect = async () => ({
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT LOWER(email) AS email, mobile FROM staff WHERE')) {
        const email = params[0];
        const mobile = params[1];
        const rows = [];
        if (email === 'staff_taken@gmail.com') rows.push({ email: 'staff_taken@gmail.com', mobile: '9876511111' });
        if (mobile === '9999911111') rows.push({ email: 'other@gmail.com', mobile: '9999911111' });
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('SELECT LOWER(email) AS email, mobile FROM staff_request WHERE')) {
        const email = params[0];
        const mobile = params[1];
        const rows = [];
        if (email === 'req_taken@gmail.com') rows.push({ email: 'req_taken@gmail.com', mobile: '9876522222' });
        if (mobile === '9999922222') rows.push({ email: 'reqother@gmail.com', mobile: '9999922222' });
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('SUBSTRING(request_id')) {
        return { rows: [{ n: 10 }] };
      }
      if (sql.includes('INSERT INTO staff_request')) {
        return { rowCount: 1 };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  });

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use('/api/auth', authRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      // 1. Staff email duplicate: 'Email Already Registered'
      const r1 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Staff Member', staffMobile: '9876533333', staffEmail: 'staff_taken@gmail.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r1.status, 409);
      assert.equal((await r1.json()).error, 'Email Already Registered');

      // 2. Staff mobile duplicate: 'Mobile Number Already Registered'
      const r2 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Staff Member', staffMobile: '9999911111', staffEmail: 'free@gmail.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r2.status, 409);
      assert.equal((await r2.json()).error, 'Mobile Number Already Registered');

      // 3. Request email duplicate: 'Email Already Requested'
      const r3 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Staff Member', staffMobile: '9876544444', staffEmail: 'req_taken@gmail.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r3.status, 409);
      assert.equal((await r3.json()).error, 'Email Already Requested');

      // 4. Request mobile duplicate: 'Mobile Number Already Requested'
      const r4 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Staff Member', staffMobile: '9999922222', staffEmail: 'free@gmail.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r4.status, 409);
      assert.equal((await r4.json()).error, 'Mobile Number Already Requested');

      // 5. Multiple matching priority: Staff email > staff mobile > req email > req mobile
      const r5 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Staff Member', staffMobile: '9999911111', staffEmail: 'staff_taken@gmail.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r5.status, 409);
      assert.equal((await r5.json()).error, 'Email Already Registered');

      // 6. Unique credentials succeeds with hyphenated REQ-XXXX format
      const r6 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'New Staff Member', staffMobile: '7777788888', staffEmail: 'brand_new@gmail.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r6.status, 201);
      const d6 = await r6.json();
      assert.equal(d6.ok, true);
      assert.equal(d6.requestId, 'REQ-0011');

      // 7. Invalid Indian mobile number rejected with HTTP 400
      const r7 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Staff Invalid Mobile', staffMobile: '1234567890', staffEmail: 'valid@gmail.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r7.status, 400);
      assert.equal((await r7.json()).error, 'Enter a valid 10-digit Indian mobile number.');

      // 8. Invalid non-Gmail email rejected with HTTP 400
      const r8 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Staff Invalid Email', staffMobile: '9876543210', staffEmail: 'staff@yahoo.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r8.status, 400);
      assert.equal((await r8.json()).error, 'Enter a valid Gmail address.');
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

// -------------------------------------------------------------
// TEST GROUP G: Session Invalidation
// -------------------------------------------------------------
test('Group G: Session Invalidation - deactivated student and staff sessions become unusable, others unaffected', async () => {
  const origQuery = pool.query;

  let studentStatus = 'Active';
  let staffStatus = 'Active';

  pool.query = async (sql, params = []) => {
    // Student status check query in requireRole
    if (sql.includes('SELECT status, student_id FROM student WHERE student_id = $1')) {
      if (params[0] === 'STU-DEACT') return { rows: [{ status: studentStatus, student_id: 'STU-DEACT' }] };
      if (params[0] === 'STU-OTHER') return { rows: [{ status: 'Active', student_id: 'STU-OTHER' }] };
      return { rows: [] };
    }
    // Staff status check query in requireRole
    if (sql.includes('SELECT status, staff_id FROM staff WHERE staff_id = $1')) {
      if (params[0] === 'STF-DEACT') return { rows: [{ status: staffStatus, staff_id: 'STF-DEACT' }] };
      return { rows: [] };
    }
    // Student dashboard query
    if (sql.includes('FROM complaint') && sql.includes('student_id = $1')) {
      return { rows: [{ total_complaints: 0, pending_complaints: 0, in_progress_complaints: 0, resolved_complaints: 0 }] };
    }
    // Global recent complaints query on dashboard
    if (sql.includes('LEFT JOIN public.student') || sql.includes('LIMIT 5')) {
      return { rows: [] };
    }
    // Staff dashboard query
    if (sql.includes('FROM complaint') && sql.includes('assigned_staff_id = $1')) {
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM session')) {
      return { rowCount: 1 };
    }
    return origQuery.call(pool, sql, params);
  };

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    name: 'gms.sid',
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
  }));

  // Route to set up test session
  testApp.post('/test/login-student', (req, res) => {
    req.session.student = { id: req.body.id, name: 'Student', email: req.body.id + '@test.com' };
    res.json({ ok: true });
  });

  testApp.post('/test/login-staff', (req, res) => {
    req.session.staff = { id: req.body.id, name: 'Staff', email: req.body.id + '@test.com' };
    res.json({ ok: true });
  });

  testApp.use('/api/student', studentRouter);
  testApp.use('/api/staff', staffRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      // 1. Student logs in and receives valid session
      const login1 = await fetch(`${baseUrl}/test/login-student`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'STU-DEACT' }),
      });
      assert.equal(login1.status, 200);
      const studentCookie = login1.headers.get('set-cookie');
      assert.ok(studentCookie);

      // 2. Student accesses protected endpoint successfully
      const access1 = await fetch(`${baseUrl}/api/student/dashboard`, {
        headers: { cookie: studentCookie },
      });
      assert.equal(access1.status, 200);

      // 3. Admin deactivates that student
      studentStatus = 'Blocked';

      // 4. Same student session is rejected on next protected request with 401
      const access2 = await fetch(`${baseUrl}/api/student/dashboard`, {
        headers: { cookie: studentCookie },
      });
      assert.equal(access2.status, 401);
      const access2Data = await access2.json();
      assert.equal(access2Data.error, 'You are not signed in as student. Sign in first.');

      // 5. Another student's session continues working
      const login2 = await fetch(`${baseUrl}/test/login-student`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'STU-OTHER' }),
      });
      const otherCookie = login2.headers.get('set-cookie');
      const otherAccess = await fetch(`${baseUrl}/api/student/dashboard`, {
        headers: { cookie: otherCookie },
      });
      assert.equal(otherAccess.status, 200);

      // 6. Reactivating the first student does not restore the invalidated session
      studentStatus = 'Active';
      const access3 = await fetch(`${baseUrl}/api/student/dashboard`, {
        headers: { cookie: studentCookie },
      });
      assert.equal(access3.status, 401);

      // 7. Same sequence works for Staff:
      const staffLogin = await fetch(`${baseUrl}/test/login-staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'STF-DEACT' }),
      });
      const staffCookie = staffLogin.headers.get('set-cookie');
      const staffAccess1 = await fetch(`${baseUrl}/api/staff/dashboard`, {
        headers: { cookie: staffCookie },
      });
      assert.equal(staffAccess1.status, 200);

      // Admin deactivates staff
      staffStatus = 'Inactive';
      const staffAccess2 = await fetch(`${baseUrl}/api/staff/dashboard`, {
        headers: { cookie: staffCookie },
      });
      assert.equal(staffAccess2.status, 401);

      // Reactivating staff does not restore invalidated session
      staffStatus = 'Active';
      const staffAccess3 = await fetch(`${baseUrl}/api/staff/dashboard`, {
        headers: { cookie: staffCookie },
      });
      assert.equal(staffAccess3.status, 401);
    });
  } finally {
    pool.query = origQuery;
  }
});

// -------------------------------------------------------------
// TEST GROUP H: Middleware Fail-Closed Security & Account Status (Tests A through H)
// -------------------------------------------------------------

test('Test A: Active Student - Successful Status Query', async () => {
  const origQuery = pool.query;
  let protectedCalled = false;
  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM student WHERE student_id = $1')) {
      return { rows: [{ status: 'Active', student_id: params[0] }] };
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.student = { id: 'STU-0001', name: 'Student One', email: 'stu@example.com' };
    res.json({ ok: true });
  });
  app.get('/protected', requireRole('student'), (req, res) => {
    protectedCalled = true;
    res.json({ ok: true, studentId: req.user.id });
  });

  try {
    await withServer(app, async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/login`, { method: 'POST' });
      assert.equal(loginRes.status, 200);
      const cookie = loginRes.headers.get('set-cookie');
      assert.ok(cookie);

      const res = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.studentId, 'STU-0001');
      assert.equal(protectedCalled, true);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Test B: Active Staff - Successful Status Query', async () => {
  const origQuery = pool.query;
  let protectedCalled = false;
  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff WHERE staff_id = $1')) {
      return { rows: [{ status: 'Active', staff_id: params[0] }] };
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.staff = { id: 'STF-0001', name: 'Staff One', email: 'staff@example.com' };
    res.json({ ok: true });
  });
  app.get('/protected', requireRole('staff'), (req, res) => {
    protectedCalled = true;
    res.json({ ok: true, staffId: req.user.id });
  });

  try {
    await withServer(app, async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/login`, { method: 'POST' });
      assert.equal(loginRes.status, 200);
      const cookie = loginRes.headers.get('set-cookie');
      assert.ok(cookie);

      const res = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.staffId, 'STF-0001');
      assert.equal(protectedCalled, true);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Test C: Inactive Student', async () => {
  const origQuery = pool.query;
  let protectedCalled = false;
  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM student WHERE student_id = $1')) {
      return { rows: [{ status: 'Inactive', student_id: params[0] }] };
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.student = { id: 'STU-INACT', name: 'Inactive Student', email: 'inact@example.com' };
    res.json({ ok: true });
  });
  app.get('/protected', requireRole('student'), (req, res) => {
    protectedCalled = true;
    res.json({ ok: true });
  });

  try {
    await withServer(app, async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/login`, { method: 'POST' });
      const cookie = loginRes.headers.get('set-cookie');

      const res = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /You are not signed in as student/);
      assert.equal(protectedCalled, false);

      // Verify session was destroyed
      const retryRes = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(retryRes.status, 401);
      assert.equal(protectedCalled, false);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Test D: Inactive Staff', async () => {
  const origQuery = pool.query;
  let protectedCalled = false;
  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff WHERE staff_id = $1')) {
      return { rows: [{ status: 'Blocked', staff_id: params[0] }] };
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.staff = { id: 'STF-BLOCKED', name: 'Blocked Staff', email: 'blocked@example.com' };
    res.json({ ok: true });
  });
  app.get('/protected', requireRole('staff'), (req, res) => {
    protectedCalled = true;
    res.json({ ok: true });
  });

  try {
    await withServer(app, async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/login`, { method: 'POST' });
      const cookie = loginRes.headers.get('set-cookie');

      const res = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /You are not signed in as staff/);
      assert.equal(protectedCalled, false);

      // Verify session was destroyed
      const retryRes = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(retryRes.status, 401);
      assert.equal(protectedCalled, false);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Test E: Student Database Query Failure', async () => {
  const origQuery = pool.query;
  let protectedCalled = false;
  pool.query = async (sql) => {
    if (sql.includes('FROM student WHERE student_id = $1')) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.student = { id: 'STU-0001', name: 'Student One', email: 'stu@example.com' };
    res.json({ ok: true });
  });
  app.get('/protected', requireRole('student'), (req, res) => {
    protectedCalled = true;
    res.json({ ok: true });
  });

  try {
    await withServer(app, async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/login`, { method: 'POST' });
      const cookie = loginRes.headers.get('set-cookie');

      const res = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.match(data.error, /Service temporarily unavailable/);
      assert.equal(protectedCalled, false);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Test F: Staff Database Query Failure', async () => {
  const origQuery = pool.query;
  let protectedCalled = false;
  pool.query = async (sql) => {
    if (sql.includes('FROM staff WHERE staff_id = $1')) {
      throw new Error('ETIMEDOUT: Connection to database timed out');
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.staff = { id: 'STF-0001', name: 'Staff One', email: 'staff@example.com' };
    res.json({ ok: true });
  });
  app.get('/protected', requireRole('staff'), (req, res) => {
    protectedCalled = true;
    res.json({ ok: true });
  });

  try {
    await withServer(app, async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/login`, { method: 'POST' });
      const cookie = loginRes.headers.get('set-cookie');

      const res = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.match(data.error, /Service temporarily unavailable/);
      assert.equal(protectedCalled, false);
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Test G: Session Isolation', async () => {
  const origQuery = pool.query;
  let simulateError = true;
  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM student WHERE student_id = $1')) {
      if (params[0] === 'STU-ERR' && simulateError) {
        throw new Error('Temporary database outage');
      }
      return { rows: [{ status: 'Active', student_id: params[0] }] };
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.student = { id: req.body.id, name: 'Student ' + req.body.id, email: req.body.id + '@example.com' };
    res.json({ ok: true });
  });
  app.get('/protected', requireRole('student'), (req, res) => {
    res.json({ ok: true, id: req.user.id });
  });

  try {
    await withServer(app, async (baseUrl) => {
      // Login User 1 and User 2
      const l1 = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'STU-ERR' }),
      });
      const cookie1 = l1.headers.get('set-cookie');

      const l2 = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'STU-OK' }),
      });
      const cookie2 = l2.headers.get('set-cookie');

      // User 1 gets 503 due to error
      const r1 = await fetch(`${baseUrl}/protected`, { headers: { cookie: cookie1 } });
      assert.equal(r1.status, 503);

      // User 2 session is completely unaffected and succeeds with 200
      const r2 = await fetch(`${baseUrl}/protected`, { headers: { cookie: cookie2 } });
      assert.equal(r2.status, 200);
      assert.equal((await r2.json()).id, 'STU-OK');

      // Subsequent request for User 1 when DB recovers succeeds normally
      simulateError = false;
      const r1Retry = await fetch(`${baseUrl}/protected`, { headers: { cookie: cookie1 } });
      assert.equal(r1Retry.status, 200);
      assert.equal((await r1Retry.json()).id, 'STU-ERR');
    });
  } finally {
    pool.query = origQuery;
  }
});

test('Test H: Existing Authentication Regression', async () => {
  const origQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM student WHERE student_id = $1')) {
      return { rows: [{ status: 'Active', student_id: params[0] }] };
    }
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  app.post('/login', (req, res) => {
    req.session.student = { id: 'STU-0001', name: 'Student One', email: 'stu@example.com' };
    res.json({ ok: true });
  });
  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });
  app.get('/protected', requireRole('student'), (req, res) => {
    res.json({ ok: true });
  });

  try {
    await withServer(app, async (baseUrl) => {
      // 1. Missing session remains HTTP 401
      const noSession = await fetch(`${baseUrl}/protected`);
      assert.equal(noSession.status, 401);
      const noSessionData = await noSession.json();
      assert.equal(noSessionData.redirect, '/HTML/STUDENTS/student_login.html');

      // 2. Invalid session remains HTTP 401
      const invalidSession = await fetch(`${baseUrl}/protected`, { headers: { cookie: 'gms.sid=s%3Ainvalid-signature' } });
      assert.equal(invalidSession.status, 401);

      // 3. Login and logout behavior remains unchanged
      const login = await fetch(`${baseUrl}/login`, { method: 'POST' });
      const cookie = login.headers.get('set-cookie');
      const authReq = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(authReq.status, 200);

      // Logout
      const logout = await fetch(`${baseUrl}/logout`, { method: 'POST', headers: { cookie } });
      assert.equal(logout.status, 200);

      // Request after logout returns 401
      const postLogout = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
      assert.equal(postLogout.status, 401);
    });
  } finally {
    pool.query = origQuery;
  }
});

// -------------------------------------------------------------
// TEST GROUP I: Phase 5 Staff Forgot Password Template Display
// -------------------------------------------------------------
test('Group I: Staff Forgot Password HTML template displays retrieved password and copy button on AJAX reset', () => {
  const html = fs.readFileSync('web/HTML/STAFF/staff_forgot_password.html', 'utf8');
  assert.ok(html.includes('showRetrievedPassword(d.password)'), 'AJAX success callback must invoke showRetrievedPassword');
  assert.ok(html.includes('passwordGroup.style.display = "block"'), 'Must unhide passwordGroup container');
  assert.ok(html.includes('id="copyPassword"'), 'Must contain copyPassword button');
});

// -------------------------------------------------------------
// TEST GROUP J: Phase 5 Staff Request ID Compatibility (REQ-0001 & REQ0001)
// -------------------------------------------------------------
test('Group J: Staff Request ID - Admin approve and reject support both REQ-0001 and legacy REQ0001 formats', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;

  const mockRequests = [
    { request_id: 'REQ-0001', staff_name: 'Hyphen Staff', email: 'hyphen@gmail.com', mobile: '9876500001', department: 'Cleanliness', password: 'Hash', security_question: 'Q', security_answer: 'A' },
    { request_id: 'REQ0002', staff_name: 'Legacy Staff', email: 'legacy@gmail.com', mobile: '9876500002', department: 'Internet', password: 'Hash', security_question: 'Q', security_answer: 'A' },
  ];

  pool.query = async (sql, params = []) => {
    if (sql.includes('FROM staff s')) {
      return { rows: [] };
    }
    if (sql.includes('FROM staff_request ORDER BY created_at')) {
      return { rows: mockRequests };
    }
    if (sql.includes('DELETE FROM staff_request WHERE request_id = ANY($1) RETURNING request_id')) {
      const candidates = params[0];
      const idx = mockRequests.findIndex((r) => candidates.includes(r.request_id));
      if (idx !== -1) {
        const removed = mockRequests.splice(idx, 1);
        return { rowCount: 1, rows: [{ request_id: removed[0].request_id }] };
      }
      return { rowCount: 0, rows: [] };
    }
    return origQuery.call(pool, sql, params);
  };

  pool.connect = async () => ({
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT * FROM staff_request WHERE request_id = ANY($1) FOR UPDATE')) {
        const candidates = params[0];
        const row = mockRequests.find((r) => candidates.includes(r.request_id));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('SELECT 1 FROM staff WHERE LOWER(email) = $1 OR mobile = $2')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SUBSTRING(staff_id')) {
        return { rows: [{ n: 1 }] };
      }
      if (sql.includes('INSERT INTO staff')) {
        return { rowCount: 1 };
      }
      if (sql.includes('DELETE FROM staff_request WHERE request_id = $1')) {
        const idx = mockRequests.findIndex((r) => r.request_id === params[0]);
        if (idx !== -1) mockRequests.splice(idx, 1);
        return { rowCount: 1 };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  });

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use((req, _res, next) => {
    req.session.admin = { id: 'ADM-0001', name: 'Test Admin', email: 'admin@example.com' };
    next();
  });
  testApp.use('/api/admin', adminRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      // 1. GET /api/admin/staff formats both REQ-0001 and REQ0002 with standard REQ- prefix
      const staffRes = await fetch(`${baseUrl}/api/admin/staff`);
      assert.equal(staffRes.status, 200);
      const staffData = await staffRes.json();
      const req1 = staffData.staff.find((s) => s.staffName === 'Hyphen Staff');
      const req2 = staffData.staff.find((s) => s.staffName === 'Legacy Staff');
      assert.equal(req1.staffId, 'REQ-0001');
      assert.equal(req2.staffId, 'REQ-0002');

      // 2. Approve hyphenated request
      const approveRes = await fetch(`${baseUrl}/api/admin/staff-requests/REQ-0001/approve`, { method: 'POST' });
      assert.equal(approveRes.status, 200);
      const approveData = await approveRes.json();
      assert.equal(approveData.ok, true);

      // 3. Reject legacy request
      const rejectRes = await fetch(`${baseUrl}/api/admin/staff-requests/REQ-0002/reject`, { method: 'POST' });
      assert.equal(rejectRes.status, 200);
      const rejectData = await rejectRes.json();
      assert.equal(rejectData.ok, true);
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

// -------------------------------------------------------------
// TEST GROUP K: Phase 7 Admin Signup Backend Format Validation
// -------------------------------------------------------------
test('Group K: Admin Registration Format Validation - reject invalid mobile, reject invalid email, and accept valid format', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const adminSecretHash = await bcrypt.hash('secret123', 10);

  pool.query = async (sql, params = []) => {
    if (sql.includes('SELECT secret_code FROM admin_secret WHERE id = 1')) {
      return { rowCount: 1, rows: [{ secret_code: adminSecretHash }] };
    }
    return origQuery.call(pool, sql, params);
  };

  pool.connect = async () => ({
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT 1 FROM admin WHERE LOWER(email)=$1')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT 1 FROM admin WHERE mobile=$1')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SUBSTRING(admin_id')) {
        return { rows: [{ n: 10 }] };
      }
      if (sql.includes('INSERT INTO admin')) {
        return { rowCount: 1 };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  });

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use('/api/auth', authRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      // 1. Invalid Indian mobile number rejected with HTTP 400
      const invalidMobileRes = await fetch(`${baseUrl}/api/auth/admin/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminName: 'Admin One',
          adminMobile: '1234567890',
          adminEmail: 'valid@gmail.com',
          adminPassword: 'Password123!',
          secretCode: 'secret123',
          securityQuestion: 'City?',
          securityAnswer: 'Delhi',
        }),
      });
      assert.equal(invalidMobileRes.status, 400);
      const invalidMobileData = await invalidMobileRes.json();
      assert.equal(invalidMobileData.error, 'Enter a valid 10-digit Indian mobile number.');

      // 2. Invalid non-Gmail email rejected with HTTP 400
      const invalidEmailRes = await fetch(`${baseUrl}/api/auth/admin/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminName: 'Admin Two',
          adminMobile: '9876543210',
          adminEmail: 'admin@yahoo.com',
          adminPassword: 'Password123!',
          secretCode: 'secret123',
          securityQuestion: 'City?',
          securityAnswer: 'Delhi',
        }),
      });
      assert.equal(invalidEmailRes.status, 400);
      const invalidEmailData = await invalidEmailRes.json();
      assert.equal(invalidEmailData.error, 'Enter a valid Gmail address.');

      // 3. Valid mobile & Gmail accepted with HTTP 201
      const validRes = await fetch(`${baseUrl}/api/auth/admin/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminName: 'Admin Valid',
          adminMobile: '9876543210',
          adminEmail: 'validadmin@gmail.com',
          adminPassword: 'Password123!',
          secretCode: 'secret123',
          securityQuestion: 'City?',
          securityAnswer: 'Delhi',
        }),
      });
      assert.equal(validRes.status, 201);
      const validData = await validRes.json();
      assert.equal(validData.ok, true);
      assert.equal(validData.adminId, 'ADM-0011');
      assert.equal(validData.redirect, '/HTML/ADMIN/admin_login.html');
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

// -------------------------------------------------------------
// TEST GROUP L: Phase 7 Admin Forgot Password Template Display
// -------------------------------------------------------------
test('Group L: Admin Forgot Password HTML template displays retrieved password and copy button on AJAX reset', () => {
  const html = fs.readFileSync('web/HTML/ADMIN/admin_forgot_password.html', 'utf8');
  assert.ok(html.includes('showRetrievedPassword(d.password)'), 'AJAX success callback must invoke showRetrievedPassword');
  assert.ok(html.includes('passwordGroup.style.display = "block"'), 'Must unhide passwordGroup container');
  assert.ok(html.includes('id="copyPassword"'), 'Must contain copyPassword button');
});

// -------------------------------------------------------------
// TEST GROUP M: Phase 8 Admin Direct Staff Creation Validation & Duplicate Detection
// -------------------------------------------------------------
test('Group M: Admin direct staff creation - validate Indian mobile, Gmail, and separate duplicate checks for staff and staff_request', async () => {
  const origQuery = pool.query;
  const origConnect = pool.connect;

  const existingStaffRows = [
    { email: 'existingstaff@gmail.com', mobile: '9876543210' },
  ];
  const pendingRequestRows = [
    { email: 'pendingrequest@gmail.com', mobile: '8765432109' },
  ];

  pool.query = async (sql, params = []) => {
    return origQuery.call(pool, sql, params);
  };

  pool.connect = async () => ({
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('FROM staff WHERE LOWER(email) = $1 OR mobile = $2')) {
        const [email, mobile] = params;
        const matched = existingStaffRows.filter(
          (r) => r.email === email || r.mobile === mobile
        );
        return { rowCount: matched.length, rows: matched };
      }
      if (sql.includes('FROM staff_request WHERE LOWER(email) = $1 OR mobile = $2')) {
        const [email, mobile] = params;
        const matched = pendingRequestRows.filter(
          (r) => r.email === email || r.mobile === mobile
        );
        return { rowCount: matched.length, rows: matched };
      }
      if (sql.includes('SUBSTRING(staff_id')) {
        return { rows: [{ n: 10 }] };
      }
      if (sql.includes('INSERT INTO staff')) {
        return { rowCount: 1 };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  });

  const testApp = express();
  testApp.use(express.json());
  testApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, name: 'gms.sid' }));
  testApp.use((req, _res, next) => {
    req.session.admin = { id: 'ADM-0001', name: 'Test Admin', email: 'admin@gmail.com' };
    next();
  });
  testApp.use('/api/admin', adminRouter);

  try {
    await withServer(testApp, async (baseUrl) => {
      const baseBody = {
        name: 'New Staff',
        mobile: '9123456780',
        email: 'newstaff@gmail.com',
        department: 'Library',
        password: 'ValidPassword123!',
        securityQuestion: 'Favorite Subject?',
        securityAnswer: 'Math',
      };

      // 1. Missing required field -> HTTP 400 'Fill in every field before adding staff.'
      const missingFieldRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, name: '' }),
      });
      assert.equal(missingFieldRes.status, 400);
      const missingFieldData = await missingFieldRes.json();
      assert.equal(missingFieldData.error, 'Fill in every field before adding staff.');

      // 2. Invalid Indian mobile -> HTTP 400 'Enter a valid 10-digit Indian mobile number.'
      const invalidMobileRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, mobile: '1234567890' }),
      });
      assert.equal(invalidMobileRes.status, 400);
      const invalidMobileData = await invalidMobileRes.json();
      assert.equal(invalidMobileData.error, 'Enter a valid 10-digit Indian mobile number.');

      // 3. Invalid non-Gmail email -> HTTP 400 'Enter a valid Gmail address.'
      const invalidEmailRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, email: 'newstaff@yahoo.com' }),
      });
      assert.equal(invalidEmailRes.status, 400);
      const invalidEmailData = await invalidEmailRes.json();
      assert.equal(invalidEmailData.error, 'Enter a valid Gmail address.');

      // 4. Short password (< 6 chars) -> HTTP 400 'Password must be at least 6 characters.'
      const shortPassRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, password: '123' }),
      });
      assert.equal(shortPassRes.status, 400);
      const shortPassData = await shortPassRes.json();
      assert.equal(shortPassData.error, 'Password must be at least 6 characters.');

      // 5. Existing staff email duplicate -> HTTP 409 'Email Already Exists'
      const dupStaffEmailRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, email: 'existingstaff@gmail.com' }),
      });
      assert.equal(dupStaffEmailRes.status, 409);
      const dupStaffEmailData = await dupStaffEmailRes.json();
      assert.equal(dupStaffEmailData.error, 'Email Already Exists');

      // 6. Existing staff mobile duplicate -> HTTP 409 'Mobile Already Exists'
      const dupStaffMobileRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, mobile: '9876543210' }),
      });
      assert.equal(dupStaffMobileRes.status, 409);
      const dupStaffMobileData = await dupStaffMobileRes.json();
      assert.equal(dupStaffMobileData.error, 'Mobile Already Exists');

      // 7. Both existing staff email AND mobile duplicate -> HTTP 409 'Email Already Exists' (email precedence)
      const dupStaffBothRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, email: 'existingstaff@gmail.com', mobile: '9876543210' }),
      });
      assert.equal(dupStaffBothRes.status, 409);
      const dupStaffBothData = await dupStaffBothRes.json();
      assert.equal(dupStaffBothData.error, 'Email Already Exists');

      // 8. Pending request email duplicate -> HTTP 409 'Email Already Requested'
      const dupReqEmailRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, email: 'pendingrequest@gmail.com' }),
      });
      assert.equal(dupReqEmailRes.status, 409);
      const dupReqEmailData = await dupReqEmailRes.json();
      assert.equal(dupReqEmailData.error, 'Email Already Requested');

      // 9. Pending request mobile duplicate -> HTTP 409 'Mobile Number Already Requested'
      const dupReqMobileRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, mobile: '8765432109' }),
      });
      assert.equal(dupReqMobileRes.status, 409);
      const dupReqMobileData = await dupReqMobileRes.json();
      assert.equal(dupReqMobileData.error, 'Mobile Number Already Requested');

      // 10. Both pending request email AND mobile duplicate -> HTTP 409 'Email Already Requested' (email precedence)
      const dupReqBothRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, email: 'pendingrequest@gmail.com', mobile: '8765432109' }),
      });
      assert.equal(dupReqBothRes.status, 409);
      const dupReqBothData = await dupReqBothRes.json();
      assert.equal(dupReqBothData.error, 'Email Already Requested');

      // 11. Valid direct creation -> HTTP 201 with generated staffId
      const validRes = await fetch(`${baseUrl}/api/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseBody),
      });
      assert.equal(validRes.status, 201);
      const validData = await validRes.json();
      assert.equal(validData.ok, true);
      assert.equal(validData.staffId, 'STF-0011');
      assert.equal(validData.message, 'Staff member New Staff was added as STF-0011.');
    });
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
});

// -------------------------------------------------------------
// TEST GROUP N: Phase 8 Admin Staff HTML Empty State Label
// -------------------------------------------------------------
test('Group N: Admin Staff HTML template displays "No Staff Found" empty state and no students label', () => {
  const html = fs.readFileSync('web/HTML/ADMIN/staff.html', 'utf8');
  assert.ok(html.includes('No Staff Found'), 'Staff table must display "No Staff Found" when page data is empty');
  assert.ok(!html.includes('No Students Found'), 'Staff table must not display "No Students Found"');
});
