/**
 * Отчёт о конкурентах по снимкам выдачи WB.
 *
 *   npm run competitors -- --demo                  — демо на выдуманных данных
 *   npm run competitors -- --dir <папка>           — собрать отчёт из <папка>/raw/*.json
 *   npm run competitors -- --dir <папка> --own 1,2 — свои артикулы вручную (без ключа WB)
 *   npm run competitors -- --render <папка>        — пересобрать отчёт с insights.md
 *
 * Снимки выдачи (raw/*.json) делает Claude в браузере командой /competitors:
 * открывает поиск WB и запускает competitors/extract-search.js на странице.
 * История снимков копится в data/competitors/history.jsonl — по ней видно,
 * что изменилось с прошлой проверки.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HOSTS, WBClient } from "../mcp/wb/src/client.js";
import { ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { buildCompetitorReport, competitorSummary, LEADERS, type CompetitorInput, type OwnProduct, type SalesData, type SearchCard, type SearchSnapshot } from "../competitors/analyze.js";
import { CardFetcher, type CardDetails } from "../competitors/cdn.js";
import { demoCompetitorInput } from "../competitors/demo.js";
import { refreshPanel } from "../panel/build.js";
import { renderCompetitorHtml, renderCompetitorXlsx } from "../competitors/render.js";

const HISTORY = join(ROOT, "data", "competitors", "history.jsonl");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Снимок от extract-search.js приходит компактно: fields + rows (массивы значений).
 * Разворачиваем в карточки; полный формат с cards тоже принимаем.
 */
export function validateSnapshot(x: unknown, file: string): SearchSnapshot {
  const raw = x as { query?: unknown; url?: string; scannedAt?: string; cards?: SearchCard[]; fields?: string[]; rows?: unknown[][] };
  if (!raw || typeof raw.query !== "string") throw new Error(`${file}: это не снимок выдачи (нет поля query)`);
  let cards: SearchCard[];
  if (Array.isArray(raw.rows) && Array.isArray(raw.fields)) {
    const f = raw.fields;
    cards = raw.rows.map((r) => {
      const o = Object.fromEntries(f.map((k, i) => [k, r[i]])) as Record<string, unknown>;
      return {
        position: Number(o["position"]),
        nmId: Number(o["nmId"]),
        brand: (o["brand"] as string | null) ?? null,
        name: (o["name"] as string | null) ?? null,
        price: (o["price"] as number | null) ?? null,
        oldPrice: (o["oldPrice"] as number | null) ?? null,
        priceIsWallet: Boolean(o["wallet"]),
        rating: (o["rating"] as number | null) ?? null,
        reviews: (o["reviews"] as number | null) ?? null,
        delivery: (o["delivery"] as string | null) ?? null,
        labels: Array.isArray(o["labels"]) ? (o["labels"] as string[]) : [],
        ad: false,
      };
    });
  } else if (Array.isArray(raw.cards)) {
    cards = raw.cards;
  } else {
    throw new Error(`${file}: это не снимок выдачи (нужны fields и rows или cards)`);
  }
  if (!cards.length) throw new Error(`${file}: в снимке нет карточек — страница поиска не успела загрузиться?`);
  return { query: raw.query, url: raw.url ?? "", scannedAt: raw.scannedAt ?? new Date().toISOString(), cards };
}

export function readHistory(file = HISTORY): SearchSnapshot[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as SearchSnapshot;
      } catch {
        return null;
      }
    })
    .filter((s): s is SearchSnapshot => s !== null);
}

/** Прошлый снимок — последний по этому запросу, сделанный не в тот же день. */
export function previousFor(history: SearchSnapshot[], current: SearchSnapshot[]): SearchSnapshot[] {
  return current
    .map((c) =>
      history
        .filter((h) => h.query === c.query && h.scannedAt.slice(0, 10) < c.scannedAt.slice(0, 10))
        .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))[0],
    )
    .filter((s): s is SearchSnapshot => Boolean(s));
}

async function ownFromWb(): Promise<OwnProduct[]> {
  loadEnv();
  const token = readKey("WB_API_TOKEN");
  if (!token) return [];
  const client = new WBClient({ token });
  const own: OwnProduct[] = [];
  let cursor: Record<string, unknown> = { limit: 100 };
  try {
    for (let page = 0; page < 50; page++) {
      const res = await client.post<{ cards?: Record<string, unknown>[]; cursor?: Record<string, unknown> }>(HOSTS.content, "/content/v2/get/cards/list", {
        settings: { cursor, filter: { withPhoto: -1 } },
      });
      const cards = res?.cards ?? [];
      for (const c of cards) own.push({ nmId: Number(c["nmID"]), vendorCode: String(c["vendorCode"] ?? ""), title: String(c["title"] ?? "") });
      if (cards.length < 100) break;
      cursor = { limit: 100, updatedAt: res?.cursor?.["updatedAt"], nmID: res?.cursor?.["nmID"] };
    }
  } catch (err) {
    console.error(`Не удалось получить свои товары по ключу WB (${err instanceof Error ? err.message : err}). Укажите артикулы вручную: --own 123,456`);
  }
  return own;
}

async function fetchDetails(snaps: SearchSnapshot[], own: OwnProduct[]): Promise<Record<string, CardDetails>> {
  const ownIds = new Set(own.map((o) => o.nmId));
  const ids = new Set<number>();
  for (const s of snaps) for (const c of s.cards) if (c.position <= LEADERS || ownIds.has(c.nmId)) ids.add(c.nmId);
  console.error(`Загружаю описания ${ids.size} карточек из открытых данных WB…`);
  const fetcher = new CardFetcher();
  const out: Record<string, CardDetails> = {};
  for (const id of ids) {
    const d = await fetcher.get(id);
    if (d) out[String(id)] = d;
  }
  console.error(`Описаний получено: ${Object.keys(out).length} из ${ids.size}.`);
  return out;
}

