/**
 * Анализ выдачи WB по запросам: цены, рейтинги и отзывы лидеров, бренды,
 * позиции товаров продавца и чем его карточка уступает лидерам.
 * Чистые функции — тестируются на демо-выдаче.
 */
import type { CardDetails } from "./cdn.js";
import { median } from "../audit/analyze.js";

export interface SearchCard {
  position: number;
  nmId: number;
  brand: string | null;
  name: string | null;
  price: number | null;
  oldPrice: number | null;
  priceIsWallet: boolean;
  rating: number | null;
  reviews: number | null;
  delivery: string | null;
  labels: string[];
  ad: boolean;
}

export interface SearchSnapshot {
  query: string;
  url: string;
  scannedAt: string;
  cards: SearchCard[];
}

export interface OwnProduct {
  nmId: number;
  vendorCode?: string;
  title?: string;
}

export interface CompetitorInput {
  generatedAt: string;
  demo: boolean;
  snapshots: SearchSnapshot[];
  own: OwnProduct[];
  details: Record<string, CardDetails>;
  /** Прошлый снимок по тем же запросам — для «что изменилось». */
  previous: SearchSnapshot[];
  /** Продажи по MPSTATS (если у продавца есть токен): заполняет Claude в mpstats.json. */
  sales?: SalesData;
}

export interface SalesData {
  source: string;
  period: { from: string; to: string };
  items: Record<string, { sales: number; revenue: number }>;
}

export const LEADERS = 10;

export const CT = {
  priceHigh: 1.15, // дороже медианы лидеров больше чем на 15%
  priceLow: 0.85, // дешевле нижней четверти рынка больше чем на 15%
  reviewsFactor: 0.3, // отзывов меньше 30% от медианы лидеров
  ratingGap: 0.2,
  farPosition: 30, // дальше — не видно без прокрутки двух экранов
  descriptionFactor: 0.6,
  characteristicsFactor: 0.7,
  photosGap: 2,
};

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (pos - lo));
}

const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
const med = (xs: (number | null | undefined)[]) => {
  const v = nums(xs);
  return v.length ? median(v) : null;
};
/** Медиана, округлённая до целого: цены, отзывы, фото — дробные «364,5 ₽» только путают. */
const medInt = (xs: (number | null | undefined)[]) => {
  const m = med(xs);
  return m === null ? null : Math.round(m);
};

export interface OwnInQuery {
  nmId: number;
  vendorCode: string;
  title: string;
  position: number | null;
  prevPosition: number | null;
  card: SearchCard | null;
  details: CardDetails | null;
  gaps: string[];
}

export interface QueryReport {
  query: string;
  url: string;
  scannedAt: string;
  scanned: number;
  price: { min: number | null; p25: number | null; median: number | null; p75: number | null; max: number | null; leadersMedian: number | null };
  leadersRatingMedian: number | null;
  leadersReviewsMedian: number | null;
  /** Медиана продаж первой десятки за период MPSTATS, шт. */
  leadersSalesMedian: number | null;
  promoShare: number;
  brands: { brand: string; cards: number; bestPosition: number }[];
  leaders: (SearchCard & { details: CardDetails | null })[];
  leadersDetails: { photos: number | null; descriptionLength: number | null; characteristics: number | null; videoShare: number | null };
  own: OwnInQuery[];
  changes: { hasPrevious: boolean; newLeaders: SearchCard[]; leaderPriceChanges: { nmId: number; brand: string | null; was: number; now: number }[] };
}

export interface CompetitorReport {
  input: CompetitorInput;
  queries: QueryReport[];
  findings: { query: string; text: string; details?: string[]; priority: "high" | "medium" | "low" }[];
}

function brandsOf(cards: SearchCard[]) {
  const m = new Map<string, { brand: string; cards: number; bestPosition: number }>();
  for (const c of cards) {
    const b = (c.brand ?? "").trim() || "без бренда";
    const e = m.get(b) ?? { brand: b, cards: 0, bestPosition: c.position };
    e.cards += 1;
    e.bestPosition = Math.min(e.bestPosition, c.position);
    m.set(b, e);
  }
  return [...m.values()].sort((a, b) => b.cards - a.cards || a.bestPosition - b.bestPosition).slice(0, 10);
}

