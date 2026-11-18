/**
 * Проверка аргументов изменения в кабинете по той же схеме, что у MCP-сервера
 * wb (tools.ts → schema.ts). Используется дважды: когда сотрудник предлагает
 * изменение и прямо перед выполнением — в WB уходит только то, что прошло схему
 * (лишние поля отбрасываются, неверные — ошибка, а не «угаданный» запрос).
 */
import { z } from "zod";
import { toolSchemaToZodShape } from "../../mcp/wb/src/schema.js";
import { WRITE_TOOLS, toolDefinitions, type ToolDefinition, type ToolName } from "../../mcp/wb/src/tools.js";

export function isWriteTool(tool: string): tool is ToolName {
  return (WRITE_TOOLS as string[]).includes(tool);
}

export function validateWriteArgs(tool: string, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!isWriteTool(tool)) return { ok: false, error: `«${tool}» — не изменение в кабинете` };
  const def = toolDefinitions[tool] as ToolDefinition;
  const r = z.object(toolSchemaToZodShape(def.inputSchema)).strict().safeParse(args ?? {});
  if (!r.success) return { ok: false, error: `Аргументы не подходят для ${tool}: ${r.error.issues.map((i) => `${i.path.join(".") || "—"}: ${i.message}`).join("; ")}` };
  return { ok: true, args: r.data as Record<string, unknown> };
}

/** Схемы инструментов записи — в описание propose_change, чтобы модель не угадывала форму аргументов. */
export function writeToolSchemas(): string {
  return WRITE_TOOLS.map((t) => `${t}: ${JSON.stringify((toolDefinitions[t] as ToolDefinition).inputSchema)}`).join("\n");
}
