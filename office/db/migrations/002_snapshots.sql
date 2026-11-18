-- Снимки магазина WB: результат синхронизации (тот же сбор, что у /audit).
-- Офис и роли читают снимок из базы, а в WB ходим только по расписанию —
-- так не упираемся в лимиты WB (статистика — 1 запрос в минуту).
CREATE TABLE wb_snapshots (
  workspace_id TEXT NOT NULL,
  id           TEXT PRIMARY KEY,
  demo         INTEGER NOT NULL DEFAULT 0,
  period_from  TEXT NOT NULL,
  period_to    TEXT NOT NULL,
  -- Весь снимок одним JSON: KPI, проблемы с ответственными, товары, недели, финансы.
  data         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX wb_snapshots_ws_created ON wb_snapshots (workspace_id, created_at);
