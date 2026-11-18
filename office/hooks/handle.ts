/**
 * Что делать офису с событием хука Claude Code. Отдельно от чтения stdin —
 * чтобы проверять тестами на готовых JSON.
 *
 * Поля — по code.claude.com/docs/en/hooks: общие session_id, hook_event_name,
 * а внутри субагента ещё agent_id и agent_type (= имя роли из .claude/agents).
 * Без agent_type событие — от основного чата, то есть от директора.
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

/** Роль из хука → сотрудник офиса. Своя роль клиента (нет в штате) — тоже показываем, директором. */
function who(h: HookInput): string {
  const t = h.agent_type?.replace(/^.*:/, ""); // плагинные роли приходят как «plugin:name»
  return t && STAFF_IDS.has(t) ? t : "director";
}

function wbTool(tool: string | undefined): string | null {
  return tool?.startsWith("mcp__wb__") ? tool.slice("mcp__wb__".length) : null;
}

function nameOf(store: OfficeStore, id: string): string {
  return store.getAgent(id)?.name ?? id;
}

export function handleHook(store: OfficeStore, h: HookInput): void {
  const agentId = who(h);
  const data = { session: h.session_id ?? null, tool: h.tool_name ?? null };

  switch (h.hook_event_name) {
    case "SessionStart": {
      // Новый запуск Claude Code: прошлые «работает» и «ждёт» уже неправда.
      // Ждущие одобрения из прошлого сеанса закрываем: решение по ним в Claude Code уже не примут.
      for (const a of store.listAgents()) if (a.status !== "idle") store.setAgentStatus(a.id, "idle");
      for (const a of store.listApprovals({ status: "pending" })) store.resolveApproval(a.id, "rejected");
      if (h.source === "startup") store.addEvent({ kind: "note", message: "Claude Code запущен — офис на связи", data });
      return;
    }

    case "UserPromptSubmit": {
      if (h.agent_type) return;
      const q = short(h.prompt);
      store.setAgentStatus("director", "working", "разбираю задачу");
      store.addEvent({ kind: "agent_started", agentId: "director", message: q ? `Новая задача: ${q}` : "Новая задача", data });
      return;
    }

    case "SubagentStart": {
      store.setAgentStatus(agentId, "working", "начинаю работу");
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
      const d = describeTool(tool, h.tool_input);
      store.setAgentStatus(agentId, "working", d.text);
      if (d.important) store.addEvent({ kind: "agent_step", agentId, message: capitalize(d.text), data });
      return;
    }

    case "PostToolUseFailure": {
      const err = maskSecrets(String(h.error ?? ""));
      const wb = wbTool(h.tool_name);
      // 401 от WB — проблема ключа: её видно в офисе красной лампой, а не только в чате.
      if (wb && /401|unauthori[sz]ed|токен|token/i.test(err)) {
        store.setAgentStatus(agentId, "error", "WB не принял ключ — нужен /setup");
        store.addEvent({ kind: "agent_error", agentId, message: "WB не принял ключ: проверьте его командой /setup", data });
        return;
      }
      if (wb) store.addEvent({ kind: "agent_step", agentId, message: `Не получилось (${describeTool(h.tool_name!).text}): ${short(err, 120)}`, data });
      return;
    }

    case "PermissionRequest": {
      const wb = wbTool(h.tool_name);
      if (!wb || !WRITE_TOOLS.has(wb)) return;
      const title = capitalize(describeTool(h.tool_name!).text);
      store.createApproval({ agentId, taskId: null, tool: wb, title, changes: [], args: h.tool_input ?? {} });
      store.setAgentStatus(agentId, "waiting", `ждёт вашего решения: ${describeTool(h.tool_name!).text}`);
      store.addEvent({ kind: "approval_requested", agentId, message: `Ждёт вашего «да»: ${describeTool(h.tool_name!).text}. Ответьте в Claude Code.`, data });
      return;
    }

    case "PermissionDenied": {
      const wb = wbTool(h.tool_name);
      if (!wb) return;
      const a = latestPending(store, wb);
      if (a) store.resolveApproval(a.id, "rejected");
      store.setAgentStatus(agentId, "working", "изменение отклонено");
      store.addEvent({ kind: "approval_resolved", agentId, message: `Отклонено: ${describeTool(h.tool_name!).text}`, data });
      return;
    }

    case "PostToolUse": {
      const wb = wbTool(h.tool_name);
      if (!wb || !WRITE_TOOLS.has(wb)) return;
      // Инструмент записи выполнился — значит, человек сказал «да».
      const a = latestPending(store, wb);
      if (a) {
        store.resolveApproval(a.id, "approved");
        store.resolveApproval(a.id, "done");
      }
      store.setAgentStatus(agentId, "working", "изменение выполнено");
      store.addEvent({ kind: "approval_resolved", agentId, message: `Сделано в кабинете WB: ${describeTool(h.tool_name!).text}`, data });
      return;
    }

    case "SubagentStop": {
      store.setAgentStatus(agentId, "idle");
      const result = short(h.last_assistant_message);
      store.addEvent({ kind: "agent_finished", agentId, message: result ? `Готово: ${result}` : "Готово", data });
      return;
    }

    case "Stop": {
      if (h.agent_type) return;
      // Основной чат закончил ответ. Роли, по которым не пришёл SubagentStop, тоже отпускаем.
      for (const a of store.listAgents()) if (a.status === "working") store.setAgentStatus(a.id, "idle");
      store.addEvent({ kind: "agent_finished", agentId: "director", message: "Ответ готов — смотрите в Claude Code", data });
      return;
    }
  }
}

function latestPending(store: OfficeStore, tool: string) {
  return store.listApprovals({ status: "pending" }).find((a) => a.tool === tool);
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
