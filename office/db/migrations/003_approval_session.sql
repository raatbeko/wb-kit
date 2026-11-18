-- Одобрения привязываем к сеансу Claude Code: в двух окнах Claude Code
-- предложения не путаются, а отказ человека закрывает только свои.
ALTER TABLE approvals ADD COLUMN session_id TEXT;
CREATE INDEX approvals_ws_session ON approvals (workspace_id, session_id, status);
