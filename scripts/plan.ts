/**
 * План закупки.
 *
 *   npm run plan                       — по ключу из .env: на 3 месяца, срок поставки 21 день
 *   npm run plan -- --demo             — на выдуманном магазине, без ключа
 *   npm run plan -- --months 4 --lead 30 --safety 20
 *   npm run plan -- --no-season        — без истории за год: быстрее (1 запрос), но без сезона
 *   npm run plan -- --render <папка>   — пересобрать отчёт из data.json (например, с insights.md)
 *
 * Результат — папка reports/plan-ГГГГ-ММ-ДД[-demo]: HTML с фото, Excel, data.json, summary.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WBClient } from "../mcp/wb/src/client.js";
import { ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { createDemoClient, DEMO_COSTS } from "../audit/demo.js";
import { loadCosts } from "../audit/cost.js";
import { markdownToHtml } from "../audit/render-html.js";
import { CardFetcher } from "../competitors/cdn.js";
import { localDate } from "../digest/digest.js";
import { buildPlan, collectPlan, planSummary, type PlanData } from "../plan/plan.js";
import { renderPlanHtml, renderPlanXlsx } from "../plan/render.js";
import { refreshPanel } from "../panel/build.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numArg(name: string, def: number, min: number, max: number, hint: string): number {
  const v = arg(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: ${hint}`);
  return n;
}

async function render(dir: string, d: PlanData) {
  const months = numArg("--months", 3, 1, 6, "от 1 до 6 месяцев");
  const leadDays = numArg("--lead", 21, 1, 120, "срок поставки от 1 до 120 дней");
  const safety = numArg("--safety", 15, 0, 100, "запас от 0 до 100%") / 100;
  if (!d.demo) d.costs = loadCosts() ?? d.costs ?? null;
  const report = buildPlan(d, { months, leadDays, safety });
  const insightsPath = join(dir, "insights.md");
  const insights = existsSync(insightsPath) ? markdownToHtml(readFileSync(insightsPath, "utf8")) : undefined;
  const date = d.today.slice(8, 10) + "." + d.today.slice(5, 7);
  const base = `План закупки${d.demo ? " ДЕМО" : ""} ${date}`;
  writeFileSync(join(dir, `${base}.html`), renderPlanHtml(report, insights));
  try {
    await renderPlanXlsx(report, join(dir, `${base}.xlsx`));
  } catch (err) {
    console.error(`Excel не записан (возможно, файл открыт — закройте и повторите): ${err instanceof Error ? err.message : err}`);
  }
  writeFileSync(join(dir, "summary.json"), JSON.stringify(planSummary(report), null, 2));
  const rel = (f: string) => relative(ROOT, join(dir, f));
  console.log(`\nГотово${insights ? " (с выводами из insights.md)" : ""}:`);
  console.log(`  отчёт:   ${rel(base + ".html")}`);
  console.log(`  Excel:   ${rel(base + ".xlsx")}`);
  console.log(`  выжимка: ${rel("summary.json")}`);
  refreshPanel(ROOT, d.demo);
  const t = report.totals;
  console.log(`\nЗаказать: ${t.toOrder.toLocaleString("ru-RU")} шт${t.money !== null ? ` на ${t.money.toLocaleString("ru-RU")} ₽` : ""}, срочно — ${t.urgent} ${t.urgent === 1 ? "товар" : "товаров"}.`);
  for (const n of report.notes) console.log(n);
  if (report.unavailable.length) console.log(`Нет в плане: ${report.unavailable.map((u) => `${u.section} (${u.reason})`).join("; ")}`);
}

async function main() {
  loadEnv();
  const renderDir = arg("--render");
  if (renderDir) {
    const dir = resolve(ROOT, renderDir);
    if (!existsSync(join(dir, "data.json"))) throw new Error(`Нет ${join(dir, "data.json")} — сначала: npm run plan`);
    return render(dir, JSON.parse(readFileSync(join(dir, "data.json"), "utf8")) as PlanData);
  }

  const demo = process.argv.includes("--demo");
  const season = !process.argv.includes("--no-season");
  let client;
  if (demo) client = createDemoClient();
  else {
    const token = readKey("WB_API_TOKEN");
    if (!token) throw new Error("Нет ключа WB в .env. Запустите /setup или npm run check. Без ключа: npm run plan -- --demo");
    client = new WBClient({ token });
  }
  console.log(season ? "Собираю данные для плана — около 5 минут (история за год, WB отдаёт 3 запроса в минуту)…" : "Собираю данные для плана — около минуты…");
  const d = await collectPlan(client, { demo, season, costs: demo ? DEMO_COSTS : loadCosts(), log: (m) => console.log("  " + m) });

  // Фото — с публичного CDN WB, только для товаров в плане. В демо артикулы выдуманные — фото нет.
  if (!demo && d.products.ok && !process.argv.includes("--no-photos")) {
    const ids = buildPlan(d).rows.filter((r) => r.toOrder > 0 || r.overstock).slice(0, 80).map((r) => r.nmId);
    const fetcher = new CardFetcher();
    d.baskets = {};
    for (const id of ids) {
      const b = await fetcher.basket(id);
      if (b) d.baskets[String(id)] = b;
    }
  }

  // Дата папки — сегодняшняя по часам компьютера, как у других отчётов.
  const dir = join(ROOT, "reports", `plan-${localDate(new Date())}${demo ? "-demo" : ""}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), JSON.stringify(d));
  await render(dir, d);
}

if (process.argv[1] && /plan\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
