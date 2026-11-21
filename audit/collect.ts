/**
 * Сбор данных для аудита кабинета. Каждый раздел собирается независимо: если в
 * ключе нет категории или WB ответил ошибкой, раздел помечается недоступным, а
 * остальные продолжают работать. Разделы с разных хостов идут параллельно —
 * лимиты WB считаются по категориям, так весь сбор укладывается в 1–3 минуты.
 */
import { HOSTS, LIMITER_KEYS, type WBClient } from "../mcp/wb/src/client.js";
import {
  fetchStatAll,
  summarizeSales,
  abcFromSales,
  fetchFinanceRows,
  summarizeFinance,
} from "../mcp/wb/src/tools.js";
import { previousPeriod, num, round2, toUnix } from "../mcp/wb/src/util.js";
import type { CostRow } from "./cost.js";
import { monthLabel } from "./analyze.js";

type Row = Record<string, unknown>;

export type Section<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface Period {
  from: string;
  to: string;
  days: number;
}

export interface WeekPoint {
  weekStart: string;
  orders: number;
  ordersSum: number;
  buyouts: number;
  buyoutsSum: number;
}

export interface FunnelRow {
  nmId: number;
  vendorCode: string;
  title: string;
  subject: string;
  rating: number | null;
  stockWb: number;
  openCount: number;
  cartCount: number;
  orderCount: number;
  orderSum: number;
  buyoutCount: number;
  addToCartPercent: number;
  cartToOrderPercent: number;
  buyoutPercent: number;
  pastOrderSum: number | null;
  pastOpenCount: number | null;
}

export interface StockRow {
  nmId: number;
  quantity: number;
  inWayToClient: number;
  inWayFromClient: number;
  warehouses: Record<string, number>;
}

export interface FeedbackRow {
  id: string;
  createdDate: string;
  rating: number;
  text: string;
  cons: string;
  answered: boolean;
  nmId: number;
  vendorCode: string;
  product: string;
}

export interface CardRow {
  nmId: number;
  vendorCode: string;
  title: string;
  subject: string;
  photos: number;
  video: boolean;
  descriptionLength: number;
  characteristics: number;
}

export interface AuditData {
  version: 1;
  generatedAt: string;
  demo: boolean;
  period: Period;
  previous: Period;
  seller: Section<{ name: string; tradeMark: string; rating: number | null; feedbackCount: number | null }>;
  sales: Section<{
    current: ReturnType<typeof summarizeSales>;
    previousTotals: ReturnType<typeof summarizeSales>["totals"];
    weekly: WeekPoint[];
  }>;
  abc: Section<ReturnType<typeof abcFromSales>>;
  finance: Section<ReturnType<typeof summarizeFinance>>;
  funnel: Section<{ products: FunnelRow[] }>;
  stocks: Section<{ products: StockRow[]; total: number }>;
  feedbacks: Section<{ unansweredFeedbacks: number; unansweredQuestions: number; list: FeedbackRow[] }>;
  ads: Section<{ total: number; campaigns: { advertId: number; campName: string; spent: number }[] }>;
  cards: Section<{ list: CardRow[] }>;
  /** Себестоимость из data/cost.csv. Нет файла — null; в старых data.json поля нет. */
  costs?: CostRow[] | null;
  /** Деньги по календарным месяцам (последний — неполный, до вчера). В старых data.json поля нет. */
  months?: MonthData[];
}

export interface MonthData {
  /** «2026-09» */
  month: string;
  from: string;
  to: string;
  /** Месяц ещё идёт: данные до вчера, финотчёт за последние дни может быть не готов. */
  partial: boolean;
  finance: Section<ReturnType<typeof summarizeFinance>>;
  ads: Section<number>;
}

