import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../mcp/wb/src/env.js";
import { STAFF } from "../core/staff.js";
import { SqliteOfficeStore } from "../store/sqlite-store.js";
import { describeTool, maskSecrets, short } from "./describe.js";
import { handleHook, type HookInput } from "./handle.js";

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

const base = { session_id: "s1" };
const inRole = (role: string) => ({ ...base, agent_id: "a1", agent_type: role });

describe("хуки → офис", () => {
  it("вопрос директору, роль берёт задачу, смотрит WB и заканчивает", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "UserPromptSubmit", prompt: "что с остатками?" });
    expect(s.getAgent("director")?.status).toBe("working");

    handleHook(s, { ...base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "logist" } });
    handleHook(s, { ...inRole("logist"), hook_event_name: "SubagentStart" });
    handleHook(s, { ...inRole("logist"), hook_event_name: "PreToolUse", tool_name: "mcp__wb__get_wb_stocks", tool_input: {} });
    expect(s.getAgent("logist")).toMatchObject({ status: "working", activity: "смотрю остатки на складах WB" });

    handleHook(s, { ...inRole("logist"), hook_event_name: "SubagentStop", last_assistant_message: "## Остатки\nКружка закончится через 6 дней" });
    expect(s.getAgent("logist")?.status).toBe("idle");

    handleHook(s, { ...base, hook_event_name: "Stop" });
    expect(s.getAgent("director")?.status).toBe("idle");

    expect(s.recentEvents().map((e) => e.message)).toEqual([
      "Новая задача: что с остатками?",
      "Передаю задачу: Логист",
      "Взялся за задачу",
      "Смотрю остатки на складах WB",
      "Готово: Остатки",
      "Ответ готов — смотрите в Claude Code",
    ]);
  });

  it("чтение файлов меняет подпись, но не засоряет ленту", () => {
    const s = office();
    handleHook(s, { ...inRole("analyst"), hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "reports/x" } });
    expect(s.getAgent("analyst")?.activity).toBe("читаю отчёты");
    expect(s.recentEvents()).toHaveLength(0);
  });

  it("неизвестная роль клиента считается директором, а не ломает хук", () => {
    const s = office();
    handleHook(s, { ...inRole("my-custom-role"), hook_event_name: "SubagentStart" });
    expect(s.getAgent("director")?.status).toBe("working");
    handleHook(s, { ...inRole("plugin:logist"), hook_event_name: "SubagentStart" });
    expect(s.getAgent("logist")?.status).toBe("working");
  });

  it("запрос на изменение в кабинете: ждёт «да», после выполнения — сделано", () => {
    const s = office();
    const req: HookInput = { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: { prices: [{ nmID: 1, price: 590 }] } };
    handleHook(s, req);
    expect(s.getAgent("director")?.status).toBe("waiting");
    expect(s.listApprovals({ status: "pending" })).toMatchObject([{ tool: "update_prices", args: { prices: [{ nmID: 1, price: 590 }] } }]);

    handleHook(s, { ...req, hook_event_name: "PostToolUse", tool_response: {} });
    expect(s.listApprovals({ status: "done" })).toHaveLength(1);
    expect(s.getAgent("director")?.status).toBe("working");
  });

  it("отказ человека закрывает одобрение как отклонённое", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__reply_feedback", tool_input: {} });
    handleHook(s, { ...base, hook_event_name: "PermissionDenied", tool_name: "mcp__wb__reply_feedback", tool_input: {} });
    expect(s.listApprovals({ status: "rejected" })).toHaveLength(1);
  });

  it("разрешения на чтение и на команды не попадают в одобрения", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    handleHook(s, { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__get_prices", tool_input: {} });
    expect(s.listApprovals()).toHaveLength(0);
  });

  it("401 от WB — красная лампа и подсказка про /setup", () => {
    const s = office();
    handleHook(s, { ...inRole("analyst"), hook_event_name: "PostToolUseFailure", tool_name: "mcp__wb__get_sales_summary", error: "HTTP 401 Unauthorized" });
    expect(s.getAgent("analyst")?.status).toBe("error");
    expect(s.recentEvents()[0]?.kind).toBe("agent_error");
  });

  it("новый запуск Claude Code сбрасывает зависшие статусы и старые ожидания", () => {
    const s = office();
    s.setAgentStatus("logist", "working", "x");
    handleHook(s, { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: {} });
    handleHook(s, { ...base, hook_event_name: "SessionStart", source: "startup" });
    expect(s.listAgents().every((a) => a.status === "idle")).toBe(true);
    expect(s.listApprovals({ status: "pending" })).toHaveLength(0);
  });

  it("ключ в тексте вопроса не попадает в ленту", () => {
    const s = office();
    const key = "eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjUwOTA0djEiLCJ0eXAiOiJKV1QifQ.abc";
    handleHook(s, { ...base, hook_event_name: "UserPromptSubmit", prompt: `вот мой ключ ${key}` });
    expect(JSON.stringify(s.recentEvents())).not.toContain(key);
  });

  it("неизвестное событие ничего не делает", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "PreCompact" });
    expect(s.recentEvents()).toHaveLength(0);
  });
});

