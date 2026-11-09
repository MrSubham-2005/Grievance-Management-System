// Session guards for the API. Each role has its own session key.
const LOGIN_PAGES = {
  student: '/HTML/STUDENTS/student_login.html',
  staff: '/HTML/STAFF/staff_login.html',
  admin: '/HTML/ADMIN/admin_login.html',
};

function requireRole(role) {
  return (req, res, next) => {
    const user = req.session && req.session[role];
    if (!user) {
      return res.status(401).json({
        error: `You are not signed in as ${role}. Sign in first.`,
        redirect: LOGIN_PAGES[role],
      });
    }
    req.user = user;
    next();
  };
}

// Wraps async route handlers so thrown errors reach the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { requireRole, wrap };
