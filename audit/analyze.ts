/**
 * Анализ собранных данных: сводная таблица по товарам, деньги магазина,
 * показатели и список проблем с действиями. Только чистые функции — их легко тестировать.
 *
 * Пороги — ориентиры из практики продавцов, а не правила WB. Они вынесены в
 * THRESHOLDS и в отчёте подписаны как ориентиры: у разных категорий нормы разные.
 *
 * Деньги считаем честно: реклама — к выкупам (заказ без выкупа денег не приносит),
 * прибыль — только там, где продавец вписал себестоимость (data/cost.csv), а где
 * не вписал — прямо говорим, что прибыль не посчитана.
 */
import type { AuditData, FeedbackRow } from "./collect.js";
import { round2 } from "../mcp/wb/src/util.js";
import { costLookup } from "./cost.js";

export const THRESHOLDS = {
  lowStockDays: 14, // меньше — пора везти поставку
  overstockDays: 120, // больше — товар лежит и копит платное хранение
  overstockMinQty: 30,
  salesDropShop: -15, // % падения заказов магазина к прошлому периоду
  salesDropProduct: -30, // % падения заказов товара
  minOpensForConversion: 200, // меньше переходов — конверсии случайны
  weakCartFactor: 0.6, // конверсия в корзину ниже 60% от медианы магазина
  lowBuyoutPercent: 60,
  minOrdersForBuyout: 20,
  negativeRating: 3, // оценка ≤ 3 — негативный отзыв
  minPhotos: 5,
  minDescription: 1000,
  minCharacteristics: 10,
  drrWarn: 15, // ДРР от выкупов, % — когда себестоимость неизвестна
  drrHigh: 25,
  drrBreakEvenWarn: 0.7, // ДРР выше 70% от безубыточного — реклама съедает почти всю прибыль
  logisticsShareWarn: 15, // доля логистики в выручке, %
  logisticsPerUnitWarn: 25, // логистика на проданную штуку, % от перечисления за неё
  minUnitsForEconomics: 5, // меньше продаж — цифры на штуку случайны
  lowMarginPercent: 10, // прибыль ниже 10% выручки — любая скидка уводит в минус
  leadTimeDays: 7, // сколько дней обычно идёт поставка до склада WB
};

export type Priority = "high" | "medium" | "low";

export interface ProductLine {
  nmId: number;
  vendorCode: string;
  title: string;
  subject: string;
  abc: "A" | "B" | "C" | "—";
  orders: number;
  ordersSum: number;
  prevOrdersSum: number | null;
  ordersDelta: number | null;
  buyouts: number;
  buyoutsSum: number;
  returns: number;
  buyoutPercent: number | null;
  perDay: number;
  stock: number | null;
  inWayToClient: number;
  daysOfStock: number | null;
  openCount: number | null;
  addToCartPercent: number | null;
  cartToOrderPercent: number | null;
  rating: number | null;
  feedbacks: number;
  negative: number;
  forPay: number | null;
  logistics: number | null;
  penalties: number | null;
  afterLogistics: number | null;
  photos: number | null;
  video: boolean | null;
  descriptionLength: number | null;
  characteristics: number | null;
  /** По финотчёту: продано штук за вычетом возвратов и выручка (продажи минус возвраты). */
  soldUnits: number | null;
  revenue: number | null;
  storage: number | null;
  avgPrice: number | null;
  logisticsPerUnit: number | null;
  /** Из data/cost.csv. */
  cost: number | null;
  taxPercent: number | null;
  /** Прибыль до рекламы: перечисление − логистика − штрафы − хранение − себестоимость − налог. */
  profit: number | null;
  profitPerUnit: number | null;
  margin: number | null;
  /** Цена, ниже которой товар в минусе с учётом удержаний WB, налога и текущего ДРР. */
  minPrice: number | null;
}

/** Деньги магазина целиком: то, ради чего продавец открывает отчёт. */
export interface Economics {
  /** Выручка по финотчёту: продажи минус возвраты, по цене со скидкой. */
  revenue: number;
  /** «На руки» по финотчёту: перечисление минус услуги WB. */
  payout: number;
  ads: number | null;
  costOfGoods: number | null;
  tax: number | null;
  /** Доля выручки, у которой вписана себестоимость, %. */
  costCoverage: number;
  /** Сколько продающихся товаров без себестоимости. */
  missingCost: number;
  /** Прибыль: на руки − реклама − себестоимость − налог. null — себестоимости нет совсем. */
  profit: number | null;
  afterWbAndAds: number;
  margin: number | null;
  /** Сколько копеек с рубля выручки забирают WB и реклама, %. */
  takeRate: number | null;
  drrBuyouts: number | null;
  /** ДРР, при котором прибыль ноль. Без себестоимости — только верхняя граница. */
  breakEvenDrr: number | null;
  breakEvenIsUpperBound: boolean;
  /** Деньги в товаре на складах WB: по себестоимости, где она есть, иначе по цене продажи. */
  stockValue: number | null;
  stockValueAtCost: boolean;
  /** За сколько дней распродаётся весь остаток при текущих выкупах. */
  turnoverDays: number | null;
  /** Сколько выкупов в рублях в день теряется на закончившихся товарах. */
  lostPerDay: number;
}

export interface Issue {
  id: string;
  priority: Priority;
  title: string;
  detail: string;
  action: string;
  impactRub?: number;
  /** Подпись к сумме: «в неделю», «заморожено в товаре»… */
  impactLabel?: string;
  products: { nmId: number; vendorCode: string; title: string; note?: string }[];
}

