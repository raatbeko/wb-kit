/**
 * Ниша на WB по снимкам выдачи.
 *
 *   npm run niche -- --mine              — ниша продавца: его предметы и запросы для проверки
 *   npm run niche -- --demo              — демо на выдуманной нише «плед»
 *   npm run niche -- --dir <папка>       — отчёт из <папка>/raw/*.json (+ mpstats.json, если есть)
 *   npm run niche -- --dir <папка> --own 1,2   — свои артикулы вручную (без ключа WB)
 *   npm run niche -- --render <папка>    — пересобрать отчёт с insights.md
 *
 * Снимки делает Claude командой /niche: страница поиска WB «по популярности» и
 * «по новинкам» (&sort=newly), код competitors/extract-search.js на странице.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WBClient } from "../mcp/wb/src/client.js";
import { ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { fetchCards, type AuditData } from "../audit/collect.js";
import { loadCosts } from "../audit/cost.js";
import { markdownToHtml } from "../audit/render-html.js";
import { CardFetcher } from "../competitors/cdn.js";
import { localDate } from "../digest/digest.js";
import { buildNiche, nicheSummary, type NicheInput } from "../niche/niche.js";
import { demoNicheInput } from "../niche/demo.js";
import { renderNicheHtml, renderNicheXlsx } from "../niche/render.js";
import { refreshPanel } from "../panel/build.js";
import { readSales, validateSnapshot } from "./competitors.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Последний настоящий аудит: предметы с выручкой и доля WB. */
function lastAudit(): { data: AuditData; takeRate: number | null } | undefined {
  const reports = join(ROOT, "reports");
  if (!existsSync(reports)) return undefined;
  const dir = readdirSync(reports).filter((f) => /^audit-\d{4}-\d{2}-\d{2}$/.test(f)).sort().pop();
  if (!dir || !existsSync(join(reports, dir, "data.json"))) return undefined;
  const data = JSON.parse(readFileSync(join(reports, dir, "data.json"), "utf8")) as AuditData;
  let takeRate: number | null = null;
  try {
    takeRate = (JSON.parse(readFileSync(join(reports, dir, "summary.json"), "utf8")) as { economics?: { takeRate?: number | null } }).economics?.takeRate ?? null;
  } catch {
    // без доли WB вердикт просто не считает деньги со штуки
  }
  return { data, takeRate };
}

/** Ниша продавца: предметы по выручке и запросы, с которых начать. */
async function mine() {
  const a = lastAudit();
  const subjects = new Map<string, { revenue: number; products: string[] }>();
  if (a?.data.funnel.ok) {
    for (const p of a.data.funnel.data.products) {
      const s = subjects.get(p.subject) ?? { revenue: 0, products: [] };
      s.revenue += p.orderSum;
      if (s.products.length < 3) s.products.push(p.title);
      subjects.set(p.subject, s);
    }
  } else {
    const token = readKey("WB_API_TOKEN");
    if (!token) throw new Error("Нет ни аудита, ни ключа WB: спросите у человека, чем он торгует, и дайте запросы вручную.");
    for (const c of await fetchCards(new WBClient({ token }))) {
      const s = subjects.get(c.subject) ?? { revenue: 0, products: [] };
      if (s.products.length < 3) s.products.push(c.title);
      subjects.set(c.subject, s);
    }
  }
  const list = [...subjects].sort((x, y) => y[1].revenue - x[1].revenue).slice(0, 8);
  console.log(JSON.stringify({ source: a ? "аудит" : "карточки WB", subjects: list.map(([subject, v]) => ({ subject, revenue: Math.round(v.revenue), examples: v.products, query: subject.toLowerCase() })) }, null, 2));
}