describe("подписи", () => {
  it("инструменты WB, команды набора и прочее", () => {
    expect(describeTool("mcp__wb__get_wb_stocks")).toEqual({ text: "смотрю остатки на складах WB", important: true });
    expect(describeTool("mcp__wb__new_method").text).toBe("запрос к WB: new_method");
    expect(describeTool("Bash", { command: "npm run audit -- --demo" }).text).toBe("собираю аудит магазина");
    expect(describeTool("Bash", { command: "ls" }).important).toBe(false);
  });

  it("у каждого инструмента записи есть подпись", () => {
    const tools = readFileSync(join(ROOT, "mcp", "wb", "src", "tools.ts"), "utf8");
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    for (const t of settings.permissions.ask as string[]) {
      const name = t.replace("mcp__wb__", "");
      expect(tools, name).toContain(name);
      expect(describeTool(t).text, t).not.toMatch(/^запрос к WB/);
    }
  });

  it("short и maskSecrets", () => {
    expect(short("\n\n## **Итог**\nвторая строка")).toBe("Итог");
    expect(short("а".repeat(300)).length).toBe(160);
    expect(maskSecrets("ключ " + "x".repeat(40))).toBe("ключ •••");
  });
});

describe("подключение хуков", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));

  it("все нужные события подключены, хуки асинхронные и ведут на существующий скрипт", () => {
    for (const e of ["SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"]) {
      const hooks = settings.hooks?.[e]?.flatMap((m: { hooks: unknown[] }) => m.hooks) ?? [];
      expect(hooks.length, e).toBeGreaterThan(0);
      for (const h of hooks as { command: string; async: boolean }[]) {
        // async: Claude Code не ждёт хук, офис не замедляет работу.
        expect(h.async, e).toBe(true);
        const file = /\$CLAUDE_PROJECT_DIR\/([^"]+)/.exec(h.command)?.[1];
        expect(file && existsSync(join(ROOT, file)), `${e}: ${h.command}`).toBe(true);
      }
    }
  });

  it("скрипт хука пишет событие в базу и молчит в stdout, даже на мусорном вводе", () => {
    const db = join(mkdtempSync(join(tmpdir(), "office-hook-")), "office.db");
    const run = (input: string) =>
      spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "office", "hooks", "event.ts")], {
        cwd: ROOT,
        input,
        env: { ...process.env, OFFICE_DB: db },
        encoding: "utf8",
        timeout: 20000,
      });

    const ok = run(JSON.stringify({ hook_event_name: "SubagentStart", agent_type: "reviews", session_id: "s" }));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("");

    const bad = run("это не JSON");
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");

    const s = new SqliteOfficeStore(db);
    stores.push(s);
    expect(s.getAgent("reviews")?.status).toBe("working");
    expect(readFileSync(join(db, "..", "office-hooks.log"), "utf8")).toContain("JSON");
  }, 30000);
});
