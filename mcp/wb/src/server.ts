/**
 * Фабрика MCP-сервера. Инструменты описаны JSON Schema в tools.ts и на
 * регистрации превращаются в Zod (schema.ts): SDK требует Zod и сам проверяет
 * входные данные. Вынесено в фабрику, чтобы тестировать с подменённым клиентом.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WBClient } from "./client.js";
import { toolDefinitions, handleTool, type ToolName, type ToolDefinition } from "./tools.js";
import { toolSchemaToZodShape } from "./schema.js";

export const TOOL_COUNT = Object.keys(toolDefinitions).length;

/** Понятное человеку объяснение частых ошибок WB — клиент остаётся без сопровождения. */
export function explainError(message: string): string {
  if (/→ 401/.test(message)) {
    return `${message}\n\nПохоже, в ключе WB нет нужной категории доступа или ключ устарел. Запусти check_connection — он покажет, каких категорий не хватает.`;
  }
  if (/→ 403/.test(message)) return `${message}\n\nWB запретил доступ к этому методу для текущего ключа.`;
  if (/→ 429/.test(message)) return `${message}\n\nWB ограничил частоту запросов. Подожди минуту и повтори.`;
  if (/network error|timed out/.test(message)) return `${message}\n\nНет связи с WB: проверь интернет или VPN.`;
  return message;
}

export function createServer(client: WBClient, version: string): McpServer {
  const server = new McpServer({ name: "wb-kit", version });

  for (const [name, def] of Object.entries(toolDefinitions) as [ToolName, ToolDefinition][]) {
    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: toolSchemaToZodShape(def.inputSchema),
        annotations: {
          readOnlyHint: !def.write,
          destructiveHint: Boolean(def.write),
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await handleTool(client, name, args);
          // Без отступов: ответы WB большие, а каждый символ идёт в контекст модели.
          return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: `Ошибка: ${explainError(message)}` }], isError: true };
        }
      },
    );
  }

  return server;
}
