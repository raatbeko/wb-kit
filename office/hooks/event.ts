/**
 * Хук Claude Code → офис. Вызывается из .claude/settings.json на каждое
 * событие, читает JSON из stdin и пишет событие в data/office.db.
 *
 * Время события фиксируется первой строкой, до загрузки базы: хуки идут
 * параллельно, и офис по этому времени понимает, какое событие новее.
 * Тяжёлые модули грузятся динамически — уже после отметки времени.
 *
 * Главное правило: хук никогда не мешает работе. Любая ошибка — тихо в
 * data/office-hooks.log, код выхода 0, в stdout ничего (stdout хука Claude
 * Code читает как решение).
 */
const at = new Date().toISOString();

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbPath = process.env.OFFICE_DB || join(ROOT, "data", "office.db");
const LOG = join(dirname(dbPath), "office-hooks.log");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let close: (() => void) | undefined;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    const [{ SqliteOfficeStore }, { STAFF }, { handleHook }, { maskSecrets }] = await Promise.all([
      import("../store/sqlite-store.js"),
      import("../core/staff.js"),
      import("./handle.js"),
      import("./describe.js"),
    ]);
    if (process.env.OFFICE_HOOK_DEBUG) {
      // Сырые данные хука — чтобы сверить поля с документацией (похожее на ключи — замаскировано).
      mkdirSync(dirname(LOG), { recursive: true });
      appendFileSync(join(dirname(dbPath), "office-hooks-raw.jsonl"), maskSecrets(JSON.stringify(input)) + "\n");
    }
    const store = new SqliteOfficeStore(dbPath);
    close = () => store.close();
    store.ensureAgents(STAFF);
    handleHook(store, input, { mainAgent: process.env.OFFICE_AGENT, at });
  } catch (err) {
    try {
      mkdirSync(dirname(LOG), { recursive: true });
      appendFileSync(LOG, `${new Date().toISOString()} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    } catch {
      /* даже записать ошибку не вышло — всё равно не мешаем Claude Code */
    }
  } finally {
    close?.();
  }
}

main().finally(() => process.exit(0));
