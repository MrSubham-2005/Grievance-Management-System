// Admin API: dashboard counts, assign complaints, approve staff, block students.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole, wrap } = require('../middleware');
const { isOverdue } = require('../sla');
const { recordEvent, timelineFor } = require('../timeline');
const { formatComplaintId, resolveComplaintId } = require('../complaint-id');
const { nextId, withIdLock } = require('../id-generator');
const { fetchRecentComplaints } = require('../recent-complaints');

const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;
const GMAIL_RE = /^[a-z0-9._%+-]+@gmail\.com$/;

const router = express.Router();
router.use(requireRole('admin'));

const fail = (res, status, message) => res.status(status).json({ error: message });
const toDateStr = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');

router.get('/profile', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT admin_name, mobile, email FROM admin WHERE admin_id = $1', [req.user.id]);
  if (!rows[0]) return fail(res, 404, 'Your admin account no longer exists. Sign in again.');
  res.json({ adminName: rows[0].admin_name, mobile: rows[0].mobile, email: rows[0].email });
}));

router.get('/dashboard', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [complaintCounts, userCounts, recentComplaints] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE LOWER(status) = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE LOWER(status) = 'assigned')::int AS assigned,
         COUNT(*) FILTER (WHERE LOWER(status) = 'in progress')::int AS in_progress,
         COUNT(*) FILTER (WHERE LOWER(status) = 'resolved')::int AS resolved,
         COUNT(*)::int AS total
       FROM public.complaint`
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM student) AS students,
         (SELECT COUNT(*)::int FROM staff) AS staff,
         (SELECT COUNT(*)::int FROM staff_request) AS pending_staff`
    ),
    fetchRecentComplaints(pool),
  ]);
  const c = complaintCounts.rows[0];
  const u = userCounts.rows[0];
  res.json({
    totalComplaints: c.total,
    pendingComplaints: c.pending,
    assignedComplaints: c.assigned,
    inProgressComplaints: c.in_progress,
    resolvedComplaints: c.resolved,
    totalStudents: u.students,
    totalStaff: u.staff,
    pendingStaff: u.pending_staff,
    recentComplaints,
  });
}));

router.get('/complaints', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.complaint_id, c.category, c.description, c.status, c.created_at, c.updated_at,
            c.student_id, st.student_name, c.assigned_staff_id, s.staff_name,
            c.assigned_by, aa.admin_name AS assigned_by_name, c.assigned_at,
            c.ai_analysis, c.due_at,
            COUNT(DISTINCT cm.student_id) FILTER (WHERE cm.student_id <> c.student_id)::int AS supporter_count
     FROM complaint c
     JOIN student st ON st.student_id = c.student_id
     LEFT JOIN staff s ON s.staff_id = c.assigned_staff_id
     LEFT JOIN admin aa ON aa.admin_id = c.assigned_by
     LEFT JOIN complaint_member cm ON cm.complaint_id = c.complaint_id
     GROUP BY c.complaint_id, st.student_name, s.staff_name, aa.admin_name
     ORDER BY c.created_at DESC`
  );
  res.json({
    complaints: rows.map((r) => {
      const assigned = Boolean(r.assigned_staff_id);
      const supporterCount = Number(r.supporter_count) || 0;
      return {
        complaintId: formatComplaintId(r.complaint_id),
        category: r.category,
        description: r.description,
        status: r.status,
        studentId: r.student_id,
        studentName: r.student_name,
        assignedStaffId: r.assigned_staff_id || null,
        staffName: assigned ? (r.staff_name || 'Not Assigned') : 'Not Assigned',
        complaintDate: toDateStr(r.created_at),
        assignedAt: assigned ? (r.assigned_at ? toDateStr(r.assigned_at) : 'Not Available') : '',
        assignedBy: assigned ? (r.assigned_by_name || 'Not Available') : '',
        supporterCount,
        supportedBy: `${supporterCount} ${supporterCount === 1 ? 'Student' : 'Students'}`,
        aiAnalysis: r.ai_analysis || null,
        dueAt: r.due_at,
        overdue: isOverdue(r.status, r.due_at),
      };
    }),
  });
}));

// Full case timeline for any complaint.
router.get('/complaints/:id/timeline', wrap(async (req, res) => {
  const actualId = await resolveComplaintId(pool, req.params.id);
  res.json({ events: actualId ? await timelineFor(actualId) : [] });
}));

// Every complaint as a CSV file, for records and reporting. Fields that start with a
// spreadsheet formula character are prefixed so Excel and Sheets do not run them.
router.get('/complaints.csv', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.complaint_id, c.category, c.priority, c.status, c.description, c.resolution,
            c.created_at, c.updated_at, c.student_id, st.student_name, s.staff_name
     FROM complaint c
     JOIN student st ON st.student_id = c.student_id
     LEFT JOIN staff s ON s.staff_id = c.assigned_staff_id
     ORDER BY c.created_at DESC`
  );
  const safe = (v) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const header = ['Complaint ID', 'Student ID', 'Student Name', 'Category', 'Priority', 'Status', 'Assigned Staff', 'Filed On', 'Last Updated', 'Description', 'Resolution'];
  const lines = rows.map((r) => [
    formatComplaintId(r.complaint_id), r.student_id, r.student_name, r.category, r.priority, r.status,
    r.staff_name || 'Not Assigned', toDateStr(r.created_at),
    toDateStr(r.updated_at), r.description, r.resolution || '',
  ].map(safe).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="complaints-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header.map(safe).join(','), ...lines].join('\r\n') + '\r\n');
}));

