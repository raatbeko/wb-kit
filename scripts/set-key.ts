/**
 * Записать один ключ в .env, не трогая остальные строки:
 *   npm run set-key -- WB_API_TOKEN <значение>
 *
 * Нужен, чтобы Claude мог сохранить ключ, присланный в чат, не открывая .env
 * целиком (чтение .env запрещено в .claude/settings.json — там все ключи).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_PATH, ROOT } from "../mcp/wb/src/env.js";

export const ALLOWED_KEYS = ["WB_API_TOKEN", "MPSTATS_TOKEN", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN"] as const;

export function setKey(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const lines = content.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trimStart().startsWith(`${name}=`));
  if (i >= 0) lines[i] = line;
  else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, line);
  return lines.join("\n");
}

function main() {
  const [name, ...rest] = process.argv.slice(2);
  const value = rest.join("").trim();
  if (!name || !(ALLOWED_KEYS as readonly string[]).includes(name)) {
    console.error(`Укажите имя ключа: ${ALLOWED_KEYS.join(", ")}`);
    process.exit(1);
  }
  if (!value || /\s/.test(value)) {
    console.error("Значение ключа пустое или содержит пробелы — скопируйте ключ заново.");
    process.exit(1);
  }
  if (!existsSync(ENV_PATH)) copyFileSync(join(ROOT, ".env.example"), ENV_PATH);
  writeFileSync(ENV_PATH, setKey(readFileSync(ENV_PATH, "utf8"), name, value));
  // Значение не печатаем: вывод команды попадает в историю чата.
  console.log(`${name} записан в .env (${value.length} символов).`);
}

if (process.argv[1] && /set-key\.ts$/.test(process.argv[1])) main();