export function analyzeQuery(s: SearchSnapshot, input: CompetitorInput): QueryReport {
  const cards = [...s.cards].sort((a, b) => a.position - b.position);
  const leaders = cards.slice(0, LEADERS);
  const prices = nums(cards.map((c) => c.price));
  const det = (id: number) => input.details[String(id)] ?? null;
  const leaderDetails = leaders.map((c) => det(c.nmId)).filter((d): d is CardDetails => d !== null);

  const report: QueryReport = {
    query: s.query,
    url: s.url,
    scannedAt: s.scannedAt,
    scanned: cards.length,
    price: {
      min: prices.length ? Math.min(...prices) : null,
      p25: quantile(prices, 0.25),
      median: quantile(prices, 0.5),
      p75: quantile(prices, 0.75),
      max: prices.length ? Math.max(...prices) : null,
      leadersMedian: medInt(leaders.map((c) => c.price)),
    },
    leadersRatingMedian: med(leaders.map((c) => c.rating)),
    leadersReviewsMedian: medInt(leaders.map((c) => c.reviews)),
    leadersSalesMedian: input.sales ? medInt(leaders.map((c) => input.sales!.items[String(c.nmId)]?.sales)) : null,
    promoShare: cards.length ? Math.round((cards.filter((c) => c.labels.length > 0).length / cards.length) * 100) : 0,
    brands: brandsOf(cards),
    leaders: leaders.map((c) => ({ ...c, details: det(c.nmId) })),
    leadersDetails: {
      photos: medInt(leaderDetails.map((d) => d.photos)),
      descriptionLength: medInt(leaderDetails.map((d) => d.descriptionLength)),
      characteristics: medInt(leaderDetails.map((d) => d.characteristics)),
      videoShare: leaderDetails.length ? Math.round((leaderDetails.filter((d) => d.hasVideo).length / leaderDetails.length) * 100) : null,
    },
    own: [],
    changes: { hasPrevious: false, newLeaders: [], leaderPriceChanges: [] },
  };

  const prev = input.previous.filter((p) => p.query === s.query).sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))[0];
  if (prev) {
    const prevById = new Map(prev.cards.map((c) => [c.nmId, c]));
    const prevLeaders = new Set(prev.cards.filter((c) => c.position <= LEADERS).map((c) => c.nmId));
    report.changes = {
      hasPrevious: true,
      newLeaders: leaders.filter((c) => !prevLeaders.has(c.nmId)),
      leaderPriceChanges: leaders
        .map((c) => ({ c, p: prevById.get(c.nmId) }))
        .filter(({ c, p }) => p?.price && c.price && Math.abs(c.price - p.price) / p.price >= 0.05)
        .map(({ c, p }) => ({ nmId: c.nmId, brand: c.brand, was: p!.price!, now: c.price! })),
    };
  }

  for (const o of input.own) {
    const card = cards.find((c) => c.nmId === o.nmId) ?? null;
    const prevCard = prev?.cards.find((c) => c.nmId === o.nmId) ?? null;
    const d = det(o.nmId);
    // Товар продавца, который не встретился в выдаче и по которому нечего сравнить, в отчёт не тащим.
    if (!card && !prevCard) continue;
    const gaps: string[] = [];
    const P = report.price;
    if (!card) gaps.push(`не найден в первых ${cards.length} карточках выдачи`);
    else if (card.position > CT.farPosition) gaps.push(`позиция ${card.position}: покупатель видит товар только после долгой прокрутки`);
    if (card?.price && P.leadersMedian && card.price > P.leadersMedian * CT.priceHigh) {
      gaps.push(`цена ${card.price} ₽ — дороже лидеров на ${Math.round((card.price / P.leadersMedian - 1) * 100)}% (медиана первой десятки ${P.leadersMedian} ₽)`);
    }
    if (card?.price && P.p25 && card.price < P.p25 * CT.priceLow) {
      gaps.push(`цена ${card.price} ₽ — заметно ниже рынка (нижняя четверть ${P.p25} ₽): возможно, недобираете маржу`);
    }
    if (card && report.leadersReviewsMedian && (card.reviews ?? 0) < report.leadersReviewsMedian * CT.reviewsFactor) {
      gaps.push(`отзывов ${card.reviews ?? 0} — у лидеров обычно ${Math.round(report.leadersReviewsMedian)}`);
    }
    if (card?.rating && report.leadersRatingMedian && card.rating < report.leadersRatingMedian - CT.ratingGap) {
      gaps.push(`рейтинг ${card.rating} — ниже лидеров (${report.leadersRatingMedian})`);
    }
    const L = report.leadersDetails;
    if (d && L.photos !== null && d.photos < L.photos - CT.photosGap) gaps.push(`фото ${d.photos} — у лидеров ${L.photos}`);
    if (d && L.descriptionLength !== null && d.descriptionLength < L.descriptionLength * CT.descriptionFactor) {
      gaps.push(`описание ${d.descriptionLength} символов — у лидеров около ${Math.round(L.descriptionLength)}`);
    }
    if (d && L.characteristics !== null && d.characteristics < L.characteristics * CT.characteristicsFactor) {
      gaps.push(`характеристик ${d.characteristics} — у лидеров ${L.characteristics}`);
    }
    if (d && !d.hasVideo && (L.videoShare ?? 0) >= 50) gaps.push(`нет видео — у ${L.videoShare}% лидеров оно есть`);
    const ownSales = input.sales?.items[String(o.nmId)];
    if (ownSales && report.leadersSalesMedian && ownSales.sales < report.leadersSalesMedian * 0.3) {
      gaps.push(`продаж ${ownSales.sales} шт за период — у лидеров около ${report.leadersSalesMedian} (MPSTATS)`);
    }
    if (card && card.labels.length === 0 && report.promoShare >= 50) gaps.push(`не участвует в акции, а в выдаче в акции ${report.promoShare}% карточек`);
    report.own.push({
      nmId: o.nmId,
      vendorCode: o.vendorCode ?? "",
      title: o.title ?? card?.name ?? d?.title ?? "",
      position: card?.position ?? null,
      prevPosition: prevCard?.position ?? null,
      card,
      details: d,
      gaps,
    });
  }
  return report;
}

