/**
 * Загрузка .env из корня wb-kit. Клиент вписывает ключи в файл, а не в
 * переменные окружения: так проще на Windows и не нужно ничего настраивать в Claude.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Корень репозитория: mcp/wb/src → ../../.. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ENV_PATH = join(ROOT, ".env");

export function loadEnv(file = ENV_PATH): void {
  if (!existsSync(file)) return;
  // Блокнот Windows может сохранить файл с меткой BOM — тогда первая строка
  // превращается в «\uFEFFWB_API_TOKEN» и ключ не находится. Срезаем её сами.
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  // parseEnv встроен в Node ≥ 20.12. Уже заданные переменные окружения не перезаписываем.
  for (const [k, v] of Object.entries(parseEnv(text))) if (process.env[k] === undefined) process.env[k] = v;
}

/** Пустое значение и шаблон из .env.example считаем «ключа нет». */
export function readKey(name: string): string | undefined {
  // Частые ошибки вставки: кавычки-ёлочки, приставка «Bearer» из чужих инструкций.
  const v = process.env[name]?.trim().replace(/^[«"']|[»"']$/g, "").replace(/^Bearer\s+/i, "").trim();
  if (!v || /^(your_|ваш|вставьте|paste)/i.test(v)) return undefined;
  return v;
}
