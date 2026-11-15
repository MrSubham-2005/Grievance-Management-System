const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const GMSDate = require('../web/gms-date');

const ROOT = path.resolve(__dirname, '..');

test('GMSDate.formatDate converts YYYY-MM-DD, DD/MM/YYYY, D/M/YYYY, and DD-MM-YYYY to DD-MM-YYYY', () => {
  assert.equal(GMSDate.formatDate('2026-11-12'), '12-11-2026');
  assert.equal(GMSDate.formatDate('2026/07/03'), '03-07-2026');
  assert.equal(GMSDate.formatDate('12/11/2026'), '12-11-2026');
  assert.equal(GMSDate.formatDate('3/7/2026'), '03-07-2026');
  assert.equal(GMSDate.formatDate('12-11-2026'), '12-11-2026');
  assert.equal(GMSDate.formatDate('5-1-2026'), '05-01-2026');
  assert.equal(GMSDate.formatDate('  2026-01-09  '), '09-01-2026');
  assert.equal(GMSDate.formatDate(new Date(2026, 10, 12)), '12-11-2026');
});

test('GMSDate.formatDate validates leap years and rejects invalid calendar dates and non-date values', () => {
  assert.equal(GMSDate.formatDate('2024-02-29'), '29-02-2024');
  assert.equal(GMSDate.formatDate('2000-02-29'), '29-02-2000');
  assert.equal(GMSDate.formatDate('2026-02-29'), '');
  assert.equal(GMSDate.formatDate('2100-02-29', 'Not Available'), 'Not Available');
  assert.equal(GMSDate.formatDate('31/02/2026'), '');
  assert.equal(GMSDate.formatDate('2026-13-01'), '');
  assert.equal(GMSDate.formatDate('00/11/2026', 'N/A'), 'N/A');
  assert.equal(GMSDate.formatDate('not-a-date'), '');
  assert.equal(GMSDate.formatDate('Invalid Date', 'Not Available'), 'Not Available');
  assert.equal(GMSDate.formatDate('NaN', 'Not Available'), 'Not Available');
  assert.equal(GMSDate.formatDate(new Date('invalid'), 'Not Available'), 'Not Available');
});

test('GMSDate.formatDate handles null, undefined, empty strings, non-strings, and domain sentinels safely', () => {
  assert.equal(GMSDate.formatDate(null), '');
  assert.equal(GMSDate.formatDate(undefined), '');
  assert.equal(GMSDate.formatDate(''), '');
  assert.equal(GMSDate.formatDate('   '), '');
  assert.equal(GMSDate.formatDate(null, 'Not Available'), 'Not Available');
  assert.equal(GMSDate.formatDate('', 'Not Available'), 'Not Available');
  assert.equal(GMSDate.formatDate(12345, 'Not Available'), 'Not Available');
  assert.equal(GMSDate.formatDate('Pending', 'Not Available'), 'Pending');
  assert.equal(GMSDate.formatDate(' pending ', 'Not Available'), 'Pending');
  assert.equal(GMSDate.formatDate('Not Available', ''), 'Not Available');
  assert.equal(GMSDate.formatDate('not available', 'Fallback'), 'Not Available');
  assert.equal(GMSDate.formatDate('N/A', ''), '');
  assert.equal(GMSDate.formatDate('-', 'Not Available'), 'Not Available');
});

