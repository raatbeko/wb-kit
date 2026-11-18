/**
 * HTTP-API офиса. Фронт знает только эти адреса (`/api/...`), поэтому тот же
 * фронт потом работает и в облаке — меняются реализации переходников.
 *
 * Без фреймворка: маршрутов мало, а лишняя зависимость — лишнее, что может
 * не поставиться у клиента.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus, OfficeStore, SecretStore } from "../core/ports.js";
import type { ApprovalStatus, TaskStatus } from "../core/types.js";

export const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

export interface AppDeps {
  store: OfficeStore;
  secrets: SecretStore;
  bus: EventBus;
  webDir?: string;
  /** Как часто слать пустой комментарий в SSE, чтобы соединение не закрылось. */
  keepAliveMs?: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".glb": "model/gltf-binary",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": TYPES[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function intParam(v: string | null, def: number): number {
  // Number(null) и Number("") — это 0, а не «не задано».
  if (v === null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

function serveStatic(res: ServerResponse, webDir: string, pathname: string) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = normalize(join(webDir, rel));
  // Только файлы внутри папки фронта: «../.env» и подобное не отдаём.
  if (!file.startsWith(normalize(webDir.endsWith(sep) ? webDir : webDir + sep)) || !existsSync(file)) {
    sendJson(res, 404, { error: "Не найдено" });
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

function stream(req: IncomingMessage, res: ServerResponse, deps: AppDeps, after: number) {
  res.writeHead(200, {
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
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

export function handle(deps: AppDeps) {
  const webDir = deps.webDir ?? WEB_DIR;
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    try {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Пока только чтение" });

      if (p === "/api/health") return sendJson(res, 200, { ok: true, agents: deps.store.listAgents().length });
      if (p === "/api/agents") return sendJson(res, 200, deps.store.listAgents());
      if (p === "/api/events") {
        const after = url.searchParams.get("after");
        const limit = intParam(url.searchParams.get("limit"), 50);
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
      if (p === "/api/reports") return sendJson(res, 200, deps.store.listReports(intParam(url.searchParams.get("limit"), 50)));
      // Только статус: есть ли ключ и какой длины. Сам ключ наружу не уходит никогда.
      if (p === "/api/keys") return sendJson(res, 200, deps.secrets.status());
      if (p.startsWith("/api/")) return sendJson(res, 404, { error: "Нет такого адреса" });

      return serveStatic(res, webDir, p);
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: "Ошибка сервера офиса" });
    }
  };
}

export function createApp(deps: AppDeps): Server {
  return createServer(handle(deps));
}
