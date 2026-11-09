// Admin API: dashboard counts, assign complaints, approve staff, block students.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole, wrap } = require('../middleware');
const { isOverdue } = require('../sla');
const { recordEvent, timelineFor } = require('../timeline');

const router = express.Router();
router.use(requireRole('admin'));

const fail = (res, status, message) => res.status(status).json({ error: message });

router.get('/profile', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT admin_name, mobile, email FROM admin WHERE admin_id = $1', [req.user.id]);
  if (!rows[0]) return fail(res, 404, 'Your admin account no longer exists. Sign in again.');
  res.json({ adminName: rows[0].admin_name, mobile: rows[0].mobile, email: rows[0].email });
}));

router.get('/dashboard', wrap(async (req, res) => {
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM complaint) AS total,
       (SELECT COUNT(*)::int FROM complaint WHERE status = 'Pending') AS pending,
       (SELECT COUNT(*)::int FROM complaint WHERE assigned_staff_id IS NOT NULL) AS assigned,
       (SELECT COUNT(*)::int FROM complaint WHERE status = 'In Progress') AS in_progress,
       (SELECT COUNT(*)::int FROM complaint WHERE status = 'Resolved') AS resolved,
       (SELECT COUNT(*)::int FROM student) AS students,
       (SELECT COUNT(*)::int FROM staff) AS staff,
       (SELECT COUNT(*)::int FROM staff_request) AS pending_staff`
  );
  const recent = await pool.query(
    `SELECT c.complaint_id, s.student_name, c.student_id, c.category, c.description, c.status, c.created_at
     FROM complaint c JOIN student s ON s.student_id = c.student_id
     ORDER BY c.created_at DESC LIMIT 5`
  );
  const c = counts.rows[0];
  res.json({
    totalComplaints: c.total,
    pendingComplaints: c.pending,
    assignedComplaints: c.assigned,
    inProgressComplaints: c.in_progress,
    resolvedComplaints: c.resolved,
    totalStudents: c.students,
    totalStaff: c.staff,
    pendingStaff: c.pending_staff,
    recentComplaints: recent.rows.map((r) => ({
      complaintId: r.complaint_id, studentName: r.student_name, studentId: r.student_id,
      category: r.category, description: r.description, status: r.status,
      date: new Date(r.created_at).toISOString().slice(0, 10),
    })),
  });
}));

router.get('/complaints', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.complaint_id, c.category, c.description, c.status, c.created_at, c.updated_at,
            c.student_id, st.student_name, c.assigned_staff_id, s.staff_name, c.ai_analysis, c.due_at
     FROM complaint c
     JOIN student st ON st.student_id = c.student_id
     LEFT JOIN staff s ON s.staff_id = c.assigned_staff_id
     ORDER BY c.created_at DESC`
  );
  res.json({
    complaints: rows.map((r) => ({
      complaintId: r.complaint_id, category: r.category, description: r.description,
      status: r.status, studentId: r.student_id, studentName: r.student_name,
      staffName: r.staff_name || 'Not assigned',
      complaintDate: new Date(r.created_at).toISOString().slice(0, 10),
      assignedAt: r.assigned_staff_id ? new Date(r.updated_at).toISOString().slice(0, 10) : '',
      assignedBy: r.assigned_staff_id ? 'Admin' : '',
      supportedBy: r.staff_name || 'Not assigned',
      aiAnalysis: r.ai_analysis || null,
      dueAt: r.due_at,
      overdue: isOverdue(r.status, r.due_at),
    })),
  });
}));

// Full case timeline for any complaint.
router.get('/complaints/:id/timeline', wrap(async (req, res) => {
  res.json({ events: await timelineFor(req.params.id) });
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
    r.complaint_id, r.student_id, r.student_name, r.category, r.priority, r.status,
    r.staff_name || 'Not assigned', new Date(r.created_at).toISOString().slice(0, 10),
    new Date(r.updated_at).toISOString().slice(0, 10), r.description, r.resolution || '',
  ].map(safe).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="complaints-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header.map(safe).join(','), ...lines].join('\r\n') + '\r\n');
}));

