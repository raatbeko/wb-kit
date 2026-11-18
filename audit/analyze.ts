/**
 * Анализ собранных данных: сводная таблица по товарам, показатели магазина и
 * список проблем с действиями. Только чистые функции — их легко тестировать.
 *
 * Пороги — ориентиры из практики продавцов, а не правила WB. Они вынесены в
 * THRESHOLDS и в отчёте подписаны как ориентиры: у разных категорий нормы разные.
 */
import type { AuditData, FeedbackRow } from "./collect.js";
import { round2 } from "../mcp/wb/src/util.js";

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
  drrWarn: 15, // ДРР, %
  drrHigh: 25,
  logisticsShareWarn: 15, // доля логистики в продажах, %
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
}

export interface Issue {
  id: string;
  priority: Priority;
  title: string;
  detail: string;
  action: string;
  impactRub?: number;
  products: { nmId: number; vendorCode: string; title: string; note?: string }[];
}

export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: "₽" | "шт" | "%" | "★" | "";
  delta?: number | null;
  hint?: string;
}

export interface AuditReport {
  data: AuditData;
  kpis: Kpi[];
  products: ProductLine[];
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
const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const ref = (p: ProductLine, note?: string) => ({ nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, note });

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
    // Товара нет в отчёте об остатках — значит, на складах WB его ноль.
    for (const p of map.values()) if (p.stock === null) p.stock = 0;
  }
  if (d.finance.ok) {
    for (const f of d.finance.data.products) {
      const p = line(f.nmId);
      fill(p, f.vendorCode, f.title);
      p.forPay = f.forPay;
      p.logistics = f.logistics;
      p.penalties = f.penalties;
      p.afterLogistics = f.afterLogistics;
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

  for (const p of map.values()) {
    p.perDay = round2(p.orders / days);
    if (p.prevOrdersSum !== null) p.ordersDelta = pct(p.ordersSum, p.prevOrdersSum);
    if (p.stock !== null && p.perDay > 0) p.daysOfStock = Math.round(p.stock / p.perDay);
  }
  // Сначала то, что приносит деньги.
  return [...map.values()].sort((a, b) => b.ordersSum - a.ordersSum || (b.stock ?? 0) - (a.stock ?? 0));
}

export function buildKpis(d: AuditData): Kpi[] {
  const k: Kpi[] = [];
  if (d.sales.ok) {
    const c = d.sales.data.current.totals;
    const p = d.sales.data.previousTotals;
    k.push({ key: "ordersSum", label: "Заказы", value: c.ordersSum, unit: "₽", delta: pct(c.ordersSum, p.ordersSum), hint: `${c.orders} шт` });
    k.push({ key: "buyoutsSum", label: "Выкупы", value: c.buyoutsSum, unit: "₽", delta: pct(c.buyoutsSum, p.buyoutsSum), hint: `${c.buyouts} шт` });
    const base = c.orders - c.cancels;
    k.push({ key: "buyoutPercent", label: "Выкуп", value: base > 0 ? round2((c.buyouts / base) * 100) : null, unit: "%", hint: "выкупы к заказам без отмен, приблизительно" });
    k.push({ key: "forPay", label: "К перечислению", value: c.forPay, unit: "₽", hint: "за выкупы минус возвраты, до логистики и хранения" });
  }
  if (d.ads.ok) {
    const ordersSum = d.sales.ok ? d.sales.data.current.totals.ordersSum : 0;
    k.push({ key: "adSpend", label: "Реклама", value: d.ads.data.total, unit: "₽" });
    k.push({ key: "drr", label: "ДРР", value: ordersSum ? round2((d.ads.data.total / ordersSum) * 100) : null, unit: "%", hint: "расходы на рекламу к сумме заказов" });
  }
  if (d.finance.ok) {
    k.push({ key: "netPayout", label: "На руки (оценка)", value: d.finance.data.totals.netPayoutEstimate, unit: "₽", hint: "по финотчёту WB, до себестоимости, налогов и рекламы" });
  }
  if (d.stocks.ok) k.push({ key: "stock", label: "На складах WB", value: d.stocks.data.total, unit: "шт" });
  if (d.seller.ok && d.seller.data.rating !== null) k.push({ key: "rating", label: "Рейтинг продавца", value: d.seller.data.rating, unit: "★" });
  if (d.feedbacks.ok) {
    k.push({ key: "unanswered", label: "Без ответа", value: d.feedbacks.data.unansweredFeedbacks + d.feedbacks.data.unansweredQuestions, unit: "", hint: `отзывов ${d.feedbacks.data.unansweredFeedbacks}, вопросов ${d.feedbacks.data.unansweredQuestions}` });
  }
  return k;
}

const ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function buildIssues(d: AuditData, products: ProductLine[]): Issue[] {
  const T = THRESHOLDS;
  const issues: Issue[] = [];
  const days = d.period.days;
  const important = (p: ProductLine) => p.abc === "A" || p.abc === "B";

  // 1. Закончился товар, который продаётся.
  if (d.stocks.ok) {
    const out = products.filter((p) => p.stock === 0 && (p.orders > 0 || (p.prevOrdersSum ?? 0) > 0));
    if (out.length) {
      const perDay = out.reduce((s, p) => s + Math.max(p.ordersSum, p.prevOrdersSum ?? 0) / days, 0);
      issues.push({
        id: "out_of_stock",
        priority: out.some(important) || perDay > 3000 ? "high" : "medium",
        title: `Закончились товары, которые продаются: ${out.length}`,
        detail: `Пока товара нет на складах WB, заказы уходят конкурентам — примерно ${rub(perDay)} заказов в день. Карточка без остатка ещё и теряет позиции в поиске.`,
        action: "Срочно отгрузить поставку. Посмотрите коэффициенты приёмки: где сейчас можно сдать быстро и дёшево.",
        impactRub: Math.round(perDay * 7),
        products: out.map((p) => ref(p, `в день было заказов на ${rub(Math.max(p.ordersSum, p.prevOrdersSum ?? 0) / days)}`)),
      });
    }
    // 2. Скоро закончится.
    const low = products.filter((p) => p.daysOfStock !== null && p.stock! > 0 && p.daysOfStock < T.lowStockDays);
    if (low.length) {
      issues.push({
        id: "low_stock",
        priority: low.some(important) ? "high" : "medium",
        title: `Скоро закончатся (меньше ${T.lowStockDays} дней): ${low.length}`,
        detail: "Запаса хватит меньше чем на две недели при текущем темпе заказов. Поставка до склада WB обычно идёт 5–10 дней.",
        action: "Запланировать поставку на этой неделе, начиная с товаров группы A.",
        products: low.sort((a, b) => a.daysOfStock! - b.daysOfStock!).map((p) => ref(p, `≈ ${p.daysOfStock} дн., остаток ${p.stock} шт`)),
      });
    }
    // 3. Затоваривание и 4. мёртвый остаток.
    const over = products.filter((p) => p.daysOfStock !== null && p.daysOfStock > T.overstockDays && (p.stock ?? 0) >= T.overstockMinQty);
    if (over.length) {
      issues.push({
        id: "overstock",
        priority: "medium",
        title: `Затоваривание (запас больше ${T.overstockDays} дней): ${over.length}`,
        detail: "Товар лежит на складах дольше, чем продаётся, и каждый день копит платное хранение.",
        action: "Не везти новые поставки этих товаров; поднять продажи акцией или скидкой; часть остатка можно вывезти.",
        products: over.sort((a, b) => b.daysOfStock! - a.daysOfStock!).map((p) => ref(p, `≈ ${p.daysOfStock} дн., остаток ${p.stock} шт`)),
      });
    }
    const dead = products.filter((p) => (p.stock ?? 0) > 0 && p.orders === 0);
    if (dead.length) {
      issues.push({
        id: "dead_stock",
        priority: "medium",
        title: `Лежат без заказов: ${dead.length}`,
        detail: `За ${days} дней ни одного заказа при остатке на складе. Это чистые расходы на хранение.`,
        action: "Проверить карточки и цены этих товаров; если спроса нет — распродажа или вывоз со склада.",
        products: dead.map((p) => ref(p, `остаток ${p.stock} шт`)),
      });
    }
  }

  // 5. Просели продажи.
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
        title: shopDelta !== null && shopDelta <= T.salesDropShop ? `Заказы упали на ${Math.abs(shopDelta)}% к прошлому периоду` : `Просели продажи важных товаров: ${dropped.length}`,
        detail: "Частые причины: закончился остаток на ключевых складах, выросла цена, конкуренты демпингуют, свежие негативные отзывы, остановилась реклама.",
        action: "По каждому товару проверить: остаток, цену, новые отзывы и позиции в поиске (команда /competitors покажет выдачу).",
        products: dropped.sort((a, b) => (a.ordersDelta ?? 0) - (b.ordersDelta ?? 0)).map((p) => ref(p, `${p.ordersDelta}%: было ${rub(p.prevOrdersSum ?? 0)}, стало ${rub(p.ordersSum)}`)),
      });
    }
  }

  // 6. Слабая конверсия в корзину.
  if (d.funnel.ok) {
    const withTraffic = products.filter((p) => (p.openCount ?? 0) >= T.minOpensForConversion && p.addToCartPercent !== null);
    const med = median(withTraffic.map((p) => p.addToCartPercent!));
    const weak = withTraffic.filter((p) => p.addToCartPercent! < med * T.weakCartFactor);
    if (weak.length && med > 0) {
      issues.push({
        id: "weak_cart_conversion",
        priority: weak.some(important) ? "high" : "medium",
        title: `Карточки, которые смотрят, но не кладут в корзину: ${weak.length}`,
        detail: `Конверсия из просмотра в корзину ниже ${Math.round(T.weakCartFactor * 100)}% от средней по магазину (медиана ${round2(med)}%). Трафик есть, карточка его не удерживает.`,
        action: "Усилить первые фото и инфографику, проверить цену против конкурентов, добавить видео, закрыть возражения в описании и ответах на отзывы.",
        products: weak.map((p) => ref(p, `в корзину ${p.addToCartPercent}% при ${p.openCount} переходах`)),
      });
    }
  }

  // 7. Низкий выкуп.
  const lowBuyout = products.filter((p) => p.buyoutPercent !== null && p.orders >= T.minOrdersForBuyout && p.buyoutPercent < T.lowBuyoutPercent);
  if (lowBuyout.length) {
    issues.push({
      id: "low_buyout",
      priority: lowBuyout.some(important) ? "high" : "medium",
      title: `Низкий выкуп (меньше ${T.lowBuyoutPercent}%): ${lowBuyout.length}`,
      detail: "Каждый невыкуп — это логистика до покупателя и обратно за ваш счёт, а ещё он снижает позиции карточки.",
      action: "Проверить таблицу размеров, честность фото и описания, частые жалобы в отзывах; для одежды и обуви — добавить подсказку по размеру.",
      products: lowBuyout.map((p) => ref(p, `выкуп ≈ ${p.buyoutPercent}% из ${p.orders} заказов`)),
    });
  }

  // 8. Негатив в отзывах.
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

  // 9. Слабые карточки.
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
        action: "Начать с товаров группы A и B. Claude может написать SEO-описание и подсказать, какие фото и инфографику добавить.",
        products: weak.sort((a, b) => b.p.ordersSum - a.p.ordersSum).map((x) => ref(x.p, x.gaps.join(", "))),
      });
    }
  }

  // 10. Реклама.
  if (d.ads.ok && d.sales.ok) {
    const ordersSum = d.sales.data.current.totals.ordersSum;
    const drr = ordersSum ? (d.ads.data.total / ordersSum) * 100 : null;
    if (drr !== null && drr > T.drrWarn) {
      issues.push({
        id: "high_drr",
        priority: drr > T.drrHigh ? "high" : "medium",
        title: `Дорогая реклама: ДРР ${round2(drr)}%`,
        detail: `На рекламу ушло ${rub(d.ads.data.total)} при заказах на ${rub(ordersSum)}. Ориентир для большинства категорий — до ${T.drrWarn}%.`,
        action: "Проверить кампании по отдельности (статистика кампаний), остановить те, что не дают заказов, и не рекламировать товары с низким выкупом или без остатка.",
        products: d.ads.data.campaigns.slice(0, 5).map((c) => ({ nmId: c.advertId, vendorCode: "", title: c.campName, note: `потрачено ${rub(c.spent)}` })),
      });
    }
  }

  // 11. Деньги: логистика, убыточные товары, штрафы.
  if (d.finance.ok) {
    const t = d.finance.data.totals;
    const share = t.sales ? (t.logistics / t.sales) * 100 : 0;
    if (share > T.logisticsShareWarn) {
      issues.push({
        id: "logistics_share",
        priority: "medium",
        title: `Логистика съедает ${round2(share)}% продаж`,
        detail: `Логистика за период — ${rub(t.logistics)}. Обычно её раздувают невыкупы и поставки не на те склады.`,
        action: "Поднять выкуп у проблемных товаров и распределять поставки по регионам, где покупают (индекс локализации).",
        products: [],
      });
    }
    const losing = products.filter((p) => p.afterLogistics !== null && p.afterLogistics < 0);
    if (losing.length) {
      issues.push({
        id: "losing_products",
        priority: "high",
        title: `Товары в минусе ещё до себестоимости: ${losing.length}`,
        detail: "К перечислению за эти товары меньше, чем ушло на логистику и штрафы по ним.",
        action: "Пересмотреть цену, поднять выкуп или вывести товар из ассортимента.",
        products: losing.sort((a, b) => a.afterLogistics! - b.afterLogistics!).map((p) => ref(p, `итог ${rub(p.afterLogistics!)}`)),
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
  const unavailable: AuditReport["unavailable"] = [];
  for (const [key, name] of SECTION_NAMES) {
    const s = d[key] as { ok: boolean; reason?: string };
    if (!s.ok) unavailable.push({ section: name, reason: s.reason ?? "" });
  }
  return {
    data: d,
    kpis: buildKpis(d),
    products,
    issues: buildIssues(d, products),
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
    issues: r.issues.map((i) => ({ ...i, products: i.products.slice(0, 8), moreProducts: Math.max(0, i.products.length - 8) })),
    unavailable: r.unavailable,
    abc: r.data.abc.ok ? r.data.abc.data.summary : null,
    topProducts: r.products.slice(0, 15).map((p) => ({
      nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, abc: p.abc, ordersSum: p.ordersSum, ordersDelta: p.ordersDelta,
      buyoutPercent: p.buyoutPercent, stock: p.stock, daysOfStock: p.daysOfStock, addToCartPercent: p.addToCartPercent, rating: p.rating,
    })),
    finance: r.data.finance.ok ? r.data.finance.data.totals : null,
    negativeFeedbacks: r.negativeFeedbacks.slice(0, 40).map((f) => ({ rating: f.rating, vendorCode: f.vendorCode, product: f.product, text: f.text, cons: f.cons })),
  };
}