/** Календарные месяцы, последний — тот, в который попадает `to` (обрезан по `to`). */
export function monthRanges(to: string, count: number): { month: string; from: string; to: string; partial: boolean }[] {
  const [y, m] = to.split("-").map(Number) as [number, number];
  const out: { month: string; from: string; to: string; partial: boolean }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(y, m - 1 - i, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    const from = first.toISOString().slice(0, 10);
    const end = last.toISOString().slice(0, 10);
    out.push({ month: from.slice(0, 7), from, to: end < to ? end : to, partial: end > to });
  }
  return out;
}

/** Имена категорий ключа для понятной причины «нет доступа». */
const CATEGORY_BY_HOST: Record<string, string> = {
  [HOSTS.statistics]: "Статистика",
  [HOSTS.analytics]: "Аналитика",
  [HOSTS.finance]: "Финансы",
  [HOSTS.feedbacks]: "Вопросы и отзывы",
  [HOSTS.advert]: "Продвижение",
  [HOSTS.content]: "Контент",
  [HOSTS.common]: "Тарифы и общее",
};

export function explainFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const host = Object.keys(CATEGORY_BY_HOST).find((h) => msg.includes(h));
  if (/→ 401/.test(msg)) return `нет доступа: в ключе WB нет категории «${host ? CATEGORY_BY_HOST[host] : "?"}»`;
  if (/→ 429/.test(msg)) return "WB ограничил частоту запросов — повторите аудит через несколько минут";
  if (/network error|timed out/.test(msg)) return "нет связи с WB";
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

async function section<T>(name: string, log: (m: string) => void, fn: () => Promise<T>): Promise<Section<T>> {
  const started = Date.now();
  try {
    const data = await fn();
    log(`✓ ${name} (${Math.round((Date.now() - started) / 1000)} с)`);
    return { ok: true, data };
  } catch (err) {
    const reason = explainFailure(err);
    log(`✗ ${name}: ${reason}`);
    return { ok: false, reason };
  }
}

const DAY = 86_400_000;
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Понедельник недели, к которой относится дата. */
export function weekStart(d: string): string {
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * DAY).toISOString().slice(0, 10);
}

