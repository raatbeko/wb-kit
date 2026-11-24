/**
 * Ниша: что продаётся по запросам покупателей, на какие сегменты делится выдача,
 * какие новинки уже пробились наверх и стоит ли туда заходить.
 *
 * Источник — видимые страницы поиска WB (снимки делает Claude в браузере тем же
 * extract-search.js, что и для /competitors): сортировка «по популярности» и
 * «по новинкам». Продажи — только если подключён MPSTATS (mpstats.json).
 * Пороги — в NT. Вердикт — эвристика по цифрам выдачи, не прогноз продаж.
 */
import { median, plural } from "../audit/analyze.js";
import { quantile, type SalesData, type SearchCard, type SearchSnapshot } from "../competitors/analyze.js";
import { normalize, stem, words } from "../card/text.js";

export const NT = {
  /** Сколько первых карточек считаем «лидерами». */
  top: 30,
  /** Отзывов у медианного лидера больше — новому товару тяжело догнать. */
  hardReviews: 1500,
  /** Доля трёх крупнейших брендов в лидерах — выше значит, нишу держат бренды. */
  brandShare: 0.5,
  /** Новинка «набирает», если у неё уже столько отзывов. */
  newMinReviews: 10,
  /** Сегмент — слово, которое встречается хотя бы в такой доле названий… */
  segMin: 0.06,
  /** …но не почти во всех (тогда это не сегмент, а сам запрос). */
  segMax: 0.7,
  segments: 6,
};

export interface NicheInput {
  generatedAt: string;
  demo: boolean;
  snapshots: SearchSnapshot[];
  /** Артикулы продавца — чтобы показать, где он в нише. */
  own: number[];
  /** Сервер картинок по артикулу (публичный CDN WB). */
  baskets?: Record<string, number>;
  sales?: SalesData;
  /** Сколько копеек с рубля забирают WB и реклама (из последнего аудита) и себестоимость товаров продавца. */
  economy?: { takeRate: number | null; costs: Record<string, number> };
}

export interface Segment {
  word: string;
  count: number;
  share: number;
  medianPrice: number | null;
  medianReviews: number | null;
  bestPosition: number;
}

export interface NicheCard extends SearchCard {
  sales?: number;
  revenue?: number;
  isNew?: boolean;
  own?: boolean;
}

export interface NicheQuery {
  query: string;
  scannedAt: string;
  leaders: NicheCard[];
  prices: { q25: number | null; median: number | null; q75: number | null };
  medianReviewsTop10: number | null;
  medianRating: number | null;
  brands: { brand: string; count: number }[];
  brandShareTop3: number;
  segments: Segment[];
  /** Новинки по сортировке «новинки», у которых уже есть отзывы. */
  newcomers: NicheCard[];
  /** Новинки, которые уже стоят в популярной выдаче. */
  newInTop: NicheCard[];
  own: { nmId: number; position: number | null; price: number | null }[];
  /** Карточки продавца из выдачи — показываем рядом с лидерами, даже если они ниже. */
  ownCards: NicheCard[];
  hasFresh: boolean;
  economy: { price: number; afterWb: number | null; cost: number | null; margin: number | null } | null;
  sales: { leadersRevenue: number; leadersSales: number; covered: number } | null;
  verdict: { level: "go" | "careful" | "hard"; title: string; reasons: string[] };
}

export interface NicheReport {
  input: NicheInput;
  queries: NicheQuery[];
  findings: { priority: "high" | "medium" | "low"; query: string; text: string }[];
}

const isFresh = (s: SearchSnapshot) => /[?&]sort=newly/.test(s.url);

