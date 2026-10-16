-- Documents, their chunks, and the full-text index used by the agentic mode's search_text tool.
-- Raw document text is stored as the company's document repository would hold it; redaction is applied on every way OUT
-- (to the embedder, the model, the log and the screen), never trusted to have happened on the way in.

CREATE TABLE documents (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  department     TEXT NOT NULL,
  access_label   TEXT NOT NULL CHECK (access_label IN ('general', 'it', 'security', 'hr', 'finance')),
  owner_name     TEXT NOT NULL,
  owner_role     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  effective_date TEXT NOT NULL,
  supersedes     TEXT,
  -- Derived from `supersedes` of other documents after every ingestion.
  superseded_by  TEXT,
  is_latest      INTEGER NOT NULL DEFAULT 1 CHECK (is_latest IN (0, 1)),
  language       TEXT NOT NULL CHECK (language IN ('pl', 'en')),
  body_md        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  -- 1 when this content has vectors in Vectorize.
  embedded       INTEGER NOT NULL DEFAULT 0 CHECK (embedded IN (0, 1)),
  ingested_at    TEXT NOT NULL
);
CREATE INDEX documents_access_idx ON documents (access_label);

-- id = "<document id>#<anchor>", at most 64 bytes, and it is also the Vectorize vector id.
CREATE TABLE chunks (
  id             TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,
  -- Document title, copied here because the full-text index reads its columns from this table.
  title          TEXT NOT NULL,
  section_path   TEXT NOT NULL,
  anchor         TEXT NOT NULL,
  text           TEXT NOT NULL,
  -- Copied from the document so every query can filter by role without a join.
  access_label   TEXT NOT NULL CHECK (access_label IN ('general', 'it', 'security', 'hr', 'finance')),
  injection_flag INTEGER NOT NULL DEFAULT 0 CHECK (injection_flag IN (0, 1)),
  token_estimate INTEGER NOT NULL
);
CREATE INDEX chunks_doc_idx ON chunks (doc_id, ord);
CREATE INDEX chunks_access_idx ON chunks (access_label);

-- Trigram tokenizer: substring matching, so "urlop" finds "urlopowy" and "urlopu" (Polish inflection), and diacritics are ignored.
-- Terms shorter than 3 characters cannot match; the query builder drops them.
CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  title, section_path, text,
  content = 'chunks', content_rowid = 'rowid',
  tokenize = 'trigram remove_diacritics 1'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, title, section_path, text) VALUES (new.rowid, new.title, new.section_path, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, title, section_path, text) VALUES ('delete', old.rowid, old.title, old.section_path, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, title, section_path, text) VALUES ('delete', old.rowid, old.title, old.section_path, old.text);
  INSERT INTO chunks_fts (rowid, title, section_path, text) VALUES (new.rowid, new.title, new.section_path, new.text);
END;