async function render(dir: string, input: NicheInput) {
  const sales = readSales(join(dir, "mpstats.json"));
  if (sales) input = { ...input, sales };
  const report = buildNiche(input);
  const insightsPath = join(dir, "insights.md");
  const insights = existsSync(insightsPath) ? markdownToHtml(readFileSync(insightsPath, "utf8")) : undefined;
  const base = `Ниша WB${input.demo ? " ДЕМО" : ""} ${input.generatedAt.slice(0, 10)}`;
  writeFileSync(join(dir, `${base}.html`), renderNicheHtml(report, insights));
  try {
    await renderNicheXlsx(report, join(dir, `${base}.xlsx`));
  } catch (err) {
    console.error(`Excel не записан (возможно, файл открыт — закройте и повторите): ${err instanceof Error ? err.message : err}`);
  }
  writeFileSync(join(dir, "summary.json"), JSON.stringify(nicheSummary(report), null, 2));
  const rel = (f: string) => relative(ROOT, join(dir, f));
  console.log(`\nГотово${insights ? " (с выводами из insights.md)" : ""}:\n  отчёт:   ${rel(base + ".html")}\n  Excel:   ${rel(base + ".xlsx")}\n  выжимка: ${rel("summary.json")}`);
  refreshPanel(ROOT, input.demo);
  for (const q of report.queries) console.log(`«${q.query}»: ${q.verdict.title}`);
}

async function main() {
  loadEnv();
  if (process.argv.includes("--mine")) return mine();

  const renderDir = arg("--render");
  if (renderDir) {
    const dir = resolve(ROOT, renderDir);
    if (!existsSync(join(dir, "input.json"))) throw new Error(`Нет ${join(dir, "input.json")} — сначала: npm run niche -- --dir <папка>`);
    return render(dir, JSON.parse(readFileSync(join(dir, "input.json"), "utf8")) as NicheInput);
  }

  if (process.argv.includes("--demo")) {
    const dir = join(ROOT, "reports", `niche-${localDate(new Date())}-demo`);
    mkdirSync(dir, { recursive: true });
    const input = demoNicheInput();
    writeFileSync(join(dir, "input.json"), JSON.stringify(input));
    return render(dir, input);
  }

  const d = arg("--dir");
  if (!d) throw new Error("Укажите --dir <папка со снимками raw/*.json>, --mine или --demo");
  const dir = resolve(ROOT, d);
  const rawDir = join(dir, "raw");
  if (!existsSync(rawDir)) throw new Error(`Нет папки ${rawDir} со снимками выдачи`);
  const snapshots = readdirSync(rawDir).filter((f) => f.endsWith(".json")).map((f) => validateSnapshot(JSON.parse(readFileSync(join(rawDir, f), "utf8")), f));
  if (!snapshots.length) throw new Error(`В ${rawDir} нет снимков`);

  const ownArg = arg("--own");
  const a = lastAudit();
  let own: number[] = ownArg ? ownArg.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0) : a?.data.cards.ok ? a.data.cards.data.list.map((c) => c.nmId) : [];
  if (!own.length && readKey("WB_API_TOKEN")) {
    try {
      own = (await fetchCards(new WBClient({ token: readKey("WB_API_TOKEN")! }))).map((c) => c.nmId);
    } catch {
      // без своих артикулов отчёт покажет рынок
    }
  }
  const costs = Object.fromEntries((loadCosts() ?? []).filter((c) => c.cost !== null).map((c) => [String(c.nmId), c.cost!]));

  // Фото — по публичному CDN WB, только для карточек, которые попадут в отчёт.
  const ids = new Set<number>();
  for (const s of snapshots) for (const c of s.cards.slice(0, /sort=newly/.test(s.url) ? 30 : 45)) ids.add(c.nmId);
  console.log(`Ищу фото для ${ids.size} карточек на CDN WB — до минуты…`);
  const fetcher = new CardFetcher();
  const baskets: Record<string, number> = {};
  for (const id of ids) {
    const b = await fetcher.basket(id);
    if (b) baskets[String(id)] = b;
  }

  const input: NicheInput = { generatedAt: new Date().toISOString(), demo: false, snapshots, own, baskets, economy: { takeRate: a?.takeRate ?? null, costs } };
  writeFileSync(join(dir, "input.json"), JSON.stringify(input));
  await render(dir, input);
}

if (process.argv[1] && /niche\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
