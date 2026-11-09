const test = require('node:test');
const assert = require('node:assert/strict');
const { statusEmail, escapeHtml, notifyStudent } = require('../server/notify');

test('escapeHtml neutralises markup in user-supplied text', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; \'y\'&lt;/b&gt;');
});

test('status email for an in-progress complaint names the status and staff', () => {
  const mail = statusEmail({ complaintId: 'C-1', status: 'In Progress', staffName: 'Asha' });
  assert.equal(mail.subject, 'Complaint C-1 is now In Progress');
  assert.match(mail.text, /Assigned to: Asha/);
});

test('resolved email includes the resolution note and escapes it in HTML', () => {
  const mail = statusEmail({ complaintId: 'C-2', status: 'Resolved', resolution: '<script>x</script>' });
  assert.equal(mail.subject, 'Complaint C-2 has been resolved');
  assert.match(mail.text, /Resolution note: <script>x<\/script>/);
  assert.doesNotMatch(mail.html, /<script>/);
});

test('notifyStudent skips cleanly and sends nothing without a Resend key', async () => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const sent = await notifyStudent({ to: 'a@example.com', complaintId: 'C-3', status: 'Resolved' });
    assert.equal(sent, false);
  } finally {
    if (saved !== undefined) process.env.RESEND_API_KEY = saved;
  }
});
