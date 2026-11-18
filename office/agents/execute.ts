/**
 * Выполнение одобренного изменения в кабинете WB: тот же код инструмента,
 * что у MCP-сервера wb (handleTool), с ключом из .env. Вызывается только
 * после кнопки «Одобрить» (см. approve в server/app.ts).
 */
import { WBClient } from "../../mcp/wb/src/client.js";
import { handleTool, type ToolName } from "../../mcp/wb/src/tools.js";
import type { SecretStore } from "../core/ports.js";
import type { Approval } from "../core/types.js";
import { validateWriteArgs } from "./validate.js";

export function createExecutor(secrets: SecretStore, opts: { demo?: boolean } = {}) {
  return async (a: Approval): Promise<string> => {
    // Только инструменты записи и только аргументы, прошедшие схему, — ровно то, что человек видел в карточке.
    const v = validateWriteArgs(a.tool, a.args);
    if (!v.ok) throw new Error(v.error);
    if (opts.demo) return "(демо-режим: в настоящий кабинет ничего не отправлено)";
    const token = secrets.get("WB_API_TOKEN");
    if (!token) throw new Error("Ключ WB не настроен");
    await handleTool(new WBClient({ token }), a.tool as ToolName, v.args);
    return "";
  };
}
