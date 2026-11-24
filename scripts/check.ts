/**
 * Проверка установки wb-kit: `npm run check` (или `npm run check -- --json`).
 *
 * Что делает: проверяет Node, создаёт .env из шаблона, читает срок ключа WB,
 * пингует каждую категорию API и показывает, какие возможности набора будут
 * работать. Ключи на экран не выводит. Нужен клиенту, который остаётся без
 * сопровождения: любая проблема описана словами и с тем, как её исправить.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeToken, pingAll, type PingResult } from "../mcp/wb/src/diagnostics.js";
import { ENV_PATH, ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";

const asJson = process.argv.includes("--json");

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

/** Возможности набора и категории ключа WB, без которых они не работают. */
export const FEATURES: { name: string; needs: string[]; optional?: string[] }[] = [
  { name: "Аудит: продажи, заказы, ABC-анализ", needs: ["statistics"] },
  { name: "Аудит: воронка, остатки на складах WB, поисковые запросы", needs: ["analytics"] },
  { name: "Аудит: деньги (финотчёт, удержания WB)", needs: ["finance"] },
  { name: "Аудит: карточки товаров", needs: ["content"] },
  { name: "/card: тексты карточки под поисковые запросы", needs: ["content", "analytics"] },
  { name: "/plan: план закупки по месяцам", needs: ["analytics"] },
  { name: "Утренняя сводка: заказы и остатки", needs: ["statistics", "analytics"] },
  { name: "Аудит: цены и скидки", needs: ["prices"] },
  { name: "Отзывы и вопросы", needs: ["feedbacks"] },
  { name: "Реклама: расходы и статистика", needs: ["promotion"] },
  { name: "Возвраты", needs: ["returns"] },
  { name: "FBS: склады продавца, сборочные задания", needs: ["marketplace"] },
];

export function featureMap(pings: PingResult[]) {
  const ok = new Set(pings.filter((p) => p.ok).map((p) => p.key));
  return FEATURES.map((f) => ({ name: f.name, available: f.needs.every((n) => ok.has(n)), missing: f.needs.filter((n) => !ok.has(n)) }));
}

async function main() {
  const checks: Check[] = [];

  // 1. Node
  const [maj, min] = process.versions.node.split(".").map(Number) as [number, number];
  const nodeOk = maj > 20 || (maj === 20 && min >= 12);
  checks.push({
    name: "Node.js",
    status: nodeOk ? "ok" : "fail",
    detail: `версия ${process.versions.node}`,
    fix: nodeOk ? undefined : "Установите Node.js 22 LTS с nodejs.org и перезапустите терминал.",
  });

  // 2. .env
  let createdEnv = false;
  if (!existsSync(ENV_PATH)) {
    copyFileSync(join(ROOT, ".env.example"), ENV_PATH);
    createdEnv = true;
  }
  loadEnv();
  checks.push({
    name: "Файл .env",
    status: createdEnv ? "warn" : "ok",
    detail: createdEnv ? "создан из шаблона, ключи пока не вписаны" : "есть",
    fix: createdEnv ? `Откройте ${ENV_PATH} и вставьте ключ WB после WB_API_TOKEN=` : undefined,
  });

  // 3. Ключ WB
  const token = readKey("WB_API_TOKEN");
  let pings: PingResult[] = [];
  if (!token) {
    checks.push({
      name: "Ключ WB",
      status: "fail",
      detail: "не вписан",
      fix: "Кабинет WB → Настройки → Доступ к API → Создать токен (можно «Только на чтение», отметьте все категории). Вставьте его в .env после WB_API_TOKEN=",
    });
  } else {
    const info = decodeToken(token);
    if (!info.valid) {
      checks.push({ name: "Ключ WB", status: "fail", detail: info.problem ?? "ключ не читается", fix: "Создайте новый ключ в кабинете WB и вставьте его в .env." });
    } else {
      const soon = info.daysLeft !== undefined && info.daysLeft < 14;
      checks.push({
        name: "Ключ WB",
        status: soon ? "warn" : "ok",
        detail: info.expiresAt ? `действует до ${info.expiresAt} (осталось дней: ${info.daysLeft})${info.isTest ? ", тестовый" : ""}` : "срок не указан",
        fix: soon ? "Скоро закончится: создайте новый ключ в кабинете WB заранее." : undefined,
      });
      pings = await pingAll(token);
      const ok = pings.filter((p) => p.ok).length;
      checks.push({
        name: "Доступ к API WB",
        status: ok === 0 ? "fail" : ok < pings.length ? "warn" : "ok",
        detail: `категорий доступно: ${ok} из ${pings.length}`,
        fix:
          ok === 0
            ? pings.every((p) => /связи|вовремя/.test(p.reason ?? ""))
              ? "WB недоступен: проверьте интернет, VPN или прокси."
              : "WB не принимает ключ. Скопируйте его заново целиком или создайте новый."
            : ok < pings.length
              ? "Чтобы включить недостающее, создайте ключ с этими категориями (Настройки → Доступ к API)."
              : undefined,
      });
    }
  }

  // 4. Необязательные ключи
  const tg = readKey("TELEGRAM_BOT_TOKEN"), tgChat = readKey("TELEGRAM_CHAT_ID");
  checks.push({
    name: "Сводка в Telegram",
    status: tg && tgChat ? "ok" : "warn",
    detail: tg && tgChat ? "бот и чат подключены" : tg ? "токен есть, чат не привязан" : "не настроена (необязательно)",
    fix: tg && !tgChat ? "Откройте своего бота, нажмите «Start» и выполните npm run telegram." : undefined,
  });
  checks.push({
    name: "Telegram-бот",
    status: readKey("ANTHROPIC_API_KEY") && readKey("TELEGRAM_BOT_TOKEN") ? "ok" : "warn",
    detail: readKey("ANTHROPIC_API_KEY") && readKey("TELEGRAM_BOT_TOKEN") ? "ключи вписаны" : "не настроен (нужен только для бота 24/7)",
  });

  const features = featureMap(pings);
  const failed = checks.some((c) => c.status === "fail");

  if (asJson) {
    console.log(JSON.stringify({ ok: !failed, checks, categories: pings, features }, null, 2));
  } else {
    const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;
    console.log("\nПроверка wb-kit\n");
    for (const c of checks) {
      console.log(`${icon[c.status]} ${c.name}: ${c.detail}`);
      if (c.fix) console.log(`   → ${c.fix}`);
    }
    if (pings.length) {
      console.log("\nКатегории ключа WB:");
      for (const p of pings) console.log(`  ${p.ok ? "✅" : "❌"} ${p.title} — ${p.ok ? p.usedFor : p.reason}`);
      console.log("\nЧто будет работать:");
      for (const f of features) console.log(`  ${f.available ? "✅" : "❌"} ${f.name}`);
    }
    console.log(failed ? "\nЕсть что исправить — см. стрелки выше.\n" : "\nВсё готово. В Claude Code напишите /audit — получите отчёт по магазину.\n");
  }
  process.exitCode = failed ? 1 : 0;
}

// Запуск только как скрипт: тесты импортируют FEATURES и featureMap без побочных эффектов.
if (process.argv[1] && /check\.ts$/.test(process.argv[1])) await main();
