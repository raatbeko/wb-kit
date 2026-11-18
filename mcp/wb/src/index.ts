#!/usr/bin/env node
/**
 * MCP-сервер wb-kit для Wildberries Seller API (stdio).
 * Ключ берётся из WB_API_TOKEN в .env в корне репозитория.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WBClient } from "./client.js";
import { createServer, TOOL_COUNT } from "./server.js";
import { loadEnv, readKey, ENV_PATH } from "./env.js";

export const VERSION = "0.1.0";

loadEnv();
const token = readKey("WB_API_TOKEN");

if (!token) {
  // Не падаем: без сервера Claude не увидит ни одного инструмента и не сможет
  // объяснить, что делать. Регистрируем инструменты, а каждый вызов вернёт подсказку.
  process.stderr.write(`[wb-kit] WB_API_TOKEN не найден в ${ENV_PATH}. Запустите /setup.\n`);
}

const client = new WBClient({ token: token ?? "" });
if (!token) {
  client.request = async () => {
    throw new Error(
      "Ключ WB не настроен. Откройте файл .env в папке wb-kit и вставьте ключ после WB_API_TOKEN= (или запустите команду /setup), затем перезапустите Claude Code.",
    );
  };
}

const server = createServer(client, VERSION);
await server.connect(new StdioServerTransport());
process.stderr.write(`[wb-kit] MCP подключён, инструментов: ${TOOL_COUNT}\n`);