// Staff in a department matching a complaint category, with their workload.
router.get('/staff-for-category', wrap(async (req, res) => {
  const category = String(req.query.category || '').trim();
  if (!category) return res.json({ staff: [] });
  const { rows } = await pool.query(
    `SELECT s.staff_id, s.staff_name,
            COUNT(c.complaint_id)::int AS total,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) IN ('assigned', 'in progress'))::int AS pending
     FROM staff s
     LEFT JOIN complaint c ON c.assigned_staff_id = s.staff_id
     WHERE s.status = 'Active'
       AND TRIM(UPPER(s.department)) = TRIM(UPPER($1))
     GROUP BY s.staff_id, s.staff_name
     ORDER BY pending ASC, total ASC, s.staff_name ASC, s.staff_id ASC`,
    [category]
  );
  res.json({ staff: rows.map((r) => ({ staffId: r.staff_id, staffName: r.staff_name, total: r.total, pending: r.pending })) });
}));

router.get('/complaints-to-assign', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT complaint_id, category FROM complaint WHERE LOWER(status) = 'pending' AND assigned_staff_id IS NULL ORDER BY created_at ASC`
  );
  res.json({ complaints: rows.map((r) => ({ complaintId: formatComplaintId(r.complaint_id), category: r.category })) });
}));

router.post('/complaints/assign', wrap(async (req, res) => {
  const complaintId = String(req.body.complaint_id || '');
  const staffId = String(req.body.staff_id || '');
  if (!complaintId || !staffId) return fail(res, 400, 'Choose a complaint and a staff member before assigning.');
  const actualId = await resolveComplaintId(pool, complaintId);
  if (!actualId) return fail(res, 404, `Complaint ${formatComplaintId(complaintId) || complaintId} is missing or already resolved.`);
  const staff = await pool.query('SELECT staff_name, department, status FROM staff WHERE staff_id = $1', [staffId]);
  if (!staff.rows[0]) return fail(res, 404, `Staff member ${staffId} does not exist.`);
  if (staff.rows[0].status !== 'Active') return fail(res, 400, `${staff.rows[0].staff_name} is inactive and cannot take complaints.`);

  const formattedId = formatComplaintId(actualId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT complaint_id, status, assigned_staff_id FROM complaint WHERE complaint_id = $1 FOR UPDATE',
      [actualId]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 404, `Complaint ${formattedId} is missing or already resolved.`);
    }
    const currentStatus = String(existing.rows[0].status || '').trim().toLowerCase();
    if (currentStatus === 'resolved') {
      await client.query('ROLLBACK');
      return fail(res, 409, `Complaint ${formattedId} is already resolved.`);
    }
    if (currentStatus !== 'pending' || existing.rows[0].assigned_staff_id) {
      await client.query('ROLLBACK');
      return fail(res, 409, `Complaint ${formattedId} is already ${existing.rows[0].status} and cannot be reassigned.`);
    }
    await client.query(
      `UPDATE complaint
       SET assigned_staff_id = $1,
           assigned_by = $2,
           assigned_at = NOW(),
           status = 'Assigned',
           updated_at = NOW()
       WHERE complaint_id = $3 AND LOWER(status) = 'pending' AND assigned_staff_id IS NULL`,
      [staffId, req.user.id, actualId]
    );
    await recordEvent(actualId, 'assigned', `Assigned to ${staff.rows[0].staff_name}.`, req.user.id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true, message: `Complaint ${formattedId} was assigned to ${staff.rows[0].staff_name}.`, redirect: '/HTML/ADMIN/assign_complaint.html' });
}));

router.post('/complaints/:id/delete', wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actualId = await resolveComplaintId(client, req.params.id);
    const displayId = formatComplaintId(req.params.id) || req.params.id;
    if (!actualId) {
      await client.query('ROLLBACK');
      return fail(res, 404, `Complaint ${displayId} does not exist.`);
    }
    await client.query('DELETE FROM feedback WHERE complaint_id = $1', [actualId]);
    const result = await client.query('DELETE FROM complaint WHERE complaint_id = $1 RETURNING complaint_id', [actualId]);
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 404, `Complaint ${formatComplaintId(actualId)} does not exist.`);
    }
    await client.query('COMMIT');
    res.json({ ok: true, message: `Complaint ${formatComplaintId(actualId)} was deleted.` });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/staff-requests', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT request_id, staff_name, mobile, email, department, created_at
     FROM staff_request ORDER BY created_at ASC`
  );
  res.json(rows);
}));

