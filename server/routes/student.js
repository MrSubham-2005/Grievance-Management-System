// Student API: raise complaints (AI-checked), join existing ones, track status, give feedback.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole, wrap } = require('../middleware');
const { analyzeComplaint, aiConfigured, CATEGORIES, findSimilarComplaintFallback } = require('../ai');
const { deadlineFor, isOverdue } = require('../sla');
const { recordEvent, timelineFor } = require('../timeline');
const {
  formatComplaintId,
  complaintIdCandidates,
  resolveComplaintId,
  nextComplaintId,
} = require('../complaint-id');
const { nextId, withIdLock } = require('../id-generator');
const { fetchRecentComplaints } = require('../recent-complaints');

const router = express.Router();
router.use(requireRole('student'));

const fail = (res, status, message) => res.status(status).json({ error: message });

router.get('/profile', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT student_id, student_name, mobile, email FROM student WHERE student_id = $1',
    [req.user.id]
  );
  if (!rows[0]) return fail(res, 404, 'Your student record no longer exists. Sign in again.');
  res.json({ studentId: rows[0].student_id, studentName: rows[0].student_name, mobile: rows[0].mobile, email: rows[0].email });
}));

// Dashboard payload: student summary counts plus the global five most recent complaints.
router.get('/dashboard', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [counts, recentComplaints] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_complaints,
              COUNT(*) FILTER (WHERE status IN ('Pending', 'Assigned'))::int AS pending_complaints,
              COUNT(*) FILTER (WHERE status = 'In Progress')::int AS in_progress_complaints,
              COUNT(*) FILTER (WHERE status = 'Resolved')::int AS resolved_complaints
       FROM complaint
       WHERE student_id = $1`,
      [req.user.id]
    ),
    fetchRecentComplaints(pool),
  ]);
  const c = counts.rows[0] || {};
  res.json({
    totalComplaints: Number(c.total_complaints ?? c.total ?? 0),
    pendingComplaints: Number(c.pending_complaints ?? c.pending ?? 0),
    inProgressComplaints: Number(c.in_progress_complaints ?? c.in_progress ?? 0),
    resolvedComplaints: Number(c.resolved_complaints ?? c.resolved ?? 0),
    total_complaints: Number(c.total_complaints ?? c.total ?? 0),
    pending_complaints: Number(c.pending_complaints ?? c.pending ?? 0),
    in_progress_complaints: Number(c.in_progress_complaints ?? c.in_progress ?? 0),
    resolved_complaints: Number(c.resolved_complaints ?? c.resolved ?? 0),
    recentComplaints,
  });
}));

// Counts for the dashboard, live from the database.
router.get('/stats', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('Pending', 'Assigned'))::int AS pending,
            COUNT(*) FILTER (WHERE status = 'In Progress')::int AS in_progress,
            COUNT(*) FILTER (WHERE status = 'Resolved')::int AS resolved
     FROM complaint WHERE student_id = $1`,
    [req.user.id]
  );
  res.json(rows[0]);
}));

// Open complaints a new complaint could duplicate or join.
async function openComplaints(category) {
  if (category && typeof category === 'string' && category.trim()) {
    const { rows } = await pool.query(
      `SELECT complaint_id, category, description FROM complaint
       WHERE status <> 'Resolved'
       ORDER BY CASE WHEN TRIM(UPPER(category)) = TRIM(UPPER($1)) THEN 0 ELSE 1 END, created_at DESC
       LIMIT 50`,
      [category.trim()]
    );
    return rows;
  }
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
  const top = analysis.issues.reduce(
    (a, b) => (rank[b.priority] < rank[a.priority] ? b : a),
    analysis.issues[0] || { category: '', priority: 'Medium' }
  );
  const validCategory = !analysis.spam && CATEGORIES.includes(top.category) ? top.category : '';
  res.json({
    ...analysis,
    description,
    message: analysis.spam ? (analysis.spamReason || 'This complaint looks like spam and was not submitted.') : analysis.verdict,
    category: validCategory,
    priority: analysis.spam ? '' : top.priority,
  });
}));

