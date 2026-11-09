// Student API: raise complaints (AI-checked), join existing ones, track status, give feedback.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole, wrap } = require('../middleware');
const { analyzeComplaint, aiConfigured, CATEGORIES } = require('../ai');
const { deadlineFor, isOverdue } = require('../sla');
const { recordEvent, timelineFor } = require('../timeline');

const router = express.Router();
router.use(requireRole('student'));

const fail = (res, status, message) => res.status(status).json({ error: message });

async function nextId(table, column, prefix) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(${column} FROM ${prefix.length + 1}) AS INTEGER)), 0) AS n FROM ${table}`
  );
  return `${prefix}${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}

router.get('/profile', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT student_id, student_name, mobile, email FROM student WHERE student_id = $1',
    [req.user.id]
  );
  if (!rows[0]) return fail(res, 404, 'Your student record no longer exists. Sign in again.');
  res.json({ studentId: rows[0].student_id, studentName: rows[0].student_name, mobile: rows[0].mobile, email: rows[0].email });
}));

// Dashboard payload: counts plus the five most recent complaints.
router.get('/dashboard', wrap(async (req, res) => {
  const counts = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c.status = 'Pending')::int AS pending,
            COUNT(*) FILTER (WHERE c.status = 'In Progress')::int AS in_progress,
            COUNT(*) FILTER (WHERE c.status = 'Resolved')::int AS resolved
     FROM complaint c JOIN complaint_member m ON m.complaint_id = c.complaint_id AND m.student_id = $1`,
    [req.user.id]
  );
  const recent = await pool.query(
    `SELECT c.complaint_id, c.category, c.description, c.priority, c.status, c.created_at,
            c.student_id, s.student_name
     FROM complaint c
     JOIN complaint_member m ON m.complaint_id = c.complaint_id AND m.student_id = $1
     JOIN student s ON s.student_id = c.student_id
     ORDER BY c.created_at DESC LIMIT 5`,
    [req.user.id]
  );
  const c = counts.rows[0];
  res.json({
    totalComplaints: c.total,
    pendingComplaints: c.pending,
    inProgressComplaints: c.in_progress,
    resolvedComplaints: c.resolved,
    recentComplaints: recent.rows.map((r) => ({
      complaintId: r.complaint_id,
      studentId: r.student_id,
      studentName: r.student_name,
      category: r.category,
      description: r.description,
      priority: r.priority,
      status: r.status,
      date: new Date(r.created_at).toLocaleDateString('en-IN'),
    })),
  });
}));

// Counts for the dashboard, live from the database.
router.get('/stats', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'In Progress')::int AS in_progress,
            COUNT(*) FILTER (WHERE status = 'Resolved')::int AS resolved
     FROM complaint WHERE student_id = $1`,
    [req.user.id]
  );
  res.json(rows[0]);
}));

// Open complaints a new complaint could duplicate or join.
async function openComplaints() {
  const { rows } = await pool.query(
    `SELECT complaint_id, category, description FROM complaint
     WHERE status <> 'Resolved' ORDER BY created_at DESC LIMIT 50`
  );
  return rows;
}

// AI segmentation and verdict for a draft complaint. Does not save anything.
router.post('/analyze', wrap(async (req, res) => {
  const description = String(req.body.description || '').trim();
  if (description.length < 10) return fail(res, 400, 'Describe the problem in at least 10 characters.');
  if (!aiConfigured()) {
    return fail(res, 503, 'AI analysis is not configured on the server. Set AI_API_KEY and restart.');
  }
  const analysis = await analyzeComplaint(description, await openComplaints());
  const rank = { High: 0, Medium: 1, Low: 2 };
  const top = analysis.issues.reduce((a, b) => (rank[b.priority] < rank[a.priority] ? b : a), analysis.issues[0] || { category: 'Other', priority: 'Medium' });
  res.json({
    ...analysis,
    description,
    message: analysis.spam ? (analysis.spamReason || 'This complaint looks like spam and was not submitted.') : analysis.verdict,
    category: analysis.spam ? '' : top.category,
    priority: analysis.spam ? '' : top.priority,
  });
}));

