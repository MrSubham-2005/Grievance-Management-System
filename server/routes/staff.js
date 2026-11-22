// Staff API: see assigned complaints and advance status through the Assigned -> In Progress -> Resolved workflow.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole, wrap } = require('../middleware');
const { isOverdue } = require('../sla');
const { recordEvent, timelineFor } = require('../timeline');
const { notifyStudent } = require('../notify');
const { formatComplaintId, resolveComplaintId } = require('../complaint-id');
const { fetchRecentComplaints, toDateStr, formatStudentId } = require('../recent-complaints');

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
  complaintId: formatComplaintId(r.complaint_id),
  studentId: formatStudentId(r.student_id),
  studentName: r.student_name,
  category: r.category,
  description: r.description,
  priority: r.priority ?? null,
  status: r.status,
  resolution: r.resolution,
  rating: r.rating,
  dueAt: r.due_at,
  overdue: isOverdue(r.status, r.due_at),
  date: toDateStr(r.created_at),
  updatedOn: toDateStr(r.updated_at),
});

const COMPLAINT_COLUMNS = `c.complaint_id, c.student_id, c.category, c.description, c.priority, c.status, c.resolution,
  c.created_at, c.updated_at, c.due_at, s.student_name,
  (SELECT ROUND(AVG(f.rating))::int FROM feedback f WHERE f.complaint_id = c.complaint_id) AS rating`;

router.get('/dashboard', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [{ rows }, recentComplaints] = await Promise.all([
    pool.query(
      `SELECT LOWER(c.status) AS status, COUNT(*)::int AS n
       FROM complaint c WHERE c.assigned_staff_id = $1 GROUP BY LOWER(c.status)`,
      [req.user.id]
    ),
    fetchRecentComplaints(pool),
  ]);
  const count = (status) => rows.find((r) => r.status === status)?.n || 0;
  res.json({
    totalComplaints: rows.reduce((sum, r) => sum + r.n, 0),
    pendingComplaints: count('pending') + count('assigned'),
    inProgressComplaints: count('in progress'),
    resolvedComplaints: count('resolved'),
    recentComplaints,
  });
}));

const NEXT_STATUS = {
  assigned: 'In Progress',
  'in progress': 'Resolved',
};

function normalizeStatusKey(status) {
  return String(status || '').trim().toLowerCase();
}

function getNextStatus(status) {
  return NEXT_STATUS[normalizeStatusKey(status)] || null;
}

function parseComplaintNumber(id) {
  const m = String(id || '').match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function sortSelectableComplaints(list) {
  return [...list].sort((a, b) => {
    const diff = parseComplaintNumber(a.complaintId) - parseComplaintNumber(b.complaintId);
    return diff !== 0 ? diff : a.complaintId.localeCompare(b.complaintId);
  });
}

router.get('/complaints', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { rows } = await pool.query(
    `SELECT ${COMPLAINT_COLUMNS} FROM complaint c JOIN student s ON s.student_id = c.student_id
     WHERE c.assigned_staff_id = $1
     ORDER BY CASE c.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, c.created_at DESC`,
    [req.user.id]
  );
  const complaints = rows.map((r) => ({ ...toComplaint(r), nextStatus: getNextStatus(r.status) }));
  const selectableComplaints = sortSelectableComplaints(
    complaints.filter((c) => {
      const key = normalizeStatusKey(c.status);
      return key === 'assigned' || key === 'in progress';
    })
  );
  res.json({ complaints, selectableComplaints });
}));

router.get('/complaints/:id', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const actualId = await resolveComplaintId(pool, req.params.id);
  const displayId = formatComplaintId(req.params.id) || req.params.id;
  if (!actualId) return fail(res, 404, `Complaint ${displayId} was not found.`);

  const { rows } = await pool.query(
    `SELECT ${COMPLAINT_COLUMNS}, c.assigned_staff_id
     FROM complaint c JOIN student s ON s.student_id = c.student_id
     WHERE c.complaint_id = $1 AND c.assigned_staff_id = $2`,
    [actualId, req.user.id]
  );
  if (!rows[0]) {
    return fail(res, 404, `Complaint ${formatComplaintId(actualId)} was not found or is not assigned to you.`);
  }

  const row = rows[0];
  const formattedId = formatComplaintId(row.complaint_id);
  const currentKey = normalizeStatusKey(row.status);
  let nextStatus = null;
  let allowedStatuses = [];
  let canUpdate = false;
  let message = '';

  if (currentKey === 'assigned') {
    nextStatus = 'In Progress';
    allowedStatuses = ['In Progress'];
    canUpdate = true;
  } else if (currentKey === 'in progress') {
    nextStatus = 'Resolved';
    allowedStatuses = ['Resolved'];
    canUpdate = true;
  } else if (currentKey === 'resolved') {
    message = `Complaint ${formattedId} is already resolved.`;
  } else {
    message = `Complaint ${formattedId} in status "${row.status}" cannot be updated.`;
  }

  const complaint = { ...toComplaint(row), nextStatus, allowedStatuses };
  res.json({
    complaint,
    category: complaint.category,
    description: complaint.description,
    currentStatus: row.status,
    nextStatus,
    allowedStatuses,
    canUpdate,
    message,
  });
}));

