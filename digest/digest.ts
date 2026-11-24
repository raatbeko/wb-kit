/**
 * Утренняя сводка: что важно сегодня. Работает без Claude — обычный скрипт,
 * который можно запускать по расписанию (Планировщик заданий Windows).
 *
 * Запросов мало и они лёгкие: заказы за 2 недели (статистика — 1 запрос в минуту),
 * остатки на складах WB, отзывы без ответа и расход на рекламу. Каждый раздел
 * независим: нет категории в ключе — раздел пропускается, остальное приходит.
 *
 * Пороги — в DT. Выводы только из цифр WB, без догадок.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTS, LIMITER_KEYS, type WBClient } from "../mcp/wb/src/client.js";
import { fetchStatAll } from "../mcp/wb/src/tools.js";
import { num, round2 } from "../mcp/wb/src/util.js";
import { explainFailure, type Section } from "../audit/collect.js";

type Row = Record<string, unknown>;

/** Пороги сводки. */
export const DT = {
  /** Закончится за столько дней или раньше — предупреждаем. */
  runoutDays: 7,
  /** …а за столько — срочно. */
  urgentDays: 3,
  /** Продажи за 7 дней упали до этой доли от прошлых 7 — «просели». */
  dropShare: 0.6,
  /** Растут: стало больше в столько раз. */
  growShare: 1.5,
  /** Сравниваем недели, только если заказов было не меньше (иначе это шум). */
  minWeekOrders: 7,
  /** Сколько строк в каждом разделе сообщения. */
  maxRows: 5,
};

export interface DigestProduct {
  nmId: number;
  vendorCode: string;
  subject: string;
  /** Заказы вчера. */
  d1: number;
  /** Заказы за последние 7 дней (до вчера включительно) и за 7 дней до них. */
  last7: number;
  prev7: number;
}

export interface DigestData {
  version: 1;
  generatedAt: string;
  demo: boolean;
  /** Вчера — последний полный день. */
  day: string;
  orders: Section<{ days: { date: string; orders: number; sum: number }[]; products: DigestProduct[] }>;
  stocks: Section<Record<string, number>>;
  feedbacks: Section<{ unansweredFeedbacks: number; unansweredQuestions: number; negative: { rating: number; vendorCode: string; product: string; text: string }[] }>;
  ads: Section<{ yesterday: number; avg7: number }>;
}

const DAY = 86_400_000;
/** Дата по часам компьютера, а не по UTC: сводку ждут «за вчера» по местному времени. */
export const localDate = (t: Date) => new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

async function section<T>(name: string, log: (m: string) => void, fn: () => Promise<T>): Promise<Section<T>> {
  try {
    const data = await fn();
    log(`✓ ${name}`);
    return { ok: true, data };
  } catch (err) {
    const reason = explainFailure(err);
    log(`✗ ${name}: ${reason}`);
    return { ok: false, reason };
  }
}

/** Заказы по дням и по товарам за 14 дней, заканчивая `day`. */
export function summarizeOrders(orders: Row[], day: string) {
  const from = shift(day, -13);
  const mid = shift(day, -6);
  const days = new Map<string, { date: string; orders: number; sum: number }>();
  for (let d = from; d <= day; d = shift(d, 1)) days.set(d, { date: d, orders: 0, sum: 0 });
  const byNm = new Map<number, DigestProduct>();
  for (const o of orders) {
    const d = String(o["date"] ?? "").slice(0, 10);
    if (d < from || d > day) continue;
    const dd = days.get(d)!;
    dd.orders += 1;
    dd.sum += num(o["priceWithDisc"]);
    const id = num(o["nmId"]);
    let p = byNm.get(id);
    if (!p) byNm.set(id, (p = { nmId: id, vendorCode: String(o["supplierArticle"] ?? id), subject: String(o["subject"] ?? ""), d1: 0, last7: 0, prev7: 0 }));
    if (d === day) p.d1 += 1;
    if (d >= mid) p.last7 += 1;
    else p.prev7 += 1;
  }
  return { days: [...days.values()].map((x) => ({ ...x, sum: round2(x.sum) })), products: [...byNm.values()] };
}