/** Сегменты — частые слова в названиях лидеров, кроме слов самого запроса. */
export function segmentsOf(cards: SearchCard[], query: string): Segment[] {
  const q = new Set(words(query).map(stem));
  const byStem = new Map<string, { forms: Map<string, number>; cards: SearchCard[] }>();
  for (const c of cards) {
    const seen = new Set<string>();
    for (const w of words(c.name ?? "")) {
      const s = stem(w);
      // Числа и размеры — не сегменты; слишком короткие основы — шум.
      if (q.has(s) || seen.has(s) || /\d/.test(w) || s.length < 3) continue;
      seen.add(s);
      let e = byStem.get(s);
      if (!e) byStem.set(s, (e = { forms: new Map(), cards: [] }));
      e.forms.set(w, (e.forms.get(w) ?? 0) + 1);
      e.cards.push(c);
    }
  }
  const n = cards.length || 1;
  return [...byStem.values()]
    .filter((e) => e.cards.length / n >= NT.segMin && e.cards.length / n <= NT.segMax && e.cards.length >= 3)
    .sort((a, b) => b.cards.length - a.cards.length)
    .slice(0, NT.segments)
    .map((e) => {
      const prices = e.cards.map((c) => c.price).filter((x): x is number => x !== null);
      const reviews = e.cards.map((c) => c.reviews).filter((x): x is number => x !== null);
      return {
        word: [...e.forms].sort((a, b) => b[1] - a[1])[0]![0],
        count: e.cards.length,
        share: Math.round((e.cards.length / n) * 100) / 100,
        medianPrice: prices.length ? Math.round(median(prices)) : null,
        medianReviews: reviews.length ? Math.round(median(reviews)) : null,
        bestPosition: Math.min(...e.cards.map((c) => c.position)),
      };
    });
}

function analyzeQuery(pop: SearchSnapshot, fresh: SearchSnapshot | undefined, input: NicheInput): NicheQuery {
  const own = new Set(input.own);
  const sale = (c: SearchCard): NicheCard => {
    const s = input.sales?.items[String(c.nmId)];
    return { ...c, ...(s ? { sales: s.sales, revenue: s.revenue } : {}), own: own.has(c.nmId) };
  };
  const freshIds = new Set(fresh?.cards.map((c) => c.nmId) ?? []);
  const cards = pop.cards.map(sale).map((c) => ({ ...c, isNew: freshIds.has(c.nmId) }));
  const leaders = cards.slice(0, NT.top);
  const prices = leaders.map((c) => c.price).filter((x): x is number => x !== null);
  const reviews10 = leaders.slice(0, 10).map((c) => c.reviews ?? 0);
  const ratings = leaders.map((c) => c.rating).filter((x): x is number => x !== null);

  const brandMap = new Map<string, number>();
  for (const c of leaders) if (c.brand) brandMap.set(c.brand, (brandMap.get(c.brand) ?? 0) + 1);
  const brands = [...brandMap].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count);
  const brandShareTop3 = leaders.length ? brands.slice(0, 3).reduce((a, b) => a + b.count, 0) / leaders.length : 0;

  const newcomers = (fresh?.cards ?? [])
    .filter((c) => (c.reviews ?? 0) >= NT.newMinReviews)
    .sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0))
    .slice(0, 12)
    .map((c) => ({ ...sale(c), isNew: true }));
  const newInTop = cards.filter((c) => c.isNew).slice(0, 12);

  const med = prices.length ? Math.round(median(prices)) : null;
  const take = input.economy?.takeRate ?? null;
  const ownInQuery = input.own.filter((id) => cards.some((c) => c.nmId === id)).map((id) => input.economy?.costs[String(id)]).filter((x): x is number => typeof x === "number");
  const cost = ownInQuery.length ? Math.round(median(ownInQuery)) : null;
  const afterWb = med !== null && take !== null ? Math.round(med * (1 - take / 100)) : null;
  const economy = med === null ? null : { price: med, afterWb, cost, margin: afterWb !== null && cost !== null ? afterWb - cost : null };

  const withSales = leaders.filter((c) => c.revenue !== undefined);
  const sales = withSales.length ? { leadersRevenue: withSales.reduce((a, c) => a + c.revenue!, 0), leadersSales: withSales.reduce((a, c) => a + c.sales!, 0), covered: withSales.length } : null;

  // Вердикт: барьеры против окон.
  const medRev = reviews10.length ? Math.round(median(reviews10)) : null;
  const barriers: string[] = [];
  const openings: string[] = [];
  if (medRev !== null && medRev >= NT.hardReviews) barriers.push(`у лидеров по ${medRev.toLocaleString("ru-RU")} отзывов — новому товару долго догонять`);
  if (brandShareTop3 >= NT.brandShare) barriers.push(`три бренда держат ${Math.round(brandShareTop3 * 100)}% лидеров`);
  if (economy?.margin !== null && economy?.margin !== undefined && economy.margin <= 0) barriers.push("по цене лидеров после WB не остаётся денег на себестоимость");
  if (newInTop.length >= 2) openings.push(`${plural(newInTop.length, "новинка", "новинки", "новинок")} уже в популярной выдаче — ниша пускает новых`);
  if (medRev !== null && medRev < NT.hardReviews / 3) openings.push(`у лидеров немного отзывов (${medRev}) — догнать реально`);
  if (brandShareTop3 < NT.brandShare / 2) openings.push("нет доминирующих брендов");
  if (economy?.margin && economy.margin > 0 && economy.cost) openings.push(`по медианной цене после WB, рекламы и себестоимости остаётся ≈ ${economy.margin.toLocaleString("ru-RU")} ₽ со штуки`);
  if (!fresh) barriers.push("новинки не смотрели — вывод неполный");
  const level = openings.length > barriers.length ? "go" : barriers.length >= 2 && !openings.length ? "hard" : "careful";
  const verdict = { level, title: { go: "Можно пробовать", careful: "Осторожно: пробовать малой партией", hard: "Тяжело зайти" }[level], reasons: [...openings, ...barriers] } as NicheQuery["verdict"];

  return {
    query: pop.query, scannedAt: pop.scannedAt, leaders,
    prices: { q25: quantile(prices, 0.25), median: med, q75: quantile(prices, 0.75) },
    medianReviewsTop10: medRev, medianRating: ratings.length ? Math.round(median(ratings) * 10) / 10 : null,
    brands: brands.slice(0, 8), brandShareTop3: Math.round(brandShareTop3 * 100) / 100,
    segments: segmentsOf(pop.cards.slice(0, 100), pop.query),
    newcomers, newInTop,
    own: input.own.map((id) => {
      const c = cards.find((x) => x.nmId === id);
      return { nmId: id, position: c?.position ?? null, price: c?.price ?? null };
    }).filter((o) => o.position !== null || input.own.length <= 5),
    ownCards: cards.filter((c) => c.own),
    hasFresh: Boolean(fresh), economy, sales, verdict,
  };
}