/**
 * Продажи MPSTATS кладёт Claude в mpstats.json (формат ответа MPSTATS он разбирает сам):
 * { "source": "MPSTATS", "period": { "from": "ГГГГ-ММ-ДД", "to": "ГГГГ-ММ-ДД" },
 *   "items": [ { "nmId": 123, "sales": 456, "revenue": 789000 } ] }
 */
export function readSales(file: string): SalesData | undefined {
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { source?: string; period?: { from?: string; to?: string }; items?: unknown[] };
  if (!Array.isArray(raw.items)) throw new Error(`${file}: нужен массив items с полями nmId, sales, revenue`);
  const items: SalesData["items"] = {};
  for (const it of raw.items as Record<string, unknown>[]) {
    const nmId = Number(it["nmId"]);
    const sales = Number(it["sales"]);
    const revenue = Number(it["revenue"]);
    if (!Number.isInteger(nmId) || !Number.isFinite(sales) || !Number.isFinite(revenue)) {
      throw new Error(`${file}: строка ${JSON.stringify(it)} — nmId, sales и revenue должны быть числами`);
    }
    items[String(nmId)] = { sales, revenue };
  }
  return { source: raw.source ?? "MPSTATS", period: { from: raw.period?.from ?? "?", to: raw.period?.to ?? "?" }, items };
}

async function render(dir: string, input: CompetitorInput) {
  const sales = readSales(join(dir, "mpstats.json"));
  if (sales) input = { ...input, sales };
  const report = buildCompetitorReport(input);
  const insightsPath = join(dir, "insights.md");
  const insights = existsSync(insightsPath) ? readFileSync(insightsPath, "utf8") : undefined;
  const base = `Конкуренты WB${input.demo ? " ДЕМО" : ""} ${input.generatedAt.slice(0, 10)}`;
  writeFileSync(join(dir, `${base}.html`), renderCompetitorHtml(report, insights));
  try {
    await renderCompetitorXlsx(report, join(dir, `${base}.xlsx`));
  } catch (err) {
    console.error(`Не удалось записать Excel (возможно, файл открыт — закройте и повторите): ${err instanceof Error ? err.message : err}`);
  }
  writeFileSync(join(dir, "summary.json"), JSON.stringify(competitorSummary(report), null, 2));
  const rel = (f: string) => relative(ROOT, join(dir, f));
  console.log(`\nГотово${insights ? " (с выводами из insights.md)" : ""}:`);
  console.log(`  отчёт:   ${rel(`${base}.html`)}`);
  console.log(`  Excel:   ${rel(`${base}.xlsx`)}`);
  console.log(`  выжимка: ${rel("summary.json")}`);
  refreshPanel(ROOT, input.demo);
  console.log(`\nЗапросов: ${report.queries.length}. Важного: ${report.findings.length} (срочного: ${report.findings.filter((f) => f.priority === "high").length}).`);
}

async function main() {
  const renderDir = arg("--render");
  if (renderDir) {
    const dir = resolve(ROOT, renderDir);
    const p = join(dir, "data.json");
    if (!existsSync(p)) throw new Error(`Нет файла ${p}. Сначала соберите отчёт.`);
    await render(dir, JSON.parse(readFileSync(p, "utf8")) as CompetitorInput);
    return;
  }

  if (process.argv.includes("--demo")) {
    const input = demoCompetitorInput();
    const dir = join(ROOT, "reports", `competitors-${input.generatedAt.slice(0, 10)}-demo`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "data.json"), JSON.stringify(input));
    await render(dir, input);
    return;
  }

  const dirArg = arg("--dir");
  if (!dirArg) throw new Error("Укажите папку со снимками: --dir reports/competitors-ГГГГ-ММ-ДД (или --demo)");
  const dir = resolve(ROOT, dirArg);
  const rawDir = join(dir, "raw");
  if (!existsSync(rawDir)) throw new Error(`Нет папки ${rawDir}: сначала снимите выдачу командой /competitors`);
  const snapshots = readdirSync(rawDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => validateSnapshot(JSON.parse(readFileSync(join(rawDir, f), "utf8")), f));
  if (!snapshots.length) throw new Error(`В ${rawDir} нет снимков выдачи`);

  const ownArg = arg("--own");
  const own: OwnProduct[] = ownArg
    ? ownArg.split(",").map((s) => ({ nmId: Number(s.trim()) })).filter((o) => Number.isInteger(o.nmId) && o.nmId > 0)
    : await ownFromWb();
  if (!own.length) console.error("Свои товары не заданы: отчёт покажет рынок, но без сравнения с вашими карточками. Добавьте ключ WB или --own 123,456.");

  const details = process.argv.includes("--no-details") ? {} : await fetchDetails(snapshots, own);
  const input: CompetitorInput = {
    generatedAt: new Date().toISOString(),
    demo: false,
    snapshots,
    own,
    details,
    previous: previousFor(readHistory(), snapshots),
  };
  writeFileSync(join(dir, "data.json"), JSON.stringify(input));

  // В историю — только то, что нужно для сравнения в следующий раз.
  mkdirSync(join(ROOT, "data", "competitors"), { recursive: true });
  for (const s of snapshots) appendFileSync(HISTORY, `${JSON.stringify(s)}\n`);

  await render(dir, input);
}

if (process.argv[1] && /competitors\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`Ошибка: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
