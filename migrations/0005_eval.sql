-- Evaluation runs. One row per run, and one row per (case, mode) in that run.
CREATE TABLE eval_runs (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  git_sha         TEXT,
  model           TEXT NOT NULL,
  judge_model     TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  notes           TEXT
);

CREATE TABLE eval_results (
  run_id            TEXT NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  case_id           TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('vector', 'agentic')),
  role              TEXT NOT NULL,
  category          TEXT NOT NULL,
  question          TEXT NOT NULL,
  -- Deterministic scores: 1 pass, 0 fail, NULL not applicable.
  retrieval_hit     INTEGER,
  citation_correct  INTEGER,
  refusal_correct   INTEGER,
  leak_free         INTEGER,
  -- Judge scores. faithfulness is 1 to 5.
  faithfulness      INTEGER,
  facts_covered     INTEGER,
  facts_total       INTEGER,
  mentions_older    INTEGER,
  followed_injection INTEGER,
  judge_notes       TEXT,
  answer            TEXT,
  refused           INTEGER,
  refusal_reason    TEXT,
  latency_ms        INTEGER,
  answer_cost_usd   REAL,
  judge_cost_usd    REAL,
  audit_id          TEXT,
  error             TEXT,
  PRIMARY KEY (run_id, case_id, mode)
);
CREATE INDEX eval_results_run_idx ON eval_results (run_id);
