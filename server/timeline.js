// Case activity timeline. Every raise, assignment and status change writes one row.
const pool = require('./db');

async function recordEvent(complaintId, kind, message, actor = null) {
  await pool.query(
    `INSERT INTO complaint_event (complaint_id, kind, message, actor) VALUES ($1,$2,$3,$4)`,
    [complaintId, kind, message, actor]
  );
}

async function timelineFor(complaintId) {
  const { rows } = await pool.query(
    `SELECT kind, message, actor, created_at FROM complaint_event
     WHERE complaint_id = $1 ORDER BY created_at ASC, event_id ASC`,
    [complaintId]
  );
  return rows.map((r) => ({ kind: r.kind, message: r.message, actor: r.actor, at: r.created_at }));
}

module.exports = { recordEvent, timelineFor };