export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: "₽" | "шт" | "%" | "★" | "дн" | "";
  delta?: number | null;
  hint?: string;
  /** 1 — главная полоска «зарабатываю ли я», 2 — операционные цифры. */
  tier: 1 | 2;
  tone?: "good" | "bad";
}

export interface AuditReport {
  data: AuditData;
  kpis: Kpi[];
  products: ProductLine[];
  economics: Economics | null;
  issues: Issue[];
  unavailable: { section: string; reason: string }[];
  negativeFeedbacks: FeedbackRow[];
}

const pct = (a: number, b: number) => (b ? round2(((a - b) / b) * 100) : null);
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** Русские окончания: plural(21, "отзыв", "отзыва", "отзывов") → «21 отзыв». */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const w = a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return `${n} ${w}`;
}
const rub = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(Math.round(n)).toLocaleString("ru-RU")} ₽`;
/** Проценты по-русски: 22,3 — с запятой и одним знаком, минус — настоящий. */
const pc = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}`;
const ref = (p: ProductLine, note?: string) => ({ nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, note });

/** Доля рекламы в выкупах (не в заказах: заказ без выкупа денег не приносит). */
export function shopDrrShare(d: AuditData): number {
  if (!d.ads.ok) return 0;
  const base = d.sales.ok ? d.sales.data.current.totals.buyoutsSum : d.finance.ok ? d.finance.data.totals.sales - d.finance.data.totals.returns : 0;
  return base > 0 ? d.ads.data.total / base : 0;
}

/** Выкуп магазина, %: выкупы к заказам без отмен. */
function shopBuyoutPercent(d: AuditData): number | null {
  if (!d.sales.ok) return null;
  const c = d.sales.data.current.totals;
  const base = c.orders - c.cancels;
  return base > 0 ? round2((c.buyouts / base) * 100) : null;
}

/** Сколько выкупов в рублях товар приносил в день, пока был в наличии. */
export function buyoutRubPerDay(p: ProductLine, days: number, shopBuyout: number | null): number {
  const orders = Math.max(p.ordersSum, p.prevOrdersSum ?? 0) / days;
  return orders * ((p.buyoutPercent ?? shopBuyout ?? 80) / 100);
}

export function buildProducts(d: AuditData): ProductLine[] {
  const map = new Map<number, ProductLine>();
  const days = d.period.days;
  const line = (nmId: number): ProductLine => {
    let p = map.get(nmId);
    if (!p) {
      p = {
        nmId, vendorCode: "", title: "", subject: "", abc: "—", orders: 0, ordersSum: 0, prevOrdersSum: null, ordersDelta: null,
        buyouts: 0, buyoutsSum: 0, returns: 0, buyoutPercent: null, perDay: 0, stock: null, inWayToClient: 0, daysOfStock: null,
        openCount: null, addToCartPercent: null, cartToOrderPercent: null, rating: null, feedbacks: 0, negative: 0,
        forPay: null, logistics: null, penalties: null, afterLogistics: null, photos: null, video: null, descriptionLength: null, characteristics: null,
        soldUnits: null, revenue: null, storage: null, avgPrice: null, logisticsPerUnit: null, cost: null, taxPercent: null,
        profit: null, profitPerUnit: null, margin: null, minPrice: null,
      };
      map.set(nmId, p);
    }
    return p;
  };
  const fill = (p: ProductLine, vendorCode?: string, title?: string, subject?: string) => {
    if (!p.vendorCode && vendorCode) p.vendorCode = vendorCode;
    if (!p.title && title) p.title = title;
    if (!p.subject && subject) p.subject = subject;
  };

  if (d.cards.ok) {
    for (const c of d.cards.data.list) {
      const p = line(c.nmId);
      fill(p, c.vendorCode, c.title, c.subject);
      p.photos = c.photos;
      p.video = c.video;
      p.descriptionLength = c.descriptionLength;
      p.characteristics = c.characteristics;
    }
  }
  if (d.sales.ok) {
    for (const s of d.sales.data.current.products) {
      const p = line(s.nmId);
      fill(p, s.vendorCode, undefined, s.subject);
      p.orders = s.orders;
      p.ordersSum = s.ordersSum;
      p.buyouts = s.buyouts;
      p.buyoutsSum = s.buyoutsSum;
      p.returns = s.returns;
      p.buyoutPercent = s.buyoutPercent;
      p.forPay = s.forPay;
    }
  }
  if (d.abc.ok) for (const a of d.abc.data.items) line(a.nmId).abc = a.class as ProductLine["abc"];
  if (d.funnel.ok) {
    for (const f of d.funnel.data.products) {
      const p = line(f.nmId);
      fill(p, f.vendorCode, f.title, f.subject);
      p.openCount = f.openCount;
      p.addToCartPercent = f.addToCartPercent;
      p.cartToOrderPercent = f.cartToOrderPercent;
      p.rating = f.rating;
      p.prevOrdersSum = f.pastOrderSum;
      // Без статистики продаж берём заказы из воронки.
      if (!d.sales.ok) {
        p.orders = f.orderCount;
        p.ordersSum = f.orderSum;
        p.buyouts = f.buyoutCount;
      }
      if (p.stock === null) p.stock = f.stockWb;
    }
  }
  if (d.stocks.ok) {
    for (const s of d.stocks.data.products) {
      const p = line(s.nmId);
      p.stock = s.quantity;
      p.inWayToClient = s.inWayToClient;
    }
    // Товара нет в отчёте об остатках — значит, на складах WB его ноль. Если отчёт пуст
    // целиком, магазин, скорее всего, торгует со своего склада (FBS): не объявляем всё «закончившимся».
    if (d.stocks.data.products.length) {
      for (const p of map.values()) if (p.stock === null) p.stock = 0;
    } else {
      for (const p of map.values()) p.stock = null; // и нули из воронки тут ничего не значат
    }
  }
  if (d.finance.ok) {
    for (const f of d.finance.data.products) {
      const p = line(f.nmId);
      fill(p, f.vendorCode, f.title);
      p.forPay = f.forPay;
      p.logistics = f.logistics;
      p.penalties = f.penalties;
      p.afterLogistics = f.afterLogistics;
      p.soldUnits = f.salesCount;
      p.revenue = round2(f.sales - f.returns);
      p.storage = f.storage ?? 0; // в старых data.json хранения по товарам нет
    }
  }
  if (d.feedbacks.ok) {
    for (const f of d.feedbacks.data.list) {
      if (!f.nmId) continue;
      const p = line(f.nmId);
      fill(p, f.vendorCode, f.product);
      p.feedbacks += 1;
      if (f.rating <= THRESHOLDS.negativeRating) p.negative += 1;
    }
  }

  const findCost = costLookup(d.costs);
  const drr = shopDrrShare(d);
  for (const p of map.values()) {
    p.perDay = round2(p.orders / days);
    if (p.prevOrdersSum !== null) p.ordersDelta = pct(p.ordersSum, p.prevOrdersSum);
    if (p.stock !== null && p.perDay > 0) p.daysOfStock = Math.round(p.stock / p.perDay);
    const c = findCost(p.nmId, p.vendorCode);
    if (c) {
      p.cost = c.cost;
      p.taxPercent = c.taxPercent ?? 0;
    }
    if (p.soldUnits && p.soldUnits > 0 && p.revenue && p.revenue > 0 && p.afterLogistics !== null) {
      const u = p.soldUnits;
      p.avgPrice = round2(p.revenue / u);
      p.logisticsPerUnit = round2((p.logistics ?? 0) / u);
      if (p.cost !== null) {
        const tax = ((p.taxPercent ?? 0) / 100) * p.revenue;
        p.profit = round2(p.afterLogistics - (p.storage ?? 0) - p.cost * u - tax);
        p.profitPerUnit = round2(p.profit / u);
        p.margin = round2((p.profit / p.revenue) * 100);
        // Цена P, при которой прибыль со штуки — ноль:
        // P × (доля перечисления − налог − ДРР) = себестоимость + (логистика + хранение + штрафы) на штуку.
        const keep = (p.forPay ?? 0) / p.revenue - (p.taxPercent ?? 0) / 100 - drr;
        const fixed = p.cost + ((p.logistics ?? 0) + (p.storage ?? 0) + (p.penalties ?? 0)) / u;
        p.minPrice = keep > 0.1 ? Math.ceil(fixed / keep / 10) * 10 : null;
      }
    }
  }
  // Сначала то, что приносит деньги.
  return [...map.values()].sort((a, b) => b.ordersSum - a.ordersSum || (b.stock ?? 0) - (a.stock ?? 0));
}

