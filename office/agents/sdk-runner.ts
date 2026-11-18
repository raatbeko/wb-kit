/**
 * Режим «Одобрить прямо в офисе»: сотрудник работает через Claude Agent SDK
 * на ключе Claude API клиента (ANTHROPIC_API_KEY в .env) — без чата Claude Code.
 * Подписку Claude так использовать нельзя, только API-ключ (условия Anthropic).
 *
 * Пакет @anthropic-ai/claude-agent-sdk ставится отдельно (npm run office:api),
 * чтобы обычная установка у клиента оставалась лёгкой. Его нет — офис работает
 * в режиме «окна» в Claude Code.
 *
 * Как устроено:
 * - роль берётся из .claude/agents/<id>.md: текст — в системный промпт;
 * - инструменты записи WB запрещены; вместо них — propose_change: предложение
 *   попадает в офис карточкой «было → станет», выполняет его кнопка «Одобрить»;
 * - хуки проекта тоже срабатывают (settingSources: project): шаги видны в ленте.
 *   OFFICE_AGENT подсказывает хуку, какой это сотрудник.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ROOT } from "../../mcp/wb/src/env.js";
import { WRITE_TOOLS } from "../../mcp/wb/src/tools.js";
import type { AgentRunner, AgentRunRequest, OfficeStore, SecretStore } from "../core/ports.js";
import { short } from "../hooks/describe.js";
import { isWriteTool, validateWriteArgs, writeToolSchemas } from "./validate.js";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** То немногое из Agent SDK, что нужно офису (пакет может быть не установлен — типы свои). */
export interface SdkLike {
  query(args: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>>;
  createSdkMcpServer(args: { name: string; version?: string; tools: unknown[] }): unknown;
  tool(name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: (args: never) => Promise<unknown>): unknown;
}

export async function loadSdk(): Promise<SdkLike | null> {
  try {
    // Имя в переменной — чтобы TypeScript не требовал пакет при проверке типов.
    const name = SDK_PACKAGE;
    return (await import(name)) as SdkLike;
  } catch {
    return null;
  }
}

/** Текст роли без frontmatter и её список инструментов. */
export function readRole(id: string, root = ROOT): { prompt: string; tools: string[] } | null {
  const file = join(root, ".claude", "agents", `${id}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return { prompt: text, tools: [] };
  const tools = /^tools:\s*(.*)$/m.exec(m[1]!)?.[1]?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
  return { prompt: m[2]!.trim(), tools };
}

const DIRECTOR_PROMPT = `Ты — директор офиса продавца Wildberries. Отвечай по-русски, просто, цифрами из инструментов WB, без выдумок.
Ты работаешь из веб-офиса, а не из чата: человек увидит твой итоговый ответ в ленте и в карточке задачи.`;

const PROPOSE_RULES = `
## Изменения в кабинете
Сам ты ничего в кабинете не меняешь: инструменты записи WB тебе недоступны. Если нужно изменить цены, остатки FBS,
ответить на отзыв или вопрос — вызови инструмент office.propose_change: укажи инструмент WB (${WRITE_TOOLS.join(", ")}),
его точные аргументы, короткий заголовок и таблицу «было → станет». Человек нажмёт «Одобрить» в офисе.
Итоговый ответ — коротко: что нашёл, что предложил, что сделать человеку.`;

/**
 * Что сотруднику можно без вопроса (спросить некого — человек в офисе):
 * - инструменты WB на чтение;
 * - Read/Grep/Glob, если они есть у роли, и только внутри папки набора, кроме .env
 *   (иначе подсказка в отзыве покупателя могла бы заставить прочитать чужие файлы).
 * Всё остальное — отказ. `updatedInput` обязателен в части версий SDK.
 */
export function makeCanUseTool(root: string, roleTools: string[]) {
  const base = resolve(root);
  const inside = (p: unknown) => {
    if (p === undefined || p === null || p === "") return true; // по умолчанию — папка набора (cwd)
    const full = resolve(base, String(p));
    const rel = relative(base, full);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    return !/(^|[\\/])\.env(\.|$)/i.test(rel);
  };
  return async (toolName: string, input: Record<string, unknown> = {}) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    if (toolName.startsWith("mcp__wb__")) {
      return isWriteTool(toolName.slice(9))
        ? deny("Изменения в кабинете — только через propose_change.")
        : { behavior: "allow" as const, updatedInput: input };
    }
    if (["Read", "Grep", "Glob"].includes(toolName) && roleTools.includes(toolName)) {
      return inside(input.file_path) && inside(input.path) ? { behavior: "allow" as const, updatedInput: input } : deny("Читать можно только файлы набора wb-kit (кроме .env).");
    }
    return deny("В офисе этот инструмент недоступен. Изменения — через propose_change.");
  };
}

export interface SdkRunnerDeps {
  store: OfficeStore;
  secrets: SecretStore;
  sdk: SdkLike;
  root?: string;
  model?: string;
  maxTurns?: number;
}

export class SdkAgentRunner implements AgentRunner {
  readonly mode = "agent_sdk" as const;

  constructor(private readonly deps: SdkRunnerDeps) {}

  /** Инструмент propose_change: предложение изменения → одобрение в офисе. */
  private officeServer(agentId: string, taskId: string) {
    const { sdk, store } = this.deps;
    const proposeChange = sdk.tool(
      "propose_change",
      "Предложить изменение в кабинете WB. Оно появится в офисе, выполнится после кнопки «Одобрить». " +
        "args — точные аргументы инструмента по его схеме (человек увидит именно их):\n" +
        writeToolSchemas(),
      {
        tool: z.enum(WRITE_TOOLS as [string, ...string[]]),
        args: z.record(z.string(), z.unknown()),
        title: z.string().max(200),
        changes: z.array(z.object({ item: z.string(), before: z.string(), after: z.string() })).max(100),
      },
      (async (a: { tool: string; args: Record<string, unknown>; title: string; changes: { item: string; before: string; after: string }[] }) => {
        // Неверные аргументы — назад модели с объяснением, а не в офис: «угаданный» запрос в WB не уйдёт.
        const v = validateWriteArgs(a.tool, a.args);
        if (!v.ok) return { content: [{ type: "text", text: `${v.error}. Исправь аргументы по схеме и предложи снова.` }], isError: true };
        const ap = store.createApproval({ agentId, taskId, tool: a.tool, title: a.title, changes: a.changes, args: v.args });
        store.setAgentStatus(agentId, "waiting", `ждёт вашего решения: ${a.title}`);
        store.addEvent({ kind: "approval_requested", agentId, taskId, message: `Предлагает: ${a.title}. Нажмите «Одобрить» или «Отклонить».`, data: { approvalId: ap.id } });
        return { content: [{ type: "text", text: "Предложение отправлено человеку на одобрение. Не повторяй его." }] };
      }) as never,
    );
    return sdk.createSdkMcpServer({ name: "office", version: "1.0.0", tools: [proposeChange] });
  }

  async run(req: AgentRunRequest): Promise<void> {
    const { store, secrets, sdk } = this.deps;
    const root = this.deps.root ?? ROOT;
    const apiKey = secrets.get("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("Нет ключа Claude API (ANTHROPIC_API_KEY)");

    const role = req.agentId === "director" ? { prompt: DIRECTOR_PROMPT, tools: ["Read", "Grep", "Glob", "mcp__wb__*"] } : readRole(req.agentId, root);
    if (!role) throw new Error(`Нет файла роли .claude/agents/${req.agentId}.md`);

    store.updateTask(req.taskId, { status: "running" });
    store.setAgentStatus(req.agentId, "working", "разбираю задачу");
    store.addEvent({ kind: "agent_started", agentId: req.agentId, taskId: req.taskId, message: `Задача из офиса: ${short(req.question)}` });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // Ключ API — только этому процессу; OFFICE_AGENT — для хуков.
    env.ANTHROPIC_API_KEY = apiKey;
    env.OFFICE_AGENT = req.agentId;

    const messages = sdk.query({
      prompt: req.question,
      options: {
        cwd: root,
        env,
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: `${role.prompt}\n${PROPOSE_RULES}` },
        model: this.deps.model,
        maxTurns: this.deps.maxTurns ?? 30,
        mcpServers: {
          wb: { type: "stdio", command: process.execPath, args: ["--import", "tsx", join(root, "mcp", "wb", "src", "index.ts")] },
          office: this.officeServer(req.agentId, req.taskId),
        },
        // Заранее разрешено только предложение изменения; остальное решает canUseTool.
        allowedTools: ["mcp__office__propose_change"],
        disallowedTools: [...WRITE_TOOLS.map((t) => `mcp__wb__${t}`), "Bash", "Write", "Edit", "WebFetch", "WebSearch"],
        canUseTool: makeCanUseTool(root, role.tools),
      },
    });

    let result = "";
    let failed: string | null = null;
    for await (const m of messages) {
      if (m.type === "result") {
        if (m.subtype === "success") result = String(m.result ?? "");
        else failed = String(m.subtype ?? "ошибка");
      }
    }

    if (failed) {
      store.updateTask(req.taskId, { status: "failed" });
      store.setAgentStatus(req.agentId, "error", "задача не выполнена");
      store.addEvent({ kind: "agent_error", agentId: req.agentId, taskId: req.taskId, message: `Задача не выполнена (${failed})` });
      return;
    }

    const report = store.addReport({ kind: "custom", title: `Ответ: ${short(req.question, 80)}`, path: null, summary: { text: result }, agentId: req.agentId });
    store.updateTask(req.taskId, { status: "done", resultReportId: report.id });
    const waiting = store.listApprovals({ status: "pending" }).some((a) => a.agentId === req.agentId);
    store.setAgentStatus(req.agentId, waiting ? "waiting" : "idle", waiting ? "ждёт вашего решения" : null);
    store.addEvent({ kind: "agent_finished", agentId: req.agentId, taskId: req.taskId, message: `Готово: ${short(result)}`, data: { reportId: report.id } });
  }
}
