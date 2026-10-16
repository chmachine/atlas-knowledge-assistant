-- Editable assumptions shown on the admin dashboard (so far: minutes saved per answered question).
-- A missing row means "use the default from src/config.ts".
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