function parseRequestIdCandidates(rawId) {
  const idStr = String(rawId || '').trim();
  const digits = idStr.match(/\d+$/)?.[0] || '';
  const num = digits ? digits.padStart(4, '0') : '';
  const set = new Set([idStr]);
  if (num) {
    set.add(`REQ-${num}`);
    set.add(`REQ${num}`);
    set.add(num);
  }
  return Array.from(set);
}

// Approving moves the request into the staff table, keeping the same login details.
router.post('/staff-requests/:id/approve', wrap(async (req, res) => {
  const candidates = parseRequestIdCandidates(req.params.id);
  const outcome = await withIdLock(pool, 'staff', async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM staff_request WHERE request_id = ANY($1) FOR UPDATE',
      [candidates]
    );
    if (!rows[0]) {
      return { error: { status: 404, message: `Request ${req.params.id} no longer exists.` } };
    }
    const r = rows[0];
    const actualRequestId = r.request_id;
    const dup = await client.query(
      'SELECT 1 FROM staff WHERE LOWER(email) = $1 OR mobile = $2',
      [String(r.email || '').toLowerCase(), r.mobile]
    );
    if (dup.rowCount) {
      return { error: { status: 409, message: 'A staff member with this email or mobile already exists.' } };
    }
    const staffId = await nextId('staff', 'staff_id', 'STF', client);
    await client.query(
      `INSERT INTO staff (staff_id, staff_name, mobile, email, department, password, security_question, security_answer, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$9,NOW())`,
      [staffId, r.staff_name, r.mobile, r.email, r.department, r.password, r.security_question, r.security_answer, req.user.id]
    );
    await client.query('DELETE FROM staff_request WHERE request_id = $1', [actualRequestId]);
    return { staffId, staffName: r.staff_name };
  });
  if (outcome.error) return fail(res, outcome.error.status, outcome.error.message);
  res.json({ ok: true, staffId: outcome.staffId, message: `Staff member ${outcome.staffName} was approved as ${outcome.staffId}.` });
}));