export async function collectDigest(client: WBClient, opts: { now?: Date; demo?: boolean; log?: (m: string) => void } = {}): Promise<DigestData> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const day = shift(localDate(now), -1);

  const ordersP = section("Заказы за 2 недели", log, async () => {
    log("… Статистика: заказы (WB отдаёт 1 запрос в минуту — подождите)");
    // dateFrom у WB — по дате изменения, поэтому берём с запасом и режем по дате заказа.
    const rows = await fetchStatAll(client, "/api/v1/supplier/orders", LIMITER_KEYS.statOrders, shift(day, -14));
    return summarizeOrders(rows, day);
  });

  const stocksP = section("Остатки на складах WB", log, async () => {
    const res = await client.post<{ data?: { items?: Row[] } }>(HOSTS.analytics, "/api/analytics/v1/stocks-report/wb-warehouses", { limit: 250_000, offset: 0 }, undefined, { limiterKey: LIMITER_KEYS.wbStocks });
    const by: Record<string, number> = {};
    for (const i of res?.data?.items ?? []) by[String(num(i["nmId"]))] = (by[String(num(i["nmId"]))] ?? 0) + num(i["quantity"]);
    return by;
  });

  const feedbacksP = section("Отзывы и вопросы", log, async () => {
    const fb = await client.get<{ data?: { countUnanswered?: number } }>(HOSTS.feedbacks, "/api/v1/feedbacks/count-unanswered");
    const q = await client.get<{ data?: { countUnanswered?: number } }>(HOSTS.feedbacks, "/api/v1/questions/count-unanswered");
    const res = await client.get<{ data?: { feedbacks?: Row[] } }>(HOSTS.feedbacks, "/api/v1/feedbacks", { isAnswered: "false", take: "200", skip: "0", order: "dateDesc" });
    // Имя покупателя не берём.
    const negative = (res?.data?.feedbacks ?? [])
      .filter((f) => num(f["productValuation"]) > 0 && num(f["productValuation"]) <= 3)
      .map((f) => {
        const pd = (f["productDetails"] ?? {}) as Row;
        return { rating: num(f["productValuation"]), vendorCode: String(pd["supplierArticle"] ?? ""), product: String(pd["productName"] ?? ""), text: String(f["text"] || f["cons"] || "").trim() };
      });
    return { unansweredFeedbacks: num(fb?.data?.countUnanswered), unansweredQuestions: num(q?.data?.countUnanswered), negative };
  });

  const adsP = section("Реклама", log, async () => {
    const rows = await client.get<Row[]>(HOSTS.advert, "/adv/v1/upd", { from: shift(day, -7), to: day });
    const byDay = new Map<string, number>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const d = String(r["updTime"] ?? "").slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + num(r["updSum"]));
    }
    let week = 0;
    for (let d = shift(day, -7); d < day; d = shift(d, 1)) week += byDay.get(d) ?? 0;
    return { yesterday: round2(byDay.get(day) ?? 0), avg7: round2(week / 7) };
  });

  const [orders, stocks, feedbacks, ads] = await Promise.all([ordersP, stocksP, feedbacksP, adsP]);
  return { version: 1, generatedAt: now.toISOString(), demo: Boolean(opts.demo), day, orders, stocks, feedbacks, ads };
}

// ── Выводы ──

export type Lvl = "bad" | "warn" | "ok";
/** Роли совпадают с сотрудниками панели. */
export type DigestRole = "analyst" | "logist" | "reviews" | "marketer";

export interface DigestRow {
  vendorCode: string;
  subject: string;
  text: string;
  /** Изменение заказов за неделю, % — для сортировки. */
  pct?: number;
}

export interface Digest {
  day: string;
  demo: boolean;
  generatedAt: string;
  headline: { orders: number; sum: number; avg7: number; vsAvgPct: number | null } | null;
  gone: DigestRow[];
  runout: (DigestRow & { daysLeft: number })[];
  drops: DigestRow[];
  growth: DigestRow[];
  reviews: { feedbacks: number; questions: number; negative: number; examples: string[] } | null;
  ads: { yesterday: number; avg7: number } | null;
  todo: { who: DigestRole; lvl: Lvl; text: string }[];
  unavailable: { section: string; reason: string }[];
}

const nf = (v: number) => Math.round(v).toLocaleString("ru-RU");
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const days = (n: number) => `${n} ${plural(n, "день", "дня", "дней")}`;

