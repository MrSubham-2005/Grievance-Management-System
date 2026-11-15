const pool = require('./db');

// Session guards for the API. Each role has its own session key.
const LOGIN_PAGES = {
  student: '/HTML/STUDENTS/student_login.html',
  staff: '/HTML/STAFF/staff_login.html',
  admin: '/HTML/ADMIN/admin_login.html',
};

const ROLE_STATUS_CONFIG = {
  student: { table: 'student', idCol: 'student_id' },
  staff: { table: 'staff', idCol: 'staff_id' },
};

function requireRole(role) {
  return async (req, res, next) => {
    try {
      const user = req.session && req.session[role];
      if (!user) {
        return res.status(401).json({
          error: `You are not signed in as ${role}. Sign in first.`,
          redirect: LOGIN_PAGES[role],
        });
      }

      const config = ROLE_STATUS_CONFIG[role];
      if (config && user.id && (req.sessionID || (req.session && req.session.cookie))) {
        let isInactive = false;
        try {
          const { rows } = await pool.query(
            `SELECT status, ${config.idCol} FROM ${config.table} WHERE ${config.idCol} = $1`,
            [user.id]
          );
          if (rows && rows.length > 0 && rows[0][config.idCol] === user.id) {
            const currentStatus = (rows[0].status || '').toLowerCase();
            if (currentStatus !== 'active') {
              isInactive = true;
            }
          } else {
            isInactive = true;
          }
        } catch (dbErr) {
          console.error(`Account status verification failed for ${role}:`, dbErr.message || dbErr);
          return res.status(503).json({
            error: 'Service temporarily unavailable. Please try again later.',
          });
        }

        if (isInactive) {
          if (req.session) {
            delete req.session[role];
            if (typeof req.session.destroy === 'function') {
              await new Promise((resolve) => req.session.destroy(resolve));
            }
          }
          return res.status(401).json({
            error: `You are not signed in as ${role}. Sign in first.`,
            redirect: LOGIN_PAGES[role],
          });
        }
      }

      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Wraps async route handlers so thrown errors reach the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { requireRole, wrap };
