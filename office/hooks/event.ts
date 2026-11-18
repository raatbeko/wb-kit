/**
 * Хук Claude Code → офис. Вызывается из .claude/settings.json на каждое
 * событие (асинхронно — Claude Code его не ждёт), читает JSON из stdin и
 * пишет событие в data/office.db.
 *
 * Главное правило: хук никогда не мешает работе. Любая ошибка — тихо в
 * data/office-hooks.log, код выхода 0, в stdout ничего (stdout хука Claude
 * Code читает как решение).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { STAFF } from "../core/staff.js";
import { DB_PATH } from "../db/sqlite.js";
import { SqliteOfficeStore } from "../store/sqlite-store.js";
import { handleHook, type HookInput } from "./handle.js";

const dbPath = process.env.OFFICE_DB || DB_PATH;
const LOG = join(dirname(dbPath), "office-hooks.log");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let store: SqliteOfficeStore | undefined;
  try {
    const input = JSON.parse(await readStdin()) as HookInput;
    if (process.env.OFFICE_HOOK_DEBUG) {
      // Сырые данные хука — чтобы сверить поля с документацией. Ключи сюда не попадают:
      // .env хуки не видят, а запуск set-key Claude не повторяет в чате.
      mkdirSync(dirname(LOG), { recursive: true });
      appendFileSync(join(dirname(dbPath), "office-hooks-raw.jsonl"), JSON.stringify(input) + "\n");
    }
    store = new SqliteOfficeStore(dbPath);
    store.ensureAgents(STAFF);
    handleHook(store, input);
  } catch (err) {
    try {
      mkdirSync(dirname(LOG), { recursive: true });
      appendFileSync(LOG, `${new Date().toISOString()} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    } catch {
      /* даже записать ошибку не вышло — всё равно не мешаем Claude Code */
    }
  } finally {
    store?.close();
  }
}

main().finally(() => process.exit(0));