export function buildEconomics(d: AuditData, products: ProductLine[]): Economics | null {
  if (!d.finance.ok) return null;
  const t = d.finance.data.totals;
  const revenue = round2(t.sales - t.returns);
  if (revenue <= 0) return null;
  const payout = t.netPayoutEstimate;
  const ads = d.ads.ok ? d.ads.data.total : null;
  const sold = products.filter((p) => (p.revenue ?? 0) > 0);
  const covered = sold.filter((p) => p.cost !== null);
  const soldRevenue = sold.reduce((s, p) => s + (p.revenue ?? 0), 0);
  const coveredRevenue = covered.reduce((s, p) => s + (p.revenue ?? 0), 0);
  const costCoverage = soldRevenue > 0 ? Math.round((coveredRevenue / soldRevenue) * 100) : 0;
  const hasCosts = covered.length > 0;
  const costOfGoods = hasCosts ? round2(covered.reduce((s, p) => s + p.cost! * (p.soldUnits ?? 0), 0)) : null;
  const tax = hasCosts ? round2(covered.reduce((s, p) => s + ((p.taxPercent ?? 0) / 100) * (p.revenue ?? 0), 0)) : null;
  const afterWbAndAds = round2(payout - (ads ?? 0));
  const profit = hasCosts ? round2(afterWbAndAds - costOfGoods! - tax!) : null;
  const buyoutsBase = d.sales.ok ? d.sales.data.current.totals.buyoutsSum : revenue;
  const drrBuyouts = ads !== null && buyoutsBase > 0 ? round2((ads / buyoutsBase) * 100) : null;
  const beforeAds = hasCosts ? payout - costOfGoods! - tax! : payout;

  let stockValue: number | null = null;
  let atCost = true;
  if (d.stocks.ok) {
    stockValue = 0;
    for (const p of products) {
      if (!p.stock) continue;
      const unit = p.cost ?? p.avgPrice ?? (p.buyouts ? p.buyoutsSum / p.buyouts : null);
      if (p.cost === null) atCost = false;
      if (unit) stockValue += p.stock * unit;
    }
    stockValue = Math.round(stockValue);
  }
  const buyoutsPerDay = d.sales.ok ? d.sales.data.current.totals.buyouts / d.period.days : 0;
  const shopBuyout = shopBuyoutPercent(d);
  const lostPerDay = d.stocks.ok
    ? Math.round(products.filter((p) => p.stock === 0 && (p.orders > 0 || (p.prevOrdersSum ?? 0) > 0)).reduce((s, p) => s + buyoutRubPerDay(p, d.period.days, shopBuyout), 0))
    : 0;

  return {
    revenue,
    payout,
    ads,
    costOfGoods,
    tax,
    costCoverage,
    missingCost: sold.length - covered.length,
    profit,
    afterWbAndAds,
    margin: profit !== null ? round2((profit / revenue) * 100) : null,
    takeRate: round2((1 - afterWbAndAds / revenue) * 100),
    drrBuyouts,
    breakEvenDrr: round2((beforeAds / revenue) * 100),
    breakEvenIsUpperBound: !hasCosts,
    stockValue,
    stockValueAtCost: atCost,
    turnoverDays: d.stocks.ok && buyoutsPerDay > 0 ? Math.round(d.stocks.data.total / buyoutsPerDay) : null,
    lostPerDay,
  };
}

