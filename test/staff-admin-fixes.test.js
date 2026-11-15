const test = require('node:test');
const assert = require('node:assert/strict');
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
      assert.equal((await r4.json()).error, 'Your staff account is not active. Wait for admin approval.');

      // 5. 'Blocked' rejected with 403
      mockStatus = 'Blocked';
      const r5 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r5.status, 403);

      // 6. null or missing status rejected with 403
      mockStatus = null;
      const r6 = await fetch(`${baseUrl}/api/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'statustest@example.com', password }),
      });
      assert.equal(r6.status, 403);
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
        if (params[0] === 'existing@admin.com') return { rowCount: 1, rows: [{ 1: 1 }] };
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
          adminEmail: 'existing@admin.com',
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
          adminEmail: 'new@admin.com',
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
          adminEmail: 'unique@admin.com',
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
        if (email === 'staff_taken@example.com') rows.push({ email: 'staff_taken@example.com', mobile: '1111111111' });
        if (mobile === '9999911111') rows.push({ email: 'other@example.com', mobile: '9999911111' });
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('SELECT LOWER(email) AS email, mobile FROM staff_request WHERE')) {
        const email = params[0];
        const mobile = params[1];
        const rows = [];
        if (email === 'req_taken@example.com') rows.push({ email: 'req_taken@example.com', mobile: '2222222222' });
        if (mobile === '9999922222') rows.push({ email: 'reqother@example.com', mobile: '9999922222' });
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
          staffName: 'Staff Member', staffMobile: '5555555555', staffEmail: 'staff_taken@example.com',
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
          staffName: 'Staff Member', staffMobile: '9999911111', staffEmail: 'free@example.com',
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
          staffName: 'Staff Member', staffMobile: '5555555555', staffEmail: 'req_taken@example.com',
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
          staffName: 'Staff Member', staffMobile: '9999922222', staffEmail: 'free@example.com',
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
          staffName: 'Staff Member', staffMobile: '9999911111', staffEmail: 'staff_taken@example.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r5.status, 409);
      assert.equal((await r5.json()).error, 'Email Already Registered');

      // 6. Unique credentials succeeds
      const r6 = await fetch(`${baseUrl}/api/auth/staff/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'New Staff Member', staffMobile: '7777788888', staffEmail: 'brand_new@example.com',
          department: 'Electricity', staffPassword: 'Password123!', securityQuestion: 'Q?', securityAnswer: 'A',
        }),
      });
      assert.equal(r6.status, 201);
      const d6 = await r6.json();
      assert.equal(d6.ok, true);
      assert.ok(d6.requestId);
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
