/**
 * Локальная реализация OfficeStore на SQLite. Облачная (Supabase) должна
 * повторять её поведение — общие тесты в office/office.test.ts.
 */
import { randomUUID } from "node:crypto";
import type { OfficeStore, StoredSnapshot } from "../core/ports.js";
import type { Snapshot } from "../sync/snapshot.js";
import {
  LOCAL_WORKSPACE,
  type Agent,
  type AgentStatus,
  type Approval,
  type ApprovalStatus,
  type NewEvent,
  type OfficeEvent,
  type Report,
  type Task,
  type TaskStatus,
} from "../core/types.js";
import { openDb, type DB } from "../db/sqlite.js";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | null => (typeof v === "string" ? (JSON.parse(v) as T) : null);

function toAgent(r: Row): Agent {
  return {
    workspaceId: r.workspace_id as string,
    id: r.id as string,
    name: r.name as string,
    title: r.title as string,
    duty: r.duty as string,
    zone: r.zone as Agent["zone"],
    status: r.status as AgentStatus,
    activity: (r.activity as string | null) ?? null,
    updatedAt: r.updated_at as string,
  };
}

function toEvent(r: Row): OfficeEvent {
  return {
    workspaceId: r.workspace_id as string,
    seq: r.seq as number,
    id: r.id as string,
    kind: r.kind as OfficeEvent["kind"],
    agentId: (r.agent_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    message: r.message as string,
    data: parse(r.data),
    createdAt: r.created_at as string,
  };
}

function toTask(r: Row): Task {
  return {
    workspaceId: r.workspace_id as string,
    id: r.id as string,
    agentId: r.agent_id as string,
    question: r.question as string,
    status: r.status as TaskStatus,
    source: r.source as Task["source"],
    resultReportId: (r.result_report_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toApproval(r: Row): Approval {
  return {
    workspaceId: r.workspace_id as string,
    id: r.id as string,
    agentId: r.agent_id as string,
    taskId: (r.task_id as string | null) ?? null,
    tool: r.tool as string,
    title: r.title as string,
    changes: parse(r.changes) ?? [],
    args: parse(r.args) ?? {},
    status: r.status as ApprovalStatus,
    sessionId: (r.session_id as string | null) ?? null,
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
  };
}

function toReport(r: Row): Report {
  return {
    workspaceId: r.workspace_id as string,
    id: r.id as string,
    kind: r.kind as Report["kind"],
    title: r.title as string,
    path: (r.path as string | null) ?? null,
    summary: parse(r.summary),
    agentId: (r.agent_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export class SqliteOfficeStore implements OfficeStore {
  readonly db: DB;

  constructor(db: DB | string = openDb(), readonly workspaceId = LOCAL_WORKSPACE) {
    this.db = typeof db === "string" ? openDb(db) : db;
  }

  listAgents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents WHERE workspace_id = ? ORDER BY rowid").all(this.workspaceId) as Row[]).map(toAgent);
  }

  getAgent(id: string): Agent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE workspace_id = ? AND id = ?").get(this.workspaceId, id) as Row | undefined;
    return r && toAgent(r);
  }

  ensureAgents(agents: Omit<Agent, "workspaceId" | "status" | "activity" | "updatedAt">[]): void {
    // Имя и должность обновляем (могли переименовать в коде), статус — не трогаем.
    const stmt = this.db.prepare(`
      INSERT INTO agents (workspace_id, id, name, title, duty, zone, updated_at)
      VALUES (@ws, @id, @name, @title, @duty, @zone, @at)
      ON CONFLICT (workspace_id, id) DO UPDATE SET name = excluded.name, title = excluded.title,
        duty = excluded.duty, zone = excluded.zone`);
    // Новый сотрудник — «давно не обновлялся»: иначе первое событие хука (время которого
    // взято до открытия базы) оказалось бы «старше» и не поменяло бы его статус.
    const at = new Date(0).toISOString();
    this.db.transaction(() => {
      for (const a of agents) stmt.run({ ws: this.workspaceId, ...a, at });
    })();
  }

  setAgentStatus(id: string, status: AgentStatus, activity: string | null = null, at?: string): void {
    const t = at ?? now();
    this.db
      .prepare("UPDATE agents SET status = ?, activity = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND updated_at <= ?")
      .run(status, activity, t, this.workspaceId, id, t);
  }

  addEvent(e: NewEvent): OfficeEvent {
    const r = this.db
      .prepare(
        `INSERT INTO events (workspace_id, id, kind, agent_id, task_id, message, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(this.workspaceId, randomUUID(), e.kind, e.agentId ?? null, e.taskId ?? null, e.message, json(e.data), now()) as Row;
    return toEvent(r);
  }

  listEvents(afterSeq = 0, limit = 200): OfficeEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(this.workspaceId, afterSeq, limit) as Row[]
    ).map(toEvent);
  }

  recentEvents(limit = 50): OfficeEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?")
      .all(this.workspaceId, limit) as Row[];
    return rows.reverse().map(toEvent);
  }

  createTask(t: Pick<Task, "agentId" | "question" | "source">): Task {
    const at = now();
    const r = this.db
      .prepare(
        `INSERT INTO tasks (workspace_id, id, agent_id, question, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?) RETURNING *`,
      )
      .get(this.workspaceId, randomUUID(), t.agentId, t.question, t.source, at, at) as Row;
    return toTask(r);
  }

  updateTask(id: string, patch: Partial<Pick<Task, "status" | "resultReportId">>): Task | undefined {
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = COALESCE(?, status), result_report_id = COALESCE(?, result_report_id), updated_at = ?
         WHERE workspace_id = ? AND id = ? RETURNING *`,
      )
      .get(patch.status ?? null, patch.resultReportId ?? null, now(), this.workspaceId, id) as Row | undefined;
    return r && toTask(r);
  }

  listTasks(filter: { status?: TaskStatus; agentId?: string } = {}): Task[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks WHERE workspace_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR agent_id = ?)
           ORDER BY created_at DESC`,
        )
        .all(this.workspaceId, filter.status ?? null, filter.status ?? null, filter.agentId ?? null, filter.agentId ?? null) as Row[]
    ).map(toTask);
  }

  createApproval(
    a: Pick<Approval, "agentId" | "taskId" | "tool" | "title" | "changes" | "args"> & { sessionId?: string | null; status?: ApprovalStatus },
  ): Approval {
    const at = now();
    const status = a.status ?? "pending";
    const r = this.db
      .prepare(
        `INSERT INTO approvals (workspace_id, id, agent_id, task_id, tool, title, changes, args, status, session_id, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        this.workspaceId, randomUUID(), a.agentId, a.taskId, a.tool, a.title, JSON.stringify(a.changes), JSON.stringify(a.args),
        status, a.sessionId ?? null, at, status === "pending" ? null : at,
      ) as Row;
    return toApproval(r);
  }

  resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | undefined {
    // Из «одобрено» — только в выполнено/ошибка. Из «ждёт» — в любое решение
    // (в окне Claude Code «да» и выполнение мы видим одним событием).
    // Иное не меняем: дважды нажатая кнопка не выполнит изменение второй раз.
    const from = status === "done" || status === "failed" ? ["pending", "approved"] : ["pending"];
    const r = this.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = ? WHERE workspace_id = ? AND id = ? AND status IN (${from.map(() => "?").join(",")}) RETURNING *`,
      )
      .get(status, now(), this.workspaceId, id, ...from) as Row | undefined;
    return r && toApproval(r);
  }

  listApprovals(filter: { status?: ApprovalStatus; sessionId?: string; agentId?: string; tool?: string } = {}): Approval[] {
    const f = (v: string | undefined) => [v ?? null, v ?? null];
    return (
      this.db
        .prepare(
          `SELECT * FROM approvals WHERE workspace_id = ?
             AND (? IS NULL OR status = ?) AND (? IS NULL OR session_id = ?) AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR tool = ?)
           ORDER BY created_at DESC, rowid DESC`,
        )
        .all(this.workspaceId, ...f(filter.status), ...f(filter.sessionId), ...f(filter.agentId), ...f(filter.tool)) as Row[]
    ).map(toApproval);
  }

  addReport(r: Omit<Report, "workspaceId" | "id" | "createdAt"> & { createdAt?: string }): Report {
    const row = this.db
      .prepare(
        `INSERT INTO reports (workspace_id, id, kind, title, path, summary, agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(this.workspaceId, randomUUID(), r.kind, r.title, r.path, json(r.summary), r.agentId, r.createdAt ?? now()) as Row;
    return toReport(row);
  }

  findReportByPath(path: string): Report | undefined {
    const r = this.db.prepare("SELECT * FROM reports WHERE workspace_id = ? AND path = ?").get(this.workspaceId, path) as Row | undefined;
    return r && toReport(r);
  }

  findReportByFolder(folder: string): Report | undefined {
    // substr вместо LIKE: в именах папок бывают «_» и «%», которые LIKE понял бы как шаблон.
    const r = this.db
      .prepare("SELECT * FROM reports WHERE workspace_id = ? AND substr(path, 1, ?) = ? ORDER BY created_at LIMIT 1")
      .get(this.workspaceId, folder.length, folder) as Row | undefined;
    return r && toReport(r);
  }

  updateReport(id: string, patch: Partial<Pick<Report, "path" | "summary" | "title">>): void {
    const cur = this.db.prepare("SELECT * FROM reports WHERE workspace_id = ? AND id = ?").get(this.workspaceId, id) as Row | undefined;
    if (!cur) return;
    this.db
      .prepare("UPDATE reports SET path = ?, summary = ?, title = ? WHERE workspace_id = ? AND id = ?")
      .run(
        patch.path !== undefined ? patch.path : cur.path,
        patch.summary !== undefined ? json(patch.summary) : cur.summary,
        patch.title ?? cur.title,
        this.workspaceId,
        id,
      );
  }

  listReports(limit = 50): Report[] {
    return (
      this.db
        .prepare("SELECT * FROM reports WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(this.workspaceId, limit) as Row[]
    ).map(toReport);
  }

  addSnapshot(s: Snapshot): StoredSnapshot {
    const id = randomUUID();
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO wb_snapshots (workspace_id, id, demo, period_from, period_to, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.workspaceId, id, s.demo ? 1 : 0, s.period.from, s.period.to, JSON.stringify(s), createdAt);
    // Храним последние 60 снимков (≈ 2 месяца по разу в день) — база не разрастается.
    this.db
      .prepare(
        `DELETE FROM wb_snapshots WHERE workspace_id = ? AND id NOT IN
         (SELECT id FROM wb_snapshots WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 60)`,
      )
      .run(this.workspaceId, this.workspaceId);
    return { id, createdAt, snapshot: s };
  }

  latestSnapshot(): StoredSnapshot | undefined {
    const r = this.db
      .prepare("SELECT id, data, created_at FROM wb_snapshots WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(this.workspaceId) as { id: string; data: string; created_at: string } | undefined;
    return r && { id: r.id, createdAt: r.created_at, snapshot: JSON.parse(r.data) as Snapshot };
  }

  getSetting<T = unknown>(key: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE workspace_id = ? AND key = ?").get(this.workspaceId, key) as
      | { value: string }
      | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(this.workspaceId, key, JSON.stringify(value), now());
  }

  close(): void {
    this.db.close();
  }
}
