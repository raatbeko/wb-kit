/**
 * План закупки: сколько штук каждого товара завезти по месяцам и до какого дня заказать.
 *
 * Данные — воронка WB по месяцам за последний год (заказы и выкупы по каждому
 * товару) и остатки на складах WB и у продавца. Сезонность считаем по предмету
 * (все пледы вместе): у одного артикула истории обычно мало. Нет года истории —
 * сезонность не учитываем и честно об этом пишем.
 *
 * Расход со склада = заказы × доля выкупа: невыкупленное возвращается на склад.
 * Пороги и допущения — в PL.
 */
import { HOSTS, LIMITER_KEYS, type WBClient } from "../mcp/wb/src/client.js";
import { num } from "../mcp/wb/src/util.js";
import { explainFailure, type Section } from "../audit/collect.js";
import type { CostRow } from "../audit/cost.js";

type Row = Record<string, unknown>;

export const PL = {
  /** Дней от заказа поставщику до приёмки на складе WB. */
  leadDays: 21,
  /** На сколько месяцев вперёд план. */
  months: 3,
  /** Запас сверху на ошибку прогноза. */
  safety: 0.15,
  /** Сезонность предмета считаем, если есть столько разных месяцев… */
  seasonMinMonths: 9,
  /** …и столько заказов за год. */
  seasonMinOrders: 60,
  /** Сезон есть, если лучший месяц продаёт хотя бы во столько раз больше худшего; иначе продажи ровные. */
  seasonMinSwing: 1.4,
  /** Сезонный коэффициент не выходит за эти пределы: выбросы истории не должны давать ×10. */
  seasonClamp: [0.3, 3] as [number, number],
  /** Доля выкупа, если своей мало данных. */
  defaultBuyout: 0.8,
  /** «Локомотив» — товар, который даёт не меньше этой доли расхода своего предмета. */
  locomotiveShare: 0.3,
};

export interface MonthPoint {
  /** «2026-03» */
  month: string;
  from: string;
  to: string;
  days: number;
  /** nmId → заказы и выкупы за месяц. */
  byNm: Record<string, { orders: number; buyouts: number }>;
}

export interface PlanProduct {
  nmId: number;
  vendorCode: string;
  title: string;
  subject: string;
  stockWb: number;
  stockOwn: number;
  orders28: number;
  buyouts28: number;
}

export interface PlanData {
  version: 1;
  generatedAt: string;
  demo: boolean;
  /** Последний полный день. */
  today: string;
  products: Section<PlanProduct[]>;
  history: Section<MonthPoint[]>;
  costs?: CostRow[] | null;
  /** Сервер картинок WB по артикулу (найден по публичному CDN), если искали. */
  baskets?: Record<string, number>;
}

const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;
const localDate = (t: Date) => new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Календарные месяцы истории: не старше 365 дней (дальше воронка WB не отдаёт), последний — до `to`. */
export function historyMonths(to: string, back = 12): { month: string; from: string; to: string }[] {
  const oldest = shift(to, -364);
  const out: { month: string; from: string; to: string }[] = [];
  const [y, m] = to.split("-").map(Number) as [number, number];
  for (let i = back; i >= 0; i--) {
    const first = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, m - i, 0)).toISOString().slice(0, 10);
    const from = first < oldest ? oldest : first;
    const end = last > to ? to : last;
    // Хвосты меньше 7 дней дают случайные коэффициенты — пропускаем.
    if (end >= from && daysBetween(from, end) >= 7) out.push({ month: first.slice(0, 7), from, to: end });
  }
  return out;
}

async function funnel(client: WBClient, from: string, to: string): Promise<Row[]> {
  const all: Row[] = [];
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const res = await client.post<{ data?: { products?: Row[] } }>(
      HOSTS.analytics,
      "/api/analytics/v3/sales-funnel/products",
      { selectedPeriod: { start: from, end: to }, nmIds: [], orderBy: { field: "orderCount", mode: "desc" }, limit: 1000, offset },
      undefined,
      { limiterKey: LIMITER_KEYS.funnel },
    );
    const page = res?.data?.products ?? [];
    all.push(...page);
    if (page.length < 1000) break;
  }
  return all;
}

