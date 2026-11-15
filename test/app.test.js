// Smoke tests for the Express app. They run without a database: they check routing,
// auth gates and the JSON error shape, which do not need a live Postgres connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server/app');

let server;
let base;

test.before(() => new Promise((resolve) => {
  server = http.createServer(app).listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => new Promise((resolve) => server.close(resolve)));

test('unknown API routes return a JSON error that names the request', async () => {
  const res = await fetch(`${base}/api/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /No such endpoint: GET \/api\/does-not-exist/);
});

test('student endpoints refuse anonymous requests', async () => {
  const res = await fetch(`${base}/api/student/complaints`);
  assert.equal(res.status, 401);
  assert.ok((await res.json()).error);
});

test('admin CSV export refuses anonymous requests', async () => {
  const res = await fetch(`${base}/api/admin/complaints.csv`);
  assert.equal(res.status, 401);
});

const fs = require('node:fs');
const path = require('node:path');

test('the home page redirects to the portal landing page', async () => {
  const res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/Home.html');
});

test('server configuration defaults exclusively to port 4000 without port 3000 references', () => {
  assert.equal(app.DEFAULT_PORT, 4000);
  const root = path.join(__dirname, '..');
  for (const rel of ['server/app.js', '.env.example', 'Dockerfile', 'README.md']) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(content, /\b3000\b/, `${rel} should not reference port 3000`);
  }
});
