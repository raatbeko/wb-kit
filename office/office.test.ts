import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEventBus } from "./bus/local-bus.js";
import { STAFF } from "./core/staff.js";
import type { OfficeEvent } from "./core/types.js";
import { listMigrations, openDb } from "./db/sqlite.js";
import { EnvSecretStore } from "./secrets/env-secrets.js";
import { createApp } from "./server/app.js";
import { SqliteOfficeStore } from "./store/sqlite-store.js";

const stores: SqliteOfficeStore[] = [];
function memStore() {
  const s = new SqliteOfficeStore(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

describe("база офиса", () => {
  it("миграции применяются, версия записывается, повторный запуск ничего не ломает", () => {
    const dir = mkdtempSync(join(tmpdir(), "office-db-"));
    const file = join(dir, "office.db");
    const db = openDb(file);
    const last = listMigrations().at(-1)!.version;
    expect(db.pragma("user_version", { simple: true })).toBe(last);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
    const again = openDb(file);
    expect(again.pragma("user_version", { simple: true })).toBe(last);
    again.close();
  });

  it("во всех таблицах есть workspace_id — для переезда в Supabase", () => {
    const s = memStore();
    const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
    for (const { name } of tables) {
      const cols = (s.db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols, name).toContain("workspace_id");
    }
  });
});

describe("сотрудники", () => {
  it("штат заносится один раз, статус переживает повторный запуск", () => {
    const s = memStore();
    s.ensureAgents(STAFF);
    s.setAgentStatus("logist", "working", "смотрю остатки");
    s.ensureAgents(STAFF);
    expect(s.listAgents().map((a) => a.id)).toEqual(STAFF.map((a) => a.id));
    expect(s.getAgent("logist")).toMatchObject({ status: "working", activity: "смотрю остатки", workspaceId: "local" });
  });

  it("id сотрудников уникальны, роли из .claude/agents есть в штате", () => {
    const ids = STAFF.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const role of ["analyst", "logist", "reviews", "marketer", "scout", "content"]) expect(ids).toContain(role);
  });
});

describe("события, задачи, одобрения, отчёты", () => {
  it("события идут по номеру, «после N» отдаёт только новые", () => {
    const s = memStore();
    const a = s.addEvent({ kind: "agent_started", agentId: "analyst", message: "начал" });
    const b = s.addEvent({ kind: "agent_step", agentId: "analyst", message: "шаг", data: { tool: "get_sales_summary" } });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(s.listEvents(a.seq)).toEqual([b]);
    expect(s.recentEvents(1)).toEqual([b]);
    expect(b.data).toEqual({ tool: "get_sales_summary" });
  });

  it("задача: создаётся в очереди, обновляется, фильтруется", () => {
    const s = memStore();
    const t = s.createTask({ agentId: "logist", question: "что с остатками?", source: "office" });
    expect(t.status).toBe("queued");
    expect(s.updateTask(t.id, { status: "done" })?.status).toBe("done");
    expect(s.listTasks({ status: "done" })).toHaveLength(1);
    expect(s.listTasks({ status: "queued" })).toHaveLength(0);
  });

  it("одобрение нельзя выполнить дважды и нельзя выполнить без «да»", () => {
    const s = memStore();
    const a = s.createApproval({
      agentId: "finance",
      taskId: null,
      tool: "update_prices",
      title: "Поднять цену",
      changes: [{ item: "Кружка 123", before: "490 ₽", after: "590 ₽" }],
      args: { prices: [{ nmID: 123, price: 590 }] },
    });
    expect(s.resolveApproval(a.id, "approved")?.status).toBe("approved");
    expect(s.resolveApproval(a.id, "approved")).toBeUndefined(); // второй клик «Одобрить» — нет
    expect(s.resolveApproval(a.id, "rejected")).toBeUndefined(); // уже решено
    expect(s.resolveApproval(a.id, "done")?.status).toBe("done");
    expect(s.resolveApproval(a.id, "done")).toBeUndefined(); // второй раз — нет
    expect(s.listApprovals()[0]!.changes[0]!.after).toBe("590 ₽");
    // Отклонённое нельзя выполнить.
    const b = s.createApproval({ agentId: "finance", taskId: null, tool: "update_prices", title: "x", changes: [], args: {} });
    s.resolveApproval(b.id, "rejected");
    expect(s.resolveApproval(b.id, "done")).toBeUndefined();
    expect(s.resolveApproval(b.id, "approved")).toBeUndefined();
  });

  it("отчёт с тем же путём второй раз не заносится", () => {
    const s = memStore();
    s.addReport({ kind: "audit", title: "Аудит", path: "reports/audit-2026-11-19", summary: { revenue: 1 }, agentId: null });
    expect(s.findReportByPath("reports/audit-2026-11-19")?.summary).toEqual({ revenue: 1 });
    expect(() =>
      s.addReport({ kind: "audit", title: "Аудит", path: "reports/audit-2026-11-19", summary: null, agentId: null }),
    ).toThrow();
  });

  it("настройки хранят любые JSON-значения", () => {
    const s = memStore();
    s.setSetting("cost", { 123: 150 });
    s.setSetting("cost", { 123: 160 });
    expect(s.getSetting("cost")).toEqual({ 123: 160 });
    expect(s.getSetting("нет")).toBeUndefined();
  });
});

describe("живые события", () => {
  it("подписчик получает события, записанные другим подключением к той же базе (как хук Claude Code)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "office-bus-")), "office.db");
    const server = new SqliteOfficeStore(file);
    const hook = new SqliteOfficeStore(file);
    stores.push(server, hook);
    const got: OfficeEvent[] = [];
    const off = new LocalEventBus(server, 20).subscribe(0, (e) => got.push(e));
    hook.addEvent({ kind: "agent_started", agentId: "reviews", message: "читаю отзывы" });
    for (let t = 0; t < 100 && !got.length; t++) await new Promise((r) => setTimeout(r, 20));
    off();
    expect(got.map((e) => e.message)).toEqual(["читаю отзывы"]);
  });
});