export function buildKpis(d: AuditData, e: Economics | null): Kpi[] {
  const k: Kpi[] = [];
  // Первый ряд: зарабатывает ли магазин.
  if (e) {
    const finNote = "по финотчёту WB, он формируется раз в неделю";
    if (e.profit !== null) {
      k.push({
        key: "profit", label: "Прибыль", value: e.profit, unit: "₽", tier: 1, tone: e.profit < 0 ? "bad" : "good",
        hint: e.costCoverage < 100 ? `себестоимость есть для ${e.costCoverage}% выручки — прибыль завышена` : `после WB, рекламы, себестоимости и налога; ${finNote}`,
      });
      k.push({ key: "margin", label: "Маржа", value: e.margin, unit: "%", tier: 1, tone: (e.margin ?? 0) < THRESHOLDS.lowMarginPercent ? "bad" : undefined, hint: "прибыль к выручке" });
    } else {
      k.push({ key: "afterWbAndAds", label: "После WB и рекламы", value: e.afterWbAndAds, unit: "₽", tier: 1, hint: "до себестоимости и налога — впишите себестоимость в data/cost.csv, и здесь будет прибыль" });
    }
    k.push({ key: "takeRate", label: "WB и реклама забирают", value: e.takeRate, unit: "%", tier: 1, hint: `с каждого рубля выручки (выручка ${rub(e.revenue)})` });
    if (e.stockValue !== null) {
      k.push({
        key: "stockValue", label: "Деньги в товаре на WB", value: e.stockValue, unit: "₽", tier: 1,
        hint: `${e.stockValueAtCost ? "по себестоимости" : "частью по цене продажи"}${e.turnoverDays !== null ? `; распродастся за ≈ ${e.turnoverDays} дн.` : ""}`,
      });
    }
  }
  // Второй ряд: что происходит с продажами.
  if (d.sales.ok) {
    const c = d.sales.data.current.totals;
    const p = d.sales.data.previousTotals;
    k.push({ key: "ordersSum", label: "Заказы", value: c.ordersSum, unit: "₽", delta: pct(c.ordersSum, p.ordersSum), hint: `${c.orders} шт`, tier: 2 });
    k.push({ key: "buyoutsSum", label: "Выкупы", value: c.buyoutsSum, unit: "₽", delta: pct(c.buyoutsSum, p.buyoutsSum), hint: `${c.buyouts} шт`, tier: 2 });
    k.push({ key: "buyoutPercent", label: "Выкуп", value: shopBuyoutPercent(d), unit: "%", hint: "выкупы к заказам без отмен, приблизительно", tier: 2 });
  }
  if (d.ads.ok) {
    const drr = round2(shopDrrShare(d) * 100);
    const be = e?.breakEvenDrr;
    k.push({
      key: "drr", label: "ДРР", value: drr || null, unit: "%", tier: 2,
      tone: be !== null && be !== undefined && drr > be ? "bad" : undefined,
      hint: `реклама ${rub(d.ads.data.total)} к выкупам${be !== null && be !== undefined ? `; безубыточный ${e!.breakEvenIsUpperBound ? "не выше " : ""}${pc(be)}%` : ""}`,
    });
  }
  if (e && e.lostPerDay > 0) k.push({ key: "lostPerDay", label: "Теряется в день", value: e.lostPerDay, unit: "₽", tier: 2, tone: "bad", hint: "выкупы закончившихся товаров" });
  if (!e && d.stocks.ok) k.push({ key: "stock", label: "На складах WB", value: d.stocks.data.total, unit: "шт", tier: 2 });
  if (d.seller.ok && d.seller.data.rating !== null) k.push({ key: "rating", label: "Рейтинг продавца", value: d.seller.data.rating, unit: "★", tier: 2 });
  if (d.feedbacks.ok) {
    k.push({ key: "unanswered", label: "Без ответа", value: d.feedbacks.data.unansweredFeedbacks + d.feedbacks.data.unansweredQuestions, unit: "", hint: `отзывов ${d.feedbacks.data.unansweredFeedbacks}, вопросов ${d.feedbacks.data.unansweredQuestions}`, tier: 2 });
  }
  return k;
}

const ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function buildIssues(d: AuditData, products: ProductLine[], e: Economics | null = buildEconomics(d, products)): Issue[] {
  const T = THRESHOLDS;
  const issues: Issue[] = [];
  const days = d.period.days;
  const important = (p: ProductLine) => p.abc === "A" || p.abc === "B";
  const shopBuyout = shopBuyoutPercent(d);
  const perDayRub = (p: ProductLine) => buyoutRubPerDay(p, days, shopBuyout);
  // Деньги в товаре: по себестоимости, если она есть, иначе по средней цене продажи.
  const unitValue = (p: ProductLine) => p.cost ?? p.avgPrice ?? (p.buyouts ? p.buyoutsSum / p.buyouts : 0);

  // 1. Закончился товар, который продаётся.
  if (d.stocks.ok) {
    const out = products.filter((p) => p.stock === 0 && (p.orders > 0 || (p.prevOrdersSum ?? 0) > 0));
    if (out.length) {
      const perDay = out.reduce((s, p) => s + perDayRub(p), 0);
      issues.push({
        id: "out_of_stock",
        priority: out.some(important) || perDay > 3000 ? "high" : "medium",
        title: `Закончились товары, которые продаются: ${out.length}`,
        detail: `Пока товара нет на складах WB, покупатели уходят к конкурентам: это примерно ${rub(perDay)} выкупов в день. Карточка без остатка ещё и теряет позиции в поиске.`,
        action: "Срочно отгрузить поставку. Посмотрите коэффициенты приёмки: где сейчас можно сдать быстро и дёшево.",
        impactRub: Math.round(perDay * 7),
        impactLabel: "выкупов в неделю",
        products: out.map((p) => ref(p, `≈ ${rub(perDayRub(p))} выкупов в день`)),
      });
    }
    // 2. Скоро закончится: поставка идёт ~неделю, всё, что кончится раньше, — упущенные дни.
    const low = products.filter((p) => p.daysOfStock !== null && p.stock! > 0 && p.daysOfStock < T.lowStockDays);
    if (low.length) {
      const gap = (p: ProductLine) => Math.max(0, T.leadTimeDays - p.daysOfStock!);
      const lost = low.reduce((s, p) => s + gap(p) * perDayRub(p), 0);
      issues.push({
        id: "low_stock",
        priority: low.some(important) ? "high" : "medium",
        title: `Скоро закончатся (меньше ${T.lowStockDays} дней): ${low.length}`,
        detail: `Запаса хватит меньше чем на две недели при текущем темпе заказов, а поставка до склада WB идёт ${T.leadTimeDays}–10 дней.${lost > 0 ? ` Если везти только сейчас, товары с запасом меньше ${T.leadTimeDays} дней всё равно успеют закончиться.` : ""}`,
        action: "Запланировать поставку на этой неделе, начиная с товаров группы A.",
        impactRub: lost > 0 ? Math.round(lost) : undefined,
        impactLabel: "выкупов под угрозой",
        products: low.sort((a, b) => a.daysOfStock! - b.daysOfStock!).map((p) => ref(p, `≈ ${p.daysOfStock} дн., остаток ${p.stock} шт`)),
      });
    }
    // 3. Затоваривание и 4. мёртвый остаток — замороженные деньги.
    const over = products.filter((p) => p.daysOfStock !== null && p.daysOfStock > T.overstockDays && (p.stock ?? 0) >= T.overstockMinQty);
    if (over.length) {
      // Лишнее — всё сверх запаса на 60 дней.
      const extra = (p: ProductLine) => Math.max(0, (p.stock ?? 0) - p.perDay * 60);
      const frozen = over.reduce((s, p) => s + extra(p) * unitValue(p), 0);
      issues.push({
        id: "overstock",
        priority: "medium",
        title: `Затоваривание (запас больше ${T.overstockDays} дней): ${over.length}`,
        detail: "Товар лежит на складах дольше, чем продаётся, и каждый день копит платное хранение. Сумма — товар сверх запаса на 60 дней.",
        action: "Не везти новые поставки этих товаров; поднять продажи акцией или скидкой (не ниже минимальной цены); часть остатка можно вывезти.",
        impactRub: Math.round(frozen) || undefined,
        impactLabel: "лишнего товара",
        products: over.sort((a, b) => b.daysOfStock! - a.daysOfStock!).map((p) => ref(p, `≈ ${p.daysOfStock} дн., остаток ${p.stock} шт`)),
      });
    }
    const dead = products.filter((p) => (p.stock ?? 0) > 0 && p.orders === 0);
    if (dead.length) {
      const frozen = dead.reduce((s, p) => s + (p.stock ?? 0) * unitValue(p), 0);
      issues.push({
        id: "dead_stock",
        priority: "medium",
        title: `Лежат без заказов: ${dead.length}`,
        detail: `За ${days} дней ни одного заказа при остатке на складе. Это деньги, которые не работают, плюс расходы на хранение. Если товар только что приехал — пропустите его.`,
        action: "Проверить карточки и цены этих товаров; если спроса нет — распродажа или вывоз со склада.",
        impactRub: Math.round(frozen) || undefined,
        impactLabel: "заморожено в товаре",
        products: dead.map((p) => ref(p, `остаток ${p.stock} шт`)),
      });
    }
  }

  // 5. Убыточные товары — только там, где известна себестоимость.
  const enough = (p: ProductLine) => (p.soldUnits ?? 0) >= T.minUnitsForEconomics;
  const losing = products.filter((p) => p.profit !== null && p.profit < 0 && enough(p));
  if (losing.length) {
    issues.push({
      id: "unprofitable",
      priority: "high",
      title: `Товары, которые продаются в минус: ${losing.length}`,
      detail: "После удержаний WB, логистики, хранения, себестоимости и налога с каждой проданной штуки вы теряете деньги, и реклама сверху делает минус больше. Минимальная цена учитывает текущие удержания WB и ДРР магазина.",
      action: "Поднять цену до минимальной или выше. Если по такой цене не покупают — снять рекламу и распродать остаток.",
      impactRub: Math.round(-losing.reduce((s, p) => s + p.profit!, 0)),
      impactLabel: "убытка за период",
      products: losing.sort((a, b) => a.profit! - b.profit!).map((p) => ref(p, `${rub(p.profitPerUnit!)} со штуки при цене ≈ ${rub(p.avgPrice ?? 0)}${p.minPrice ? `; минимальная цена ≈ ${rub(p.minPrice)}` : ""}`)),
    });
  }
  const thin = products.filter((p) => p.margin !== null && p.profit! >= 0 && p.margin < T.lowMarginPercent && enough(p));
  if (thin.length) {
    issues.push({
      id: "low_margin",
      priority: thin.some(important) ? "medium" : "low",
      title: `Почти без прибыли (маржа меньше ${T.lowMarginPercent}%): ${thin.length}`,
      detail: "Любая скидка, акция WB или подорожание логистики уведёт эти товары в минус.",
      action: "Не заходить с ними в акции ниже минимальной цены; искать дешевле закупку или поднять цену.",
      products: thin.sort((a, b) => a.margin! - b.margin!).map((p) => ref(p, `маржа ${pc(p.margin!)}%, ${rub(p.profitPerUnit!)} со штуки${p.minPrice ? `; ниже ${rub(p.minPrice)} — минус` : ""}`)),
    });
  }
  // Без себестоимости видно только, что товар в минусе уже по услугам WB.
  const wbLosing = products.filter((p) => p.cost === null && p.afterLogistics !== null && p.afterLogistics < 0);
  if (wbLosing.length) {
    issues.push({
      id: "losing_products",
      priority: "high",
      title: `Товары в минусе ещё до себестоимости: ${wbLosing.length}`,
      detail: "К перечислению за эти товары меньше, чем ушло на логистику и штрафы по ним. Бывает и ложный минус: логистика попала в этот отчёт, а выкуп — в следующий.",
      action: "Пересмотреть цену, поднять выкуп или вывести товар из ассортимента.",
      products: wbLosing.sort((a, b) => a.afterLogistics! - b.afterLogistics!).map((p) => ref(p, `итог ${rub(p.afterLogistics!)}`)),
    });
  }

  // 6. Просели продажи.
  if (d.sales.ok) {
    const c = d.sales.data.current.totals.ordersSum;
    const prev = d.sales.data.previousTotals.ordersSum;
    const shopDelta = pct(c, prev);
    // Падение мелкого товара с 2 заказов до 1 — шум; берём важные товары или заметные суммы.
    const dropped = products.filter(
      (p) =>
        p.ordersDelta !== null &&
        p.ordersDelta <= T.salesDropProduct &&
        (p.prevOrdersSum ?? 0) > 0 &&
        (important(p) || (p.prevOrdersSum ?? 0) >= 10_000),
    );
    if ((shopDelta !== null && shopDelta <= T.salesDropShop) || dropped.length) {
      issues.push({
        id: "sales_drop",
        priority: shopDelta !== null && shopDelta <= T.salesDropShop ? "high" : "medium",
        title: shopDelta !== null && shopDelta <= T.salesDropShop ? `Заказы упали на ${pc(Math.abs(shopDelta))}% к прошлому периоду` : `Просели продажи важных товаров: ${dropped.length}`,
        detail: "Частые причины: закончился остаток на ключевых складах, выросла цена, конкуренты демпингуют, свежие негативные отзывы, остановилась реклама.",
        action: "По каждому товару проверить: остаток, цену, новые отзывы и позиции в поиске (команда /competitors покажет выдачу).",
        products: dropped.sort((a, b) => (a.ordersDelta ?? 0) - (b.ordersDelta ?? 0)).map((p) => ref(p, `${pc(p.ordersDelta!)}%: было ${rub(p.prevOrdersSum ?? 0)}, стало ${rub(p.ordersSum)}`)),
      });
    }
  }

  // 7. Слабая конверсия в корзину.
  if (d.funnel.ok) {
    const withTraffic = products.filter((p) => (p.openCount ?? 0) >= T.minOpensForConversion && p.addToCartPercent !== null);
    const med = median(withTraffic.map((p) => p.addToCartPercent!));
    const weak = withTraffic.filter((p) => p.addToCartPercent! < med * T.weakCartFactor);
    if (weak.length && med > 0) {
      issues.push({
        id: "weak_cart_conversion",
        priority: weak.some(important) ? "high" : "medium",
        title: `Карточки, которые смотрят, но не кладут в корзину: ${weak.length}`,
        detail: `Конверсия из просмотра в корзину ниже ${Math.round(T.weakCartFactor * 100)}% от средней по магазину (медиана ${pc(round2(med))}%). Трафик есть, карточка его не удерживает.`,
        action: "Усилить первые фото и инфографику, проверить цену против конкурентов, добавить видео, закрыть возражения в описании и ответах на отзывы.",
        products: weak.map((p) => ref(p, `в корзину ${pc(p.addToCartPercent!)}% при ${p.openCount!.toLocaleString("ru-RU")} переходах`)),
      });
    }
  }

  // 8. Низкий выкуп и дорогая логистика на штуку — одна причина, разные стороны.
  const lowBuyout = products.filter((p) => p.buyoutPercent !== null && p.orders >= T.minOrdersForBuyout && p.buyoutPercent < T.lowBuyoutPercent);
  if (lowBuyout.length) {
    issues.push({
      id: "low_buyout",
      priority: lowBuyout.some(important) ? "high" : "medium",
      title: `Низкий выкуп (меньше ${T.lowBuyoutPercent}%): ${lowBuyout.length}`,
      detail: "Каждый невыкуп — это логистика до покупателя и обратно за ваш счёт, а ещё он снижает позиции карточки. Для одежды и обуви 40–60% бывает нормой — сравнивайте с конкурентами в своей категории.",
      action: "Проверить таблицу размеров, честность фото и описания, частые жалобы в отзывах; для одежды и обуви — добавить подсказку по размеру.",
      products: lowBuyout.map((p) => ref(p, `выкуп ≈ ${pc(p.buyoutPercent!)}% из ${p.orders} заказов${p.logisticsPerUnit ? `, логистика ${rub(p.logisticsPerUnit)} на проданную штуку` : ""}`)),
    });
  }
  const pricyLogistics = products.filter(
    (p) => p.logisticsPerUnit !== null && enough(p) && (p.forPay ?? 0) > 0 && (p.logisticsPerUnit * p.soldUnits!) / p.forPay! * 100 > T.logisticsPerUnitWarn && !lowBuyout.includes(p),
  );
  if (pricyLogistics.length) {
    issues.push({
      id: "logistics_per_unit",
      priority: pricyLogistics.some(important) ? "medium" : "low",
      title: `Логистика съедает больше ${T.logisticsPerUnitWarn}% перечисления: ${pricyLogistics.length}`,
      detail: "Логистика считается на каждый заказ, а деньги приходят только за выкуп. Дешёвым товарам и товарам, которые возвращают, это особенно больно.",
      action: "Поднять выкуп (размеры, фото, описание), продавать дешёвые товары наборами, проверить габариты в карточке — по ним WB считает тариф.",
      products: pricyLogistics.map((p) => ref(p, `${rub(p.logisticsPerUnit!)} на штуку при перечислении ≈ ${rub(p.forPay! / p.soldUnits!)}`)),
    });
  }

  // 9. Негатив в отзывах.
  if (d.feedbacks.ok) {
    // Пара плохих отзывов у хита с сотней оценок — норма; важна доля негатива.
    const bad = products.filter(
      (p) => (p.negative >= 2 && p.feedbacks >= 5 && p.negative / p.feedbacks >= 0.15) || (p.negative >= 8 && p.negative / p.feedbacks >= 0.1),
    );
    if (bad.length) {
      issues.push({
        id: "negative_feedback",
        priority: bad.some(important) ? "high" : "medium",
        title: `Товары с жалобами в отзывах: ${bad.length}`,
        detail: `За период у этих товаров много оценок ${T.negativeRating}★ и ниже. Негатив на первых местах снижает конверсию и выкуп.`,
        action: "Разобрать жалобы (ниже — примеры), исправить причину в товаре или карточке, ответить на каждый негативный отзыв.",
        products: bad.sort((a, b) => b.negative - a.negative).map((p) => ref(p, `${p.negative} негативных из ${p.feedbacks}`)),
      });
    }
    const un = d.feedbacks.data.unansweredFeedbacks + d.feedbacks.data.unansweredQuestions;
    if (un > 0) {
      issues.push({
        id: "unanswered",
        priority: un >= 10 ? "medium" : "low",
        title: `Без ответа: ${plural(d.feedbacks.data.unansweredFeedbacks, "отзыв", "отзыва", "отзывов")} и ${plural(d.feedbacks.data.unansweredQuestions, "вопрос", "вопроса", "вопросов")}`,
        detail: "Ответы продавца видят будущие покупатели. Неотвеченный вопрос — часто потерянный заказ.",
        action: "Ответить сегодня. Можно попросить Claude подготовить черновики ответов — отправка только после вашего «да».",
        products: [],
      });
    }
  }

  // 10. Слабые карточки.
  if (d.cards.ok) {
    const weak = products
      .filter((p) => p.photos !== null)
      .map((p) => {
        const gaps: string[] = [];
        if ((p.photos ?? 0) < T.minPhotos) gaps.push(`фото: ${p.photos}`);
        if (p.video === false) gaps.push("нет видео");
        if ((p.descriptionLength ?? 0) < T.minDescription) gaps.push(`описание ${p.descriptionLength} симв.`);
        if ((p.characteristics ?? 0) < T.minCharacteristics) gaps.push(`характеристик ${p.characteristics}`);
        return { p, gaps };
      })
      .filter((x) => x.gaps.length);
    if (weak.length) {
      issues.push({
        id: "weak_cards",
        priority: weak.some((x) => important(x.p)) ? "medium" : "low",
        title: `Карточки с пробелами в контенте: ${weak.length}`,
        detail: `Ориентир: от ${T.minPhotos} фото, видео, описание от ${T.minDescription} символов с ключевыми запросами, от ${T.minCharacteristics} заполненных характеристик — по ним WB показывает товар в фильтрах.`,
        action: "Начать с товаров группы A и B: команда /card подберёт слова под запросы покупателей и бриф на фото.",
        products: weak.sort((a, b) => b.p.ordersSum - a.p.ordersSum).map((x) => ref(x.p, x.gaps.join(", "))),
      });
    }
  }

  // 11. Реклама: сравниваем с безубыточным ДРР, если знаем себестоимость.
  if (d.ads.ok && e?.drrBuyouts != null) {
    const drr = e.drrBuyouts;
    const be = e.breakEvenDrr;
    const known = be !== null && !e.breakEvenIsUpperBound;
    const over = known ? drr > be! : drr > T.drrHigh;
    const warn = known ? drr > be! * T.drrBreakEvenWarn : drr > T.drrWarn;
    if (warn || (be !== null && drr > be)) {
      issues.push({
        id: "high_drr",
        priority: over || (be !== null && drr > be) ? "high" : "medium",
        title: known && drr > be! ? `Реклама дороже, чем приносит: ДРР ${pc(drr)}% при безубыточном ${pc(be!)}%` : `Дорогая реклама: ДРР ${pc(drr)}% от выкупов`,
        detail: known
          ? `На рекламу ушло ${rub(e.ads ?? 0)}. С вашей себестоимостью реклама окупается, пока ДРР ниже ${pc(be!)}%: выше — каждый рекламный рубль уменьшает прибыль.`
          : `На рекламу ушло ${rub(e.ads ?? 0)} при выкупах на ${rub((e.ads ?? 0) / (drr / 100))}. Ориентир — до ${T.drrWarn}% от выкупов; точный потолок покажет себестоимость в data/cost.csv${be !== null ? ` (сейчас известно только, что он не выше ${pc(be)}%)` : ""}.`,
        action: "Проверить кампании по отдельности (статистика кампаний), остановить те, что не дают заказов, и не рекламировать товары в минусе, с низким выкупом или без остатка.",
        products: d.ads.data.campaigns.slice(0, 5).map((c) => ({ nmId: c.advertId, vendorCode: "", title: c.campName, note: `потрачено ${rub(c.spent)}` })),
      });
    }
  }

  // 12. Деньги: логистика и штрафы.
  if (d.finance.ok) {
    const t = d.finance.data.totals;
    const revenue = t.sales - t.returns;
    const share = revenue > 0 ? (t.logistics / revenue) * 100 : 0;
    if (share > T.logisticsShareWarn) {
      issues.push({
        id: "logistics_share",
        priority: "medium",
        title: `Логистика съедает ${pc(round2(share))}% выручки`,
        detail: `Логистика за период — ${rub(t.logistics)}. Обычно её раздувают невыкупы и поставки не на те склады.`,
        action: "Поднять выкуп у проблемных товаров и распределять поставки по регионам, где покупают (индекс локализации).",
        products: [],
      });
    }
    if (t.penalties > 0) {
      issues.push({
        id: "penalties",
        priority: t.penalties > 5000 ? "medium" : "low",
        title: `Штрафы WB: ${rub(t.penalties)}`,
        detail: "Штрафы обычно за несоответствие поставки, маркировку или нарушение правил упаковки.",
        action: "Найти причины в отчёте о реализации (строки «Штраф») и устранить их в следующих поставках.",
        products: [],
      });
    }
  }

  // 13. Нет себестоимости — главного, без чего прибыль не посчитать.
  if (e && e.costCoverage < 80) {
    issues.push({
      id: "no_costs",
      priority: "low",
      title: e.costCoverage === 0 ? "Не вписана себестоимость — прибыль не посчитана" : `Себестоимость вписана только для ${e.costCoverage}% выручки`,
      detail: "WB не знает, сколько товар стоит вам. Без этого отчёт видит выручку и удержания WB, но не прибыль, не убыточные товары и не минимальную цену для акций.",
      action: "Команда «npm run cost -- --init» создаст файл data/cost.csv со всеми артикулами — впишите себестоимость штуки и налог, потом пересоберите отчёт. Или попросите Claude: «впиши себестоимость».",
      products: [],
    });
  }

  return issues.sort((a, b) => ORDER[a.priority] - ORDER[b.priority] || (b.impactRub ?? 0) - (a.impactRub ?? 0));
}

