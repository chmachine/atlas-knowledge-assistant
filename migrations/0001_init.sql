-- Users, sessions and rate counters. Later migrations are additive only.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  -- Document role. Which access labels a role may read is decided in code (src/worker/access/policy.ts).
  role          TEXT NOT NULL CHECK (role IN ('employee', 'it_ops', 'hr', 'finance')),
  -- Admin sees the audit log and the dashboard. It does not widen document access.
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  -- Demo users log in with one click and never have a password; real accounts always have one.
  is_demo       INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  password_hash TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((is_demo = 1 AND password_hash IS NULL) OR (is_demo = 0 AND password_hash IS NOT NULL))
);

-- Only sha256(token) is stored, never the token itself (a database leak cannot be replayed as a cookie).
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  ip_hash    TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Fixed-window counters for logins and daily question limits. Key examples: login:<iphash>:<hour>, ask:user:<id>:<day>.
CREATE TABLE rate_counters (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX rate_counters_updated_idx ON rate_counters (updated_at);
