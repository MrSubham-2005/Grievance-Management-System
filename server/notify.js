// Email notifications for complaint status changes, sent through the Resend API.
// Without RESEND_API_KEY nothing is sent and the app keeps working, so a missing key never blocks a status update.
const RESEND_URL = 'https://api.resend.com/emails';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusEmail({ complaintId, status, resolution, staffName }) {
  const subject = status === 'Resolved'
    ? `Complaint ${complaintId} has been resolved`
    : `Complaint ${complaintId} is now ${status}`;
  const lines = [
    `Your complaint ${complaintId} is now ${status}.`,
    staffName ? `Assigned to: ${staffName}.` : null,
    resolution ? `Resolution note: ${resolution}` : null,
    'Sign in to the GMS portal to see the full timeline.',
  ].filter(Boolean);
  const body = lines
    .map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#475569;">${escapeHtml(l)}</p>`)
    .join('');
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">` +
    `<div style="background:#3b82f6;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700;">GMS Complaint Portal</div>` +
    `<div style="padding:24px;"><h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;">${escapeHtml(subject)}</h1>${body}</div>` +
    `</div><p style="max-width:560px;margin:14px auto 0;font-size:12px;color:#64748b;text-align:center;">Reply to this email to contact the GMS team.</p>` +
    `</body></html>`;
  return { subject, text: lines.join('\n\n'), html };
}

// Sends a status email. Returns true when sent, false when skipped or failed. Never throws.
async function notifyStudent({ to, complaintId, status, resolution, staffName }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  const from = process.env.NOTIFY_FROM || 'GMS Complaints <onboarding@resend.dev>';
  const mail = statusEmail({ complaintId, status, resolution, staffName });
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: from, subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`Status email for ${complaintId} was rejected with HTTP ${res.status}.`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Status email for ${complaintId} failed: ${err.message}`);
    return false;
  }
}

module.exports = { notifyStudent, statusEmail, escapeHtml };