// Duplicate check for the popup: returns the open complaint the AI matched, with its real details.
router.post('/check-duplicate', wrap(async (req, res) => {
  const description = String(req.body.description || '').trim();
  if (description.length < 10) return fail(res, 400, 'Describe the problem in at least 10 characters.');
  if (!aiConfigured()) {
    return fail(res, 503, 'AI analysis is not configured on the server. Set AI_API_KEY and restart.');
  }
  const open = await openComplaints();
  const analysis = await analyzeComplaint(description, open);
  const match = open.find((c) => c.complaint_id === analysis.duplicateOf);
  if (!match) return res.json({ duplicate: false });
  const detail = await pool.query(
    `SELECT c.complaint_id, c.category, c.description, c.status,
            (SELECT COUNT(*)::int FROM complaint_member m WHERE m.complaint_id = c.complaint_id) AS reported_by
     FROM complaint c WHERE c.complaint_id = $1`,
    [match.complaint_id]
  );
  const d = detail.rows[0];
  res.json({
    duplicate: true,
    complaintId: d.complaint_id,
    similarity: 100,
    category: d.category,
    description: d.description,
    reportedBy: d.reported_by,
    status: d.status,
    reason: analysis.duplicateReason,
  });
}));

// Raise a complaint. Saves real data, after the AI verdict is shown to the student.
router.post('/complaints', wrap(async (req, res) => {
  const description = String(req.body.description || '').trim();
  const category = String(req.body.complaint_category || req.body.category || '').trim();
  const priority = String(req.body.priority || 'Medium').trim();
  const joining = String(req.body.joinComplaint || '') === 'true';
  const joinId = joining ? String(req.body.existingComplaintId || req.body.joinComplaintId || '').trim() : '';

  if (joinId) {
    const target = await pool.query(
      `SELECT complaint_id, status FROM complaint WHERE complaint_id = $1`,
      [joinId]
    );
    if (!target.rowCount) return fail(res, 404, `Complaint ${joinId} does not exist.`);
    if (target.rows[0].status === 'Resolved') return fail(res, 409, `Complaint ${joinId} is already resolved.`);
    await pool.query(
      `INSERT INTO complaint_member (complaint_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [joinId, req.user.id]
    );
    return res.status(201).json({ ok: true, complaintId: joinId, joined: true });
  }

  if (description.length < 10) return fail(res, 400, 'Describe the problem in at least 10 characters.');
  if (!CATEGORIES.includes(category)) return fail(res, 400, 'Choose a valid category.');
  if (!['High', 'Medium', 'Low'].includes(priority)) return fail(res, 400, 'Choose a valid priority.');

  // The AI analysis is kept only if it came back from the analyse step for this same text.
  let analysis = null;
  try {
    const raw = typeof req.body.ai_analysis === 'string' ? JSON.parse(req.body.ai_analysis) : req.body.ai_analysis;
    if (raw && typeof raw === 'object' && raw.description === description) analysis = raw;
  } catch (_) { analysis = null; }

  const id = await nextId('complaint', 'complaint_id', 'CMP');
  await pool.query(
    `INSERT INTO complaint (complaint_id, student_id, category, description, priority, status, ai_analysis, due_at)
     VALUES ($1,$2,$3,$4,$5,'Pending',$6,$7)`,
    [id, req.user.id, category, description, priority, analysis, deadlineFor(priority)]
  );
  await pool.query(
    `INSERT INTO complaint_member (complaint_id, student_id) VALUES ($1,$2)`,
    [id, req.user.id]
  );
  await recordEvent(id, 'raised', `Complaint raised with ${priority} priority.`, req.user.id);
  res.status(201).json({ ok: true, complaintId: id });
}));

// The student's own complaints, with their live status.
router.get('/complaints', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.complaint_id, c.category, c.description, c.priority, c.status, c.resolution,
            c.created_at, c.updated_at, c.ai_analysis, c.due_at, s.staff_name
     FROM complaint c
     JOIN complaint_member m ON m.complaint_id = c.complaint_id AND m.student_id = $1
     LEFT JOIN staff s ON s.staff_id = c.assigned_staff_id
     ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json({
    complaints: rows.map((r) => ({
      complaintId: r.complaint_id,
      type: 'Complaint',
      category: r.category,
      description: r.description,
      priority: r.priority,
      status: r.status,
      resolution: r.resolution || '',
      assignedStaff: r.staff_name || 'Not assigned',
      aiAnalysis: r.ai_analysis || null,
      dueAt: r.due_at,
      overdue: isOverdue(r.status, r.due_at),
      date: new Date(r.created_at).toLocaleDateString('en-IN'),
      updatedOn: new Date(r.updated_at).toLocaleDateString('en-IN'),
    })),
  });
}));

// Case timeline for one complaint. Only members of that complaint can read it.
router.get('/complaints/:id/timeline', wrap(async (req, res) => {
  const member = await pool.query(
    'SELECT 1 FROM complaint_member WHERE complaint_id = $1 AND student_id = $2',
    [req.params.id, req.user.id]
  );
  if (!member.rowCount) return fail(res, 404, `Complaint ${req.params.id} was not found on your account.`);
  res.json({ events: await timelineFor(req.params.id) });
}));

// Resolved complaints this student can rate, with the staff member who handled each.
router.get('/feedback-options', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.complaint_id, c.category, c.assigned_staff_id, s.staff_name
     FROM complaint c
     JOIN complaint_member m ON m.complaint_id = c.complaint_id AND m.student_id = $1
     LEFT JOIN staff s ON s.staff_id = c.assigned_staff_id
     WHERE c.status = 'Resolved'
       AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.complaint_id = c.complaint_id AND f.student_id = $1)
     ORDER BY c.updated_at DESC`,
    [req.user.id]
  );
  res.json({
    complaints: rows.map((r) => ({
      complaintId: r.complaint_id,
      category: r.category,
      staffId: r.assigned_staff_id || '',
      staffName: r.staff_name || 'Not assigned',
    })),
  });
}));

// Feedback is allowed only once a complaint is resolved, by a student who is a member of it.
router.post('/feedback', wrap(async (req, res) => {
  const complaintId = String(req.body.complaint_id || '').trim();
  const rating = Number(req.body.rating);
  const review = String(req.body.review || req.body['review-message'] || '').trim();
  if (!complaintId) return fail(res, 400, 'Choose the complaint you are rating.');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, 400, 'Rating must be a whole number from 1 to 5.');
  const { rows } = await pool.query(
    `SELECT c.complaint_id, c.category, c.status, c.assigned_staff_id
     FROM complaint c JOIN complaint_member m ON m.complaint_id = c.complaint_id AND m.student_id = $2
     WHERE c.complaint_id = $1`,
    [complaintId, req.user.id]
  );
  if (!rows[0]) return fail(res, 404, `You are not a member of complaint ${complaintId}.`);
  if (rows[0].status !== 'Resolved') return fail(res, 409, 'You can rate a complaint only after it is resolved.');
  const dup = await pool.query('SELECT 1 FROM feedback WHERE complaint_id=$1 AND student_id=$2', [complaintId, req.user.id]);
  if (dup.rowCount) return fail(res, 409, 'You have already rated this complaint.');
  const id = await nextId('feedback', 'feedback_id', 'FB');
  await pool.query(
    `INSERT INTO feedback (feedback_id, complaint_id, student_id, staff_id, category, rating, review)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, complaintId, req.user.id, rows[0].assigned_staff_id, rows[0].category, rating, review]
  );
  if (rows[0].assigned_staff_id) {
    await pool.query(
      `UPDATE staff SET rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM feedback WHERE staff_id = $1) WHERE staff_id = $1`,
      [rows[0].assigned_staff_id]
    );
  }
  res.status(201).json({ ok: true, feedbackId: id });
}));

router.post('/password', wrap(async (req, res) => {
  const current = req.body.student_current_password || '';
  const next = req.body.student_new_password || '';
  const confirm = req.body.student_conform_password || '';
  if (!current || !next) return fail(res, 400, 'Enter your current and new password.');
  if (next !== confirm) return fail(res, 400, 'The new passwords do not match.');
  if (next.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  const { rows } = await pool.query('SELECT password FROM student WHERE student_id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password))) {
    return fail(res, 401, 'Your current password is wrong.');
  }
  await pool.query('UPDATE student SET password = $1 WHERE student_id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
