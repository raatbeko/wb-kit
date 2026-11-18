import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../mcp/wb/src/env.js";
import { createExecutor } from "./agents/execute.js";
import { SdkAgentRunner, makeCanUseTool, readRole, type SdkLike } from "./agents/sdk-runner.js";
import { LocalEventBus } from "./bus/local-bus.js";
import { STAFF } from "./core/staff.js";
import { buildScenario, startDemo } from "./demo/simulator.js";
import { EnvSecretStore } from "./secrets/env-secrets.js";
import { createApp, safeJoin, type AppDeps } from "./server/app.js";
import { SqliteOfficeStore } from "./store/sqlite-store.js";
import { scanReports } from "./sync/reports-scan.js";
import { ISSUE_OWNER } from "./sync/snapshot.js";
import { isStale, syncWb } from "./sync/sync.js";

const stores: SqliteOfficeStore[] = [];
function office() {
  const s = new SqliteOfficeStore(":memory:");
  s.ensureAgents(STAFF);
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
function secretsWith(content: string) {
  const f = join(tmp("office-env-"), ".env");
  writeFileSync(f, content);
  return new EnvSecretStore(f);
}

describe("этап 3: данные WB в офисе", () => {
  it("демо-синхронизация кладёт снимок: KPI, проблемы с ответственными, цифры на столах", async () => {
    const s = office();
    const r = await syncWb(s, secretsWith(""), { demo: true });
    expect(r.ok).toBe(true);
    const snap = s.latestSnapshot()!.snapshot;
    expect(snap.demo).toBe(true);
    expect(snap.kpis.length).toBeGreaterThan(3);
    expect(snap.issues.length).toBeGreaterThan(3);
    // В демо-магазине заложены проблемы — каждая у своего сотрудника.
    for (const i of snap.issues) expect(STAFF.map((a) => a.id), i.id).toContain(i.owner);
    expect(snap.issues.some((i) => i.owner === "logist")).toBe(true);
    for (const a of STAFF) expect(snap.desks[a.id], a.id).toBeDefined();
    expect(s.recentEvents().at(-1)?.kind).toBe("sync_finished");
    expect(s.getAgent("analyst")?.status).toBe("idle");
  }, 60000);

  it("без ключа WB синхронизация честно говорит почему", async () => {
    const s = office();
    const r = await syncWb(s, secretsWith(""), {});
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("Ключ WB") });
    expect(s.latestSnapshot()).toBeUndefined();
  });

  it("у каждой проблемы аудита есть ответственный в штате", () => {
    for (const owner of Object.values(ISSUE_OWNER)) expect(STAFF.map((a) => a.id)).toContain(owner);
  });

  it("isStale", () => {
    expect(isStale(undefined, 6)).toBe(true);
    expect(isStale(new Date().toISOString(), 6)).toBe(false);
    expect(isStale(new Date(Date.now() - 7 * 3600_000).toISOString(), 6)).toBe(true);
  });

  it("отчёты из reports/ заносятся один раз, недописанные — пропускаются", () => {
    const s = office();
    const dir = tmp("office-reports-");
    mkdirSync(join(dir, "audit-2026-11-19"));
    writeFileSync(join(dir, "audit-2026-11-19", "Аудит WB 2026-11-19.html"), "<html>");
    writeFileSync(join(dir, "audit-2026-11-19", "summary.json"), JSON.stringify({ issues: [{ priority: "high" }, { priority: "low" }], kpis: [] }));
    mkdirSync(join(dir, "office-2026-11-18-demo"));
    writeFileSync(join(dir, "office-2026-11-18-demo", "план.md"), "# план"); // HTML ещё нет — отчёт пишется
    mkdirSync(join(dir, "competitors-2026-11-19")); // пусто — ещё пишется
    mkdirSync(join(dir, "чужая папка"));
    expect(scanReports(s, dir)).toBe(1);
    expect(scanReports(s, dir)).toBe(0);
    const audit = s.listReports().find((r) => r.kind === "audit")!;
    expect(audit).toMatchObject({ title: "Аудит магазина — 19.11.2026", agentId: "analyst", summary: { issues: 2, high: 1 } });
    // /office дописал HTML — появляется одна запись, не три.
    writeFileSync(join(dir, "office-2026-11-18-demo", "Офис.html"), "<html>");
    expect(scanReports(s, dir)).toBe(1);
    expect(s.listReports().filter((r) => r.kind === "office")).toHaveLength(1);
    expect(s.listReports().find((r) => r.kind === "office")?.title).toContain("(демо)");
  });

  it("выжимка, дописанная после HTML, подтягивается в ту же запись", () => {
    const s = office();
    const dir = tmp("office-reports-");
    mkdirSync(join(dir, "audit-2026-11-20"));
    writeFileSync(join(dir, "audit-2026-11-20", "a.html"), "<html>");
    expect(scanReports(s, dir)).toBe(1);
    expect(s.listReports()[0]?.summary).toBeNull();
    writeFileSync(join(dir, "audit-2026-11-20", "summary.json"), JSON.stringify({ issues: [{ priority: "high" }] }));
    expect(scanReports(s, dir)).toBe(0);
    expect(s.listReports()).toHaveLength(1);
    expect(s.listReports()[0]?.summary).toMatchObject({ issues: 1, high: 1 });
  });
});