async function handleStatusUpdate(req, res) {
  const body = req.body || {};
  const rawComplaintId = String(req.params.id || body['complaint-id'] || '').trim();
  const rawStatus = body['complaint-status'] !== undefined && body['complaint-status'] !== null
    ? body['complaint-status']
    : body.status;
  const requestedStatus = rawStatus !== undefined && rawStatus !== null ? String(rawStatus).trim() : '';
  const expectedStatus = body.expectedStatus !== undefined && body.expectedStatus !== null && String(body.expectedStatus).trim() !== ''
    ? normalizeStatusKey(body.expectedStatus)
    : null;

  if (!rawComplaintId) {
    return fail(res, 400, 'Complaint ID is required.');
  }
  if (!requestedStatus) {
    return fail(res, 400, 'Status is required.');
  }
  if (!STATUSES.includes(requestedStatus)) {
    return fail(res, 400, 'Status must be "In Progress" or "Resolved".');
  }

  const actualId = await resolveComplaintId(pool, rawComplaintId);
  const displayId = formatComplaintId(rawComplaintId) || rawComplaintId;
  if (!actualId) return fail(res, 404, `Complaint ${displayId} was not found.`);
  const formattedId = formatComplaintId(actualId);

  const client = await pool.connect();
  let updated = null;
  let recipient = null;
  let previousStatus = null;
  let nextStatus = null;
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT complaint_id, status FROM complaint WHERE complaint_id = $1 AND assigned_staff_id = $2 FOR UPDATE`,
      [actualId, req.user.id]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 404, `Complaint ${formattedId} was not found or is not assigned to you.`);
    }

    const row = existing.rows[0];
    previousStatus = row.status;
    const currentKey = normalizeStatusKey(row.status);

    if (expectedStatus && expectedStatus !== currentKey) {
      await client.query('ROLLBACK');
      return fail(res, 409, `Complaint ${formattedId} is now ${row.status}. Refresh and try again.`);
    }

    if (currentKey === 'assigned' && requestedStatus === 'In Progress') {
      nextStatus = 'In Progress';
    } else if (currentKey === 'in progress' && requestedStatus === 'Resolved') {
      nextStatus = 'Resolved';
    } else {
      await client.query('ROLLBACK');
      if (currentKey === 'resolved') {
        return fail(res, 409, `Complaint ${formattedId} is already resolved.`);
      }
      if (currentKey === 'assigned' && requestedStatus === 'Resolved') {
        return fail(res, 409, `Start working on complaint ${formattedId} (move to In Progress) before resolving it.`);
      }
      if (currentKey === 'in progress' && requestedStatus === 'In Progress') {
        return fail(res, 409, `Complaint ${formattedId} is already In Progress.`);
      }
      return fail(res, 409, `Complaint ${formattedId} cannot change from ${row.status} to ${requestedStatus}.`);
    }

    const result = await client.query(
      `UPDATE complaint SET status = $1, updated_at = now()
       WHERE complaint_id = $2 AND assigned_staff_id = $3
       RETURNING complaint_id, status, resolution, updated_at`,
      [nextStatus, actualId, req.user.id]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 404, `Complaint ${formattedId} was not found or is not assigned to you.`);
    }
    updated = result.rows[0];
    const message = nextStatus === 'Resolved' ? 'Marked resolved.' : `Status changed to ${nextStatus}.`;
    await recordEvent(updated.complaint_id, nextStatus === 'Resolved' ? 'resolved' : 'status', message, req.user.id, client);

    const who = await client.query(
      `SELECT st.email, st.student_name, s.staff_name FROM complaint c
       JOIN student st ON st.student_id = c.student_id
       JOIN staff s ON s.staff_id = c.assigned_staff_id
       WHERE c.complaint_id = $1`,
      [updated.complaint_id]
    );
    recipient = who.rows[0] || null;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The email is best effort: a failed send never fails or rolls back the status change.
  const emailed = recipient
    ? await notifyStudent({
        to: recipient.email,
        complaintId: formattedId,
        status: nextStatus,
        resolution: updated.resolution,
        staffName: recipient.staff_name,
      })
    : false;
  res.json({ ok: true, ...updated, previousStatus, nextStatus, complaint_id: formattedId, complaintId: formattedId, emailed });
}

router.post('/complaints/status', wrap(handleStatusUpdate));
router.post('/complaints/:id/status', wrap(handleStatusUpdate));

// Case timeline, only for complaints assigned to this staff member.
router.get('/complaints/:id/timeline', wrap(async (req, res) => {
  const actualId = await resolveComplaintId(pool, req.params.id);
  const displayId = formatComplaintId(req.params.id) || req.params.id;
  if (!actualId) return fail(res, 404, `Complaint ${displayId} is not assigned to you.`);
  const own = await pool.query(
    'SELECT 1 FROM complaint WHERE complaint_id = $1 AND assigned_staff_id = $2',
    [actualId, req.user.id]
  );
  if (!own.rowCount) return fail(res, 404, `Complaint ${formatComplaintId(actualId)} is not assigned to you.`);
  res.json({ events: await timelineFor(actualId) });
}));

router.post('/password', wrap(async (req, res) => {
  const body = req.body || {};
  const current = typeof body.staff_current_password === 'string' ? body.staff_current_password : '';
  const next = typeof body.staff_new_password === 'string' ? body.staff_new_password : '';
  const confirm = typeof body.staff_conform_password === 'string' ? body.staff_conform_password : '';
  if (!current.trim() || !next.trim() || !confirm.trim()) {
    return fail(res, 400, 'Fill in all three password fields.');
  }
  if (next !== confirm) return fail(res, 400, 'The new passwords do not match.');
  if (next.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  if (current === next) return fail(res, 400, 'New Password cannot be the same as Current Password');
  const { rows } = await pool.query('SELECT password FROM staff WHERE staff_id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password))) {
    return fail(res, 401, 'Your current password is wrong.');
  }
  await pool.query('UPDATE staff SET password = $1 WHERE staff_id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
