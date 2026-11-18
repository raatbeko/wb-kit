/**
 * «Переходники» офиса. У каждого две реализации: локальная (ноутбук клиента:
 * SQLite, .env, опрос базы) и облачная (Supabase, Vault, Realtime, Agent SDK).
 * Остальной код — сервер, фронт, хуки — знает только эти интерфейсы, поэтому
 * переезд в облако — это новые реализации, а не переписывание офиса.
 * См. docs/office-3d/PLAN.md, раздел 8.
 */
import type {
  Agent,
  AgentStatus,
  Approval,
  ApprovalStatus,
  NewEvent,
  OfficeEvent,
  Report,
  Task,
  TaskStatus,
} from "./types.js";
import type { Snapshot } from "../sync/snapshot.js";

export interface StoredSnapshot {
  id: string;
  createdAt: string;
  snapshot: Snapshot;
}

export interface OfficeStore {
  listAgents(): Agent[];
  getAgent(id: string): Agent | undefined;
  /** Добавить недостающих сотрудников из штатного расписания, существующих не трогать. */
  ensureAgents(agents: Omit<Agent, "workspaceId" | "status" | "activity" | "updatedAt">[]): void;
  /**
   * `at` — когда случилось событие. Хуки асинхронные и могут записаться не по
   * порядку: более старое событие не перезапишет более новый статус.
   */
  setAgentStatus(id: string, status: AgentStatus, activity?: string | null, at?: string): void;

  addEvent(e: NewEvent): OfficeEvent;
  /** События после номера `afterSeq`, по возрастанию, не больше `limit`. */
  listEvents(afterSeq?: number, limit?: number): OfficeEvent[];
  /** Последние `limit` событий, по возрастанию — для первой загрузки страницы. */
  recentEvents(limit?: number): OfficeEvent[];

  createTask(t: Pick<Task, "agentId" | "question" | "source">): Task;
  updateTask(id: string, patch: Partial<Pick<Task, "status" | "resultReportId">>): Task | undefined;
  listTasks(filter?: { status?: TaskStatus; agentId?: string }): Task[];

  createApproval(
    a: Pick<Approval, "agentId" | "taskId" | "tool" | "title" | "changes" | "args"> & { sessionId?: string | null; status?: ApprovalStatus },
  ): Approval;
  /**
   * Переходы: pending → approved | rejected | failed | done; approved → done | failed.
   * Остальные — нет (повторный клик не выполнит изменение второй раз). undefined — переход не сделан.
   */
  resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | undefined;
  listApprovals(filter?: { status?: ApprovalStatus; sessionId?: string; agentId?: string; tool?: string }): Approval[];

  addReport(r: Omit<Report, "workspaceId" | "id" | "createdAt"> & { createdAt?: string }): Report;
  /** Отчёт по пути — чтобы не заносить один и тот же файл дважды. */
  findReportByPath(path: string): Report | undefined;
  listReports(limit?: number): Report[];

  addSnapshot(s: Snapshot): StoredSnapshot;
  latestSnapshot(): StoredSnapshot | undefined;

  getSetting<T = unknown>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;

  close(): void;
}

/** Имена ключей офиса — те же, что в .env.example. */
export type SecretName = "WB_API_TOKEN" | "MPSTATS_TOKEN" | "ANTHROPIC_API_KEY";

export interface SecretStatus {
  name: SecretName;
  present: boolean;
  /** Длина ключа — чтобы человек видел «вставлен», не видя самого ключа. */
  length: number | null;
}

/** Ключи. Наружу (на фронт) отдаётся только статус, сам ключ — никогда. */
export interface SecretStore {
  get(name: SecretName): string | undefined;
  set(name: SecretName, value: string): void;
  status(): SecretStatus[];
}

export type Unsubscribe = () => void;

/** Живые события для фронта: локально — опрос SQLite, в облаке — Supabase Realtime. */
export interface EventBus {
  publish(e: NewEvent): OfficeEvent;
  /** Подписка на события после `afterSeq`; колбэк получает их по порядку. */
  subscribe(afterSeq: number, onEvent: (e: OfficeEvent) => void): Unsubscribe;
}

export interface AgentRunRequest {
  agentId: string;
  question: string;
  taskId: string;
}

/**
 * Запуск сотрудника. Локально в режиме «окна» его запускает сам Claude Code
 * клиента, а офис только узнаёт о шагах через хуки — реализации нет.
 * С ключом ANTHROPIC_API_KEY или в облаке — Agent SDK.
 */
export interface AgentRunner {
  readonly mode: "claude_code" | "agent_sdk";
  run(req: AgentRunRequest): Promise<void>;
}