describe("этап 8: демо-офис", () => {
  it("сценарий опирается на проблемы демо-магазина и проходит по всем сотрудникам", async () => {
    const s = office();
    await syncWb(s, secretsWith(""), { demo: true });
    const beats = buildScenario(s.latestSnapshot()!.snapshot);
    expect(new Set(beats.map((b) => b.agent))).toEqual(new Set(STAFF.map((a) => a.id)));
    expect(beats.find((b) => b.agent === "logist")!.done).toMatch(/закончился|кончится/);
  }, 60000);

  it("симулятор оживляет офис и не копит одобрения", async () => {
    const s = office();
    const stop = startDemo(s, () => undefined, 5);
    // Ждём по условию, а не фиксированное время: под нагрузкой таймеры запаздывают.
    for (let t = 0; t < 100 && s.recentEvents(500).length <= 20; t++) await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(s.recentEvents(500).length).toBeGreaterThan(20);
    expect(s.listApprovals({ status: "pending" }).length).toBeLessThanOrEqual(2);
  });
});

describe("сервер: защита и одобрения", () => {
  async function start(extra: Partial<AppDeps> = {}) {
    const store = office();
    const app = createApp({ store, bus: new LocalEventBus(store, 20), secrets: secretsWith("WB_API_TOKEN=x\n"), keepAliveMs: 50, ...extra });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const port = (app.address() as AddressInfo).port;
    const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        });
        req.on("error", reject);
        req.end(body);
      });
    return { store, port, call, close: () => new Promise((r) => app.close(r)) };
  }
  const json = { "content-type": "application/json" };

  it("чужой Host (DNS rebinding) — 403", async () => {
    const { call, close } = await start();
    try {
      expect((await call("GET", "/api/agents", { host: "evil.example" })).status).toBe(403);
      expect((await call("GET", "/api/agents")).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("POST с чужого сайта или не JSON — отказ", async () => {
    const { call, port, close } = await start({ startSync: () => {} });
    try {
      expect((await call("POST", "/api/sync", { ...json, origin: "https://evil.example" })).status).toBe(403);
      expect((await call("POST", "/api/sync", { "content-type": "text/plain", origin: `http://localhost:${port}` })).status).toBe(415);
      expect((await call("POST", "/api/sync", { ...json, origin: `http://localhost:${port}` })).status).toBe(202);
    } finally {
      await close();
    }
  });

  it("битый %-код в адресе — не 500", async () => {
    const { call, close } = await start();
    try {
      expect((await call("GET", "/%E0%A4%A")).status).toBe(404);
      expect(safeJoin("/a", "../b")).toBeNull();
    } finally {
      await close();
    }
  });

  it("в режиме «окна» одобрять в офисе нельзя — подсказка про Claude Code", async () => {
    const { store, call, close } = await start();
    try {
      const a = store.createApproval({ agentId: "finance", taskId: null, tool: "update_prices", title: "x", changes: [], args: {} });
      const r = await call("POST", `/api/approvals/${a.id}/approve`, json, "{}");
      expect(r.status).toBe(409);
      expect(r.body).toContain("Claude Code");
      expect(store.listApprovals({ status: "pending" })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("одобрение в демо выполняется один раз, второй клик — 409", async () => {
    let calls = 0;
    const exec = createExecutor(secretsWith(""), { demo: true });
    const { store, call, close } = await start({ demo: true, executeApproval: async (a) => (calls++, exec(a)) });
    try {
      const a = store.createApproval({ agentId: "reviews", taskId: null, tool: "reply_feedback", title: "Ответ", changes: [], args: { id: "f1", text: "Спасибо!" } });
      expect((await call("POST", `/api/approvals/${a.id}/approve`, json, "{}")).status).toBe(200);
      expect((await call("POST", `/api/approvals/${a.id}/approve`, json, "{}")).status).toBe(409);
      expect(calls).toBe(1);
      expect(store.listApprovals({ status: "done" })).toHaveLength(1);
      const b = store.createApproval({ agentId: "reviews", taskId: null, tool: "reply_feedback", title: "Ответ 2", changes: [], args: { id: "f2", text: "Спасибо!" } });
      expect((await call("POST", `/api/approvals/${b.id}/reject`, json, "{}")).status).toBe(200);
      expect(store.listApprovals({ status: "rejected" })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("через одобрение нельзя вызвать инструмент чтения, чужой или с неверными аргументами", async () => {
    const exec = createExecutor(secretsWith(""), { demo: true });
    await expect(exec({ tool: "get_prices", args: {} } as never)).rejects.toThrow();
    await expect(exec({ tool: "rm -rf", args: {} } as never)).rejects.toThrow();
    await expect(exec({ tool: "update_prices", args: { data: [{ nmID: 1, price: 0 }] } } as never)).rejects.toThrow(/Аргументы/);
    await expect(exec({ tool: "update_prices", args: { prices: [{ nmID: 1, price: 590 }] } } as never)).resolves.toContain("демо");
  });

  it("запрос из Claude Code нельзя одобрить в офисе — только в терминале (иначе изменение уйдёт дважды)", async () => {
    let calls = 0;
    const { store, call, close } = await start({ executeApproval: async () => (calls++, "") });
    try {
      const a = store.createApproval({ agentId: "finance", taskId: null, tool: "update_prices", title: "x", changes: [], args: {}, sessionId: "S1" });
      const r = await call("POST", `/api/approvals/${a.id}/approve`, json, "{}");
      expect(r.status).toBe(409);
      expect(calls).toBe(0);
    } finally {
      await close();
    }
  });

  it("офис нельзя встроить во фрейм, отчёты — в песочнице", async () => {
    const dir = tmp("office-rep-");
    mkdirSync(join(dir, "audit-2026-11-19"));
    writeFileSync(join(dir, "audit-2026-11-19", "a.html"), "<script>fetch('/api/approvals')</script>");
    const { port, close } = await start({ reportsDir: dir });
    try {
      const head = (path: string) =>
        new Promise<Record<string, unknown>>((resolve) =>
          request({ host: "127.0.0.1", port, path, headers: { host: `localhost:${port}` } }, (res) => {
            res.resume();
            resolve(res.headers);
          }).end(),
        );
      const page = await head("/");
      expect(page["x-frame-options"]).toBe("DENY");
      expect(String(page["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(String((await head("/reports/audit-2026-11-19/a.html"))["content-security-policy"])).toMatch(/^sandbox/);
    } finally {
      await close();
    }
  });

  it("вопрос из офиса без ключа Claude API — 409 с подсказкой", async () => {
    const { call, close } = await start();
    try {
      const r = await call("POST", "/api/tasks", json, JSON.stringify({ agentId: "logist", question: "что с остатками?" }));
      expect(r.status).toBe(409);
      expect((await call("POST", "/api/tasks", json, JSON.stringify({ agentId: "nobody", question: "x" }))).status).toBe(400);
    } finally {
      await close();
    }
  });

  it("отдаёт отчёты из reports/, но не выше", async () => {
    const dir = tmp("office-rep-");
    mkdirSync(join(dir, "audit-2026-11-19"));
    writeFileSync(join(dir, "audit-2026-11-19", "a.html"), "<h1>отчёт</h1>");
    const { call, close } = await start({ reportsDir: dir });
    try {
      expect((await call("GET", "/reports/audit-2026-11-19/a.html")).body).toContain("отчёт");
      expect((await call("GET", "/reports/..%2f..%2fpackage.json")).status).toBe(404);
      expect((await call("GET", "/vendor/three/build/three.module.js")).status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe("этап 7: сотрудник через Agent SDK (SDK подменён)", () => {
  function fakeSdk(result: string, onOptions?: (o: Record<string, unknown>) => void, propose = false): SdkLike {
    const tools: { name: string; handler: (a: never) => Promise<unknown> }[] = [];
    return {
      tool: (name, _d, _s, handler) => {
        const t = { name, handler };
        tools.push(t);
        return t;
      },
      createSdkMcpServer: (a) => a,
      query: ({ options }) => {
        onOptions?.(options);
        return (async function* () {
          if (propose)
            await tools[0]!.handler({ tool: "update_prices", args: { prices: [{ nmID: 1, price: 1590 }] }, title: "Поднять цену", changes: [{ item: "Плед", before: "1490", after: "1590" }] } as never);
          yield { type: "result", subtype: "success", result };
        })();
      },
    };
  }

  it("роль читается из .claude/agents, инструменты записи запрещены, задача и ответ — в базе", async () => {
    const s = office();
    let opts: Record<string, unknown> = {};
    const runner = new SdkAgentRunner({ store: s, secrets: secretsWith("ANTHROPIC_API_KEY=sk-test\n"), sdk: fakeSdk("Кружка кончится через 6 дней", (o) => (opts = o)) });
    const task = s.createTask({ agentId: "logist", question: "что с остатками?", source: "office" });
    await runner.run({ agentId: "logist", question: "что с остатками?", taskId: task.id });

    expect(s.listTasks()[0]).toMatchObject({ status: "done" });
    expect(s.listReports()[0]?.summary).toEqual({ text: "Кружка кончится через 6 дней" });
    expect(s.getAgent("logist")?.status).toBe("idle");
    expect((opts.disallowedTools as string[])).toContain("mcp__wb__update_prices");
    expect((opts.env as Record<string, string>).OFFICE_AGENT).toBe("logist");
    expect((opts.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-test");
    const canUse = opts.canUseTool as (n: string) => Promise<{ behavior: string }>;
    expect((await canUse("mcp__wb__get_wb_stocks")).behavior).toBe("allow");
    expect((await canUse("mcp__wb__update_prices")).behavior).toBe("deny");
    expect((await canUse("Bash")).behavior).toBe("deny");
  });

  it("предложение изменения становится одобрением, сотрудник ждёт решения", async () => {
    const s = office();
    const runner = new SdkAgentRunner({ store: s, secrets: secretsWith("ANTHROPIC_API_KEY=sk-test\n"), sdk: fakeSdk("Предложил поднять цену", undefined, true) });
    const task = s.createTask({ agentId: "finance", question: "что в минусе?", source: "office" });
    await runner.run({ agentId: "finance", question: "что в минусе?", taskId: task.id });
    expect(s.listApprovals({ status: "pending" })).toMatchObject([{ agentId: "finance", tool: "update_prices", taskId: task.id, changes: [{ after: "1590" }] }]);
    expect(s.getAgent("finance")?.status).toBe("waiting");
  });

  it("неверные аргументы предложения возвращаются модели, а не попадают в офис", async () => {
    const s = office();
    const tools: { handler: (a: never) => Promise<{ isError?: boolean }> }[] = [];
    const sdk: SdkLike = {
      tool: (_n, _d, _s, handler) => (tools.push({ handler: handler as never }), {}),
      createSdkMcpServer: (a) => a,
      query: () =>
        (async function* () {
          const r = await tools[0]!.handler({ tool: "update_prices", args: { data: [] }, title: "x", changes: [] } as never);
          expect(r.isError).toBe(true);
          yield { type: "result", subtype: "success", result: "ok" };
        })(),
    };
    const task = s.createTask({ agentId: "finance", question: "x", source: "office" });
    await new SdkAgentRunner({ store: s, secrets: secretsWith("ANTHROPIC_API_KEY=k\n"), sdk }).run({ agentId: "finance", question: "x", taskId: task.id });
    expect(s.listApprovals()).toHaveLength(0);
  });

  it("сотрудник читает только файлы набора, не .env и не чужие папки", async () => {
    const can = makeCanUseTool(ROOT, ["Read", "Grep", "Glob", "mcp__wb__*"]);
    expect((await can("Read", { file_path: join(ROOT, "reports", "x.md") })).behavior).toBe("allow");
    expect((await can("Read", { file_path: "reports/x.md" })).behavior).toBe("allow");
    expect((await can("Grep", { pattern: "x" })).behavior).toBe("allow");
    expect((await can("Read", { file_path: join(ROOT, ".env") })).behavior).toBe("deny");
    expect((await can("Read", { file_path: join(ROOT, "..", "secret.txt") })).behavior).toBe("deny");
    expect((await can("Glob", { pattern: "*", path: "C:\\Users" })).behavior).toBe("deny");
    expect((await can("Write", { file_path: "reports/x.md" })).behavior).toBe("deny");
    const noRead = makeCanUseTool(ROOT, ["mcp__wb__*"]);
    expect((await noRead("Read", { file_path: "reports/x.md" })).behavior).toBe("deny");
    const allow = await can("mcp__wb__get_prices", { a: 1 });
    expect(allow).toEqual({ behavior: "allow", updatedInput: { a: 1 } });
  });

  it("без ключа Claude API — понятная ошибка", async () => {
    const s = office();
    const runner = new SdkAgentRunner({ store: s, secrets: secretsWith(""), sdk: fakeSdk("") });
    await expect(runner.run({ agentId: "logist", question: "x", taskId: "t" })).rejects.toThrow(/ключа Claude API/);
  });

  it("все роли штата (кроме директора) есть в .claude/agents", () => {
    for (const a of STAFF.filter((a) => a.id !== "director")) expect(readRole(a.id, ROOT), a.id).not.toBeNull();
  });
});

describe("база при одновременном старте", () => {
  it("шесть хуков сразу на новой базе — все события записаны, миграции не падают", async () => {
    const db = join(tmp("office-race-"), "office.db");
    const run = (i: number) =>
      new Promise<number>((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", join(ROOT, "office", "hooks", "event.ts")], { cwd: ROOT, env: { ...process.env, OFFICE_DB: db } });
        p.stdin.end(JSON.stringify({ hook_event_name: "SubagentStart", agent_type: STAFF[i + 1]!.id, session_id: "s" }));
        p.on("exit", (c) => resolve(c ?? 1));
      });
    const codes = await Promise.all([0, 1, 2, 3, 4, 5].map(run));
    expect(codes.every((c) => c === 0)).toBe(true);
    const s = new SqliteOfficeStore(db);
    stores.push(s);
    expect(s.recentEvents(50)).toHaveLength(6);
  }, 60000);
});