router.post('/staff-requests/:id/reject', wrap(async (req, res) => {
  const candidates = parseRequestIdCandidates(req.params.id);
  const result = await pool.query(
    'DELETE FROM staff_request WHERE request_id = ANY($1) RETURNING request_id',
    [candidates]
  );
  if (!result.rowCount) return fail(res, 404, `Request ${req.params.id} no longer exists.`);
  res.json({ ok: true, message: `Request ${req.params.id} was rejected.` });
}));

// Staff with complaint counts. Pending requests are listed too, marked with a REQ- prefix.
router.get('/staff', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.staff_id, s.staff_name, s.mobile, s.email, s.department, s.rating, s.status,
            s.created_by, s.created_at, a.admin_name AS created_by_name,
            COUNT(c.complaint_id)::int AS total,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) IN ('pending', 'assigned'))::int AS pending,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) = 'in progress')::int AS in_progress,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) = 'resolved')::int AS resolved
     FROM staff s
     LEFT JOIN admin a ON a.admin_id = s.created_by
     LEFT JOIN complaint c ON c.assigned_staff_id = s.staff_id
     GROUP BY s.staff_id, a.admin_name
     ORDER BY s.staff_name`
  );
  const reqs = await pool.query(
    `SELECT request_id, staff_name, mobile, email, department, created_at FROM staff_request ORDER BY created_at ASC`
  );
  const staff = [
    ...reqs.rows.map((r) => {
      const raw = String(r.request_id || '').trim();
      const displayId = raw.startsWith('REQ-') ? raw : (raw.startsWith('REQ') ? `REQ-${raw.slice(3)}` : `REQ-${raw}`);
      return {
        staffId: displayId, staffName: r.staff_name, mobile: r.mobile, email: r.email,
        department: r.department, rating: 0, status: 'Pending', addedBy: 'Self sign up',
        approvedOn: 'Pending',
        totalComplaint: 0, pending: 0, inProgress: 0, resolved: 0,
      };
    }),
    ...rows.map((r) => ({
      staffId: r.staff_id, staffName: r.staff_name, mobile: r.mobile, email: r.email,
      department: r.department, rating: Number(r.rating), status: r.status,
      addedBy: r.created_by_name || 'Not Available',
      approvedOn: r.created_at ? toDateStr(r.created_at) : 'Not Available',
      totalComplaint: r.total, pending: r.pending, inProgress: r.in_progress, resolved: r.resolved,
    })),
  ];
  res.json({ staff });
}));

// Admin adds an active staff member directly.
router.post('/staff', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const mobile = String(req.body.mobile || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const department = String(req.body.department || '').trim();
  const password = String(req.body.password || '');
  const question = String(req.body.securityQuestion || '').trim();
  const answer = String(req.body.securityAnswer || '').trim();
  if (!name || !mobile || !email || !department || !password || !question || !answer) {
    return fail(res, 400, 'Fill in every field before adding staff.');
  }
  if (!INDIAN_MOBILE_RE.test(mobile)) {
    return fail(res, 400, 'Enter a valid 10-digit Indian mobile number.');
  }
  if (!GMAIL_RE.test(email)) {
    return fail(res, 400, 'Enter a valid Gmail address.');
  }
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const outcome = await withIdLock(pool, 'staff', async (client) => {
    const existingStaff = await client.query(
      'SELECT LOWER(email) AS email, mobile FROM staff WHERE LOWER(email) = $1 OR mobile = $2',
      [email, mobile]
    );
    if (existingStaff.rowCount > 0) {
      const emailTaken = existingStaff.rows.some((r) => r.email === email);
      if (emailTaken) {
        return { error: { status: 409, message: 'Email Already Exists' } };
      }
      return { error: { status: 409, message: 'Mobile Already Exists' } };
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

    const staffId = await nextId('staff', 'staff_id', 'STF', client);
    await client.query(
      `INSERT INTO staff (staff_id, staff_name, mobile, email, department, password, security_question, security_answer, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$9,NOW())`,
      [staffId, name, mobile, email, department, await bcrypt.hash(password, 10), question, answer.toLowerCase(), req.user.id]
    );
    return { staffId };
  });
  if (outcome.error) return fail(res, outcome.error.status, outcome.error.message);
  res.status(201).json({ ok: true, staffId: outcome.staffId, message: `Staff member ${name} was added as ${outcome.staffId}.` });
}));

// Activate or deactivate an existing staff member.
router.post('/staff/:id/status', wrap(async (req, res) => {
  const status = req.body.action === 'inactive' ? 'Inactive' : 'Active';
  const result = await pool.query('UPDATE staff SET status = $1 WHERE staff_id = $2 RETURNING staff_id', [status, req.params.id]);
  if (!result.rowCount) return fail(res, 404, `Staff member ${req.params.id} does not exist.`);
  if (status === 'Inactive') {
    try {
      await pool.query(`DELETE FROM session WHERE sess->'staff'->>'id' = $1`, [req.params.id]);
    } catch (_) {
      // session cleanup is best-effort
    }
  }
  res.json({ ok: true, status, message: `Staff member ${req.params.id} is now ${status}.` });
}));

router.get('/students', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT st.student_id, st.student_name, st.mobile, st.email, st.status,
            COUNT(c.complaint_id)::int AS total,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) = 'assigned')::int AS assigned,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) = 'pending')::int AS pending,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) = 'in progress')::int AS in_progress,
            COUNT(c.complaint_id) FILTER (WHERE LOWER(c.status) = 'resolved')::int AS resolved
     FROM student st LEFT JOIN complaint c ON c.student_id = st.student_id
     GROUP BY st.student_id ORDER BY st.created_at DESC`
  );
  res.json({
    students: rows.map((r) => ({
      studentId: r.student_id, studentName: r.student_name, mobile: r.mobile, email: r.email,
      status: r.status, totalComplaint: r.total, assigned: r.assigned, pending: r.pending,
      inProgress: r.in_progress, resolved: r.resolved,
    })),
  });
}));

