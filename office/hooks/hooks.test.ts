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
      "Готово: Кружка закончится через 6 дней",
      "Ответ готов — смотрите в Claude Code",
    ]);
  });

  it("чтение файлов меняет подпись, но не засоряет ленту", () => {
    const s = office();
    handleHook(s, { ...inRole("analyst"), hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "reports/x" } });
    expect(s.getAgent("analyst")?.activity).toBe("читаю отчёты");
    expect(s.recentEvents()).toHaveLength(0);
  });

  it("встроенные субагенты и свои роли клиента не трогают статус директора", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "UserPromptSubmit", prompt: "x" });
    handleHook(s, { ...inRole("Explore"), hook_event_name: "SubagentStart" });
    handleHook(s, { ...inRole("Explore"), hook_event_name: "SubagentStop", last_assistant_message: "нашёл" });
    expect(s.getAgent("director")?.status).toBe("working");
    expect(s.recentEvents().map((e) => e.message)).toEqual(["Новая задача: x"]);
    handleHook(s, { ...inRole("plugin:logist"), hook_event_name: "SubagentStart" });
    expect(s.getAgent("logist")?.status).toBe("working");
  });

  it("старое событие не перезаписывает более новый статус (хуки идут не по порядку)", () => {
    const s = office();
    const t = Date.now();
    handleHook(s, { ...base, hook_event_name: "Stop" }, { at: new Date(t).toISOString() });
    handleHook(s, { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }, { at: new Date(t - 1000).toISOString() });
    expect(s.getAgent("director")?.status).toBe("idle");
  });

  it("«да» записалось раньше запроса — одобрение всё равно «сделано», а не «ждёт» навсегда", () => {
    const s = office();
    const req: HookInput = { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: {} };
    const t = Date.now();
    handleHook(s, { ...req, hook_event_name: "PostToolUse" }, { at: new Date(t - 2000).toISOString() });
    handleHook(s, req, { at: new Date(t - 3000).toISOString() });
    handleHook(s, { ...base, hook_event_name: "Stop" }, { at: new Date(t).toISOString() });
    expect(s.listApprovals({ status: "done" })).toHaveLength(1);
    expect(s.getAgent("director")?.status).toBe("idle");
  });

  it("человек нажал «Нет» в окне разрешения: после ответа одобрение отклонено, никто не «ждёт»", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: {} });
    handleHook(s, { ...base, hook_event_name: "Stop" });
    expect(s.listApprovals({ status: "rejected" })).toHaveLength(1);
    expect(s.listAgents().some((a) => a.status === "waiting")).toBe(false);
    // Следующее разрешённое изменение не «закрывает» старое отклонённое.
    handleHook(s, { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__wb__update_prices", tool_input: {} });
    expect(s.listApprovals({ status: "rejected" })).toHaveLength(1);
    expect(s.listApprovals({ status: "done" })).toHaveLength(1);
  });

  it("WB не принял изменение после «да» — одобрение с ошибкой", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: {} });
    handleHook(s, { ...base, hook_event_name: "PostToolUseFailure", tool_name: "mcp__wb__update_prices", error: "400 bad price" });
    expect(s.listApprovals({ status: "failed" })).toHaveLength(1);
    expect(s.getAgent("director")?.status).toBe("working");
  });

  it("одобрения двух окон Claude Code не путаются", () => {
    const s = office();
    handleHook(s, { session_id: "A", hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: { w: "A" } });
    handleHook(s, { session_id: "B", hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: { w: "B" } });
    handleHook(s, { session_id: "B", hook_event_name: "PostToolUse", tool_name: "mcp__wb__update_prices", tool_input: {} });
    expect(s.listApprovals({ status: "done" })[0]?.args).toEqual({ w: "B" });
    expect(s.listApprovals({ status: "pending" })[0]?.args).toEqual({ w: "A" });
  });

  it("сжатие контекста и /resume не сбрасывают работу", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: {} });
    handleHook(s, { ...base, hook_event_name: "SessionStart", source: "compact" });
    expect(s.listApprovals({ status: "pending" })).toHaveLength(1);
    expect(s.getAgent("director")?.status).toBe("waiting");
  });

  it("запуск сотрудника из офиса: шаги пишутся на него, а не на директора", () => {
    const s = office();
    handleHook(s, { ...base, hook_event_name: "UserPromptSubmit", prompt: "x" }, { mainAgent: "logist" });
    handleHook(s, { ...base, hook_event_name: "PreToolUse", tool_name: "mcp__wb__get_wb_stocks", tool_input: {} }, { mainAgent: "logist" });
    expect(s.getAgent("logist")?.activity).toBe("смотрю остатки на складах WB");
    expect(s.getAgent("director")?.status).toBe("idle");
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

  it("новый запуск Claude Code сбрасывает зависшие статусы и брошенные час назад ожидания", () => {
    const s = office();
    s.setAgentStatus("logist", "working", "x");
    handleHook(s, { session_id: "old", hook_event_name: "PermissionRequest", tool_name: "mcp__wb__update_prices", tool_input: {} });
    handleHook(s, { session_id: "new", hook_event_name: "SessionStart", source: "startup" }, { at: new Date(Date.now() + 2 * 3600_000).toISOString() });
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

  it("у каждого инструмента WB (не только записи) есть понятная подпись", async () => {
    const { toolDefinitions } = await import("../../mcp/wb/src/tools.js");
    for (const name of Object.keys(toolDefinitions)) expect(describeTool(`mcp__wb__${name}`).text, name).not.toMatch(/^запрос к WB/);
  });

  it("нет ключа WB — «не настроен», а не «не принял»", () => {
    const s = office();
    handleHook(s, { ...inRole("logist"), hook_event_name: "PostToolUseFailure", tool_name: "mcp__wb__get_wb_stocks", error: "Ключ WB не настроен: вставьте его в .env" });
    expect(s.recentEvents()[0]?.message).toContain("не настроен");
  });

  it("short и maskSecrets", () => {
    expect(short("## Главное\n- Кружка кончится через 6 дней\n| a | b |")).toBe("Кружка кончится через 6 дней");
    expect(short("|---|---|\n1. **Итог**")).toBe("Итог");
    expect(short("## Только заголовок")).toBe("Только заголовок");
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
      const matchers = settings.hooks[e].map((m: { matcher?: string }) => m.matcher ?? "");
      for (const h of hooks as { command: string; async?: boolean }[]) {
        // Синхронно — только там, где важен порядок «запрос → да → конец ответа», и только
        // для инструментов записи WB: обычная работа Claude Code не ждёт хук.
        if (["PermissionRequest", "PostToolUse"].includes(e)) {
          expect(h.async, e).toBeFalsy();
          expect(matchers.join(), e).toMatch(/^mcp__wb__\(/);
        } else if (e === "Stop") expect(h.async, e).toBeFalsy();
        else expect(h.async, e).toBe(true);
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