test('GMSDate.formatDateTime converts dates to DD-MM-YYYY while preserving time cleanly', () => {
  assert.equal(GMSDate.formatDateTime('12/11/2026, 08:03:36 am'), '12-11-2026, 08:03:36 am');
  assert.equal(GMSDate.formatDateTime('3/7/2026, 9:05:12 pm'), '03-07-2026, 9:05:12 pm');
  assert.equal(GMSDate.formatDateTime('2026-11-12 14:30:00'), '12-11-2026, 14:30:00');
  assert.equal(GMSDate.formatDateTime('2026-11-12'), '12-11-2026');
  assert.equal(GMSDate.formatDateTime(null, 'Not Available'), 'Not Available');
  assert.equal(GMSDate.formatDateTime('not-a-date', 'Not Available'), 'Not Available');

  const isoFormatted = GMSDate.formatDateTime('2026-11-12T02:33:36.123Z');
  assert.match(isoFormatted, /^\d{2}-\d{2}-\d{4}, .+$/);
  assert.doesNotMatch(isoFormatted, /\//);

  const dateObjFormatted = GMSDate.formatDateTime(new Date(2026, 10, 12, 9, 5, 3));
  assert.match(dateObjFormatted, /^12-11-2026, .+$/);
  assert.doesNotMatch(dateObjFormatted, /\//);
});

test('GMSDate avoids timezone date-shift across negative and positive UTC offsets', () => {
  const script = [
    'const g = require("./web/gms-date");',
    'console.log(JSON.stringify([',
    '  g.formatDate("2026-01-01"),',
    '  g.formatDate("2026-11-12"),',
    '  g.formatDate("01/01/2026"),',
    '  g.formatDate("12/11/2026"),',
    '  g.formatDateTime("12/11/2026, 11:59:59 pm")',
    ']));',
  ].join('\n');

  for (const tz of ['America/New_York', 'UTC', 'Asia/Kolkata', 'Pacific/Auckland']) {
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(out), [
      '01-01-2026',
      '12-11-2026',
      '01-01-2026',
      '12-11-2026',
      '12-11-2026, 11:59:59 pm',
    ]);
  }
});

test('GMSRecentComplaints.render formats API dates as DD-MM-YYYY', () => {
  const recentSrc = fs.readFileSync(path.join(ROOT, 'web', 'gms-recent-complaints.js'), 'utf8');
  const dateSrc = fs.readFileSync(path.join(ROOT, 'web', 'gms-date.js'), 'utf8');

  const tbodyEl = { innerHTML: '' };
  const fakeWindow = {
    location: { pathname: '/HTML/ADMIN/admin_dashboard.html' },
    document: {
      getElementById: (id) => (id === 'recentComplaintsBody' ? tbodyEl : null),
    },
  };
  fakeWindow.window = fakeWindow;
  fakeWindow.globalThis = fakeWindow;

  const ctx = vm.createContext(fakeWindow);
  vm.runInContext(dateSrc, ctx);
  vm.runInContext(recentSrc, ctx);

  ctx.GMSRecentComplaints.render(tbodyEl, [
    {
      complaintId: 'CMP-0042',
      studentId: 'STU-0001',
      studentName: 'Asha Rao',
      category: 'Hostel',
      description: 'Water supply issue',
      priority: 'High',
      date: '2026-11-12',
      status: 'Pending',
    },
    {
      complaintId: 'CMP-0041',
      studentId: 'STU-0002',
      studentName: 'Ravi Kumar',
      category: 'Library',
      description: 'AC not cooling',
      priority: 'Medium',
      date: '3/7/2026',
      status: 'Assigned',
    },
  ]);

  assert.match(tbodyEl.innerHTML, /<td>12-11-2026<\/td>/);
  assert.match(tbodyEl.innerHTML, /<td>03-07-2026<\/td>/);
  assert.doesNotMatch(tbodyEl.innerHTML, /2026-11-12/);
  assert.doesNotMatch(tbodyEl.innerHTML, /3\/7\/2026/);
});

test('All Admin, Staff, and Student table/timeline portal pages load /gms-date.js and use GMSDate', () => {
  const dashboardPages = [
    'web/HTML/ADMIN/admin_dashboard.html',
    'web/HTML/STAFF/staff_dashboard.html',
    'web/HTML/STUDENTS/student_dashboard.html',
  ];

  for (const relPath of dashboardPages) {
    const html = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const dateIdx = html.indexOf('<script src="/gms-date.js"></script>');
    const recentIdx = html.indexOf('<script src="/gms-recent-complaints.js"></script>');
    assert.ok(dateIdx !== -1, `${relPath} must load /gms-date.js`);
    assert.ok(recentIdx !== -1 && dateIdx < recentIdx, `${relPath} must load /gms-date.js before /gms-recent-complaints.js`);
  }

  const portalDatePages = [
    { relPath: 'web/HTML/ADMIN/view_complaints.html', calls: ['GMSDate.formatDate(c.complaintDate', 'GMSDate.formatDate(c.assignedAt'] },
    { relPath: 'web/HTML/ADMIN/staff.html', calls: ['GMSDate.formatDate(s.approvedOn'] },
    { relPath: 'web/HTML/STAFF/view_assigned_complaints.html', calls: ['GMSDate.formatDate(c.date'] },
    { relPath: 'web/HTML/STUDENTS/view_complaint_status.html', calls: ['GMSDate.formatDate(c.date)'] },
  ];

  for (const page of portalDatePages) {
    const html = fs.readFileSync(path.join(ROOT, page.relPath), 'utf8');
    assert.ok(html.includes('<script src="/gms-date.js"></script>'), `${page.relPath} must load /gms-date.js`);
    assert.doesNotMatch(html, /toLocaleDateString\s*\(/, `${page.relPath} must not use raw toLocaleDateString`);
    assert.doesNotMatch(html, /toLocaleString\s*\(\s*["']en-IN["']/, `${page.relPath} must not use raw toLocaleString("en-IN")`);
    for (const call of page.calls) {
      assert.ok(html.includes(call), `${page.relPath} must call ${call}`);
    }
  }
});
