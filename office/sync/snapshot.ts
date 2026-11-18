/**
 * Снимок магазина для офиса: из отчёта аудита (audit/analyze.ts) берём то,
 * что показывают экраны и столы сотрудников, и раскладываем проблемы по
 * ответственным. Считать заново ничего не нужно — расчёты общие с /audit.
 */
import type { AuditReport, Issue, Kpi, ProductLine } from "../../audit/analyze.js";

/** Кто в офисе отвечает за проблему аудита. */
export const ISSUE_OWNER: Record<string, string> = {
  out_of_stock: "logist",
  low_stock: "logist",
  overstock: "logist",
  dead_stock: "logist",
  sales_drop: "analyst",
  low_buyout: "analyst",
  weak_cart_conversion: "analyst",
  losing_products: "finance",
  logistics_share: "finance",
  penalties: "finance",
  high_drr: "marketer",
  negative_feedback: "reviews",
  unanswered: "reviews",
  weak_cards: "content",
};

export interface SnapshotIssue extends Omit<Issue, "products"> {
  owner: string;
  products: Issue["products"];
}

/** Товар — все расчёты аудита по нему (продажи, остатки, воронка, деньги, карточка). */
export type SnapshotProduct = ProductLine;

/** Отзыв для менеджера отзывов. Имён покупателей в данных WB тут нет. */
export interface SnapshotFeedback {
  createdDate: string;
  rating: number;
  text: string;
  cons: string;
  answered: boolean;
  nmId: number;
  vendorCode: string;
  product: string;
}

/** Цифры «на столе» сотрудника: 2–3 главных показателя его участка. */
export interface DeskStat {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}

export interface Snapshot {
  demo: boolean;
  shop: string | null;
  period: { from: string; to: string; days: number };
  generatedAt: string;
  kpis: Kpi[];
  issues: SnapshotIssue[];
  products: SnapshotProduct[];
  weekly: { week: string; ordersSum: number; buyoutsSum: number }[];
  unavailable: { section: string; reason: string }[];
  desks: Record<string, DeskStat[]>;
  /** Деньги по финотчёту WB (итоги периода) — для финансиста. */
  finance: Record<string, number> | null;
  /** Реклама — для маркетолога. */
  ads: { total: number; campaigns: { advertId: number; campName: string; spent: number }[] } | null;
  /** Отзывы: последние негативные и счётчики без ответа. */
  feedbacks: { unansweredFeedbacks: number; unansweredQuestions: number; negative: SnapshotFeedback[] } | null;
  /** Остатки по складам WB — для логиста. */
  warehouses: { name: string; quantity: number }[];
  /** ABC: сколько товаров в каждой группе и их доля выручки. */
  abc: Record<string, unknown> | null;
}

const rub = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const kpi = (r: AuditReport, key: string) => r.kpis.find((k) => k.key === key);

