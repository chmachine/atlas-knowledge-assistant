-- One row per question. Everything text-like is redacted BEFORE it is written (see governance/audit.ts).
-- The admin sees this table; nobody else does.
CREATE TABLE audit_log (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL,
  user_id             TEXT,
  username            TEXT,
  role                TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('vector', 'agentic')),
  -- live: a real visitor. simulated: seeded history for the dashboard. eval: a run of the evaluation set.
  source              TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'simulated', 'eval')),
  question            TEXT NOT NULL,
  -- Chunk ids that retrieval contributed / that the answer cited, as JSON arrays.
  retrieved_chunk_ids TEXT NOT NULL DEFAULT '[]',
  cited_chunk_ids     TEXT NOT NULL DEFAULT '[]',
  -- Agentic mode: the tool calls the model made, as JSON.
  tool_calls          TEXT NOT NULL DEFAULT '[]',
  answer              TEXT NOT NULL DEFAULT '',
  refused             INTEGER NOT NULL DEFAULT 0 CHECK (refused IN (0, 1)),
  -- no_answer | uncited | model_refusal | max_tokens | blocked
  refusal_reason      TEXT,
  injection_detected  INTEGER NOT NULL DEFAULT 0 CHECK (injection_detected IN (0, 1)),
  -- How many personal-data items were removed from the question and the retrieved text.
  pii_redactions      INTEGER NOT NULL DEFAULT 0,
  latency_ms          INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cost_usd            REAL,
  -- The model that actually answered (a server-side fallback can differ from the configured one).
  model               TEXT,
  fell_back           INTEGER NOT NULL DEFAULT 0 CHECK (fell_back IN (0, 1)),
  -- Thumbs: 1 up, -1 down.
  feedback            INTEGER CHECK (feedback IN (-1, 1)),
  feedback_at         TEXT,
  error               TEXT
);
CREATE INDEX audit_created_idx ON audit_log (created_at);
CREATE INDEX audit_user_idx ON audit_log (user_id, created_at);
CREATE INDEX audit_source_idx ON audit_log (source, created_at);
