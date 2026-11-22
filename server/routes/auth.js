// Sign in, sign up, sign out for students, staff and admins.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { wrap } = require('../middleware');
const { nextId, withIdLock } = require('../id-generator');

const router = express.Router();

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

const RESET_MAX_FAILURES = 5;
const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;
const GMAIL_RE = /^[a-z0-9._%+-]+@gmail\.com$/;

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

router.nextId = nextId;

function resolveIdentifier(body, rolePrefix) {
  const b = body || {};
  const emailKey = `${rolePrefix}Email`;
  const mobileKey = `${rolePrefix}Mobile`;

  const hasMobileKey = mobileKey in b || 'mobile' in b;
  const hasEmailKey = emailKey in b || 'email' in b;

  let rawValue;
  let kind = 'email';

  if (hasMobileKey && !hasEmailKey) {
    kind = 'mobile';
    rawValue = b[mobileKey] !== undefined ? b[mobileKey] : b.mobile;
  } else if (hasEmailKey && !hasMobileKey) {
    rawValue = b[emailKey] !== undefined ? b[emailKey] : b.email;
    if (typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())) {
      kind = 'mobile';
    } else {
      kind = 'email';
    }
  } else if (hasEmailKey && hasMobileKey) {
    const rawMobile = b[mobileKey] !== undefined ? b[mobileKey] : b.mobile;
    const rawEmail = b[emailKey] !== undefined ? b[emailKey] : b.email;
    if (clean(rawMobile)) {
      kind = 'mobile';
      rawValue = rawMobile;
    } else if (clean(rawEmail)) {
      kind = 'email';
      rawValue = rawEmail;
    } else if (rawMobile !== undefined) {
      kind = 'mobile';
      rawValue = rawMobile;
    } else {
      kind = 'email';
      rawValue = rawEmail;
    }
  } else if ('identifier' in b) {
    rawValue = b.identifier;
    if (typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())) {
      kind = 'mobile';
    } else {
      kind = 'email';
    }
  } else {
    kind = 'email';
    rawValue = undefined;
  }

  const value = clean(rawValue);
  const isPresent = Boolean(rawValue !== null && rawValue !== undefined && value !== '');

  return { value, kind, isPresent };
}

