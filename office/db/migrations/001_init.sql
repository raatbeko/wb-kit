-- Офис: первая схема. Пишется так, чтобы перевод в Postgres (Supabase) был
-- механическим: TEXT-id (UUID), время ISO-строкой в UTC, JSON в TEXT-колонках
-- (в Postgres станут jsonb), workspace_id во всех таблицах.

CREATE TABLE agents (
  workspace_id TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  title        TEXT NOT NULL,
  duty         TEXT NOT NULL,
  zone         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','working','waiting','error')),
  activity     TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- seq — сквозной номер события: фронт и подписчики догружают «всё после N».
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  id           TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  agent_id     TEXT,
  task_id      TEXT,
  message      TEXT NOT NULL,
  data         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX events_ws_seq ON events (workspace_id, seq);

CREATE TABLE tasks (
  workspace_id     TEXT NOT NULL,
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  question         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  source           TEXT NOT NULL CHECK (source IN ('claude_code','office','schedule')),
  result_report_id TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX tasks_ws_status ON tasks (workspace_id, status);

CREATE TABLE approvals (
  workspace_id TEXT NOT NULL,
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  task_id      TEXT,
  tool         TEXT NOT NULL,
  title        TEXT NOT NULL,
  changes      TEXT NOT NULL,
  args         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','done','failed')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);
CREATE INDEX approvals_ws_status ON approvals (workspace_id, status);

CREATE TABLE reports (
  workspace_id TEXT NOT NULL,
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('audit','office','competitors','card','custom')),
  title        TEXT NOT NULL,
  path         TEXT,
  summary      TEXT,
  agent_id     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX reports_ws_created ON reports (workspace_id, created_at);
CREATE UNIQUE INDEX reports_ws_path ON reports (workspace_id, path) WHERE path IS NOT NULL;

CREATE TABLE settings (
  workspace_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