export function analyzeDigest(d: DigestData): Digest {
  const unavailable: Digest["unavailable"] = [];
  const miss = (name: string, s: Section<unknown>) => !s.ok && unavailable.push({ section: name, reason: s.reason });
  miss("Заказы", d.orders);
  miss("Остатки", d.stocks);
  miss("Отзывы", d.feedbacks);
  miss("Реклама", d.ads);

  const out: Digest = { day: d.day, demo: d.demo, generatedAt: d.generatedAt, headline: null, gone: [], runout: [], drops: [], growth: [], reviews: null, ads: d.ads.ok ? d.ads.data : null, todo: [], unavailable };

  if (d.orders.ok) {
    const ds = d.orders.data.days;
    const y = ds[ds.length - 1]!;
    const week = ds.slice(-8, -1);
    const avg7 = week.reduce((s, x) => s + x.orders, 0) / (week.length || 1);
    out.headline = { orders: y.orders, sum: y.sum, avg7: Math.round(avg7 * 10) / 10, vsAvgPct: avg7 >= 3 ? Math.round((y.orders / avg7 - 1) * 100) : null };

    for (const p of d.orders.data.products) {
      const base = { vendorCode: p.vendorCode, subject: p.subject };
      if (p.prev7 >= DT.minWeekOrders && p.last7 <= p.prev7 * DT.dropShare)
        {
        const pct = Math.round((p.last7 / p.prev7 - 1) * 100);
        out.drops.push({ ...base, pct, text: `−${-pct}% за неделю (${p.prev7} → ${p.last7} заказов)` });
      }
      else if (p.last7 >= DT.minWeekOrders && p.last7 >= p.prev7 * DT.growShare && p.prev7 > 0)
        {
        const pct = Math.round((p.last7 / p.prev7 - 1) * 100);
        out.growth.push({ ...base, pct, text: `+${pct}% за неделю (${p.prev7} → ${p.last7} заказов)` });
      }
    }
    out.drops.sort((a, b) => a.pct! - b.pct!);
    out.growth.sort((a, b) => b.pct! - a.pct!);

    if (d.stocks.ok) {
      const stock = d.stocks.data;
      for (const p of d.orders.data.products) {
        const left = stock[String(p.nmId)] ?? 0;
        const perDay = (p.last7 + p.prev7) / 14;
        const base = { vendorCode: p.vendorCode, subject: p.subject };
        if (left <= 0 && p.prev7 + p.last7 > 0) {
          // Пока товара нет, заказов тоже нет — спрос считаем по неделе, когда он был.
          const was = Math.max(p.last7, p.prev7) / 7;
          const n = Math.round(was);
          out.gone.push({ ...base, text: `спрос был ${was >= 1 ? `≈ ${n} ${plural(n, "заказ", "заказа", "заказов")} в день` : `${p.prev7 + p.last7} ${plural(p.prev7 + p.last7, "заказ", "заказа", "заказов")} за 2 недели`}` });
        } else if (perDay > 0) {
          const daysLeft = Math.floor(left / perDay);
          if (daysLeft <= DT.runoutDays) out.runout.push({ ...base, daysLeft, text: `хватит на ${days(daysLeft)} (${nf(left)} шт, ≈ ${perDay >= 1 ? Math.round(perDay) : perDay.toFixed(1)} в день)` });
        }
      }
      out.runout.sort((a, b) => a.daysLeft - b.daysLeft);
      // Просел, потому что закончился, — это не про спрос: остаётся только в «Закончились».
      const gone = new Set(out.gone.map((g) => g.vendorCode));
      out.drops = out.drops.filter((x) => !gone.has(x.vendorCode));
    }
  }

  if (d.feedbacks.ok) {
    const f = d.feedbacks.data;
    out.reviews = {
      feedbacks: f.unansweredFeedbacks,
      questions: f.unansweredQuestions,
      negative: f.negative.length,
      examples: f.negative.slice(0, 3).map((n) => `${n.rating}★ ${n.vendorCode || n.product}: «${n.text.length > 90 ? n.text.slice(0, 88) + "…" : n.text || "без текста"}»`),
    };
  }

  // Что сделать сегодня — по убыванию срочности, не больше трёх пунктов.
  const todo = out.todo;
  if (out.gone.length) todo.push({ who: "logist", lvl: "bad", text: `Привезти ${out.gone.slice(0, 3).map((g) => g.vendorCode).join(", ")} — ${out.gone.length === 1 ? "закончился" : "закончились"}, а спрос есть.` });
  const urgent = out.runout.filter((r) => r.daysLeft <= DT.urgentDays);
  if (urgent.length) todo.push({ who: "logist", lvl: "bad", text: `Срочно поставка: ${urgent.slice(0, 3).map((r) => `${r.vendorCode} (${days(r.daysLeft)})`).join(", ")}.` });
  else if (out.runout.length) todo.push({ who: "logist", lvl: "warn", text: `Запланировать поставку: ${out.runout.slice(0, 3).map((r) => `${r.vendorCode} (${days(r.daysLeft)})`).join(", ")}.` });
  if (out.reviews?.negative) todo.push({ who: "reviews", lvl: "warn", text: `Ответить на ${out.reviews.negative} ${plural(out.reviews.negative, "негативный отзыв", "негативных отзыва", "негативных отзывов")} — их видят покупатели.` });
  else if (out.reviews && out.reviews.questions) todo.push({ who: "reviews", lvl: "warn", text: `Ответить на ${out.reviews.questions} ${plural(out.reviews.questions, "вопрос", "вопроса", "вопросов")} покупателей.` });
  if (out.drops.length) todo.push({ who: "marketer", lvl: "warn", text: `Разобраться, почему просел ${out.drops[0]!.vendorCode} (${out.drops[0]!.text.split(" (")[0]}): позиции, цена, реклама.` });
  out.todo = todo.slice(0, 3);
  return out;
}