async function findUserForLogin(table, body, rolePrefix, password) {
  const ident = resolveIdentifier(body, rolePrefix);
  if (!ident.isPresent) {
    return {
      error: {
        status: 400,
        message: ident.kind === 'mobile' ? 'Invalid Mobile Number' : 'Invalid Email',
      },
    };
  }

  if (!password) {
    return { error: { status: 400, message: 'Enter your email and password.' } };
  }

  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE LOWER(email) = LOWER($1) OR mobile = $1`,
    [ident.value]
  );

  const candidates = (rows || []).filter((r) => {
    if (ident.kind === 'mobile') {
      return Boolean(r.mobile && r.mobile === ident.value);
    }
    return Boolean(r.email && r.email.toLowerCase() === ident.value.toLowerCase());
  });

  if (candidates.length === 0) {
    if (table === 'staff') {
      const pendingRes = await pool.query(
        `SELECT 1
         FROM staff_request
         WHERE LOWER(email) = LOWER($1) OR mobile = $1
         LIMIT 1`,
        [ident.value]
      );
      if (pendingRes.rowCount || (pendingRes.rows && pendingRes.rows.length > 0)) {
        return {
          error: {
            status: 403,
            message:
              'Your registration request is pending Admin approval. Please wait until your account is approved.',
          },
        };
      }
    }

    return {
      notFound: true,
      error: {
        status: 401,
        message: ident.kind === 'mobile' ? 'Invalid Mobile Number' : 'Invalid Email',
      },
    };
  }

  let matchedUser = null;
  for (const candidate of candidates) {
    if (await bcrypt.compare(password, candidate.password)) {
      if (matchedUser) {
        return { error: { status: 401, message: 'Email or password is incorrect.' } };
      }
      matchedUser = candidate;
    }
  }

  if (!matchedUser) {
    return { error: { status: 401, message: 'Email or password is incorrect.' } };
  }

  return { user: matchedUser };
}

// Students

router.post('/student/login', wrap(async (req, res) => {
  const password = req.body.studentPassword || req.body.password || '';
  const result = await findUserForLogin('student', req.body, 'student', password);
  if (result.error) return fail(res, result.error.status, result.error.message);
  const user = result.user;
  if ((user.status || '').toLowerCase() !== 'active') return fail(res, 403, 'This student account is blocked. Contact the admin.');
  req.session.student = { id: user.student_id, name: user.student_name, email: user.email };
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
  const outcome = await withIdLock(pool, 'student', async (client) => {
    const existing = await client.query(
      'SELECT LOWER(email) AS email, mobile FROM student WHERE LOWER(email) = $1 OR mobile = $2',
      [email, mobile]
    );
    if (existing.rowCount > 0) {
      const emailTaken = existing.rows.some((r) => r.email === email);
      const mobileTaken = existing.rows.some((r) => r.mobile === mobile);
      if (emailTaken) {
        return { error: { status: 409, message: 'Email already registered' } };
      }
      if (mobileTaken) {
        return { error: { status: 409, message: 'Mobile Number already registered' } };
      }
    }
    const id = await nextId('student', 'student_id', 'STU', client);
    await client.query(
      `INSERT INTO student (student_id, student_name, mobile, email, password, security_question, security_answer)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, name, mobile, email, await bcrypt.hash(password, 10), question, answer.toLowerCase()]
    );
    return { id };
  });
  if (outcome.error) return fail(res, outcome.error.status, outcome.error.message);
  res.status(201).json({ ok: true, studentId: outcome.id, redirect: '/HTML/STUDENTS/student_login.html' });
}));

// Staff