export async function collectPlan(client: WBClient, opts: { now?: Date; demo?: boolean; season?: boolean; log?: (m: string) => void; costs?: CostRow[] | null } = {}): Promise<PlanData> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const today = shift(localDate(now), -1);

  let products: Section<PlanProduct[]>;
  try {
    log("… Товары, остатки и заказы за 4 недели");
    const rows = await funnel(client, shift(today, -27), today);
    products = {
      ok: true,
      data: rows.map((item) => {
        const p = (item["product"] ?? {}) as Row;
        const sel = (((item["statistic"] ?? {}) as Row)["selected"] ?? {}) as Row;
        const st = (p["stocks"] ?? {}) as Row;
        return {
          nmId: num(p["nmId"]),
          vendorCode: String(p["vendorCode"] ?? ""),
          title: String(p["title"] ?? ""),
          subject: String(p["subjectName"] ?? ""),
          stockWb: num(st["wb"]),
          stockOwn: num(st["mp"]),
          orders28: num(sel["orderCount"]),
          buyouts28: num(sel["buyoutCount"]),
        };
      }),
    };
    log("✓ Товары и остатки");
  } catch (err) {
    products = { ok: false, reason: explainFailure(err) };
    log(`✗ Товары: ${products.reason}`);
  }

  let history: Section<MonthPoint[]> = { ok: true, data: [] };
  if (products.ok && opts.season !== false) {
    const months = historyMonths(today);
    log(`… История по месяцам: ${months.length} запросов, WB отдаёт 3 в минуту — около ${Math.ceil(months.length / 3)} мин`);
    try {
      const data: MonthPoint[] = [];
      for (const m of months) {
        const byNm: MonthPoint["byNm"] = {};
        for (const item of await funnel(client, m.from, m.to)) {
          const p = (item["product"] ?? {}) as Row;
          const sel = (((item["statistic"] ?? {}) as Row)["selected"] ?? {}) as Row;
          const o = num(sel["orderCount"]);
          if (o || num(sel["buyoutCount"])) byNm[String(num(p["nmId"]))] = { orders: o, buyouts: num(sel["buyoutCount"]) };
        }
        data.push({ ...m, days: daysBetween(m.from, m.to), byNm });
        log(`  ✓ ${m.month}`);
      }
      history = { ok: true, data };
    } catch (err) {
      history = { ok: false, reason: explainFailure(err) };
      log(`✗ История: ${history.reason}`);
    }
  }
  return { version: 1, generatedAt: now.toISOString(), demo: Boolean(opts.demo), today, products, history, costs: opts.costs ?? null };
}

// ── Расчёт ──

export interface PlanMonth {
  /** «2026-12» */
  month: string;
  /** Сколько уйдёт со склада за месяц (с учётом выкупа и сезона). */
  need: number;
  /** Сколько должно приехать на склад к началу месяца. */
  ship: number;
}

export interface PlanRow {
  nmId: number;
  vendorCode: string;
  title: string;
  subject: string;
  stock: number;
  stockWb: number;
  stockOwn: number;
  /** Заказов в день сейчас (за 4 недели). */
  ordersPerDay: number;
  buyout: number;
  /** Сколько уходит со склада в день сейчас. */
  perDay: number;
  /** Хватит остатка, дней (null — продаж нет). */
  daysLeft: number | null;
  /** До какого дня заказать у поставщика (с учётом срока поставки). */
  orderBy: string | null;
  urgent: boolean;
  months: PlanMonth[];
  /** Сколько заказать всего, с запасом. */
  toOrder: number;
  cost: number | null;
  money: number | null;
  seasonal: boolean;
  locomotive: boolean;
  /** Остаток больше, чем уйдёт за весь план. */
  overstock: boolean;
}

export interface PlanReport {
  data: PlanData;
  params: { leadDays: number; months: number; safety: number };
  monthsList: string[];
  rows: PlanRow[];
  /** Предмет → сезонные коэффициенты по номеру месяца (1–12); нет — сезонность не учтена. */
  season: Record<string, Record<number, number>>;
  totals: { toOrder: number; money: number | null; urgent: number; costCoverage: number };
  notes: string[];
  unavailable: { section: string; reason: string }[];
}

const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const monthName = (ym: string) => MONTHS_RU[Number(ym.slice(5, 7)) - 1]!;

