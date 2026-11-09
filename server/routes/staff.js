// Staff API: see complaints assigned to them and update status with a real resolution note.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole, wrap } = require('../middleware');
const { isOverdue } = require('../sla');
const { recordEvent, timelineFor } = require('../timeline');
const { notifyStudent } = require('../notify');

const router = express.Router();
router.use(requireRole('staff'));

const fail = (res, status, message) => res.status(status).json({ error: message });
const STATUSES = ['In Progress', 'Resolved'];

router.get('/profile', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT staff_id, staff_name, mobile, email, department, rating FROM staff WHERE staff_id = $1',
    [req.user.id]
  );
  if (!rows[0]) return fail(res, 404, 'Your staff record no longer exists. Sign in again.');
  const s = rows[0];
  res.json({
    staffId: s.staff_id, staffName: s.staff_name, mobile: s.mobile, email: s.email,
    department: s.department, rating: Number(s.rating),
  });
}));

const toComplaint = (r) => ({
  complaintId: r.complaint_id,
  studentName: r.student_name,
  category: r.category,
  description: r.description,
  priority: r.priority,
  status: r.status,
  resolution: r.resolution,
  rating: r.rating,
  dueAt: r.due_at,
  overdue: isOverdue(r.status, r.due_at),
  date: new Date(r.created_at).toLocaleDateString('en-IN'),
  updatedOn: new Date(r.updated_at).toLocaleDateString('en-IN'),
});

const COMPLAINT_COLUMNS = `c.complaint_id, c.category, c.description, c.priority, c.status, c.resolution,
  c.created_at, c.updated_at, c.due_at, s.student_name,
  (SELECT ROUND(AVG(f.rating))::int FROM feedback f WHERE f.complaint_id = c.complaint_id) AS rating`;

router.get('/dashboard', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.status, COUNT(*)::int AS n FROM complaint c WHERE c.assigned_staff_id = $1 GROUP BY c.status`,
    [req.user.id]
  );
  const count = (status) => rows.find((r) => r.status === status)?.n || 0;
  const recent = await pool.query(
    `SELECT ${COMPLAINT_COLUMNS} FROM complaint c JOIN student s ON s.student_id = c.student_id
     WHERE c.assigned_staff_id = $1 ORDER BY c.created_at DESC LIMIT 5`,
    [req.user.id]
  );
  res.json({
    totalComplaints: rows.reduce((sum, r) => sum + r.n, 0),
    pendingComplaints: count('Pending'),
    inProgressComplaints: count('In Progress'),
    resolvedComplaints: count('Resolved'),
    recentComplaints: recent.rows.map(toComplaint),
  });
}));

router.get('/complaints', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${COMPLAINT_COLUMNS} FROM complaint c JOIN student s ON s.student_id = c.student_id
     WHERE c.assigned_staff_id = $1
     ORDER BY CASE c.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, c.created_at DESC`,
    [req.user.id]
  );
  res.json({ complaints: rows.map(toComplaint) });
}));

router.post('/complaints/:id/status', wrap(async (req, res) => {
  const status = String(req.body.status || '').trim();
  const resolution = String(req.body.resolution || '').trim();
  if (!STATUSES.includes(status)) return fail(res, 400, 'Status must be "In Progress" or "Resolved".');
  if (status === 'Resolved' && resolution.length < 5) {
    return fail(res, 400, 'Write a short resolution note before marking the complaint resolved.');
  }
  const result = await pool.query(
    `UPDATE complaint SET status = $1, resolution = COALESCE(NULLIF($2,''), resolution), updated_at = now()
     WHERE complaint_id = $3 AND assigned_staff_id = $4 RETURNING complaint_id, status, resolution`,
    [status, resolution, req.params.id, req.user.id]
  );
  if (!result.rowCount) return fail(res, 404, `Complaint ${req.params.id} is not assigned to you.`);
  const updated = result.rows[0];
  const who = await pool.query(
    `SELECT st.email, st.student_name, s.staff_name FROM complaint c
     JOIN student st ON st.student_id = c.student_id
     JOIN staff s ON s.staff_id = c.assigned_staff_id
     WHERE c.complaint_id = $1`,
    [updated.complaint_id]
  );
  const message = status === 'Resolved'
    ? `Marked resolved${resolution ? `: ${resolution}` : '.'}`
    : `Status changed to ${status}.`;
  await recordEvent(updated.complaint_id, status === 'Resolved' ? 'resolved' : 'status', message, req.user.id);
  // The email is best effort: a failed send never fails the status change.
  const emailed = who.rows[0]
    ? await notifyStudent({
        to: who.rows[0].email,
        complaintId: updated.complaint_id,
        status,
        resolution: updated.resolution,
        staffName: who.rows[0].staff_name,
      })
    : false;
  res.json({ ok: true, ...updated, emailed });
}));

// Case timeline, only for complaints assigned to this staff member.
router.get('/complaints/:id/timeline', wrap(async (req, res) => {
  const own = await pool.query(
    'SELECT 1 FROM complaint WHERE complaint_id = $1 AND assigned_staff_id = $2',
    [req.params.id, req.user.id]
  );
  if (!own.rowCount) return fail(res, 404, `Complaint ${req.params.id} is not assigned to you.`);
  res.json({ events: await timelineFor(req.params.id) });
}));

router.post('/password', wrap(async (req, res) => {
  const current = req.body.staff_current_password || '';
  const next = req.body.staff_new_password || '';
  const confirm = req.body.staff_conform_password || '';
  if (!current || !next) return fail(res, 400, 'Enter your current and new password.');
  if (next !== confirm) return fail(res, 400, 'The new passwords do not match.');
  if (next.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const { rows } = await pool.query('SELECT password FROM staff WHERE staff_id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password))) {
    return fail(res, 401, 'Your current password is wrong.');
  }
  await pool.query('UPDATE staff SET password = $1 WHERE staff_id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
