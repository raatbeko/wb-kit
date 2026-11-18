/**
 * Сущности офиса. Одинаковые для локальной версии (SQLite) и облачной
 * (Supabase): везде есть workspaceId, id — UUID, время — ISO-строка в UTC.
 * Так данные переезжают из одной базы в другую без преобразований.
 */

/** Локальная установка всегда работает в одном «рабочем пространстве». */
export const LOCAL_WORKSPACE = "local";

export type AgentStatus =
  | "idle" // отдыхает
  | "working" // делает задачу
  | "waiting" // ждёт решения человека
  | "error"; // ошибка: ключ, лимит WB и т. п.

export interface Agent {
  workspaceId: string;
  /** Совпадает с именем файла роли в .claude/agents (`analyst`), у директора — `director`. */
  id: string;
  name: string;
  title: string;
  /** Чем занимается, одной фразой — для подсказки в офисе. */
  duty: string;
  /** Зона офиса, где стоит стол. */
  zone: OfficeZone;
  status: AgentStatus;
  /** Что делает прямо сейчас («смотрю остатки…»), пусто в покое. */
  activity: string | null;
  updatedAt: string;
}

export type OfficeZone = "director" | "finance" | "analytics" | "operations" | "marketing" | "meeting";

export type EventKind =
  | "agent_started"
  | "agent_step"
  | "agent_finished"
  | "agent_error"
  | "approval_requested"
  | "approval_resolved"
  | "report_added"
  | "sync_finished"
  | "note";

export interface OfficeEvent {
  workspaceId: string;
  /** Растущий номер — по нему фронт догружает «всё после N». */
  seq: number;
  id: string;
  kind: EventKind;
  agentId: string | null;
  taskId: string | null;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export type NewEvent = Pick<OfficeEvent, "kind" | "message"> &
  Partial<Pick<OfficeEvent, "agentId" | "taskId" | "data">>;

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  workspaceId: string;
  id: string;
  agentId: string;
  question: string;
  status: TaskStatus;
  /** Откуда задача: чат Claude Code, клик в офисе, расписание. */
  source: "claude_code" | "office" | "schedule";
  resultReportId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "done" | "failed";

/** Предложенное изменение в кабинете WB: выполняется только после «да» человека. */
export interface Approval {
  workspaceId: string;
  id: string;
  agentId: string;
  taskId: string | null;
  /** Инструмент записи MCP WB, например `update_prices`. */
  tool: string;
  title: string;
  /** Таблица «было → станет» для показа человеку. */
  changes: { item: string; before: string; after: string }[];
  /** Аргументы инструмента — их выполнит директор/воркер после одобрения. */
  args: Record<string, unknown>;
  status: ApprovalStatus;
  /** Сеанс Claude Code, из которого пришёл запрос (null — из офиса). */
  sessionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type ReportKind = "audit" | "office" | "competitors" | "card" | "custom";

export interface Report {
  workspaceId: string;
  id: string;
  kind: ReportKind;
  title: string;
  /** Путь от корня wb-kit (`reports/…`). В облаке — ключ в хранилище файлов. */
  path: string | null;
  /** Краткие цифры для офиса (из summary.json отчёта). */
  summary: Record<string, unknown> | null;
  agentId: string | null;
  createdAt: string;
}
