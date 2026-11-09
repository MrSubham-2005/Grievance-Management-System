// Sign in, sign up, sign out for students, staff and admins.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { wrap } = require('../middleware');

const router = express.Router();

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

const RESET_MAX_FAILURES = 5;

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

async function nextId(table, column, prefix) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(${column} FROM ${prefix.length + 1}) AS INTEGER)), 0) AS n FROM ${table}`
  );
  return `${prefix}${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}

// Students

router.post('/student/login', wrap(async (req, res) => {
  const email = clean(req.body.studentEmail).toLowerCase();
  const password = req.body.studentPassword || '';
  if (!email || !password) return fail(res, 400, 'Enter your email and password.');
  const { rows } = await pool.query('SELECT * FROM student WHERE LOWER(email) = $1', [email]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password))) {
    return fail(res, 401, 'Email or password is incorrect.');
  }
  if (rows[0].status !== 'Active') return fail(res, 403, 'This student account is blocked. Contact the admin.');
  req.session.student = { id: rows[0].student_id, name: rows[0].student_name, email: rows[0].email };
  res.json({ ok: true, redirect: '/HTML/STUDENTS/student_dashboard.html' });
}));

router.post('/student/signup', wrap(async (req, res) => {
  const name = clean(req.body.studentName);
  const mobile = clean(req.body.studentMobile);
  const email = clean(req.body.studentEmail).toLowerCase();
  const password = req.body.studentPassword || '';
  const question = clean(req.body.securityQuestion);
  const answer = clean(req.body.securityAnswer);
  if (!name || !mobile || !email || !password || !question || !answer) {
    return fail(res, 400, 'Fill in every field to create your student account.');
  }
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const taken = await pool.query('SELECT 1 FROM student WHERE LOWER(email) = $1 OR mobile = $2', [email, mobile]);
  if (taken.rowCount) return fail(res, 409, 'A student with this email or mobile already exists. Sign in instead.');
  const id = await nextId('student', 'student_id', 'STU');
  await pool.query(
    `INSERT INTO student (student_id, student_name, mobile, email, password, security_question, security_answer)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name, mobile, email, await bcrypt.hash(password, 10), question, answer.toLowerCase()]
  );
  res.status(201).json({ ok: true, studentId: id, redirect: '/HTML/STUDENTS/student_login.html' });
}));

// Staff

router.post('/staff/login', wrap(async (req, res) => {
  const email = clean(req.body.staffEmail).toLowerCase();
  const password = req.body.staffPassword || '';
  if (!email || !password) return fail(res, 400, 'Enter your email and password.');
  const { rows } = await pool.query('SELECT * FROM staff WHERE LOWER(email) = $1', [email]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password))) {
    return fail(res, 401, 'Email or password is incorrect.');
  }
  if (rows[0].status !== 'Active') return fail(res, 403, 'Your staff account is not active. Wait for admin approval.');
  req.session.staff = { id: rows[0].staff_id, name: rows[0].staff_name, email: rows[0].email, department: rows[0].department };
  res.json({ ok: true, redirect: '/HTML/STAFF/staff_dashboard.html' });
}));

router.post('/staff/signup', wrap(async (req, res) => {
  const name = clean(req.body.staffName);
  const mobile = clean(req.body.staffMobile);
  const email = clean(req.body.staffEmail).toLowerCase();
  const department = clean(req.body.department);
  const password = req.body.staffPassword || '';
  const question = clean(req.body.securityQuestion);
  const answer = clean(req.body.securityAnswer);
  if (!name || !mobile || !email || !department || !password || !question || !answer) {
    return fail(res, 400, 'Fill in every field to request a staff account.');
  }
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const taken = await pool.query(
    `SELECT 1 FROM staff WHERE LOWER(email)=$1 OR mobile=$2
     UNION ALL SELECT 1 FROM staff_request WHERE LOWER(email)=$1 OR mobile=$2`,
    [email, mobile]
  );
  if (taken.rowCount) return fail(res, 409, 'A staff account or pending request already uses this email or mobile.');
  const id = await nextId('staff_request', 'request_id', 'REQ');
  await pool.query(
    `INSERT INTO staff_request (request_id, staff_name, mobile, email, department, password, security_question, security_answer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, name, mobile, email, department, await bcrypt.hash(password, 10), question, answer.toLowerCase()]
  );
  res.status(201).json({ ok: true, requestId: id, message: 'Request sent. An admin must approve it before you can sign in.' });
}));

// Admins