router.post('/students/:id/status', wrap(async (req, res) => {
  const status = req.body.action === 'inactive' ? 'Blocked' : 'Active';
  const result = await pool.query(
    'UPDATE student SET status = $1 WHERE student_id = $2 RETURNING student_id',
    [status, req.params.id]
  );
  if (!result.rowCount) return fail(res, 404, `Student ${req.params.id} does not exist.`);
  if (status === 'Blocked') {
    try {
      await pool.query(`DELETE FROM session WHERE sess->'student'->>'id' = $1`, [req.params.id]);
    } catch (_) {
      // session cleanup is best-effort
    }
  }
  res.json({ ok: true, status, message: `Student ${req.params.id} is now ${status}.` });
}));

router.post('/password', wrap(async (req, res) => {
  const body = req.body || {};
  const current = typeof body.admin_current_password === 'string' ? body.admin_current_password : '';
  const next = typeof body.admin_new_password === 'string' ? body.admin_new_password : '';
  const confirm = typeof body.admin_conform_password === 'string' ? body.admin_conform_password : '';
  if (!current.trim() || !next.trim() || !confirm.trim()) {
    return fail(res, 400, 'Fill in all three password fields.');
  }
  if (next !== confirm) return fail(res, 400, 'The new passwords do not match.');
  if (next.length < 6) return fail(res, 400, 'New password must be at least 6 characters.');
  if (current === next) return fail(res, 400, 'New Password cannot be the same as Current Password');
  const { rows } = await pool.query('SELECT password FROM admin WHERE admin_id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password))) {
    return fail(res, 401, 'Your current password is wrong.');
  }
  await pool.query('UPDATE admin SET password = $1 WHERE admin_id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true, message: 'Password changed.', redirect: '/HTML/ADMIN/admin_dashboard.html' });
}));

module.exports = router;