describe("ключи", () => {
  it("записываются в .env, наружу — только статус без значения", () => {
    const file = join(mkdtempSync(join(tmpdir(), "office-env-")), ".env");
    writeFileSync(file, "﻿WB_API_TOKEN=\nMPSTATS_TOKEN=your_token\n");
    const secrets = new EnvSecretStore(file);
    expect(secrets.get("WB_API_TOKEN")).toBeUndefined();
    expect(secrets.get("MPSTATS_TOKEN")).toBeUndefined(); // шаблон — не ключ
    secrets.set("WB_API_TOKEN", "abc123");
    expect(secrets.get("WB_API_TOKEN")).toBe("abc123");
    expect(readFileSync(file, "utf8")).toContain("MPSTATS_TOKEN=your_token");
    const status = secrets.status();
    expect(status.find((s) => s.name === "WB_API_TOKEN")).toEqual({ name: "WB_API_TOKEN", present: true, length: 6 });
    expect(JSON.stringify(status)).not.toContain("abc123");
    expect(() => secrets.set("WB_API_TOKEN", "a b")).toThrow();
  });
});

describe("сервер офиса", () => {
  async function start() {
    const store = memStore();
    store.ensureAgents(STAFF);
    const file = join(mkdtempSync(join(tmpdir(), "office-srv-")), ".env");
    writeFileSync(file, "WB_API_TOKEN=secret-value\n");
    const app = createApp({ store, bus: new LocalEventBus(store, 20), secrets: new EnvSecretStore(file), keepAliveMs: 50 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    return { store, base, close: () => new Promise((r) => app.close(r)) };
  }

  it("отдаёт сотрудников, события и статус ключей без самого ключа", async () => {
    const { store, base, close } = await start();
    try {
      store.addEvent({ kind: "note", message: "привет" });
      expect(await (await fetch(`${base}/api/agents`)).json()).toHaveLength(STAFF.length);
      expect(((await (await fetch(`${base}/api/events`)).json()) as OfficeEvent[]).map((e) => e.message)).toEqual(["привет"]);
      const keys = await (await fetch(`${base}/api/keys`)).text();
      expect(keys).toContain('"present":true');
      expect(keys).not.toContain("secret-value");
      expect((await fetch(`${base}/api/nope`)).status).toBe(404);
      expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
    } finally {
      await close();
    }
  });

  it("не отдаёт файлы вне папки фронта", async () => {
    const { base, close } = await start();
    try {
      for (const p of ["/../../.env", "/%2e%2e/%2e%2e/.env", "/..%5c..%5c.env"]) {
        const res = await fetch(base + p);
        expect(await res.text(), p).not.toContain("WB_API_TOKEN");
      }
    } finally {
      await close();
    }
  });

  it("поток событий присылает новые события", async () => {
    const { store, base, close } = await start();
    const ctrl = new AbortController();
    try {
      const res = await fetch(`${base}/api/stream?after=0`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      store.addEvent({ kind: "agent_started", agentId: "logist", message: "смотрю остатки" });
      let text = "";
      const until = Date.now() + 2000;
      while (!text.includes("смотрю остатки") && Date.now() < until) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain("event: office");
      expect(text).toContain("смотрю остатки");
    } finally {
      ctrl.abort();
      await close();
    }
  });
});
