const test = require('node:test');
const assert = require('node:assert/strict');
const { deadlineFor, isOverdue, HOURS } = require('../server/sla');

const HOUR = 60 * 60 * 1000;

test('deadline follows priority: High 24h, Medium 72h, Low 7 days', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  assert.equal(deadlineFor('High', start).getTime() - start.getTime(), 24 * HOUR);
  assert.equal(deadlineFor('Medium', start).getTime() - start.getTime(), 72 * HOUR);
  assert.equal(deadlineFor('Low', start).getTime() - start.getTime(), 168 * HOUR);
  assert.deepEqual(HOURS, { High: 24, Medium: 72, Low: 168 });
});

test('unknown priority falls back to the Medium deadline', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  assert.equal(deadlineFor('Urgent', start).getTime() - start.getTime(), 72 * HOUR);
});

test('an open complaint past its deadline is overdue', () => {
  const now = new Date('2026-01-05T00:00:00Z');
  const due = new Date('2026-01-04T00:00:00Z');
  assert.equal(isOverdue('Pending', due, now), true);
  assert.equal(isOverdue('In Progress', due, now), true);
});

test('a complaint before its deadline, or without one, is not overdue', () => {
  const now = new Date('2026-01-05T00:00:00Z');
  assert.equal(isOverdue('Pending', new Date('2026-01-06T00:00:00Z'), now), false);
  assert.equal(isOverdue('Pending', null, now), false);
});

test('a resolved complaint is never overdue', () => {
  const now = new Date('2026-01-05T00:00:00Z');
  assert.equal(isOverdue('Resolved', new Date('2026-01-01T00:00:00Z'), now), false);
});
