-- GMS complaint portal schema (PostgreSQL). Safe to re-run.

-- Login sessions, stored in Postgres so they survive serverless invocations.
CREATE TABLE IF NOT EXISTS session (
  sid     VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess    JSON    NOT NULL,
  expire  TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

-- Failed password-reset answers, used to lock an account after repeated mistakes.
CREATE TABLE IF NOT EXISTS reset_attempt (
  email        VARCHAR(150) NOT NULL,
  role         VARCHAR(20)  NOT NULL,
  failed_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reset_attempt_lookup ON reset_attempt (role, email, failed_at);

CREATE TABLE IF NOT EXISTS admin (
  admin_id          VARCHAR(20) PRIMARY KEY,
  admin_name        VARCHAR(100),
  mobile            VARCHAR(20),
  email             VARCHAR(150),
  password          VARCHAR(255) NOT NULL,
  security_question VARCHAR(255),
  security_answer   VARCHAR(255),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student (
  student_id        VARCHAR(20) PRIMARY KEY,
  student_name      VARCHAR(100) NOT NULL,
  mobile            VARCHAR(20) NOT NULL,
  email             VARCHAR(150) NOT NULL UNIQUE,
  password          VARCHAR(255) NOT NULL,
  security_question VARCHAR(255),
  security_answer   VARCHAR(255),
  status            VARCHAR(20) NOT NULL DEFAULT 'Active',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  staff_id          VARCHAR(20) PRIMARY KEY,
  staff_name        VARCHAR(100) NOT NULL,
  mobile            VARCHAR(20) NOT NULL,
  email             VARCHAR(150) NOT NULL,
  department        VARCHAR(100),
  password          VARCHAR(255) NOT NULL,
  security_question VARCHAR(255),
  security_answer   VARCHAR(255),
  rating            NUMERIC(3,2) NOT NULL DEFAULT 0,
  status            VARCHAR(20) NOT NULL DEFAULT 'Active',
  created_by        VARCHAR(20),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_request (
  request_id        VARCHAR(20) PRIMARY KEY,
  staff_name        VARCHAR(100) NOT NULL,
  mobile            VARCHAR(20) NOT NULL,
  email             VARCHAR(150) NOT NULL,
  department        VARCHAR(100),
  password          VARCHAR(255) NOT NULL,
  security_question VARCHAR(255),
  security_answer   VARCHAR(255),
  status            VARCHAR(20) NOT NULL DEFAULT 'Pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS complaint (
  complaint_id      VARCHAR(20) PRIMARY KEY,
  student_id        VARCHAR(20) NOT NULL REFERENCES student(student_id),
  category          VARCHAR(100) NOT NULL,
  description       TEXT NOT NULL,
  priority          VARCHAR(20) NOT NULL DEFAULT 'Medium',
  status            VARCHAR(30) NOT NULL DEFAULT 'Pending',
  assigned_staff_id VARCHAR(20) REFERENCES staff(staff_id),
  resolution        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS complaint_member (
  complaint_id      VARCHAR(20) NOT NULL REFERENCES complaint(complaint_id) ON DELETE CASCADE,
  student_id        VARCHAR(20) NOT NULL REFERENCES student(student_id),
  PRIMARY KEY (complaint_id, student_id)
);

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id       VARCHAR(20) PRIMARY KEY,
  complaint_id      VARCHAR(20) NOT NULL REFERENCES complaint(complaint_id),
  student_id        VARCHAR(20) NOT NULL REFERENCES student(student_id),
  staff_id          VARCHAR(20) REFERENCES staff(staff_id),
  category          VARCHAR(100),
  rating            INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_secret (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  secret_code       VARCHAR(255) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_complaint_student ON complaint(student_id);
CREATE INDEX IF NOT EXISTS idx_complaint_staff ON complaint(assigned_staff_id);

ALTER TABLE complaint ADD COLUMN IF NOT EXISTS ai_analysis JSONB;

-- Service-level deadline. Set from priority when a complaint is raised (see server/sla.js).
ALTER TABLE complaint ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
UPDATE complaint SET due_at = created_at + CASE priority
  WHEN 'High' THEN INTERVAL '24 hours'
  WHEN 'Low' THEN INTERVAL '7 days'
  ELSE INTERVAL '3 days' END
 WHERE due_at IS NULL;

-- Case timeline: one row per change (raised, assigned, status, resolved).
CREATE TABLE IF NOT EXISTS complaint_event (
  event_id      BIGSERIAL PRIMARY KEY,
  complaint_id  VARCHAR(20) NOT NULL REFERENCES complaint(complaint_id) ON DELETE CASCADE,
  kind          VARCHAR(30) NOT NULL,
  message       TEXT NOT NULL,
  actor         VARCHAR(150),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_complaint_event_complaint ON complaint_event(complaint_id, created_at);
