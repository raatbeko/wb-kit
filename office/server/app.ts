/**
 * HTTP-API офиса. Фронт знает только эти адреса (`/api/...`), поэтому тот же
 * фронт потом работает и в облаке — меняются реализации переходников.
 *
 * Без фреймворка: маршрутов мало, а лишняя зависимость — лишнее, что может
 * не поставиться у клиента.
 *
 * Защита: офис слушает 127.0.0.1, но браузер клиента может открыть чужой сайт,
 * который попробует постучаться на localhost. Поэтому:
 * - Host должен быть localhost/127.0.0.1 (против DNS rebinding);
 * - POST — только со своей страницы (Origin) и с JSON, иначе 403.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../../mcp/wb/src/env.js";
import type { AgentRunner, EventBus, OfficeStore, SecretStore } from "../core/ports.js";
import type { Approval, ApprovalStatus, TaskStatus } from "../core/types.js";

export const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
export const REPORTS_DIR = join(ROOT, "reports");
const THREE_DIR = join(ROOT, "node_modules", "three");

export interface AppDeps {
  store: OfficeStore;
  secrets: SecretStore;
  bus: EventBus;
  /** Режим офиса: «окно» в Claude Code или самостоятельный (Agent SDK по API-ключу). */
  mode?: "claude_code" | "agent_sdk";
  demo?: boolean;
  /** Есть только в режиме agent_sdk: запуск сотрудника из офиса. */
  runner?: AgentRunner;
  /** Выполнить одобренное изменение в кабинете WB. Нет — одобрять можно только в Claude Code. */
  executeApproval?: (a: Approval) => Promise<string>;
  /** Запустить синхронизацию WB (не ждёт окончания). */
  startSync?: () => void;
  webDir?: string;
  reportsDir?: string;
  /** Как часто слать пустой комментарий в SSE, чтобы соединение не закрылось. */
  keepAliveMs?: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Заголовки для всех ответов: офис нельзя встроить во фрейм чужого сайта
 * (иначе кнопку «Одобрить» подсунули бы под клик), тип файла не угадывается.
 */
const SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": TYPES[".json"]!, "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function intParam(v: string | null, def: number): number {
  // Number(null) и Number("") — это 0, а не «не задано».
  if (v === null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/** Файл строго внутри `root`, иначе null (никаких «../.env»). */
export function safeJoin(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const file = normalize(join(base, decoded));
  if (file !== base && !file.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
  return file;
}

function sendFile(res: ServerResponse, file: string | null, opts: { download?: boolean; sandbox?: boolean } = {}) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) return sendJson(res, 404, { error: "Не найдено" });
  const headers: Record<string, string> = { ...SECURITY_HEADERS, "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" };
  // Отчёты пишет Claude из данных WB и отзывов покупателей. В «песочнице» скрипт из отчёта
  // не получит адрес офиса и не сможет нажать «Одобрить» через API.
  if (opts.sandbox) headers["content-security-policy"] = "sandbox allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'none'";
  if (opts.download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(file.split(sep).pop()!)}`;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function checkHost(req: IncomingMessage) {
  const host = req.headers.host ?? "";
  if (!LOCAL_HOSTS.test(host)) throw new HttpError(403, "Офис открывается только по адресу localhost");
}

function checkWrite(req: IncomingMessage) {
  const origin = req.headers.origin;
  // Origin есть у любого запроса из браузера. Чужой сайт → его адрес → отказ.
  if (origin !== undefined) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* пусто — отказ ниже */
    }
    if (!LOCAL_HOSTS.test(host) || host !== req.headers.host) throw new HttpError(403, "Запрос не со страницы офиса");
  }
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Нужен JSON");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "Слишком большой запрос");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Неверный JSON");
  }
}

function stream(req: IncomingMessage, res: ServerResponse, deps: AppDeps, after: number) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  const unsubscribe = deps.bus.subscribe(after, (e) => {
    // id: — браузер сам пришлёт Last-Event-ID при переподключении.
    res.write(`id: ${e.seq}\nevent: office\ndata: ${JSON.stringify(e)}\n\n`);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), deps.keepAliveMs ?? 15000);
  ping.unref?.();
  const stop = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on("close", stop);
  res.on("error", stop);
}

async function approve(deps: AppDeps, id: string, decision: "approve" | "reject") {
  const { store } = deps;
  const a = store.listApprovals().find((x) => x.id === id);
  if (!a) throw new HttpError(404, "Нет такого предложения");
  if (a.status !== "pending") throw new HttpError(409, "Это предложение уже решено");
  // Запрос из Claude Code (у него есть сеанс) решается только там: иначе «Одобрить» здесь
  // и «да» в терминале выполнили бы одно изменение в WB дважды.
  if (a.sessionId !== null || !deps.executeApproval)
    throw new HttpError(409, "Решение по этому изменению принимается в Claude Code — ответьте там «да» или «нет»");

  if (decision === "reject") {
    const r = store.resolveApproval(id, "rejected");
    store.setAgentStatus(a.agentId, "idle");
    store.addEvent({ kind: "approval_resolved", agentId: a.agentId, message: `Отклонено: ${a.title}` });
    return r;
  }
  // Сначала «одобрено» в базе (условно, из pending) — второй клик сюда уже не пройдёт.
  if (!store.resolveApproval(id, "approved")) throw new HttpError(409, "Это предложение уже решено");
  store.setAgentStatus(a.agentId, "working", `выполняю: ${a.title.toLowerCase()}`);
  try {
    const result = await deps.executeApproval(a);
    store.setAgentStatus(a.agentId, "idle");
    store.addEvent({ kind: "approval_resolved", agentId: a.agentId, message: `Сделано в кабинете WB: ${a.title}. ${result}`.trim() });
    return store.resolveApproval(id, "done");
  } catch (err) {
    store.setAgentStatus(a.agentId, "error", "WB не принял изменение");
    store.addEvent({ kind: "agent_error", agentId: a.agentId, message: `Не получилось: ${a.title}. ${err instanceof Error ? err.message : err}` });
    return store.resolveApproval(id, "failed");
  }
}

export function handle(deps: AppDeps) {
  const webDir = deps.webDir ?? WEB_DIR;
  const reportsDir = deps.reportsDir ?? REPORTS_DIR;
  const mode = deps.mode ?? "claude_code";

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    try {
      checkHost(req);

      if (req.method === "POST") {
        checkWrite(req);
        if (p === "/api/sync") {
          if (!deps.startSync) throw new HttpError(409, "Синхронизация недоступна");
          deps.startSync();
          return sendJson(res, 202, { ok: true });
        }
        const m = /^\/api\/approvals\/([0-9a-f-]{36})\/(approve|reject)$/.exec(p);
        if (m) return sendJson(res, 200, await approve(deps, m[1]!, m[2] as "approve" | "reject"));
        if (p === "/api/tasks") {
          const body = await readJson(req);
          const agentId = String(body.agentId ?? "");
          const question = String(body.question ?? "").trim().slice(0, 2000);
          if (!deps.store.getAgent(agentId)) throw new HttpError(400, "Нет такого сотрудника");
          if (!question) throw new HttpError(400, "Пустой вопрос");
          if (!deps.runner) {
            throw new HttpError(409, "Задать вопрос из офиса можно с ключом Claude API. Сейчас спросите в Claude Code — офис покажет, как сотрудник работает.");
          }
          const task = deps.store.createTask({ agentId, question, source: "office" });
          // Не ждём: ответ придёт событиями в ленту.
          void deps.runner.run({ agentId, question, taskId: task.id }).catch((err) => {
            deps.store.updateTask(task.id, { status: "failed" });
            deps.store.setAgentStatus(agentId, "error", "не получилось выполнить задачу");
            deps.store.addEvent({ kind: "agent_error", agentId, taskId: task.id, message: `Ошибка: ${err instanceof Error ? err.message : err}` });
          });
          return sendJson(res, 202, task);
        }
        throw new HttpError(404, "Нет такого адреса");
      }

      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Метод не поддерживается");

      if (p === "/api/health") return sendJson(res, 200, { ok: true, agents: deps.store.listAgents().length });
      if (p === "/api/mode")
        return sendJson(res, 200, { mode, demo: Boolean(deps.demo), canApprove: Boolean(deps.executeApproval), canAsk: Boolean(deps.runner) });
      if (p === "/api/agents") return sendJson(res, 200, deps.store.listAgents());
      if (p === "/api/events") {
        const after = url.searchParams.get("after");
        const limit = Math.min(intParam(url.searchParams.get("limit"), 50), 500);
        return sendJson(res, 200, after === null ? deps.store.recentEvents(limit) : deps.store.listEvents(intParam(after, 0), limit));
      }
      if (p === "/api/stream") {
        const lastId = req.headers["last-event-id"];
        const after = intParam(typeof lastId === "string" ? lastId : url.searchParams.get("after"), 0);
        return stream(req, res, deps, after);
      }
      if (p === "/api/tasks") {
        const status = (url.searchParams.get("status") ?? undefined) as TaskStatus | undefined;
        return sendJson(res, 200, deps.store.listTasks({ status }));
      }
      if (p === "/api/approvals") {
        const status = (url.searchParams.get("status") ?? undefined) as ApprovalStatus | undefined;
        return sendJson(res, 200, deps.store.listApprovals({ status }));
      }
      if (p === "/api/reports") return sendJson(res, 200, deps.store.listReports(Math.min(intParam(url.searchParams.get("limit"), 50), 500)));
      if (p === "/api/snapshot") {
        const s = deps.store.latestSnapshot();
        return sendJson(res, 200, s ?? null);
      }
      // Только статус: есть ли ключ и какой длины. Сам ключ наружу не уходит никогда.
      if (p === "/api/keys") return sendJson(res, 200, deps.secrets.status());
      if (p.startsWith("/api/")) throw new HttpError(404, "Нет такого адреса");

      // Отчёты Claude Code: reports/… (Excel — скачиванием).
      if (p.startsWith("/reports/")) {
        const file = safeJoin(reportsDir, p.slice("/reports/".length));
        return sendFile(res, file, { download: file?.endsWith(".xlsx"), sandbox: true });
      }
      // three.js из node_modules — без сборки фронта и без интернета.
      if (p.startsWith("/vendor/three/")) return sendFile(res, safeJoin(THREE_DIR, p.slice("/vendor/three/".length)));

      return sendFile(res, safeJoin(webDir, p === "/" ? "index.html" : p.slice(1)));
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: "Ошибка сервера офиса" });
    }
  };
}

export function createApp(deps: AppDeps): Server {
  const h = handle(deps);
  return createServer((req, res) => void h(req, res));
}
