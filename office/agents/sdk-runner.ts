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
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../../mcp/wb/src/env.js";
import { WRITE_TOOLS } from "../../mcp/wb/src/tools.js";
import type { AgentRunner, AgentRunRequest, OfficeStore, SecretStore } from "../core/ports.js";
import { short } from "../hooks/describe.js";

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
      "Предложить изменение в кабинете WB. Оно появится в офисе, выполнится после кнопки «Одобрить».",
      {
        tool: z.enum(WRITE_TOOLS as [string, ...string[]]),
        args: z.record(z.string(), z.unknown()),
        title: z.string().max(200),
        changes: z.array(z.object({ item: z.string(), before: z.string(), after: z.string() })).max(100),
      },
      (async (a: { tool: string; args: Record<string, unknown>; title: string; changes: { item: string; before: string; after: string }[] }) => {
        const ap = store.createApproval({ agentId, taskId, tool: a.tool, title: a.title, changes: a.changes, args: a.args });
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
        allowedTools: [...role.tools.filter((t) => t !== "Bash" && t !== "Write" && t !== "Edit"), "mcp__office__propose_change"],
        disallowedTools: [...WRITE_TOOLS.map((t) => `mcp__wb__${t}`), "Bash", "Write", "Edit"],
        // Всё, что не разрешено явно, — отказ без вопроса: спросить некого, человек в офисе.
        canUseTool: async (toolName: string) =>
          toolName.startsWith("mcp__wb__") && !(WRITE_TOOLS as string[]).includes(toolName.slice(9))
            ? { behavior: "allow" }
            : { behavior: "deny", message: "В офисе этот инструмент недоступен. Изменения — через propose_change." },
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
