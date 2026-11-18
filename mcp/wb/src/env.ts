/**
 * Загрузка .env из корня wb-kit. Клиент вписывает ключи в файл, а не в
 * переменные окружения: так проще на Windows и не нужно ничего настраивать в Claude.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Корень репозитория: mcp/wb/src → ../../.. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ENV_PATH = join(ROOT, ".env");

export function loadEnv(): void {
  if (!existsSync(ENV_PATH)) return;
  // Встроено в Node ≥ 20.12. Уже заданные переменные окружения не перезаписывает.
  process.loadEnvFile(ENV_PATH);
}

/** Пустое значение и шаблон из .env.example считаем «ключа нет». */
export function readKey(name: string): string | undefined {
  const v = process.env[name]?.trim();
  if (!v || /^(your_|ваш|вставьте|paste)/i.test(v)) return undefined;
  return v;
}
