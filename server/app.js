// GMS complaint portal: Express app. Serves the existing pages and the JSON API.
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const pool = require('./db');

const app = express();
const webRoot = path.join(__dirname, '..', 'web');
const PgSession = connectPgSimple(session);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

// Sessions live in Postgres so they survive serverless invocations (Vercel).
app.use(
  session({
    store: new PgSession({ pool, tableName: 'session' }),
    name: 'gms.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/student', require('./routes/student'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/admin', require('./routes/admin'));

// Unknown API routes get a JSON error that says what went wrong.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

app.get('/', (req, res) => res.redirect('/Home.html'));
app.use(express.static(webRoot, { extensions: ['html'] }));

// Final error handler: always JSON for API calls, plain text otherwise.
app.use((err, req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  const message = status === 500 ? 'Something went wrong on the server. Try again.' : err.message;
  if (req.originalUrl.startsWith('/api')) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`GMS running on http://localhost:${port}`);
  });
}
