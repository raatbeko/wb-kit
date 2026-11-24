/**
 * Утренняя сводка по магазину.
 *
 *   npm run digest                      — собрать сводку, обновить панель, отправить в Telegram
 *   npm run digest -- --demo            — то же на выдуманном магазине, без ключа
 *   npm run digest -- --no-send         — не отправлять в Telegram (только файл и панель)
 *   npm run digest -- --schedule 08:00  — каждый день в 08:00 (Планировщик заданий Windows)
 *   npm run digest -- --unschedule      — выключить расписание
 *
 * Работает без Claude: подписка Claude не нужна и не тратится.
 * Результат — reports/digest/ГГГГ-ММ-ДД[-demo].json и журнал reports/digest/log.txt.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { WBClient } from "../mcp/wb/src/client.js";
import { ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { createDemoClient } from "../audit/demo.js";
import { analyzeDigest, collectDigest, DIGEST_DIR, localDate, renderTelegram } from "../digest/digest.js";
import { refreshPanel } from "../panel/build.js";
import { sendTelegram } from "./telegram.js";

export const TASK_NAME = "wb-kit digest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Строка PowerShell в одинарных кавычках. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

function schedule(time: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Время — в виде ЧЧ:ММ, например 08:00.");
  const cmd = join(ROOT, "scripts", "digest.cmd");
  if (process.platform !== "win32") {
    const [h, m] = time.split(":");
    console.log(`На этом компьютере не Windows. Добавьте строку в crontab (crontab -e):\n${Number(m)} ${Number(h)} * * * cd "${ROOT}" && npm run digest -- --scheduled >> reports/digest/log.txt 2>&1`);
    return;
  }
  // StartWhenAvailable: если в это время компьютер был выключен — сводка придёт при включении.
  // Окно консоли прячем: человек не должен видеть мигающий чёрный экран по утрам.
  const ps = [
    `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psq(`-NoProfile -WindowStyle Hidden -Command "& '${cmd.replace(/'/g, "''")}'"`)}`,
    `$t = New-ScheduledTaskTrigger -Daily -At ${psq(time)}`,
    `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)`,
    `Register-ScheduledTask -TaskName ${psq(TASK_NAME)} -Action $a -Trigger $t -Settings $s -Description 'Утренняя сводка wb-kit' -Force | Out-Null`,
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "ignore", "pipe"] });
  console.log(`Готово: сводка будет собираться каждый день в ${time}.`);
  console.log("Если компьютер в это время выключен — придёт, когда включите. Выключить: npm run digest -- --unschedule");
  if (!readKey("TELEGRAM_CHAT_ID")) console.log("Telegram не подключён — сводка будет только в панели. Подключить: npm run telegram");
}

function unschedule() {
  if (process.platform !== "win32") return console.log("Уберите строку wb-kit из crontab (crontab -e).");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Unregister-ScheduledTask -TaskName ${psq(TASK_NAME)} -Confirm:$false`], { stdio: ["ignore", "ignore", "pipe"] });
    console.log("Расписание выключено.");
  } catch {
    console.log("Расписания и не было.");
  }
}

async function main() {
  loadEnv();
  const when = arg("--schedule");
  if (when) return schedule(when);
  if (process.argv.includes("--unschedule")) return unschedule();

  const demo = process.argv.includes("--demo");
  const scheduled = process.argv.includes("--scheduled");
  const dir = DIGEST_DIR(ROOT);
  mkdirSync(dir, { recursive: true });
  const today = localDate(new Date());
  const file = join(dir, `${today}${demo ? "-demo" : ""}.json`);
  // По расписанию — не больше одной сводки в день: задача могла сработать и утром, и при включении.
  if (scheduled && existsSync(file)) return console.log(`${new Date().toISOString()} сводка за сегодня уже есть — пропускаю.`);

  let client;
  if (demo) client = createDemoClient();
  else {
    const token = readKey("WB_API_TOKEN");
    if (!token) throw new Error("Нет ключа WB в .env. Запустите /setup или npm run check. Без ключа: npm run digest -- --demo");
    client = new WBClient({ token });
  }
  console.log(`${scheduled ? new Date().toISOString() + " " : ""}Собираю сводку — 1–2 минуты (лимиты WB)…`);
  const data = await collectDigest(client, { demo, log: (m) => console.log("  " + m) });
  const digest = analyzeDigest(data);
  writeFileSync(file, JSON.stringify({ data, digest }, null, 2));
  refreshPanel(ROOT, demo);
  const text = renderTelegram(digest);
  console.log(`\nГотово: ${relative(ROOT, file)}, панель обновлена.`);

  if (process.argv.includes("--no-send")) return;
  if (!readKey("TELEGRAM_BOT_TOKEN") || !readKey("TELEGRAM_CHAT_ID")) {
    if (!scheduled) console.log("Telegram не подключён — сводка только в панели. Подключить: npm run telegram");
    return;
  }
  try {
    await sendTelegram(text);
    console.log("Отправлено в Telegram.");
  } catch (e) {
    console.error(`В Telegram не ушло: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && /digest\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