/** Сезонные коэффициенты предмета: заказы в день по месяцу к среднему за год. */
export function seasonIndex(history: MonthPoint[], nmIds: number[]): Record<number, number> | null {
  const rate = new Map<number, number[]>();
  let total = 0;
  for (const m of history) {
    let o = 0;
    for (const id of nmIds) o += m.byNm[String(id)]?.orders ?? 0;
    total += o;
    const cal = Number(m.month.slice(5, 7));
    // Месяц, в котором товара ещё не было, не делает сезон «мёртвым»: пропускаем нули.
    if (o > 0) rate.set(cal, [...(rate.get(cal) ?? []), o / m.days]);
  }
  if (rate.size < PL.seasonMinMonths || total < PL.seasonMinOrders) return null;
  const perCal = new Map([...rate].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  const avg = [...perCal.values()].reduce((a, b) => a + b, 0) / perCal.size;
  const [lo, hi] = PL.seasonClamp;
  const out: Record<number, number> = {};
  for (let c = 1; c <= 12; c++) out[c] = Math.min(hi, Math.max(lo, (perCal.get(c) ?? avg) / avg));
  const vals = Object.values(out);
  return Math.max(...vals) / Math.min(...vals) >= PL.seasonMinSwing ? out : null;
}

export function buildPlan(d: PlanData, opts: Partial<{ leadDays: number; months: number; safety: number }> = {}): PlanReport {
  const params = { leadDays: opts.leadDays ?? PL.leadDays, months: opts.months ?? PL.months, safety: opts.safety ?? PL.safety };
  const unavailable: PlanReport["unavailable"] = [];
  if (!d.products.ok) unavailable.push({ section: "Товары и остатки", reason: d.products.reason });
  if (!d.history.ok) unavailable.push({ section: "История по месяцам", reason: d.history.reason });
  const products = d.products.ok ? d.products.data : [];
  const history = d.history.ok ? d.history.data : [];
  const notes: string[] = [];

  // Месяцы плана: текущий (остаток дней) и следующие.
  const start = shift(d.today, 1);
  const monthsList: string[] = [];
  for (let i = 0; i < params.months; i++) {
    const [y, m] = start.split("-").map(Number) as [number, number];
    monthsList.push(new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7));
  }
  const daysIn = (ym: string) => {
    const [y, m] = ym.split("-").map(Number) as [number, number];
    const first = `${ym}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return daysBetween(first < start ? start : first, last);
  };

  const subjects = new Map<string, number[]>();
  for (const p of products) subjects.set(p.subject, [...(subjects.get(p.subject) ?? []), p.nmId]);
  const season: PlanReport["season"] = {};
  for (const [s, ids] of subjects) {
    const idx = seasonIndex(history, ids);
    if (idx) season[s] = idx;
  }
  if (!history.length) notes.push("Сезонность не учтена: история по месяцам не собиралась. Прогноз — по продажам последних 4 недель.");
  else if (!Object.keys(season).length) notes.push("Сезонных колебаний не нашли (или истории меньше года). Прогноз — по продажам последних 4 недель.");

  const costMap = new Map((d.costs ?? []).filter((c) => c.cost !== null).map((c) => [c.nmId, c.cost!]));
  const curCal = Number(d.today.slice(5, 7));

  const rows: PlanRow[] = [];
  for (const p of products) {
    const stock = p.stockWb + p.stockOwn;
    if (!p.orders28 && !stock) continue;
    // Пока товара не было, заказов не было — берём лучший месяц из последних двух, если остаток пуст.
    let ordersPerDay = p.orders28 / 28;
    if (p.stockWb === 0 && history.length >= 2) {
      const recent = history.slice(-3, -1).map((m) => (m.byNm[String(p.nmId)]?.orders ?? 0) / m.days);
      ordersPerDay = Math.max(ordersPerDay, ...recent);
    }
    const hb = history.slice(-3).reduce((a, m) => a + (m.byNm[String(p.nmId)]?.buyouts ?? 0), 0);
    const ho = history.slice(-3).reduce((a, m) => a + (m.byNm[String(p.nmId)]?.orders ?? 0), 0);
    const bo = ho >= 20 ? hb / ho : p.orders28 >= 20 ? p.buyouts28 / p.orders28 : PL.defaultBuyout;
    const buyout = Math.min(1, Math.max(0.2, bo));
    const perDay = ordersPerDay * buyout;
    const idx = season[p.subject];
    const f = (ym: string) => (idx ? idx[Number(ym.slice(5, 7))]! / idx[curCal]! : 1);

    let left = stock;
    const months: PlanMonth[] = monthsList.map((ym) => {
      const need = Math.round(perDay * daysIn(ym) * f(ym));
      const ship = Math.max(0, need - left);
      left = Math.max(0, left - need);
      return { month: ym, need, ship };
    });
    const totalShip = months.reduce((a, m) => a + m.ship, 0);
    const toOrder = totalShip ? Math.ceil(totalShip * (1 + params.safety)) : 0;
    // На сколько дней хватит — день за днём с сезоном: зимой плед уходит быстрее, чем сейчас.
    let daysLeft: number | null = null;
    if (perDay > 0) {
      let rest = stock;
      daysLeft = 0;
      while (daysLeft < 730) {
        rest -= perDay * f(shift(start, daysLeft).slice(0, 7));
        if (rest < 0) break;
        daysLeft++;
      }
    }
    const orderBy = daysLeft === null ? null : shift(d.today, daysLeft - params.leadDays);
    const cost = costMap.get(p.nmId) ?? null;
    rows.push({
      nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, subject: p.subject,
      stock, stockWb: p.stockWb, stockOwn: p.stockOwn,
      ordersPerDay: Math.round(ordersPerDay * 10) / 10, buyout: Math.round(buyout * 100) / 100, perDay: Math.round(perDay * 10) / 10,
      daysLeft, orderBy, urgent: orderBy !== null && orderBy <= d.today && toOrder > 0,
      months, toOrder, cost, money: cost !== null ? Math.round(cost * toOrder) : null,
      seasonal: Boolean(idx), locomotive: false, overstock: perDay > 0 && left > 0 && left > months.reduce((a, m) => a + m.need, 0) * 0.5,
    });
  }

  // Локомотив предмета — товар, на котором держится предмет (как «тёмно-синий» в линейке цветов).
  const bySubj = new Map<string, PlanRow[]>();
  for (const r of rows) bySubj.set(r.subject, [...(bySubj.get(r.subject) ?? []), r]);
  for (const list of bySubj.values()) {
    if (list.length < 2) continue;
    const sum = list.reduce((a, r) => a + r.perDay, 0);
    const top = [...list].sort((a, b) => b.perDay - a.perDay)[0]!;
    if (sum > 0 && top.perDay / sum >= PL.locomotiveShare) top.locomotive = true;
  }

  rows.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.orderBy ?? "9999").localeCompare(b.orderBy ?? "9999") || b.toOrder - a.toOrder);
  const withCost = rows.filter((r) => r.toOrder > 0 && r.money !== null);
  const need = rows.filter((r) => r.toOrder > 0);
  return {
    data: d, params, monthsList, rows, season,
    totals: {
      toOrder: need.reduce((a, r) => a + r.toOrder, 0),
      money: withCost.length ? withCost.reduce((a, r) => a + r.money!, 0) : null,
      urgent: rows.filter((r) => r.urgent).length,
      costCoverage: need.length ? Math.round((withCost.length / need.length) * 100) : 100,
    },
    notes, unavailable,
  };
}

/** Выжимка для Claude и панели. */
export function planSummary(r: PlanReport) {
  return {
    generatedAt: r.data.generatedAt,
    demo: r.data.demo,
    params: r.params,
    months: r.monthsList,
    totals: r.totals,
    notes: r.notes,
    unavailable: r.unavailable,
    seasonalSubjects: Object.keys(r.season),
    urgent: r.rows.filter((x) => x.urgent).map((x) => ({ vendorCode: x.vendorCode, subject: x.subject, daysLeft: x.daysLeft, toOrder: x.toOrder })),
    toOrder: r.rows.filter((x) => x.toOrder > 0).slice(0, 30).map((x) => ({ vendorCode: x.vendorCode, subject: x.subject, stock: x.stock, perDay: x.perDay, orderBy: x.orderBy, toOrder: x.toOrder, byMonth: x.months.map((m) => m.ship), locomotive: x.locomotive, seasonal: x.seasonal })),
    overstock: r.rows.filter((x) => x.overstock).map((x) => ({ vendorCode: x.vendorCode, stock: x.stock, daysLeft: x.daysLeft })),
  };
}