// Staff in a department matching a complaint category, with their workload.
router.get('/staff-for-category', wrap(async (req, res) => {
  const category = String(req.query.category || '');
  const { rows } = await pool.query(
    `SELECT s.staff_id, s.staff_name,
            COUNT(c.complaint_id)::int AS total,
            COUNT(c.complaint_id) FILTER (WHERE c.status <> 'Resolved')::int AS pending
     FROM staff s LEFT JOIN complaint c ON c.assigned_staff_id = s.staff_id
     WHERE s.status = 'Active' AND s.department = $1
     GROUP BY s.staff_id, s.staff_name ORDER BY s.staff_name`,
    [category]
  );
  res.json({ staff: rows.map((r) => ({ staffId: r.staff_id, staffName: r.staff_name, total: r.total, pending: r.pending })) });
}));

router.get('/complaints-to-assign', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT complaint_id, category FROM complaint WHERE status <> 'Resolved' AND assigned_staff_id IS NULL ORDER BY created_at ASC`
  );
  res.json({ complaints: rows.map((r) => ({ complaintId: r.complaint_id, category: r.category })) });
}));

router.post('/complaints/assign', wrap(async (req, res) => {
  const complaintId = String(req.body.complaint_id || '');
  const staffId = String(req.body.staff_id || '');
  if (!complaintId || !staffId) return fail(res, 400, 'Choose a complaint and a staff member before assigning.');
  const staff = await pool.query("SELECT staff_name, department, status FROM staff WHERE staff_id = $1", [staffId]);
  if (!staff.rows[0]) return fail(res, 404, `Staff member ${staffId} does not exist.`);
  if (staff.rows[0].status !== 'Active') return fail(res, 400, `${staff.rows[0].staff_name} is inactive and cannot take complaints.`);
  const result = await pool.query(
    `UPDATE complaint SET assigned_staff_id = $1, status = CASE WHEN status = 'Pending' THEN 'In Progress' ELSE status END, updated_at = NOW()
     WHERE complaint_id = $2 AND status <> 'Resolved' RETURNING complaint_id`,
    [staffId, complaintId]
  );
  if (!result.rowCount) return fail(res, 404, `Complaint ${complaintId} is missing or already resolved.`);
  await recordEvent(complaintId, 'assigned', `Assigned to ${staff.rows[0].staff_name}.`, req.user.id);
  res.json({ ok: true, message: `Complaint ${complaintId} was assigned to ${staff.rows[0].staff_name}.`, redirect: '/HTML/ADMIN/assign_complaint.html' });
}));

router.post('/complaints/:id/delete', wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM feedback WHERE complaint_id = $1', [req.params.id]);
    const result = await client.query('DELETE FROM complaint WHERE complaint_id = $1 RETURNING complaint_id', [req.params.id]);
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 404, `Complaint ${req.params.id} does not exist.`);
    }
    await client.query('COMMIT');
    res.json({ ok: true, message: `Complaint ${req.params.id} was deleted.` });
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

// Approving moves the request into the staff table, keeping the same login details.
router.post('/staff-requests/:id/approve', wrap(async (req, res) => {
  const requestId = req.params.id.replace(/^REQ-/, '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM staff_request WHERE request_id = $1 FOR UPDATE', [requestId]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return fail(res, 404, `Request ${req.params.id} no longer exists.`);
    }
    const r = rows[0];
    const idRes = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(staff_id FROM 4) AS INTEGER)), 0) AS n FROM staff`
    );
    const staffId = `STF${String(Number(idRes.rows[0].n) + 1).padStart(4, '0')}`;
    await client.query(
      `INSERT INTO staff (staff_id, staff_name, mobile, email, department, password, security_question, security_answer, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$9)`,
      [staffId, r.staff_name, r.mobile, r.email, r.department, r.password, r.security_question, r.security_answer, req.user.id]
    );
    await client.query('DELETE FROM staff_request WHERE request_id = $1', [requestId]);
    await client.query('COMMIT');
    res.json({ ok: true, staffId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/staff-requests/:id/reject', wrap(async (req, res) => {
  const result = await pool.query('DELETE FROM staff_request WHERE request_id = $1 RETURNING request_id', [req.params.id.replace(/^REQ-/, '')]);
  if (!result.rowCount) return fail(res, 404, `Request ${req.params.id} no longer exists.`);
  res.json({ ok: true, message: `Request ${req.params.id} was rejected.` });
}));

