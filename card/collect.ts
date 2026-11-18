/**
 * Сбор данных для `/card`: своя карточка (API контента), поисковые запросы по ней
 * (аналитика WB) и карточки конкурентов (публичный CDN). Ничего не меняет в кабинете.
 */
import { HOSTS, LIMITER_KEYS, type WBClient } from "../mcp/wb/src/client.js";
import { explainFailure } from "../audit/collect.js";
import type { SearchSnapshot } from "../competitors/analyze.js";
import { parseCardText, type CardFetcher } from "../competitors/cdn.js";
import { stems } from "./text.js";
import type { CardInput, CardText, Characteristic, SearchText } from "./analyze.js";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function charValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join("; ");
  return v === null || v === undefined ? "" : String(v);
}

export function ownFromContent(c: Row): CardText {
  const chars: Characteristic[] = (Array.isArray(c["characteristics"]) ? (c["characteristics"] as Row[]) : [])
    .map((x) => ({ name: String(x["name"] ?? ""), value: charValue(x["value"]) }))
    .filter((x) => x.name && x.value);
  return {
    nmId: Number(c["nmID"]),
    vendorCode: String(c["vendorCode"] ?? ""),
    brand: String(c["brand"] ?? ""),
    subject: String(c["subjectName"] ?? ""),
    title: String(c["title"] ?? ""),
    description: String(c["description"] ?? ""),
    characteristics: chars,
    photos: Array.isArray(c["photos"]) ? (c["photos"] as unknown[]).length : 0,
    hasVideo: Boolean(c["video"]),
  };
}

/** Карточка по артикулу WB или артикулу продавца. */
export async function findOwnCard(client: WBClient, id: string): Promise<CardText> {
  const res = await client.post<{ cards?: Row[] }>(HOSTS.content, "/content/v2/get/cards/list", {
    settings: { cursor: { limit: 100 }, filter: { textSearch: id, withPhoto: -1 } },
  });
  const cards = res?.cards ?? [];
  const hit = cards.find((c) => String(c["nmID"]) === id) ?? cards.find((c) => String(c["vendorCode"]).toLowerCase() === id.toLowerCase());
  if (!hit) {
    const near = cards.slice(0, 5).map((c) => `${c["nmID"]} ${c["vendorCode"]}`).join(", ");
    throw new Error(`Карточка «${id}» не найдена среди ваших товаров${near ? `. Похожие: ${near}` : ""}. Укажите артикул WB (число) или точный артикул продавца.`);
  }
  return ownFromContent(hit);
}

export function parseSearchTexts(res: unknown, nmId: number): SearchText[] {
  const items = ((res as { data?: { items?: Row[] } })?.data?.items ?? []) as Row[];
  const cur = (x: unknown) => {
    const v = (x as { current?: unknown } | undefined)?.current;
    return typeof v === "number" ? v : null;
  };
  // Подменённые артикулы (includeSubstitutedSKUs) приходят отдельными строками — считаем только свой.
  const mine = items.filter((i) => Number(i["nmId"]) === nmId);
  const byText = new Map<string, SearchText>();
  for (const i of mine.length ? mine : items) {
    const text = String(i["text"] ?? "").trim();
    if (!text) continue;
    const q: SearchText = {
      text,
      frequency: cur(i["frequency"]) ?? 0,
      weekFrequency: typeof i["weekFrequency"] === "number" ? (i["weekFrequency"] as number) : null,
      avgPosition: cur(i["avgPosition"]),
      openCard: cur(i["openCard"]),
      orders: cur(i["orders"]),
    };
    const was = byText.get(text.toLowerCase());
    if (!was || was.frequency < q.frequency) byText.set(text.toLowerCase(), q);
  }
  return [...byText.values()].sort((a, b) => b.frequency - a.frequency);
}