router.post('/staff/login', wrap(async (req, res) => {
  const password = req.body.staffPassword || req.body.password || '';
  const result = await findUserForLogin('staff', req.body, 'staff', password);
  if (result.error) return fail(res, result.error.status, result.error.message);
  const user = result.user;
  if ((user.status || '').toLowerCase() !== 'active') return fail(res, 403, 'Your account has been deactivated by the Admin.');
  req.session.staff = { id: user.staff_id, name: user.staff_name, email: user.email, department: user.department };
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
  if (!INDIAN_MOBILE_RE.test(mobile)) {
    return fail(res, 400, 'Enter a valid 10-digit Indian mobile number.');
  }
  if (!GMAIL_RE.test(email)) {
    return fail(res, 400, 'Enter a valid Gmail address.');
  }
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const outcome = await withIdLock(pool, 'staff_request', async (client) => {
    const existingStaff = await client.query(
      'SELECT LOWER(email) AS email, mobile FROM staff WHERE LOWER(email) = $1 OR mobile = $2',
      [email, mobile]
    );
    if (existingStaff.rowCount > 0) {
      const emailTaken = existingStaff.rows.some((r) => r.email === email);
      if (emailTaken) {
        return { error: { status: 409, message: 'Email Already Registered' } };
      }
      return { error: { status: 409, message: 'Mobile Number Already Registered' } };
    }

    const existingReq = await client.query(
      'SELECT LOWER(email) AS email, mobile FROM staff_request WHERE LOWER(email) = $1 OR mobile = $2',
      [email, mobile]
    );
    if (existingReq.rowCount > 0) {
      const reqEmailTaken = existingReq.rows.some((r) => r.email === email);
      if (reqEmailTaken) {
        return { error: { status: 409, message: 'Email Already Requested' } };
      }
      return { error: { status: 409, message: 'Mobile Number Already Requested' } };
    }
    const id = await nextId('staff_request', 'request_id', 'REQ', client);
    await client.query(
      `INSERT INTO staff_request (request_id, staff_name, mobile, email, department, password, security_question, security_answer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, name, mobile, email, department, await bcrypt.hash(password, 10), question, answer.toLowerCase()]
    );
    return { id };
  });
  if (outcome.error) return fail(res, outcome.error.status, outcome.error.message);
  res.status(201).json({ ok: true, requestId: outcome.id, message: 'Request sent. An admin must approve it before you can sign in.' });
}));

// Admins

router.post('/admin/login', wrap(async (req, res) => {
  const password = req.body.adminPassword || req.body.password || '';
  const result = await findUserForLogin('admin', req.body, 'admin', password);
  if (result.error) return fail(res, result.error.status, result.error.message);
  const user = result.user;
  req.session.admin = { id: user.admin_id, name: user.admin_name, email: user.email };
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
  if (!INDIAN_MOBILE_RE.test(mobile)) {
    return fail(res, 400, 'Enter a valid 10-digit Indian mobile number.');
  }
  if (!GMAIL_RE.test(email)) {
    return fail(res, 400, 'Enter a valid Gmail address.');
  }
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const secret = await pool.query('SELECT secret_code FROM admin_secret WHERE id = 1');
  if (!secret.rowCount || !(await bcrypt.compare(code, secret.rows[0].secret_code))) {
    return fail(res, 403, 'The admin code is wrong. Ask the system owner for the current code.');
  }
  const outcome = await withIdLock(pool, 'admin', async (client) => {
    const taken = await client.query('SELECT 1 FROM admin WHERE LOWER(email)=$1', [email]);
    if (taken.rowCount) {
      return { error: { status: 409, message: 'An admin with this email already exists. Sign in instead.' } };
    }
    const mobileTaken = await client.query('SELECT 1 FROM admin WHERE mobile=$1', [mobile]);
    if (mobileTaken.rowCount) {
      return { error: { status: 409, message: 'Mobile Already Exists' } };
    }
    const id = await nextId('admin', 'admin_id', 'ADM', client);
    await client.query(
      `INSERT INTO admin (admin_id, admin_name, mobile, email, password, security_question, security_answer)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, name, mobile, email, await bcrypt.hash(password, 10), question, answer.toLowerCase()]
    );
    return { id };
  });
  if (outcome.error) return fail(res, outcome.error.status, outcome.error.message);
  res.status(201).json({ ok: true, adminId: outcome.id, redirect: '/HTML/ADMIN/admin_login.html' });
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
  if (!account) {
    if (req.params.role === 'staff') {
      const pending = await pool.query(
        'SELECT 1 FROM staff_request WHERE LOWER(email) = $1 LIMIT 1',
        [email]
      );
      if (pending.rowCount) {
        return fail(
          res,
          403,
          'Your registration request is pending Admin approval. Please wait until your account is approved.'
        );
      }
    }
    return fail(res, 404, `No ${config.label} account uses that email.`);
  }

  const { rows: recent } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reset_attempt
     WHERE role = $1 AND email = $2 AND failed_at > now() - interval '15 minutes'`,
    [req.params.role, email]
  );
  if (recent[0].n >= RESET_MAX_FAILURES) {
    return fail(res, 429, 'Too many wrong answers. Wait 15 minutes, then try again.');
  }

  const storedAnswer = clean(account.security_answer).toLowerCase();
  if (account.security_question !== question || !storedAnswer || storedAnswer !== answer) {
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
  const clearCookie = () => {
    res.clearCookie('gms.sid', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
  };
  if (!req.session) {
    clearCookie();
    return res.json({ ok: true, redirect: '/Home.html' });
  }
  req.session.destroy((err) => {
    if (err) {
      return fail(res, 500, 'Could not sign you out right now. Please try again.');
    }
    clearCookie();
    res.json({ ok: true, redirect: '/Home.html' });
  });
});

module.exports = router;
