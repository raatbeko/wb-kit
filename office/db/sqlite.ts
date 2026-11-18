/**
 * Подключение к SQLite офиса: data/office.db (папка data/ не попадает в git).
 *
 * better-sqlite3, а не встроенный node:sqlite: у клиентов Node бывает 20–22,
 * а node:sqlite без флага работает только с Node 22.13+. У better-sqlite3
 * есть готовые сборки для Windows и Mac — компилятор ставить не нужно.
 */
import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../../mcp/wb/src/env.js";

export type DB = Database.Database;

export const DB_PATH = join(ROOT, "data", "office.db");
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Миграции по порядку: `001_init.sql` → версия 1. */
export function listMigrations(dir = MIGRATIONS_DIR): { version: number; file: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .map((f) => ({ version: Number(f.slice(0, 3)), file: join(dir, f) }))
    .sort((a, b) => a.version - b.version);
}

/** Применить недостающие миграции. Версия хранится в PRAGMA user_version. */
export function migrate(db: DB, dir = MIGRATIONS_DIR): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  let version = current;
  for (const m of listMigrations(dir)) {
    if (m.version <= version) continue;
    const sql = readFileSync(m.file, "utf8");
    // Каждая миграция целиком или никак: при ошибке база остаётся на прошлой версии.
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    version = m.version;
  }
  return version;
}

/**
 * Открыть базу офиса. `:memory:` — для тестов.
 * WAL: хуки Claude Code пишут события, пока сервер офиса читает — без блокировок.
 */
export function openDb(path = DB_PATH): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // Хук и сервер могут писать одновременно — ждём до 5 секунд, а не падаем с SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
