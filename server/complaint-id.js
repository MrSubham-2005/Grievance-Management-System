// Shared complaint ID formatting and lookup helpers.
// Displays legacy IDs (CMP0001) and new IDs (CMP-0001) uniformly as CMP-0001
// without modifying stored primary keys or foreign key references.

const { nextId } = require('./id-generator');

function formatComplaintId(id) {
  if (typeof id !== 'string') return '';
  const trimmed = id.trim();
  const match = trimmed.match(/^CMP-?(\d+)$/i);
  if (!match) return trimmed;
  return `CMP-${match[1].padStart(4, '0')}`;
}

function complaintIdCandidates(id) {
  if (typeof id !== 'string') return [];
  const trimmed = id.trim();
  if (!trimmed) return [];
  const match = trimmed.match(/^CMP-?(\d+)$/i);
  if (!match) return [trimmed];
  const digits = match[1];
  const padded = digits.padStart(4, '0');
  return [...new Set([trimmed, `CMP-${padded}`, `CMP${padded}`, `CMP-${digits}`, `CMP${digits}`])];
}

async function resolveComplaintId(db, id) {
  const candidates = complaintIdCandidates(id);
  if (!candidates.length) return null;
  const { rows } = await db.query(
    'SELECT complaint_id FROM complaint WHERE complaint_id = ANY($1) LIMIT 1',
    [candidates]
  );
  return rows[0] ? rows[0].complaint_id : null;
}

async function nextComplaintId(db) {
  return nextId('complaint', 'complaint_id', 'CMP', db);
}

module.exports = {
  formatComplaintId,
  complaintIdCandidates,
  resolveComplaintId,
  nextComplaintId,
};
