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

test('the home page redirects to the portal landing page', async () => {
  const res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/Home.html');
});