async function fetchJoinCount(db, complaintId) {
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT cm.student_id) FILTER (WHERE cm.student_id <> c.student_id)::int AS join_count
     FROM public.complaint c
     LEFT JOIN public.complaint_member cm ON cm.complaint_id = c.complaint_id
     WHERE c.complaint_id = $1
     GROUP BY c.complaint_id`,
    [complaintId]
  );
  return rows[0] ? Number(rows[0].join_count) || 0 : 0;
}

async function joinExistingComplaint(rawComplaintId, studentId) {
  const actualJoinId = await resolveComplaintId(pool, rawComplaintId);
  const displayJoinId = formatComplaintId(rawComplaintId) || rawComplaintId;
  if (!actualJoinId) {
    return { status: 404, error: `Complaint ${displayJoinId} does not exist.` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the complaint row so concurrent join attempts by the same student serialize cleanly.
    const target = await client.query(
      `SELECT complaint_id, student_id, status
       FROM public.complaint
       WHERE complaint_id = $1
       FOR UPDATE`,
      [actualJoinId]
    );
    if (!target.rowCount) {
      await client.query('ROLLBACK');
      return { status: 404, error: `Complaint ${displayJoinId} does not exist.` };
    }

    const row = target.rows[0];
    const formattedId = formatComplaintId(row.complaint_id);

    // Ensure target complaint is active before evaluating membership/joining.
    if (row.status === 'Resolved') {
      await client.query('ROLLBACK');
      return { status: 409, error: `Complaint ${formattedId} is already resolved.` };
    }

    // Compare original complaint owner ID with the authenticated student ID first.
    if (row.student_id === studentId) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        error: 'You are the original creator of this complaint.',
        message: 'You are the original creator of this complaint.',
      };
    }

    const existing = await client.query(
      `SELECT COUNT(*)::int AS already_joined FROM public.complaint_member WHERE complaint_id = $1 AND student_id = $2`,
      [actualJoinId, studentId]
    );
    const alreadyJoined = Number(existing.rows[0] && existing.rows[0].already_joined) || 0;
    if (alreadyJoined > 0) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        error: 'You have already joined this complaint.',
        message: 'You have already joined this complaint.',
      };
    }

    await client.query(
      `INSERT INTO public.complaint_member (complaint_id, student_id) VALUES ($1, $2)`,
      [actualJoinId, studentId]
    );
    const reportedBy = await fetchJoinCount(client, actualJoinId);
    await client.query('COMMIT');
    return {
      status: 201,
      ok: true,
      complaintId: formattedId,
      joined: true,
      reportedBy,
      message: 'You have successfully joined this complaint.',
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') {
      const reportedBy = await fetchJoinCount(pool, actualJoinId).catch(() => undefined);
      return {
        status: 409,
        error: 'You have already joined this complaint.',
        ...(reportedBy !== undefined ? { reportedBy } : {}),
      };
    }
    throw err;
  } finally {
    client.release();
  }
}

function sendJoinResponse(res, outcome) {
  if (outcome.error) {
    return res.status(outcome.status).json({
      error: outcome.error,
      ...(outcome.reportedBy !== undefined ? { reportedBy: outcome.reportedBy } : {}),
    });
  }
  return res.status(outcome.status).json({
    ok: true,
    complaintId: outcome.complaintId,
    joined: true,
    reportedBy: outcome.reportedBy,
    message: outcome.message,
  });
}

// Duplicate check for the popup: returns the open complaint the AI matched, with its real details.
router.post('/check-duplicate', wrap(async (req, res) => {
  const description = String(req.body.description || '').trim();
  const category = String(req.body.category || '').trim();
  if (description.length < 10) return fail(res, 400, 'Describe the problem in at least 10 characters.');

  const open = await openComplaints(category);
  if (!open || open.length === 0) {
    return res.json({ duplicate: false });
  }

  let matchedComplaintId = '';
  let matchedReason = '';
  let matchedSimilarity = 85;

  if (aiConfigured()) {
    try {
      const analysis = await analyzeComplaint(description, open);
      if (analysis && analysis.duplicateOf) {
        const dupCandidates = complaintIdCandidates(analysis.duplicateOf);
        const match = open.find((c) => dupCandidates.includes(c.complaint_id));
        if (match) {
          matchedComplaintId = match.complaint_id;
          matchedReason = analysis.duplicateReason || 'AI identified this as a semantically similar complaint.';
          matchedSimilarity = analysis.similarity || 85;
        }
      }
    } catch (_err) {
      // AI call failed (network/quota/model error) - fallback to semantic keyword/synonym matcher
      const fallback = findSimilarComplaintFallback(description, open, category);
      if (fallback) {
        matchedComplaintId = fallback.complaintId;
        matchedReason = fallback.reason;
        matchedSimilarity = fallback.similarity;
      }
    }
  } else {
    // AI not configured - fallback to semantic keyword/synonym matcher
    const fallback = findSimilarComplaintFallback(description, open, category);
    if (fallback) {
      matchedComplaintId = fallback.complaintId;
      matchedReason = fallback.reason;
      matchedSimilarity = fallback.similarity;
    }
  }

  if (!matchedComplaintId) {
    return res.json({ duplicate: false });
  }

  const detail = await pool.query(
    `SELECT c.complaint_id, c.category, c.description, c.status,
            COUNT(DISTINCT m.student_id) FILTER (WHERE m.student_id <> c.student_id)::int AS reported_by
     FROM public.complaint c
     LEFT JOIN public.complaint_member m ON m.complaint_id = c.complaint_id
     WHERE c.complaint_id = $1
     GROUP BY c.complaint_id`,
    [matchedComplaintId]
  );
  const d = detail.rows[0];
  if (!d) return res.json({ duplicate: false });

  res.json({
    duplicate: true,
    complaintId: formatComplaintId(d.complaint_id),
    similarity: matchedSimilarity,
    category: d.category,
    description: d.description,
    reportedBy: Number(d.reported_by) || 0,
    status: d.status,
    reason: matchedReason,
  });
}));

router.post('/complaints/:id/join', wrap(async (req, res) => {
  const outcome = await joinExistingComplaint(req.params.id, req.user.id);
  return sendJoinResponse(res, outcome);
}));

// Raise a complaint. Saves real data, after the AI verdict is shown to the student.
router.post('/complaints', wrap(async (req, res) => {
  const description = String(req.body.description || '').trim();
  const category = String(req.body.complaint_category || req.body.category || '').trim();
  const priority = String(req.body.priority || 'Medium').trim();
  const joining = String(req.body.joinComplaint || '') === 'true';
  const joinId = joining
    ? String(req.body.existingComplaintId || req.body.joinComplaintId || req.body.complaintId || '').trim()
    : '';

  if (joining) {
    if (!joinId) return fail(res, 400, 'Choose a complaint to join.');
    const outcome = await joinExistingComplaint(joinId, req.user.id);
    return sendJoinResponse(res, outcome);
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

  const id = await withIdLock(pool, 'complaint', async (client) => {
    const newId = await nextComplaintId(client);
    await client.query(
      `INSERT INTO complaint (complaint_id, student_id, category, description, priority, status, ai_analysis, due_at)
       VALUES ($1,$2,$3,$4,$5,'Pending',$6,$7)`,
      [newId, req.user.id, category, description, priority, analysis, deadlineFor(priority)]
    );
    await recordEvent(newId, 'raised', `Complaint raised with ${priority} priority.`, req.user.id, client);
    return newId;
  });
  res.status(201).json({ ok: true, complaintId: id });
}));

// The student's own or joined complaints, with their live status directly from public.complaint.
router.get('/complaints', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { rows } = await pool.query(
    `SELECT DISTINCT
            c.complaint_id, c.student_id, c.category, c.description, c.priority, c.status, c.resolution,
            c.created_at, c.updated_at, c.ai_analysis, c.due_at, c.assigned_staff_id, s.staff_name
     FROM public.complaint c
     LEFT JOIN public.complaint_member cm ON cm.complaint_id = c.complaint_id
     LEFT JOIN public.staff s ON s.staff_id = c.assigned_staff_id
     WHERE c.student_id = $1
        OR cm.student_id = $1
     ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json({
    complaints: rows.map((r) => ({
      complaintId: formatComplaintId(r.complaint_id),
      type: r.student_id === req.user.id ? 'Owner' : 'Joined',
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

// Case timeline for one complaint. Only owners or joined members of that complaint can read it.
router.get('/complaints/:id/timeline', wrap(async (req, res) => {
  const actualId = await resolveComplaintId(pool, req.params.id);
  const displayId = formatComplaintId(req.params.id) || req.params.id;
  if (!actualId) return fail(res, 404, `Complaint ${displayId} was not found on your account.`);
  const member = await pool.query(
    `SELECT 1 FROM public.complaint c
     WHERE c.complaint_id = $1
       AND (c.student_id = $2 OR EXISTS (SELECT 1 FROM public.complaint_member cm WHERE cm.complaint_id = c.complaint_id AND cm.student_id = $2))`,
    [actualId, req.user.id]
  );
  if (!member.rowCount) return fail(res, 404, `Complaint ${formatComplaintId(actualId)} was not found on your account.`);
  res.json({ events: await timelineFor(actualId) });
}));

// Resolved complaints this student can rate, with the staff member who handled each.
router.get('/feedback-options', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.complaint_id, c.category, c.assigned_staff_id, s.staff_name, c.updated_at
     FROM public.complaint c
     LEFT JOIN public.complaint_member cm ON cm.complaint_id = c.complaint_id
     LEFT JOIN public.staff s ON s.staff_id = c.assigned_staff_id
     WHERE (c.student_id = $1 OR cm.student_id = $1)
       AND c.status = 'Resolved'
       AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.complaint_id = c.complaint_id AND f.student_id = $1)
     ORDER BY c.updated_at DESC`,
    [req.user.id]
  );
  res.json({
    complaints: rows.map((r) => ({
      complaintId: formatComplaintId(r.complaint_id),
      category: r.category,
      staffId: r.assigned_staff_id || '',
      staffName: r.staff_name || 'Not assigned',
    })),
  });
}));

// Feedback is allowed only once a complaint is resolved, by a student who owns or joined it.
router.post('/feedback', wrap(async (req, res) => {
  const complaintId = String(req.body.complaint_id || '').trim();
  const rating = Number(req.body.rating);
  const review = String(req.body.review || req.body['review-message'] || '').trim();
  const feedbackCategory = String(req.body.feedbackCategory || req.body.category || '').trim();
  if (!complaintId) return fail(res, 400, 'Choose the complaint you are rating.');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, 400, 'Rating must be a whole number from 1 to 5.');
  const actualComplaintId = await resolveComplaintId(pool, complaintId);
  if (!actualComplaintId) return fail(res, 404, `You are not a member of complaint ${formatComplaintId(complaintId) || complaintId}.`);
  const { rows } = await pool.query(
    `SELECT c.complaint_id, c.category, c.status, c.assigned_staff_id
     FROM public.complaint c
     WHERE c.complaint_id = $1
       AND (c.student_id = $2 OR EXISTS (SELECT 1 FROM public.complaint_member cm WHERE cm.complaint_id = c.complaint_id AND cm.student_id = $2))`,
    [actualComplaintId, req.user.id]
  );
  const formattedId = formatComplaintId(actualComplaintId);
  if (!rows[0]) return fail(res, 404, `You are not a member of complaint ${formattedId}.`);
  if (rows[0].status !== 'Resolved') return fail(res, 409, 'You can rate a complaint only after it is resolved.');
  const categoryToSave = feedbackCategory || rows[0].category;
  const outcome = await withIdLock(pool, 'feedback', async (client) => {
    const dup = await client.query('SELECT 1 FROM feedback WHERE complaint_id=$1 AND student_id=$2', [actualComplaintId, req.user.id]);
    if (dup.rowCount) {
      return { error: { status: 409, message: 'You have already rated this complaint.' } };
    }
    const id = await nextId('feedback', 'feedback_id', 'FB', client);
    await client.query(
      `INSERT INTO feedback (feedback_id, complaint_id, student_id, staff_id, category, rating, review)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actualComplaintId, req.user.id, rows[0].assigned_staff_id, categoryToSave, rating, review]
    );
    if (rows[0].assigned_staff_id) {
      await client.query(
        `UPDATE staff SET rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM feedback WHERE staff_id = $1) WHERE staff_id = $1`,
        [rows[0].assigned_staff_id]
      );
    }
    return { id };
  });
  if (outcome.error) return fail(res, outcome.error.status, outcome.error.message);
  res.status(201).json({ ok: true, feedbackId: outcome.id });
}));

router.post('/password', wrap(async (req, res) => {
  const body = req.body || {};
  const current = typeof body.student_current_password === 'string' ? body.student_current_password : '';
  const next = typeof body.student_new_password === 'string' ? body.student_new_password : '';
  const confirm = typeof body.student_conform_password === 'string' ? body.student_conform_password : '';
  if (!current.trim() || !next.trim() || !confirm.trim()) {
    return fail(res, 400, 'Fill in all three password fields.');
  }
  if (next !== confirm) return fail(res, 400, 'The new passwords do not match.');
  if (next.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  if (current === next) return fail(res, 400, 'New Password cannot be the same as Current Password');
  const { rows } = await pool.query('SELECT password FROM student WHERE student_id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password))) {
    return fail(res, 401, 'Your current password is wrong.');
  }
  await pool.query('UPDATE student SET password = $1 WHERE student_id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