export function weeklySeries(orders: Row[], sales: Row[], from: string, to: string): WeekPoint[] {
  const map = new Map<string, WeekPoint>();
  const get = (d: string) => {
    const w = weekStart(d);
    let p = map.get(w);
    if (!p) map.set(w, (p = { weekStart: w, orders: 0, ordersSum: 0, buyouts: 0, buyoutsSum: 0 }));
    return p;
  };
  for (const o of orders) {
    const d = String(o["date"] ?? "").slice(0, 10);
    if (d < from || d > to) continue;
    const p = get(d);
    p.orders += 1;
    p.ordersSum += num(o["priceWithDisc"]);
  }
  for (const s of sales) {
    const d = String(s["date"] ?? "").slice(0, 10);
    if (d < from || d > to || String(s["saleID"] ?? "").startsWith("R")) continue;
    const p = get(d);
    p.buyouts += 1;
    p.buyoutsSum += num(s["priceWithDisc"]);
  }
  return [...map.values()].map((p) => ({ ...p, ordersSum: round2(p.ordersSum), buyoutsSum: round2(p.buyoutsSum) })).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export interface CollectOptions {
  days?: number;
  now?: Date;
  demo?: boolean;
  log?: (m: string) => void;
  costs?: CostRow[] | null;
  /** Сколько календарных месяцев показать в разделе «По месяцам» (0 — не собирать). */
  months?: number;
}

/** Все карточки продавца (контент). Нужны аудиту и заготовке data/cost.csv. */
export async function fetchCards(client: WBClient): Promise<CardRow[]> {
  const list: CardRow[] = [];
  let cursor: Row = { limit: 100 };
  for (let page = 0; page < 50; page++) {
    const res = await client.post<{ cards?: Row[]; cursor?: Row }>(HOSTS.content, "/content/v2/get/cards/list", {
      settings: { cursor, filter: { withPhoto: -1 } },
    });
    const cards = res?.cards ?? [];
    for (const c of cards) {
      list.push({
        nmId: num(c["nmID"]),
        vendorCode: String(c["vendorCode"] ?? ""),
        title: String(c["title"] ?? ""),
        subject: String(c["subjectName"] ?? ""),
        photos: Array.isArray(c["photos"]) ? (c["photos"] as unknown[]).length : 0,
        video: Boolean(c["video"]),
        descriptionLength: String(c["description"] ?? "").length,
        characteristics: Array.isArray(c["characteristics"]) ? (c["characteristics"] as unknown[]).length : 0,
      });
    }
    // По Swagger: страницы кончились, когда total меньше limit.
    if (cards.length < 100 || num(res?.cursor?.["total"]) < 100) break;
    cursor = { limit: 100, updatedAt: res?.cursor?.["updatedAt"], nmID: res?.cursor?.["nmID"] };
  }
  return list;
}

export async function collectAudit(client: WBClient, opts: CollectOptions = {}): Promise<AuditData> {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  // Сегодняшний день неполный — берём период, заканчивающийся вчера.
  const to = shift(now.toISOString().slice(0, 10), -1);
  const from = shift(to, -(days - 1));
  const prev = previousPeriod(from, to);
  const period: Period = { from, to, days };
  const previous: Period = { from: prev.start, to: prev.end, days };

  // Статистика: одна выгрузка за оба периода (заказы и продажи — по 1 запросу в минуту).
  const salesP = section("Продажи и заказы", log, async () => {
    log("… Статистика: заказы и продажи (WB отдаёт 1 запрос в минуту, подождите)");
    // График — до 12 полных недель (статистика хранит 90 дней). Начинаем с понедельника,
    // иначе первая неделя неполная и выглядит как провал продаж.
    const back = shift(to, -83);
    const chartStart = weekStart(back) === back ? back : shift(weekStart(back), 7);
    const fetchFrom = chartStart < prev.start ? chartStart : prev.start;
    const orders = await fetchStatAll(client, "/api/v1/supplier/orders", LIMITER_KEYS.statOrders, fetchFrom);
    const sales = await fetchStatAll(client, "/api/v1/supplier/sales", LIMITER_KEYS.statSales, fetchFrom);
    return {
      current: summarizeSales(orders, sales, from, to),
      previousTotals: summarizeSales(orders, sales, prev.start, prev.end).totals,
      weekly: weeklySeries(orders, sales, chartStart, to),
    };
  });

  const financeP = section("Деньги (финотчёт)", log, async () => {
    log("… Финансы: отчёт о реализации (1 запрос в минуту)");
    return summarizeFinance(await fetchFinanceRows(client, from, to, "weekly"), 1000);
  });

  // Помесячно — отдельным запросом на месяц: WB сам отбирает строки по датам, а
  // финансы отдают 1 запрос в минуту, поэтому 3 месяца — это ещё ~3 минуты.
  const monthsP = (async (): Promise<MonthData[]> => {
    await financeP; // не толкаемся с основным отчётом в одной очереди
    const out: MonthData[] = [];
    for (const r of monthRanges(to, opts.months ?? 3)) {
      const label = monthLabel(r.month).toLowerCase();
      const finance = await section(`Деньги за ${label}`, log, async () => {
        log(`… Финансы за ${label} (1 запрос в минуту)`);
        return summarizeFinance(await fetchFinanceRows(client, r.from, r.to, "weekly"), 5000);
      });
      const ads = await section(`Реклама за ${label}`, log, async () => {
        const part = await client.get<Row[]>(HOSTS.advert, "/adv/v1/upd", { from: r.from, to: r.to });
        return round2((Array.isArray(part) ? part : []).reduce((s, x) => s + num(x["updSum"]), 0));
      });
      out.push({ ...r, finance, ads });
    }
    return out;
  })();

  // Аналитика: воронка и остатки — один хост, идут по очереди.
  const analyticsP = (async () => {
    const funnel = await section("Воронка карточек", log, async () => {
      log("… Аналитика: воронка карточек");
      const products: FunnelRow[] = [];
      for (let offset = 0; offset < 10_000; offset += 1000) {
        const res = await client.post<{ data?: { products?: Row[] } }>(
          HOSTS.analytics,
          "/api/analytics/v3/sales-funnel/products",
          { selectedPeriod: { start: from, end: to }, pastPeriod: prev, nmIds: [], orderBy: { field: "orderSum", mode: "desc" }, limit: 1000, offset },
          undefined,
          { limiterKey: LIMITER_KEYS.funnel },
        );
        const page = res?.data?.products ?? [];
        for (const item of page) {
          const p = (item["product"] ?? {}) as Row;
          const st = (item["statistic"] ?? {}) as Row;
          const sel = (st["selected"] ?? {}) as Row;
          const past = st["past"] as Row | undefined;
          const conv = (sel["conversions"] ?? {}) as Row;
          products.push({
            nmId: num(p["nmId"]),
            vendorCode: String(p["vendorCode"] ?? ""),
            title: String(p["title"] ?? ""),
            subject: String(p["subjectName"] ?? ""),
            rating: p["productRating"] === undefined ? null : num(p["productRating"]),
            stockWb: num((p["stocks"] as Row | undefined)?.["wb"]),
            openCount: num(sel["openCount"]),
            cartCount: num(sel["cartCount"]),
            orderCount: num(sel["orderCount"]),
            orderSum: num(sel["orderSum"]),
            buyoutCount: num(sel["buyoutCount"]),
            addToCartPercent: num(conv["addToCartPercent"]),
            cartToOrderPercent: num(conv["cartToOrderPercent"]),
            buyoutPercent: num(conv["buyoutPercent"]),
            pastOrderSum: past ? num(past["orderSum"]) : null,
            pastOpenCount: past ? num(past["openCount"]) : null,
          });
        }
        if (page.length < 1000) break;
      }
      return { products };
    });
    const stocks = await section("Остатки на складах WB", log, async () => {
      log("… Аналитика: остатки на складах WB");
      const res = await client.post<{ data?: { items?: Row[] } }>(
        HOSTS.analytics,
        "/api/analytics/v1/stocks-report/wb-warehouses",
        { limit: 250_000, offset: 0 },
        undefined,
        { limiterKey: LIMITER_KEYS.wbStocks },
      );
      const byNm = new Map<number, StockRow>();
      for (const i of res?.data?.items ?? []) {
        const id = num(i["nmId"]);
        let p = byNm.get(id);
        if (!p) byNm.set(id, (p = { nmId: id, quantity: 0, inWayToClient: 0, inWayFromClient: 0, warehouses: {} }));
        const q = num(i["quantity"]);
        p.quantity += q;
        p.inWayToClient += num(i["inWayToClient"]);
        p.inWayFromClient += num(i["inWayFromClient"]);
        if (q) p.warehouses[String(i["warehouseName"])] = (p.warehouses[String(i["warehouseName"])] ?? 0) + q;
      }
      const products = [...byNm.values()];
      return { products, total: products.reduce((s, p) => s + p.quantity, 0) };
    });
    return { funnel, stocks };
  })();

  const feedbacksP = section("Отзывы и вопросы", log, async () => {
    log("… Отзывы и вопросы");
    const fb = await client.get<{ data?: { countUnanswered?: number } }>(HOSTS.feedbacks, "/api/v1/feedbacks/count-unanswered");
    const q = await client.get<{ data?: { countUnanswered?: number } }>(HOSTS.feedbacks, "/api/v1/questions/count-unanswered");
    const list: FeedbackRow[] = [];
    for (const answered of [false, true]) {
      const res = await client.get<{ data?: { feedbacks?: Row[] } }>(HOSTS.feedbacks, "/api/v1/feedbacks", {
        isAnswered: String(answered),
        take: "5000",
        skip: "0",
        order: "dateDesc",
        dateFrom: String(toUnix(from, "from")),
        dateTo: String(toUnix(to, "to", true)),
      });
      for (const f of res?.data?.feedbacks ?? []) {
        const pd = (f["productDetails"] ?? {}) as Row;
        // Имя покупателя сознательно не сохраняем.
        list.push({
          id: String(f["id"]),
          createdDate: String(f["createdDate"] ?? ""),
          rating: num(f["productValuation"]),
          text: String(f["text"] ?? ""),
          cons: String(f["cons"] ?? ""),
          answered,
          nmId: num(pd["nmId"]),
          vendorCode: String(pd["supplierArticle"] ?? ""),
          product: String(pd["productName"] ?? ""),
        });
      }
    }
    return { unansweredFeedbacks: num(fb?.data?.countUnanswered), unansweredQuestions: num(q?.data?.countUnanswered), list };
  });

  const adsP = section("Реклама", log, async () => {
    log("… Реклама: списания");
    const rows: Row[] = [];
    // История затрат отдаётся кусками до 31 дня.
    for (let start = from; start <= to; start = shift(start, 31)) {
      const end = shift(start, 30) < to ? shift(start, 30) : to;
      const part = await client.get<Row[]>(HOSTS.advert, "/adv/v1/upd", { from: start, to: end });
      if (Array.isArray(part)) rows.push(...part);
    }
    const byC = new Map<number, { advertId: number; campName: string; spent: number }>();
    for (const r of rows) {
      const id = num(r["advertId"]);
      const c = byC.get(id) ?? { advertId: id, campName: String(r["campName"] ?? ""), spent: 0 };
      c.spent += num(r["updSum"]);
      byC.set(id, c);
    }
    const campaigns = [...byC.values()].map((c) => ({ ...c, spent: round2(c.spent) })).sort((a, b) => b.spent - a.spent);
    return { total: round2(campaigns.reduce((s, c) => s + c.spent, 0)), campaigns };
  });

  const cardsP = section("Карточки товаров", log, async () => {
    log("… Контент: карточки");
    return { list: await fetchCards(client) };
  });

  const sellerP = section("Продавец", log, async () => {
    const info = await client.get<Row>(HOSTS.common, "/api/v1/seller-info", undefined, { limiterKey: LIMITER_KEYS.sellerInfo });
    let rating: number | null = null;
    let feedbackCount: number | null = null;
    try {
      const r = await client.get<Row>(HOSTS.feedbacks, "/api/common/v1/rating", undefined, { limiterKey: LIMITER_KEYS.sellerRating });
      rating = r?.["valuation"] === undefined ? null : num(r["valuation"]);
      feedbackCount = r?.["feedbackCount"] === undefined ? null : num(r["feedbackCount"]);
    } catch {
      // Рейтинг — приятное дополнение, без него шапка отчёта всё равно строится.
    }
    return { name: String(info?.["name"] ?? ""), tradeMark: String(info?.["tradeMark"] ?? ""), rating, feedbackCount };
  });

  const [sales, finance, analytics, feedbacks, ads, cards, seller, months] = await Promise.all([salesP, financeP, analyticsP, feedbacksP, adsP, cardsP, sellerP, monthsP]);
  const abc: Section<ReturnType<typeof abcFromSales>> = sales.ok ? { ok: true, data: abcFromSales(sales.data.current.products) } : { ok: false, reason: sales.reason };

  return {
    version: 1,
    generatedAt: now.toISOString(),
    demo: Boolean(opts.demo),
    period,
    previous,
    seller,
    sales,
    abc,
    finance,
    funnel: analytics.funnel,
    stocks: analytics.stocks,
    feedbacks,
    ads,
    cards,
    costs: opts.costs ?? null,
    months,
  };
}