function desks(r: AuditReport, issues: SnapshotIssue[]): Record<string, DeskStat[]> {
  const count = (owner: string, priority?: string) =>
    issues.filter((i) => i.owner === owner && (!priority || i.priority === priority)).length;
  const issueStat = (owner: string): DeskStat => {
    const high = count(owner, "high");
    const all = count(owner);
    return { label: "Проблем", value: String(all), tone: high ? "bad" : all ? "warn" : "ok" };
  };

  const orders = kpi(r, "ordersSum");
  const buyout = kpi(r, "buyoutPercent");
  const drr = kpi(r, "drr");
  const ads = kpi(r, "adSpend");
  const net = kpi(r, "netPayout");
  const unanswered = kpi(r, "unanswered");
  const rating = kpi(r, "rating");
  const stock = kpi(r, "stock");
  const ending = r.products.filter((p) => p.daysOfStock !== null && p.daysOfStock < 14 && p.perDay > 0).length;
  const fin = r.data.finance.ok ? r.data.finance.data.totals : null;
  const weakCards = issues.find((i) => i.id === "weak_cards")?.products.length ?? 0;

  const delta = (d: number | null | undefined): DeskStat["tone"] => (d === null || d === undefined ? "neutral" : d < -10 ? "bad" : d < 0 ? "warn" : "ok");

  return {
    director: [
      { label: "Заказы", value: rub(orders?.value), tone: delta(orders?.delta) },
      { label: "Срочно", value: String(issues.filter((i) => i.priority === "high").length), tone: issues.some((i) => i.priority === "high") ? "bad" : "ok" },
    ],
    analyst: [
      { label: "Заказы", value: orders?.delta !== null && orders?.delta !== undefined ? `${orders.delta > 0 ? "+" : ""}${orders.delta}%` : "—", tone: delta(orders?.delta) },
      { label: "Выкуп", value: buyout?.value !== null && buyout?.value !== undefined ? `${buyout.value}%` : "—", tone: buyout?.value !== null && buyout?.value !== undefined && buyout.value < 50 ? "bad" : "neutral" },
      issueStat("analyst"),
    ],
    finance: [
      { label: "На руки", value: rub(net?.value), tone: "neutral" },
      { label: "Штрафы", value: rub(fin?.penalties), tone: fin && fin.penalties > 0 ? "warn" : "ok" },
      issueStat("finance"),
    ],
    scout: [{ label: "Конкуренты", value: "/competitors", tone: "neutral" }],
    reviews: [
      { label: "Без ответа", value: unanswered?.value !== null && unanswered?.value !== undefined ? String(unanswered.value) : "—", tone: unanswered?.value ? "warn" : "ok" },
      { label: "Рейтинг", value: rating?.value !== null && rating?.value !== undefined ? `${rating.value}★` : "—", tone: "neutral" },
      issueStat("reviews"),
    ],
    logist: [
      { label: "На складах", value: stock?.value !== null && stock?.value !== undefined ? `${stock.value.toLocaleString("ru-RU")} шт` : "—", tone: "neutral" },
      { label: "Кончится <14 дн", value: String(ending), tone: ending ? "bad" : "ok" },
      issueStat("logist"),
    ],
    marketer: [
      { label: "Реклама", value: rub(ads?.value), tone: "neutral" },
      { label: "ДРР", value: drr?.value !== null && drr?.value !== undefined ? `${drr.value}%` : "—", tone: drr?.value && drr.value > 15 ? "bad" : "ok" },
    ],
    content: [{ label: "Слабых карточек", value: String(weakCards), tone: weakCards ? "warn" : "ok" }],
    reports: [{ label: "Отчётов", value: "по запросу", tone: "neutral" }],
  };
}

export function buildSnapshot(r: AuditReport): Snapshot {
  const issues: SnapshotIssue[] = r.issues.map((i) => ({ ...i, owner: ISSUE_OWNER[i.id] ?? "director", products: i.products.slice(0, 20) }));
  const d = r.data;
  return {
    demo: d.demo,
    shop: d.seller.ok ? d.seller.data.tradeMark || d.seller.data.name : null,
    period: d.period,
    generatedAt: d.generatedAt,
    kpis: r.kpis,
    issues,
    // До 300 товаров: таблицы сотрудников сортируются и фильтруются в браузере.
    products: r.products.slice(0, 300),
    weekly: d.sales.ok ? d.sales.data.weekly.map((w) => ({ week: w.weekStart, ordersSum: w.ordersSum, buyoutsSum: w.buyoutsSum })) : [],
    unavailable: r.unavailable,
    desks: desks(r, issues),
    finance: d.finance.ok ? (d.finance.data.totals as unknown as Record<string, number>) : null,
    ads: d.ads.ok ? { total: d.ads.data.total, campaigns: [...d.ads.data.campaigns].sort((a, b) => b.spent - a.spent).slice(0, 50) } : null,
    feedbacks: d.feedbacks.ok
      ? {
          unansweredFeedbacks: d.feedbacks.data.unansweredFeedbacks,
          unansweredQuestions: d.feedbacks.data.unansweredQuestions,
          negative: r.negativeFeedbacks.slice(0, 40).map((f) => ({
            createdDate: f.createdDate, rating: f.rating, text: f.text, cons: f.cons, answered: f.answered, nmId: f.nmId, vendorCode: f.vendorCode, product: f.product,
          })),
        }
      : null,
    warehouses: d.stocks.ok ? warehouseTotals(d.stocks.data.products) : [],
    abc: d.abc.ok ? (d.abc.data.summary as unknown as Record<string, unknown>) : null,
  };
}

/** Сумма остатков по складам WB, от большего к меньшему. */
function warehouseTotals(products: { warehouses: Record<string, number> }[]): { name: string; quantity: number }[] {
  const m = new Map<string, number>();
  for (const p of products) for (const [name, q] of Object.entries(p.warehouses)) m.set(name, (m.get(name) ?? 0) + q);
  return [...m].map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity);
}