// ── Файлы ──

export const DIGEST_DIR = (root: string) => join(root, "reports", "digest");

/** Последняя сохранённая сводка: reports/digest/ГГГГ-ММ-ДД[-demo].json. */
export function latestDigest(root: string, demo: boolean): Digest | undefined {
  const dir = DIGEST_DIR(root);
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir)
    .filter((x) => /^\d{4}-\d{2}-\d{2}(-demo)?\.json$/.test(x) && x.endsWith("-demo.json") === demo)
    .sort()
    .pop();
  try {
    return f ? (JSON.parse(readFileSync(join(dir, f), "utf8")) as { digest: Digest }).digest : undefined;
  } catch {
    return undefined;
  }
}

// ── Сообщение в Telegram ──

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ruD = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const short = (v: number) => (v >= 1e6 ? `${(v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млн` : v >= 1e4 ? `${nf(v / 1e3)} тыс` : nf(v));

function rows(title: string, list: DigestRow[]): string {
  if (!list.length) return "";
  const more = list.length > DT.maxRows ? `\n   и ещё ${list.length - DT.maxRows}` : "";
  return `${title}\n${list.slice(0, DT.maxRows).map((r) => `• <b>${esc(r.vendorCode)}</b> — ${esc(r.text)}`).join("\n")}${more}`;
}

/** Текст сообщения (HTML-разметка Telegram). */
export function renderTelegram(g: Digest): string {
  const parts: string[] = [];
  parts.push(`<b>Сводка${g.demo ? " · ДЕМО" : ""} за ${ruD(g.day)}</b>`);
  if (g.headline) {
    const h = g.headline;
    const cmp = h.vsAvgPct === null ? "" : h.vsAvgPct === 0 ? ", как в среднем за неделю" : `, ${h.vsAvgPct > 0 ? "на " + h.vsAvgPct + "% выше" : "на " + -h.vsAvgPct + "% ниже"} среднего за неделю`;
    parts.push(`Вчера ${h.orders} ${plural(h.orders, "заказ", "заказа", "заказов")} на ${short(h.sum)} ₽${cmp}.`);
  }
  if (g.ads && (g.ads.yesterday || g.ads.avg7))
    // WB иногда проводит списания с опозданием — ноль за вчера не значит, что реклама стоит.
    parts.push(g.ads.yesterday ? `Реклама вчера: ${short(g.ads.yesterday)} ₽ (в среднем ${short(g.ads.avg7)} ₽ в день).` : `Списаний за рекламу вчера пока нет (в среднем ${short(g.ads.avg7)} ₽ в день).`);
  const blocks = [
    rows("🔴 <b>Закончились</b>", g.gone),
    rows("🟠 <b>Скоро закончатся</b>", g.runout),
    rows("📉 <b>Просели</b>", g.drops),
    rows("📈 <b>Растут</b>", g.growth.slice(0, 3)),
  ].filter(Boolean);
  if (g.reviews && (g.reviews.feedbacks || g.reviews.questions)) {
    const r = g.reviews;
    blocks.push(`💬 <b>Без ответа</b>: ${r.feedbacks} ${plural(r.feedbacks, "отзыв", "отзыва", "отзывов")}${r.negative ? ` (негативных — ${r.negative})` : ""}, ${r.questions} ${plural(r.questions, "вопрос", "вопроса", "вопросов")}${r.examples.length ? "\n" + r.examples.map((x) => `• ${esc(x)}`).join("\n") : ""}`);
  }
  if (blocks.length) parts.push(blocks.join("\n\n"));
  else if (g.headline) parts.push("✅ Ничего срочного: остатков хватает, просадок нет.");
  if (g.todo.length) parts.push(`<b>Сегодня:</b>\n${g.todo.map((t, i) => `${i + 1}. ${esc(t.text)}`).join("\n")}`);
  if (g.unavailable.length) parts.push(`<i>Нет в сводке: ${g.unavailable.map((u) => `${u.section.toLowerCase()} (${esc(u.reason)})`).join("; ")}.</i>`);
  parts.push("<i>Подробнее — в панели магазина или спросите Claude.</i>");
  return parts.join("\n\n");
}