const SECTION_NAMES: [keyof AuditData, string][] = [
  ["sales", "Продажи и заказы"],
  ["finance", "Деньги"],
  ["funnel", "Воронка карточек"],
  ["stocks", "Остатки"],
  ["feedbacks", "Отзывы и вопросы"],
  ["ads", "Реклама"],
  ["cards", "Карточки"],
  ["seller", "Продавец"],
];

export function buildReport(d: AuditData): AuditReport {
  const products = buildProducts(d);
  const economics = buildEconomics(d, products);
  const unavailable: AuditReport["unavailable"] = [];
  for (const [key, name] of SECTION_NAMES) {
    const s = d[key] as { ok: boolean; reason?: string };
    if (!s.ok) unavailable.push({ section: name, reason: s.reason ?? "" });
  }
  return {
    data: d,
    kpis: buildKpis(d, economics),
    products,
    economics,
    issues: buildIssues(d, products, economics),
    unavailable,
    negativeFeedbacks: d.feedbacks.ok
      ? d.feedbacks.data.list.filter((f) => f.rating <= THRESHOLDS.negativeRating).sort((a, b) => b.createdDate.localeCompare(a.createdDate)).slice(0, 60)
      : [],
  };
}

/** Сжатая выжимка для Claude: по ней он пишет выводы, не читая весь data.json. */
export function summaryForClaude(r: AuditReport) {
  return {
    shop: r.data.seller.ok ? r.data.seller.data : null,
    demo: r.data.demo,
    period: r.data.period,
    previous: r.data.previous,
    kpis: r.kpis,
    economics: r.economics,
    economicsNote:
      "profit — прибыль после WB, рекламы, себестоимости и налога; null — себестоимость не вписана (тогда говори «до себестоимости»). costCoverage < 100 — прибыль завышена. drrBuyouts — реклама к выкупам; breakEvenDrr — ДРР, при котором прибыль ноль (если breakEvenIsUpperBound — это лишь верхняя граница). Финотчёт недельный: последние дни периода могут не попасть.",
    issues: r.issues.map((i) => ({ ...i, products: i.products.slice(0, 8), moreProducts: Math.max(0, i.products.length - 8) })),
    unavailable: r.unavailable,
    abc: r.data.abc.ok ? r.data.abc.data.summary : null,
    topProducts: r.products.slice(0, 15).map((p) => ({
      nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, abc: p.abc, ordersSum: p.ordersSum, ordersDelta: p.ordersDelta,
      buyoutPercent: p.buyoutPercent, stock: p.stock, daysOfStock: p.daysOfStock, addToCartPercent: p.addToCartPercent, rating: p.rating,
      profit: p.profit, profitPerUnit: p.profitPerUnit, margin: p.margin, minPrice: p.minPrice, avgPrice: p.avgPrice,
    })),
    finance: r.data.finance.ok ? r.data.finance.data.totals : null,
    negativeFeedbacks: r.negativeFeedbacks.slice(0, 40).map((f) => ({ rating: f.rating, vendorCode: f.vendorCode, product: f.product, text: f.text, cons: f.cons })),
  };
}
