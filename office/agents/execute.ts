/**
 * Выполнение одобренного изменения в кабинете WB: тот же код инструмента,
 * что у MCP-сервера wb (handleTool), с ключом из .env. Вызывается только
 * после кнопки «Одобрить» (см. approve в server/app.ts).
 */
import { WBClient } from "../../mcp/wb/src/client.js";
import { WRITE_TOOLS, handleTool, type ToolName } from "../../mcp/wb/src/tools.js";
import type { SecretStore } from "../core/ports.js";
import type { Approval } from "../core/types.js";

export function createExecutor(secrets: SecretStore, opts: { demo?: boolean } = {}) {
  return async (a: Approval): Promise<string> => {
    // Только инструменты записи из списка — произвольный вызов через одобрение невозможен.
    if (!(WRITE_TOOLS as string[]).includes(a.tool)) throw new Error(`«${a.tool}» — не изменение в кабинете`);
    if (opts.demo) return "(демо-режим: в настоящий кабинет ничего не отправлено)";
    const token = secrets.get("WB_API_TOKEN");
    if (!token) throw new Error("Ключ WB не настроен");
    await handleTool(new WBClient({ token }), a.tool as ToolName, a.args);
    return "";
  };
}
