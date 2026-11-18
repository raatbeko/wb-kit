/**
 * Что делать офису с событием хука Claude Code. Отдельно от чтения stdin —
 * чтобы проверять тестами на готовых JSON.
 *
 * Поля — по code.claude.com/docs/en/hooks (сверено на живом запуске):
 * общие session_id и hook_event_name, а внутри субагента ещё agent_id и
 * agent_type (= имя роли из .claude/agents). Без agent_type событие — от
 * основного чата, то есть от директора.
 *
 * Хуки асинхронные (кроме PermissionRequest и Stop) и могут записаться не по
 * порядку. Поэтому:
 * - время события `at` фиксируется в самом начале хука, статус сотрудника
 *   не перезаписывается более старым событием;
 * - одобрения ищутся по сеансу, сотруднику и инструменту, самое старое первым;
 * - «да» без увиденного запроса (запрос записался позже) — тоже фиксируем.
 */
import type { OfficeStore } from "../core/ports.js";
import { STAFF } from "../core/staff.js";
import { describeTool, maskSecrets, short } from "./describe.js";

export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  error?: string;
  last_assistant_message?: string;
  source?: string;
  [k: string]: unknown;
}

export interface HookOptions {
  /** Кто «основной чат» процесса: в Claude Code — директор, при запуске из офиса (Agent SDK) — сам сотрудник. */
  mainAgent?: string;
  /** Когда хук запущен (ISO). По умолчанию — сейчас. */
  at?: string;
}

const STAFF_IDS = new Set(STAFF.map((s) => s.id));
const WRITE_TOOLS = new Set([
  "update_prices",
  "update_fbs_stocks",
  "create_fbs_supply",
  "add_orders_to_fbs_supply",
  "deliver_fbs_supply",
  "reply_feedback",
  "reply_question",
]);

function wbTool(tool: string | undefined): string | null {
  return tool?.startsWith("mcp__wb__") ? tool.slice("mcp__wb__".length) : null;
}

