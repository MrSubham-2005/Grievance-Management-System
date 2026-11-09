// Service-level deadlines. A complaint is due this long after it is raised, by priority.
const HOURS = { High: 24, Medium: 72, Low: 168 };

function deadlineFor(priority, from = new Date()) {
  const hours = HOURS[priority] || HOURS.Medium;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

// A complaint is overdue when it is still open and its deadline has passed.
function isOverdue(status, dueAt, now = new Date()) {
  if (!dueAt || status === 'Resolved') return false;
  return new Date(dueAt).getTime() < now.getTime();
}

module.exports = { HOURS, deadlineFor, isOverdue };