export function buildNiche(input: NicheInput): NicheReport {
  const key = (s: SearchSnapshot) => normalize(s.query).trim();
  const popular = input.snapshots.filter((s) => !isFresh(s));
  const queries = popular.map((p) => analyzeQuery(p, input.snapshots.find((s) => isFresh(s) && key(s) === key(p)), input));
  const findings: NicheReport["findings"] = [];
  for (const q of queries) {
    findings.push({ priority: q.verdict.level === "go" ? "low" : q.verdict.level === "hard" ? "high" : "medium", query: q.query, text: `«${q.query}»: ${q.verdict.title.toLowerCase()} — ${q.verdict.reasons[0] ?? "мало данных"}` });
    if (q.segments[0]) findings.push({ priority: "low", query: q.query, text: `«${q.query}»: главный сегмент — «${q.segments[0].word}» (${Math.round(q.segments[0].share * 100)}% выдачи, медиана ${q.segments[0].medianPrice ?? "—"} ₽)` });
  }
  return { input, queries, findings };
}

export function nicheSummary(r: NicheReport) {
  return {
    generatedAt: r.input.generatedAt,
    demo: r.input.demo,
    salesSource: r.input.sales?.source ?? null,
    findings: r.findings,
    queries: r.queries.map((q) => ({
      query: q.query,
      verdict: q.verdict,
      prices: q.prices,
      medianReviewsTop10: q.medianReviewsTop10,
      brandShareTop3: q.brandShareTop3,
      topBrands: q.brands.slice(0, 3),
      segments: q.segments,
      newInTop: q.newInTop.map((c) => ({ nmId: c.nmId, position: c.position, name: c.name, price: c.price, reviews: c.reviews })),
      newcomers: q.newcomers.slice(0, 6).map((c) => ({ nmId: c.nmId, name: c.name, price: c.price, reviews: c.reviews, rating: c.rating })),
      own: q.own,
      economy: q.economy,
      sales: q.sales,
      leaders: q.leaders.slice(0, 10).map((c) => ({ position: c.position, nmId: c.nmId, brand: c.brand, name: c.name, price: c.price, rating: c.rating, reviews: c.reviews, sales: c.sales, revenue: c.revenue })),
    })),
  };
}