router.post('/admin/login', wrap(async (req, res) => {
  const email = clean(req.body.adminEmail).toLowerCase();
  const password = req.body.adminPassword || '';
  if (!email || !password) return fail(res, 400, 'Enter your email and password.');
  const { rows } = await pool.query('SELECT * FROM admin WHERE LOWER(email) = $1', [email]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password))) {
    return fail(res, 401, 'Email or password is incorrect.');
  }
  req.session.admin = { id: rows[0].admin_id, name: rows[0].admin_name, email: rows[0].email };
  res.json({ ok: true, redirect: '/HTML/ADMIN/admin_dashboard.html' });
}));

router.post('/admin/signup', wrap(async (req, res) => {
  const name = clean(req.body.adminName);
  const mobile = clean(req.body.adminMobile);
  const email = clean(req.body.adminEmail).toLowerCase();
  const password = req.body.adminPassword || '';
  const code = req.body.secretCode || '';
  const question = clean(req.body.securityQuestion);
  const answer = clean(req.body.securityAnswer);
  if (!name || !mobile || !email || !password || !code || !question || !answer) {
    return fail(res, 400, 'Fill in every field, including the admin code.');
  }
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const secret = await pool.query('SELECT secret_code FROM admin_secret WHERE id = 1');
  if (!secret.rowCount || !(await bcrypt.compare(code, secret.rows[0].secret_code))) {
    return fail(res, 403, 'The admin code is wrong. Ask the system owner for the current code.');
  }
  const taken = await pool.query('SELECT 1 FROM admin WHERE LOWER(email)=$1', [email]);
  if (taken.rowCount) return fail(res, 409, 'An admin with this email already exists. Sign in instead.');
  const id = await nextId('admin', 'admin_id', 'ADM');
  await pool.query(
    `INSERT INTO admin (admin_id, admin_name, mobile, email, password, security_question, security_answer)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name, mobile, email, await bcrypt.hash(password, 10), question, answer.toLowerCase()]
  );
  res.status(201).json({ ok: true, adminId: id, redirect: '/HTML/ADMIN/admin_login.html' });
}));

// Forgot password: checks the email, security question and answer, then sets a new password.
// The server generates the password and returns it once, so the page never handles a value it made up.
const RESET_TABLES = {
  student: { table: 'student', idColumn: 'student_id', label: 'student' },
  staff: { table: 'staff', idColumn: 'staff_id', label: 'staff member' },
  admin: { table: 'admin', idColumn: 'admin_id', label: 'admin' },
};

function generatePassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = require('crypto').randomBytes(10);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

router.post('/:role/reset-password', wrap(async (req, res) => {
  const config = RESET_TABLES[req.params.role];
  if (!config) return fail(res, 404, 'Unknown account type. Go back to the sign in page and choose again.');
  const email = clean(req.body.email || req.body.studentEmail || req.body.staffEmail || req.body.adminEmail).toLowerCase();
  const question = clean(req.body.securityQuestion);
  const answer = clean(req.body.securityAnswer).toLowerCase();
  if (!email || !question || !answer) return fail(res, 400, 'Fill in your email, security question and answer.');
  const { rows } = await pool.query(
    `SELECT ${config.idColumn} AS id, security_question, security_answer FROM ${config.table} WHERE LOWER(email) = $1`,
    [email]
  );
  const account = rows[0];
  if (!account) return fail(res, 404, `No ${config.label} account uses that email. Check the address or sign up first.`);

  const { rows: recent } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reset_attempt
     WHERE role = $1 AND email = $2 AND failed_at > now() - interval '15 minutes'`,
    [req.params.role, email]
  );
  if (recent[0].n >= RESET_MAX_FAILURES) {
    return fail(res, 429, 'Too many wrong answers. Wait 15 minutes, then try again.');
  }

  if (account.security_question !== question || account.security_answer.toLowerCase() !== answer) {
    await pool.query('INSERT INTO reset_attempt (email, role) VALUES ($1, $2)', [email, req.params.role]);
    return fail(res, 403, 'The security question or answer does not match. Check them and try again.');
  }

  await pool.query('DELETE FROM reset_attempt WHERE role = $1 AND email = $2', [req.params.role, email]);
  const password = generatePassword();
  await pool.query(`UPDATE ${config.table} SET password = $1 WHERE ${config.idColumn} = $2`, [await bcrypt.hash(password, 10), account.id]);
  res.json({ ok: true, password, message: `Your new password is ${password}. Copy it now, it is shown only once.` });
}));

// Reports which portal the current browser is signed in to. Used by the page guards.
router.get('/session', (req, res) => {
  const s = req.session || {};
  res.set('Cache-Control', 'no-store');
  res.json({ student: !!s.student, staff: !!s.staff, admin: !!s.admin });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true, redirect: '/Home.html' }));
});

module.exports = router;
