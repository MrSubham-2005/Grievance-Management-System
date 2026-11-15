// Shared query and formatter for the global "Recent Complaints" table shown on dashboards.
const pool = require('./db');
const { formatComplaintId } = require('./complaint-id');

function toDateStr(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : '';
}

function formatStudentId(id) {
  const raw = String(id || '').trim();
  const match = raw.match(/^STU-?(\d+)$/i);
  return match ? `STU-${match[1].padStart(4, '0')}` : raw;
}

const RECENT_COMPLAINTS_SQL = `
  SELECT
    c.complaint_id,
    c.student_id,
    s.student_name,
    c.category,
    c.description,
    c.priority,
    c.created_at,
    c.status
  FROM public.complaint c
  LEFT JOIN public.student s ON s.student_id = c.student_id
  ORDER BY c.created_at DESC, c.complaint_id DESC
  LIMIT 5
`;

async function fetchRecentComplaints(db = pool) {
  const { rows } = await db.query(RECENT_COMPLAINTS_SQL);
  return rows.slice(0, 5).map((r) => ({
    complaintId: formatComplaintId(r.complaint_id),
    studentId: formatStudentId(r.student_id),
    studentName: r.student_name || 'Student',
    category: r.category,
    description: r.description || '',
    priority: r.priority || 'Medium',
    date: toDateStr(r.created_at),
    status: r.status,
  }));
}

module.exports = { fetchRecentComplaints, RECENT_COMPLAINTS_SQL, toDateStr, formatStudentId };
