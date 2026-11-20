/**
 * Аудит кабинета WB.
 *
 *   npm run audit                      — собрать данные по ключу из .env и сделать отчёт
 *   npm run audit -- --demo            — то же на выдуманном магазине, без ключа
 *   npm run audit -- --days 14         — другой период (по умолчанию 30 дней)
 *   npm run audit -- --render <папка>  — пересобрать отчёт из data.json, добавив insights.md
 *
 * Результат — папка reports/audit-ГГГГ-ММ-ДД: HTML-отчёт, Excel, data.json (все
 * данные) и summary.json (выжимка, по которой Claude пишет выводы в insights.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WBClient } from "../mcp/wb/src/client.js";
import { ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { collectAudit, type AuditData } from "../audit/collect.js";
import { createDemoClient, DEMO_COSTS } from "../audit/demo.js";
import { loadCosts } from "../audit/cost.js";
import { buildReport, summaryForClaude } from "../audit/analyze.js";
import { renderHtml } from "../audit/render-html.js";
import { renderXlsx } from "../audit/render-xlsx.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function reportNames(d: AuditData) {
  const date = d.generatedAt.slice(0, 10);
  const base = `Аудит WB${d.demo ? " ДЕМО" : ""} ${date}`;
  return { html: `${base}.html`, xlsx: `${base}.xlsx` };
}

async function render(dir: string, d: AuditData) {
  // Себестоимость могли вписать уже после сбора — при пересборке берём свежий файл.
  if (!d.demo) d.costs = loadCosts() ?? d.costs ?? null;
  const report = buildReport(d);
  const insightsPath = join(dir, "insights.md");
  const insights = existsSync(insightsPath) ? readFileSync(insightsPath, "utf8") : undefined;
  const names = reportNames(d);
  writeFileSync(join(dir, names.html), renderHtml(report, insights));
  try {
    await renderXlsx(report, join(dir, names.xlsx));
  } catch (err) {
    // Чаще всего файл открыт в Excel и заблокирован — HTML при этом уже готов.
    console.error(`Не удалось записать Excel (возможно, файл открыт в Excel — закройте его и повторите): ${err instanceof Error ? err.message : err}`);
  }
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summaryForClaude(report), null, 2));
  const rel = (f: string) => relative(ROOT, join(dir, f));
  console.log(`\nГотово${insights ? " (с выводами из insights.md)" : ""}:`);
  console.log(`  отчёт:   ${rel(names.html)}`);
  console.log(`  Excel:   ${rel(names.xlsx)}`);
  console.log(`  выжимка: ${rel("summary.json")}`);
  console.log(`\nНайдено проблем: ${report.issues.length} (срочных: ${report.issues.filter((i) => i.priority === "high").length}).`);
  const e = report.economics;
  if (e && e.costCoverage < 100) console.log(`Себестоимость есть для ${e.costCoverage}% выручки. Без неё прибыль не посчитать — заполните data/cost.csv (npm run cost -- --init).`);
  if (report.unavailable.length) console.log(`Нет в отчёте: ${report.unavailable.map((u) => `${u.section} (${u.reason})`).join("; ")}`);
}

async function main() {
  const renderDir = arg("--render");
  if (renderDir) {
    const dir = resolve(ROOT, renderDir);
    const dataPath = join(dir, "data.json");
    if (!existsSync(dataPath)) throw new Error(`Нет файла ${dataPath} — сначала соберите аудит: npm run audit`);
    await render(dir, JSON.parse(readFileSync(dataPath, "utf8")) as AuditData);
    return;
  }

  const demo = process.argv.includes("--demo");
  const days = Number(arg("--days") ?? 30);
  if (!Number.isInteger(days) || days < 7 || days > 60) throw new Error("--days: от 7 до 60 (статистика WB хранится 90 дней, нужен ещё прошлый период для сравнения)");

  let client;
  if (demo) {
    client = createDemoClient();
  } else {
    loadEnv();
    const token = readKey("WB_API_TOKEN");
    if (!token) {
      console.error("Ключ WB не настроен. Запустите /setup в Claude Code или впишите ключ в .env.\nПосмотреть, как выглядит отчёт, можно без ключа: npm run audit -- --demo");
      process.exitCode = 1;
      return;
    }
    client = new WBClient({ token });
  }

  console.error(`Собираю данные за ${days} дней${demo ? " (демо-магазин)" : ""}. С настоящим ключом это 1–3 минуты: WB отдаёт отчёты не чаще раза в минуту.`);
  const data = await collectAudit(client, { days, demo, costs: demo ? DEMO_COSTS : loadCosts(), log: (m) => console.error(m) });
  const dir = join(ROOT, "reports", `audit-${data.generatedAt.slice(0, 10)}${demo ? "-demo" : ""}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), JSON.stringify(data));
  await render(dir, data);
}

if (process.argv[1] && /audit\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`Ошибка: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