async function searchTexts(client: WBClient, nmId: number, from: string, to: string): Promise<SearchText[]> {
  const body = (limit: number) => ({
    currentPeriod: { start: from, end: to },
    nmIds: [nmId],
    topOrderBy: "openCard",
    includeSubstitutedSKUs: true,
    includeSearchTexts: true,
    orderBy: { field: "openCard", mode: "desc" },
    limit,
  });
  const call = (limit: number) =>
    client.post(HOSTS.analytics, "/api/v2/search-report/product/search-texts", body(limit), undefined, { limiterKey: LIMITER_KEYS.searchTexts });
  try {
    // 100 запросов — только с тарифом «Джем» Продвинутый/Премиум; без него WB вернёт ошибку, тогда 30.
    return parseSearchTexts(await call(100), nmId);
  } catch {
    return parseSearchTexts(await call(30), nmId);
  }
}

/**
 * Конкуренты из последней проверки `/competitors`: снимок выдачи по запросу, который
 * ближе всего к спросу на товар (самый частый поисковый запрос из найденных).
 */
export function competitorsFromHistory(history: SearchSnapshot[], own: CardText, queries: SearchText[], limit = 10): { ids: number[]; from: string } | null {
  if (!history.length) return null;
  const latest = new Map<string, SearchSnapshot>();
  for (const s of history) if (!latest.has(s.query) || latest.get(s.query)!.scannedAt < s.scannedAt) latest.set(s.query, s);
  const key = (t: string) => stems(t).sort().join(" ");
  const demand = new Map(queries.map((q) => [key(q.text), q.frequency]));
  const ownTitle = new Set(stems(own.title));
  let best: { snap: SearchSnapshot; score: number } | null = null;
  for (const snap of latest.values()) {
    const k = key(snap.query);
    const score = demand.get(k) ?? (stems(snap.query).every((s) => ownTitle.has(s)) ? 0.5 : 0);
    if (score > 0 && (!best || score > best.score || (score === best.score && snap.scannedAt > best.snap.scannedAt))) best = { snap, score };
  }
  if (!best) return null;
  const cards = best.snap.cards.filter((c) => c.nmId !== own.nmId);
  const organic = cards.filter((c) => !c.ad);
  const ids = (organic.length >= limit ? organic : cards).slice(0, limit).map((c) => c.nmId);
  return { ids, from: `выдача «${best.snap.query}» от ${new Date(best.snap.scannedAt).toLocaleDateString("ru-RU")}` };
}

export async function collectCard(opts: {
  client: WBClient;
  id: string;
  fetcher: CardFetcher;
  history: SearchSnapshot[];
  competitorIds?: number[];
  days?: number;
  now?: Date;
  log?: (m: string) => void;
}): Promise<CardInput> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const to = day(now.getTime() - DAY);
  const from = day(now.getTime() - (opts.days ?? 30) * DAY);

  const own = await findOwnCard(opts.client, opts.id);
  log(`✓ карточка ${own.nmId} ${own.vendorCode}: «${own.title}»`);

  let queries: SearchText[] = [];
  let searchTextsError: string | undefined;
  try {
    queries = await searchTexts(opts.client, own.nmId, from, to);
    log(`✓ поисковые запросы: ${queries.length}`);
    if (!queries.length) searchTextsError = "за период по товару нет данных — так бывает у новых товаров и товаров без показов в поиске";
  } catch (err) {
    searchTextsError = explainFailure(err);
    log(`✗ поисковые запросы: ${searchTextsError}`);
  }

  let ids = opts.competitorIds ?? [];
  let competitorsFrom = ids.length ? "указаны вручную" : undefined;
  if (!ids.length) {
    const auto = competitorsFromHistory(opts.history, own, queries);
    if (auto) ({ ids, from: competitorsFrom } = auto);
  }
  const competitors: CardText[] = [];
  for (const nmId of ids) {
    const j = await opts.fetcher.getRaw(nmId);
    if (j) competitors.push(parseCardText(nmId, j));
  }
  if (ids.length) log(`✓ карточки конкурентов: ${competitors.length} из ${ids.length} (${competitorsFrom})`);
  else log("· конкуренты не указаны и проверок /competitors по этому товару нет — сравнение с лидерами пропущено");

  return { generatedAt: now.toISOString(), period: { from, to }, own, searchTexts: queries, searchTextsError, competitors, competitorsFrom };
}