function nameOf(store: OfficeStore, id: string): string {
  return store.getAgent(id)?.name ?? id;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function handleHook(store: OfficeStore, h: HookInput, opts: HookOptions = {}): void {
  const at = opts.at ?? new Date().toISOString();
  const main = opts.mainAgent && STAFF_IDS.has(opts.mainAgent) ? opts.mainAgent : "director";
  const fromOffice = main !== "director";
  const ev = h.hook_event_name;

  // Запуск из офиса (Agent SDK): начало, конец и итог задачи пишет сам запускальщик.
  if (fromOffice && (ev === "SessionStart" || ev === "UserPromptSubmit" || ev === "Stop")) return;

  // Чей это шаг. Встроенные субагенты Claude Code (Explore, Plan…) и свои роли
  // клиента — не сотрудники офиса: их начало и конец не трогают статус директора.
  const type = h.agent_type?.replace(/^.*:/, ""); // плагинные роли приходят как «plugin:name»
  const staffRole = type ? STAFF_IDS.has(type) : true;
  const agentId = !type ? main : staffRole ? type : "director";
  const session = h.session_id ?? null;
  const data = { session, tool: h.tool_name ?? null };
  const status = (s: Parameters<OfficeStore["setAgentStatus"]>[1], activity: string | null = null, id = agentId) =>
    store.setAgentStatus(id, s, activity, at);

  /** Самое старое ждущее одобрение этого инструмента в этом сеансе (сначала у этого же сотрудника). */
  const pendingFor = (tool: string) => {
    const base = { status: "pending" as const, tool, ...(session ? { sessionId: session } : {}) };
    const own = store.listApprovals({ ...base, agentId });
    const list = own.length ? own : store.listApprovals(base);
    return list.at(-1);
  };

  switch (ev) {
    case "SessionStart": {
      // Только настоящий новый запуск. compact/resume/clear — та же работа, статусы верны.
      if (h.source !== "startup") return;
      for (const a of store.listAgents()) if (a.status !== "idle") status("idle", null, a.id);
      // Ожидания, брошенные упавшим или закрытым окном больше часа назад: ответа уже не будет.
      const hourAgo = new Date(Date.parse(at) - 3600_000).toISOString();
      for (const a of store.listApprovals({ status: "pending" }))
        if (a.sessionId !== null && a.sessionId !== session && a.createdAt < hourAgo) store.resolveApproval(a.id, "rejected");
      store.addEvent({ kind: "note", message: "Claude Code запущен — офис на связи", data });
      return;
    }

    case "UserPromptSubmit": {
      if (h.agent_type) return;
      // Новый вопрос — значит, прошлые запросы «да/нет» этого сеанса уже решены (скорее всего «нет»).
      closeSessionPending(store, session, at);
      const q = short(h.prompt);
      status("working", "разбираю задачу", "director");
      store.addEvent({ kind: "agent_started", agentId: "director", message: q ? `Новая задача: ${q}` : "Новая задача", data });
      return;
    }

    case "SubagentStart": {
      if (!staffRole) return;
      status("working", "начинаю работу");
      store.addEvent({ kind: "agent_started", agentId, message: "Взялся за задачу", data: { ...data, agent: h.agent_id ?? null } });
      return;
    }

    case "PreToolUse": {
      const tool = h.tool_name ?? "";
      // Директор раздаёт задачу роли — это и есть «пошёл к логисту».
      if (tool === "Agent" || tool === "Task") {
        const role = String(h.tool_input?.subagent_type ?? "");
        if (STAFF_IDS.has(role)) {
          store.addEvent({ kind: "agent_step", agentId: "director", message: `Передаю задачу: ${nameOf(store, role)}`, data });
          return;
        }
      }
      if (!staffRole) return;
      const d = describeTool(tool, h.tool_input);
      status("working", d.text);
      if (d.important) store.addEvent({ kind: "agent_step", agentId, message: capitalize(d.text), data });
      return;
    }

    case "PostToolUseFailure": {
      const err = maskSecrets(String(h.error ?? ""));
      const wb = wbTool(h.tool_name);
      if (!wb) return;
      if (WRITE_TOOLS.has(wb)) {
        // «Да» сказали, а WB не принял: одобрение — «ошибка», а не «ждёт» навсегда.
        const a = pendingFor(wb);
        if (a) store.resolveApproval(a.id, "failed");
      }
      // Ключа нет вовсе — это не «WB не принял», а «надо вписать».
      if (/не настроен|not configured|WB_API_TOKEN/i.test(err)) {
        status("error", "нет ключа WB — нужен /setup");
        store.addEvent({ kind: "agent_error", agentId, message: "Ключ WB не настроен: запустите /setup в Claude Code", data });
        return;
      }
      // 401 от WB — проблема ключа: её видно в офисе красной лампой, а не только в чате.
      if (/401|unauthori[sz]ed|токен|token/i.test(err)) {
        status("error", "WB не принял ключ — нужен /setup");
        store.addEvent({ kind: "agent_error", agentId, message: "WB не принял ключ: проверьте его командой /setup", data });
        return;
      }
      if (WRITE_TOOLS.has(wb)) status("working", "WB не принял изменение");
      store.addEvent({ kind: "agent_step", agentId, message: `Не получилось (${describeTool(h.tool_name!).text}): ${short(err, 120)}`, data });
      return;
    }

    case "PermissionRequest": {
      const wb = wbTool(h.tool_name);
      if (!wb || !WRITE_TOOLS.has(wb)) return;
      const text = describeTool(h.tool_name!).text;
      store.createApproval({ agentId, taskId: null, tool: wb, title: capitalize(text), changes: [], args: h.tool_input ?? {}, sessionId: session });
      status("waiting", `ждёт вашего решения: ${text}`);
      store.addEvent({ kind: "approval_requested", agentId, message: `Ждёт вашего «да»: ${text}. Ответьте в Claude Code.`, data });
      return;
    }

    case "PermissionDenied": {
      const wb = wbTool(h.tool_name);
      if (!wb || !WRITE_TOOLS.has(wb)) return;
      const a = pendingFor(wb);
      if (a) store.resolveApproval(a.id, "rejected");
      status("working", "изменение отклонено");
      store.addEvent({ kind: "approval_resolved", agentId, message: `Отклонено: ${describeTool(h.tool_name!).text}`, data });
      return;
    }

    case "PostToolUse": {
      const wb = wbTool(h.tool_name);
      if (!wb || !WRITE_TOOLS.has(wb)) return;
      // Инструмент записи выполнился — значит, человек сказал «да».
      const text = describeTool(h.tool_name!).text;
      const a = pendingFor(wb);
      if (a) store.resolveApproval(a.id, "done");
      // Запрос ещё не записался (хуки не по порядку) или разрешение было постоянным — фиксируем как сделанное.
      else store.createApproval({ agentId, taskId: null, tool: wb, title: capitalize(text), changes: [], args: h.tool_input ?? {}, sessionId: session, status: "done" });
      status("working", "изменение выполнено");
      store.addEvent({ kind: "approval_resolved", agentId, message: `Сделано в кабинете WB: ${text}`, data });
      return;
    }

    case "SubagentStop": {
      if (!staffRole) return;
      status("idle");
      const result = short(h.last_assistant_message);
      store.addEvent({ kind: "agent_finished", agentId, message: result ? `Готово: ${result}` : "Готово", data });
      return;
    }

    case "Stop": {
      if (h.agent_type) return;
      // Ответ закончен: несостоявшиеся «да» этого сеанса — это «нет» (окно разрешения закрыли).
      closeSessionPending(store, session, at);
      // Отметка времени ставится всем (кроме «ошибки»): запоздавший шаг из этого ответа уже не вернёт «работает».
      for (const a of store.listAgents()) if (a.status !== "error") status("idle", null, a.id);
      store.addEvent({ kind: "agent_finished", agentId: "director", message: "Ответ готов — смотрите в Claude Code", data });
      return;
    }
  }
}

/** Ждущие одобрения сеанса, созданные до `at`, — отклонены (ответа «да» не было). */
function closeSessionPending(store: OfficeStore, session: string | null, at: string) {
  if (!session) return;
  for (const a of store.listApprovals({ status: "pending", sessionId: session }))
    if (a.createdAt <= at) store.resolveApproval(a.id, "rejected");
}
