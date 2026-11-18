/**
 * Снимок магазина для офиса: из отчёта аудита (audit/analyze.ts) берём то,
 * что показывают экраны и столы сотрудников, и раскладываем проблемы по
 * ответственным. Считать заново ничего не нужно — расчёты общие с /audit.
 */
import type { AuditReport, Issue, Kpi } from "../../audit/analyze.js";

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

export interface SnapshotProduct {
  nmId: number;
  vendorCode: string;
  title: string;
  abc: string;
  ordersSum: number;
  ordersDelta: number | null;
  perDay: number;
  stock: number | null;
  daysOfStock: number | null;
  buyoutPercent: number | null;
  rating: number | null;
  negative: number;
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
    products: r.products.slice(0, 200).map((p) => ({
      nmId: p.nmId,
      vendorCode: p.vendorCode,
      title: p.title,
      abc: p.abc,
      ordersSum: p.ordersSum,
      ordersDelta: p.ordersDelta,
      perDay: p.perDay,
      stock: p.stock,
      daysOfStock: p.daysOfStock,
      buyoutPercent: p.buyoutPercent,
      rating: p.rating,
      negative: p.negative,
    })),
    weekly: d.sales.ok ? d.sales.data.weekly.map((w) => ({ week: w.weekStart, ordersSum: w.ordersSum, buyoutsSum: w.buyoutsSum })) : [],
    unavailable: r.unavailable,
    desks: desks(r, issues),
  };
}