// Staff with complaint counts. Pending requests are listed too, marked with a REQ- prefix.
router.get('/staff', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.staff_id, s.staff_name, s.mobile, s.email, s.department, s.rating, s.status, s.created_at,
            COUNT(c.complaint_id)::int AS total,
            COUNT(c.complaint_id) FILTER (WHERE c.status = 'Pending')::int AS pending,
            COUNT(c.complaint_id) FILTER (WHERE c.status = 'In Progress')::int AS in_progress,
            COUNT(c.complaint_id) FILTER (WHERE c.status = 'Resolved')::int AS resolved
     FROM staff s LEFT JOIN complaint c ON c.assigned_staff_id = s.staff_id
     GROUP BY s.staff_id ORDER BY s.staff_name`
  );
  const reqs = await pool.query(
    `SELECT request_id, staff_name, mobile, email, department, created_at FROM staff_request ORDER BY created_at ASC`
  );
  const staff = [
    ...reqs.rows.map((r) => ({
      staffId: `REQ-${r.request_id}`, staffName: r.staff_name, mobile: r.mobile, email: r.email,
      department: r.department, rating: 0, status: 'Pending', addedBy: 'Self sign up',
      createdDate: new Date(r.created_at).toISOString().slice(0, 10),
      totalComplaint: 0, pending: 0, inProgress: 0, resolved: 0,
    })),
    ...rows.map((r) => ({
      staffId: r.staff_id, staffName: r.staff_name, mobile: r.mobile, email: r.email,
      department: r.department, rating: Number(r.rating), status: r.status, addedBy: 'Admin',
      createdDate: new Date(r.created_at).toISOString().slice(0, 10),
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
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const taken = await pool.query('SELECT 1 FROM staff WHERE LOWER(email) = $1', [email]);
  if (taken.rowCount) return fail(res, 409, 'A staff member with this email already exists.');
  const idRes = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(staff_id FROM 4) AS INTEGER)), 0) AS n FROM staff`
  );
  const staffId = `STF${String(Number(idRes.rows[0].n) + 1).padStart(4, '0')}`;
  await pool.query(
    `INSERT INTO staff (staff_id, staff_name, mobile, email, department, password, security_question, security_answer, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$9)`,
    [staffId, name, mobile, email, department, await bcrypt.hash(password, 10), question, answer.toLowerCase(), req.user.id]
  );
  res.status(201).json({ ok: true, staffId, message: `Staff member ${name} was added as ${staffId}.` });
}));

// Activate or deactivate an existing staff member.
router.post('/staff/:id/status', wrap(async (req, res) => {
  const status = req.body.action === 'inactive' ? 'Inactive' : 'Active';
  const result = await pool.query('UPDATE staff SET status = $1 WHERE staff_id = $2 RETURNING staff_id', [status, req.params.id]);
  if (!result.rowCount) return fail(res, 404, `Staff member ${req.params.id} does not exist.`);
  res.json({ ok: true, status, message: `Staff member ${req.params.id} is now ${status}.` });
}));

router.get('/students', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT st.student_id, st.student_name, st.mobile, st.email, st.status,
            COUNT(c.complaint_id)::int AS total,
            COUNT(c.complaint_id) FILTER (WHERE c.assigned_staff_id IS NOT NULL)::int AS assigned,
            COUNT(c.complaint_id) FILTER (WHERE c.status = 'Pending')::int AS pending,
            COUNT(c.complaint_id) FILTER (WHERE c.status = 'In Progress')::int AS in_progress,
            COUNT(c.complaint_id) FILTER (WHERE c.status = 'Resolved')::int AS resolved
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
  res.json({ ok: true, status, message: `Student ${req.params.id} is now ${status}.` });
}));

router.post('/password', wrap(async (req, res) => {
  const current = req.body.admin_current_password || '';
  const next = req.body.admin_new_password || '';
  const confirm = req.body.admin_conform_password || '';
  if (!current || !next || !confirm) return fail(res, 400, 'Fill in all three password fields.');
  if (next !== confirm) return fail(res, 400, 'The new passwords do not match.');
  if (next.length < 6) return fail(res, 400, 'New password must be at least 6 characters.');
  const { rows } = await pool.query('SELECT password FROM admin WHERE admin_id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password))) {
    return fail(res, 401, 'Your current password is wrong.');
  }
  await pool.query('UPDATE admin SET password = $1 WHERE admin_id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true, message: 'Password changed.', redirect: '/HTML/ADMIN/admin_dashboard.html' });
}));

module.exports = router;