export function buildCompetitorReport(input: CompetitorInput): CompetitorReport {
  const queries = input.snapshots.map((s) => analyzeQuery(s, input));
  const findings: CompetitorReport["findings"] = [];
  for (const q of queries) {
    for (const o of q.own) {
      const name = o.vendorCode || o.title || String(o.nmId);
      if (o.position === null) findings.push({ query: q.query, priority: "high", text: `${name}: нет в первых ${q.scanned} карточках по запросу «${q.query}»` });
      else if (o.prevPosition !== null && o.position - o.prevPosition >= 10) {
        findings.push({ query: q.query, priority: "high", text: `${name}: опустился с ${o.prevPosition} на ${o.position} место` });
      }
      if (o.gaps.length && o.position !== null) {
        findings.push({ query: q.query, priority: o.position > CT.farPosition ? "high" : "medium", text: `${name}, место ${o.position} — чем уступает лидерам:`, details: o.gaps });
      }
    }
    if (q.changes.newLeaders.length) {
      findings.push({ query: q.query, priority: "low", text: `В первой десятке новые товары: ${q.changes.newLeaders.map((c) => `${c.brand ?? "?"} (${c.nmId})`).join(", ")}` });
    }
    if (q.changes.leaderPriceChanges.length) {
      findings.push({
        query: q.query,
        priority: "medium",
        text: `Лидеры поменяли цены: ${q.changes.leaderPriceChanges.map((c) => `${c.brand ?? c.nmId} ${c.was}→${c.now} ₽`).join(", ")}`,
      });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return { input, queries, findings };
}

/** Выжимка для Claude: по ней он пишет выводы в insights.md. */
export function competitorSummary(r: CompetitorReport) {
  return {
    demo: r.input.demo,
    generatedAt: r.input.generatedAt,
    salesSource: r.input.sales ? { source: r.input.sales.source, period: r.input.sales.period } : null,
    findings: r.findings,
    queries: r.queries.map((q) => ({
      query: q.query,
      scanned: q.scanned,
      price: q.price,
      leadersRatingMedian: q.leadersRatingMedian,
      leadersReviewsMedian: q.leadersReviewsMedian,
      promoShare: q.promoShare,
      brands: q.brands.slice(0, 5),
      leaders: q.leaders.map((c) => ({ position: c.position, nmId: c.nmId, brand: c.brand, name: c.name, price: c.price, rating: c.rating, reviews: c.reviews, labels: c.labels, photos: c.details?.photos, descriptionLength: c.details?.descriptionLength, sales: r.input.sales?.items[String(c.nmId)]?.sales, revenue: r.input.sales?.items[String(c.nmId)]?.revenue })),
      leadersSalesMedian: q.leadersSalesMedian,
      leadersDetails: q.leadersDetails,
      own: q.own.map((o) => ({ nmId: o.nmId, vendorCode: o.vendorCode, title: o.title, position: o.position, prevPosition: o.prevPosition, price: o.card?.price ?? null, rating: o.card?.rating ?? null, reviews: o.card?.reviews ?? null, sales: r.input.sales?.items[String(o.nmId)]?.sales ?? null, revenue: r.input.sales?.items[String(o.nmId)]?.revenue ?? null, gaps: o.gaps })),
      changes: q.changes,
    })),
  };
}
