/**
 * Telegram для утренней сводки: `npm run telegram` (или `-- --test`).
 *
 * Бот у каждого продавца свой (создаётся у @BotFather), поэтому данные магазина
 * идут из его компьютера прямо в его Telegram — без нашего сервера.
 *
 * Бот не может написать первым: человек открывает бота и нажимает «Start»,
 * а команда находит этот чат в getUpdates и сама записывает TELEGRAM_CHAT_ID
 * в .env. Руками искать ID не нужно.
 *
 * Токен на экран не выводим: вывод команды попадает в историю чата.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_PATH, ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { setKey } from "./set-key.js";

export interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number; type: string; first_name?: string; username?: string }; text?: string; date: number };
}

/** Последний личный чат, из которого писали боту. Группы не берём: сводка — личная. */
export function findChat(updates: TgUpdate[]): { id: number; name: string } | undefined {
  const msgs = updates.map((u) => u.message).filter((m) => m && m.chat.type === "private");
  const last = msgs.sort((a, b) => b!.date - a!.date)[0];
  return last ? { id: last.chat.id, name: last.chat.first_name ?? last.chat.username ?? "без имени" } : undefined;
}

/** Текст для parse_mode=HTML: Telegram ругается на голые < > &. */
export function tgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Ошибку Telegram пересказываем словами и без URL — в нём токен. */
function explain(code: number, desc = ""): string {
  if (code === 401 || code === 404) return "Telegram не принимает токен бота. Скопируйте его у @BotFather заново целиком.";
  if (code === 403) return "Бот заблокирован в Telegram. Откройте бота, нажмите «Перезапустить» и запустите команду снова.";
  if (code === 400 && /chat not found/i.test(desc)) return "Чат не найден. Откройте бота, нажмите «Start» и запустите `npm run telegram`.";
  if (code === 409) return "У бота включён webhook (он уже подключён к другому сервису). Создайте для сводки отдельного бота.";
  return `Telegram ответил ошибкой ${code}${desc ? `: ${desc}` : ""}.`;
}

async function call<T>(token: string, method: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("Нет связи с Telegram: проверьте интернет, VPN или прокси.");
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string };
  if (!json.ok) throw new Error(explain(json.error_code ?? res.status, json.description));
  return json.result as T;
}

/** Отправить сообщение в чат продавца. Для сводки и других скриптов. */
export async function sendTelegram(html: string, opts: { token?: string; chatId?: string } = {}): Promise<void> {
  loadEnv();
  const token = opts.token ?? readKey("TELEGRAM_BOT_TOKEN");
  const chatId = opts.chatId ?? readKey("TELEGRAM_CHAT_ID");
  if (!token || !chatId) throw new Error("Telegram не подключён: выполните `npm run telegram`.");
  // Лимит Telegram — 4096 символов в сообщении.
  const text = html.length > 4000 ? html.slice(0, 3990) + "\n…" : html;
  await call(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

function saveChatId(id: number) {
  if (!existsSync(ENV_PATH)) copyFileSync(join(ROOT, ".env.example"), ENV_PATH);
  writeFileSync(ENV_PATH, setKey(readFileSync(ENV_PATH, "utf8"), "TELEGRAM_CHAT_ID", String(id)));
}

async function main() {
  loadEnv();
  const token = readKey("TELEGRAM_BOT_TOKEN");
  if (!token) {
    console.log(
      "Токена бота нет.\n" +
        "1. В Telegram откройте @BotFather → /newbot, придумайте имя — он пришлёт токен.\n" +
        "2. Сохраните его: npm run set-key -- TELEGRAM_BOT_TOKEN <токен>\n" +
        "3. Запустите npm run telegram ещё раз.",
    );
    process.exit(1);
  }
  const me = await call<{ username: string }>(token, "getMe");
  const link = `https://t.me/${me.username}`;

  let chatId = readKey("TELEGRAM_CHAT_ID");
  if (!chatId || process.argv.includes("--relink")) {
    const chat = findChat(await call<TgUpdate[]>(token, "getUpdates", { allowed_updates: ["message"] }));
    if (!chat) {
      console.log(`Бот @${me.username} найден, но ему ещё не писали.\nОткройте ${link}, нажмите «Start» и запустите npm run telegram ещё раз.`);
      process.exit(1);
    }
    saveChatId(chat.id);
    chatId = String(chat.id);
    console.log(`Чат найден (${chat.name}), TELEGRAM_CHAT_ID записан в .env.`);
  }

  await sendTelegram("✅ <b>wb-kit подключён.</b>\nСюда будет приходить утренняя сводка по магазину.", { token, chatId });
  console.log(`Готово: тестовое сообщение отправлено в чат с ботом @${me.username}.`);
}

if (process.argv[1] && /telegram\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
