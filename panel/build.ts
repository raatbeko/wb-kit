/**
 * Панель магазина: одна HTML-страница из последних отчётов в reports/.
 *
 * Обзор (цифры, графики, сотрудники, план), аудит, офис, конкуренты и карточки —
 * вкладками, без рамок и второй прокрутки. Подробности открываются по клику.
 * Пока Claude работает, страница каждые 3 секунды читает reports/panel/status.js
 * и показывает, кто из сотрудников что делает (формат — в .claude/commands/panel.md).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditData } from "../audit/collect.js";
import type { summaryForClaude } from "../audit/analyze.js";
import { esc, markdownToHtml } from "../audit/render-html.js";

type Summary = ReturnType<typeof summaryForClaude>;
type Issue = Summary["issues"][number];
type Product = Summary["topProducts"][number];

/** Сотрудники офиса: id — имя агента в .claude/agents, file — имя файла отчёта в /office. */
export const PANEL_ROLES = [
  { id: "analyst", file: "аналитик", name: "Аналитик", title: "Аналитик", desc: "продажи, деньги, маржа" },
  { id: "logist", file: "логист", name: "Логист", title: "Логист", desc: "остатки и поставки" },
  { id: "marketer", file: "маркетолог", name: "Маркетолог", title: "Маркетолог", desc: "реклама и ДРР" },
  { id: "reviews", file: "отзывы", name: "Отзывы", title: "Менеджер отзывов", desc: "жалобы и ответы" },
  { id: "content", file: "контент", name: "Контент", title: "Контент-мейкер", desc: "карточки" },
  { id: "scout", file: "разведчик", name: "Разведчик", title: "Разведчик", desc: "конкуренты" },
] as const;
type RoleId = (typeof PANEL_ROLES)[number]["id"];

/** Чья это находка аудита — в чью карточку сотрудника её положить. */
export const ISSUE_ROLE: Record<string, RoleId> = {
  out_of_stock: "logist", low_stock: "logist", overstock: "logist", dead_stock: "logist",
  unprofitable: "analyst", low_margin: "analyst", sales_drop: "analyst", logistics_per_unit: "analyst", penalties: "analyst", low_buyout: "analyst",
  high_drr: "marketer",
  negative_feedback: "reviews", unanswered: "reviews",
  weak_cart_conversion: "content", weak_cards: "content",
};

export interface Finding {
  who: RoleId;
  lvl: "bad" | "warn" | "ok";
  text: string;
}

export interface DocPart {
  id: string;
  name: string;
  html: string;
}

export interface PanelSources {
  demo: boolean;
  audit?: { dir: string; summary: Summary; data: AuditData; html?: string };
  office?: { dir: string; parts: DocPart[] };
  competitors?: { dir: string; summary?: { findings?: { priority: string; text: string; query?: string }[] }; html: string };
  cards: { dir: string; vendorCode: string; findings: string[]; html: string }[];
}

// ── Поиск последних отчётов ──

/** Папки reports/<префикс>-…ГГГГ-ММ-ДД[-demo], свежие первыми. */
function folders(reports: string, prefix: string, demo: boolean): string[] {
  if (!existsSync(reports)) return [];
  return readdirSync(reports, { withFileTypes: true })
    .filter((f) => f.isDirectory() && f.name.startsWith(prefix + "-") && f.name.endsWith("-demo") === demo && /\d{4}-\d{2}-\d{2}/.test(f.name))
    .map((f) => f.name)
    .sort((a, b) => (a.match(/\d{4}-\d{2}-\d{2}/)![0] < b.match(/\d{4}-\d{2}-\d{2}/)![0] ? 1 : -1));
}

function readJson<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

function htmlIn(dir: string): string | undefined {
  const f = readdirSync(dir).find((x) => x.endsWith(".html"));
  return f ? readFileSync(join(dir, f), "utf8") : undefined;
}

/** План директора и отчёты ролей из .md-файлов папки /office. */
export function officeParts(files: Record<string, string>): DocPart[] {
  const parts: DocPart[] = [];
  if (files["план"]) parts.push({ id: "план", name: "План директора", html: markdownToHtml(files["план"]) });
  const known = new Set<string>(PANEL_ROLES.map((r) => r.file));
  for (const r of PANEL_ROLES) if (files[r.file]) parts.push({ id: r.file, name: r.title, html: markdownToHtml(files[r.file]!) });
  for (const f of Object.keys(files).sort()) if (f !== "план" && !known.has(f)) parts.push({ id: f, name: f[0]!.toUpperCase() + f.slice(1), html: markdownToHtml(files[f]!) });
  return parts;
}

/** Демо-офис без папки reports/office-…-demo: берём готовую страницу из docs/. */
function officeFromHtml(src: string): DocPart[] {
  const parts: DocPart[] = [];
  const plan = src.match(/<section class="insights"><h2>План<\/h2>([\s\S]*?)<\/section>/);
  if (plan) parts.push({ id: "план", name: "План директора", html: plan[1]! });
  const re = /<section class="role" id="([^"]+)"><h2>([^<]+)<small>[^<]*<\/small><\/h2>([\s\S]*?)<\/section>/g;
  let m;
  while ((m = re.exec(src))) parts.push({ id: m[1]!, name: m[2]!, html: m[3]! });
  return parts;
}

export function findSources(root: string, demo: boolean): PanelSources {
  const reports = join(root, "reports");
  const src: PanelSources = { demo, cards: [] };

  const a = folders(reports, "audit", demo).find((f) => existsSync(join(reports, f, "summary.json")) && existsSync(join(reports, f, "data.json")));
  if (a) {
    const dir = join(reports, a);
    const summary = readJson<Summary>(join(dir, "summary.json"));
    const data = readJson<AuditData>(join(dir, "data.json"));
    if (summary && data) src.audit = { dir, summary, data, html: htmlIn(dir) };
  }

  const o = folders(reports, "office", demo).find((f) => readdirSync(join(reports, f)).some((x) => x.endsWith(".md")));
  if (o) {
    const dir = join(reports, o);
    const files: Record<string, string> = {};
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) files[f.slice(0, -3).toLowerCase()] = readFileSync(join(dir, f), "utf8");
    src.office = { dir, parts: officeParts(files) };
  } else if (demo && existsSync(join(root, "docs/demo-office.html"))) {
    src.office = { dir: join(root, "docs"), parts: officeFromHtml(readFileSync(join(root, "docs/demo-office.html"), "utf8")) };
  }

  const c = folders(reports, "competitors", demo).find((f) => htmlIn(join(reports, f)));
  if (c) {
    const dir = join(reports, c);
    src.competitors = { dir, summary: readJson(join(dir, "summary.json")), html: htmlIn(dir)! };
  }

  // Карточки: по одной, самой свежей, на каждый артикул.
  const seen = new Set<string>();
  for (const f of folders(reports, "card", demo)) {
    const dir = join(reports, f);
    const s = readJson<{ product?: { vendorCode?: string; nmId?: number }; findings?: string[] }>(join(dir, "summary.json"));
    const vendorCode = String(s?.product?.vendorCode || s?.product?.nmId || f.replace(/^card-/, "").replace(/-\d{4}-\d{2}-\d{2}(-demo)?$/, ""));
    const html = htmlIn(dir);
    if (!html || seen.has(vendorCode)) continue;
    seen.add(vendorCode);
    src.cards.push({ dir, vendorCode, findings: s?.findings ?? [], html });
  }
  return src;
}

// ── Числа ──

const nf = (v: number, k = 0) => Math.abs(v).toLocaleString("ru-RU", { maximumFractionDigits: k });
const rub = (v: number) => `${v < 0 ? "−" : ""}${nf(Math.round(v))} ₽`;
const pc = (v: number, k = 1) => `${v < 0 ? "−" : ""}${nf(v, k)}%`;
const short = (v: number) =>
  `${v < 0 ? "−" : ""}${Math.abs(v) >= 1e6 ? `${nf(v / 1e6, 2)} млн` : Math.abs(v) >= 1e3 ? `${nf(Math.round(v / 1e3))} тыс` : nf(Math.round(v))}`;
const ruD = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
/** «Круглый» шаг сетки графика. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const k of [1, 2, 2.5, 5, 10]) if (raw <= k * p) return k * p;
  return 10 * p;
}
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;

// ── Находки ──

export function collectFindings(src: PanelSources): Finding[] {
  const out: Finding[] = [];
  const lvl = (p: string): Finding["lvl"] => (p === "high" ? "bad" : p === "medium" ? "warn" : "ok");
  for (const i of src.audit?.summary.issues ?? []) {
    const impact = i.impactRub ? ` — ≈ ${rub(i.impactRub)}${i.impactLabel ? ` ${i.impactLabel}` : ""}` : "";
    out.push({ who: ISSUE_ROLE[i.id] ?? "analyst", lvl: lvl(i.priority), text: `${i.title}${impact}` });
  }
  for (const f of src.competitors?.summary?.findings ?? []) out.push({ who: "scout", lvl: lvl(f.priority), text: f.query ? `«${f.query}»: ${f.text}` : f.text });
  for (const c of src.cards) for (const t of c.findings.slice(0, 2)) out.push({ who: "content", lvl: "warn", text: `${c.vendorCode}: ${t}` });
  const order = { bad: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => order[a.lvl] - order[b.lvl]);
}

/** Первые слова отчёта роли — для карточки сотрудника. */
function firstParagraph(html: string): string {
  // Первый абзац, похожий на мысль, а не на подзаголовок «**Срочно**».
  const strip = (x: string) => x.replace(/<[^>]+>/g, "").trim();
  const p = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]!).find((x) => strip(x).length >= 40) ?? "";
  const t = p.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  return t.length > 260 ? t.slice(0, 257) + "…" : t;
}

// ── Блоки обзора ──

interface Drawer {
  title: string;
  sub?: string;
  text?: string;
  rows?: [string, string][];
  kv?: [string, string][];
  list?: string[];
  go?: [string, string?];
  goLabel?: string;
  ask: string;
}

interface Week {
  weekStart: string;
  orders: number;
  ordersSum: number;
  buyouts: number;
  buyoutsSum: number;
}

function weekChart(weeks: Week[], to: string): string {
  // Неделя, где прошло меньше 4 дней, рисует обрыв вниз — её не показываем.
  if (weeks.length && days(weeks[weeks.length - 1]!.weekStart, to) < 4) weeks = weeks.slice(0, -1);
  if (weeks.length < 2) return "";
  const W = 760, H = 240, L = 64, R = 24, B = 24, TP = 12;
  const step = niceStep(Math.max(...weeks.map((w) => w.ordersSum)) / 4);
  const max = Math.max(step, Math.ceil(Math.max(...weeks.map((w) => w.ordersSum)) / step) * step);
  const x = (i: number) => L + (i * (W - L - R)) / (weeks.length - 1);
  const y = (v: number) => TP + (H - B - TP) * (1 - v / max);
  const last = weeks.length - 1;
  // Неделя, которая ещё идёт, — пунктиром: её цифры ещё вырастут.
  const partial = days(weeks[last]!.weekStart, to) < 7;
  const solidTo = partial ? last : last + 1;
  const path = (k: "ordersSum" | "buyoutsSum", n: number) => weeks.slice(0, n).map((w, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(w[k]).toFixed(1)}`).join("");
  const seg = (k: "ordersSum" | "buyoutsSum") => (partial ? `<path d="M${x(last - 1)},${y(weeks[last - 1]![k])}L${x(last)},${y(weeks[last]![k])}" class="ln ${k === "ordersSum" ? "c1" : "c2"} dash"/>` : "");
  const lastSolid = solidTo - 1;
  let grid = "";
  for (let v = 0; v <= max; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="${v ? "g" : "g0"}"/><text x="${L - 8}" y="${y(v) + 4}" class="ax" text-anchor="end">${v ? short(v) : "0"}</text>`;
  const every = Math.ceil(weeks.length / 8);
  const labels = weeks.map((w, i) => ((last - i) % every === 0 ? `<text x="${x(i)}" y="${H - 6}" class="ax" text-anchor="middle">${ruD(w.weekStart)}</text>` : "")).join("");
  const half = (W - L - R) / (weeks.length - 1) / 2;
  const hits = weeks
    .map((w, i) => {
      const tip = `Неделя с ${ruD(w.weekStart)}${i === last && partial ? " (идёт)" : ""}|Заказы ${rub(w.ordersSum)} · ${w.orders} шт|Выкупы ${rub(w.buyoutsSum)} · ${w.buyouts} шт`;
      return `<rect class="hit" x="${x(i) - half}" y="${TP}" width="${half * 2}" height="${H - B - TP}" data-tip="${esc(tip)}" data-x="${x(i)}" data-y1="${y(w.ordersSum)}" data-y2="${y(w.buyoutsSum)}"/>`;
    })
    .join("");
  const area = `${path("ordersSum", solidTo)}L${x(lastSolid)},${H - B}L${x(0)},${H - B}Z`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" id="wk" role="img" aria-label="Заказы и выкупы по неделям">
<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c1)" stop-opacity=".22"/><stop offset="1" stop-color="var(--c1)" stop-opacity="0"/></linearGradient></defs>
${grid}<path d="${area}" fill="url(#ga)"/>
<path d="${path("ordersSum", solidTo)}" class="ln c1 draw"/>${seg("ordersSum")}
<path d="${path("buyoutsSum", solidTo)}" class="ln c2 draw"/>${seg("buyoutsSum")}
<text x="${x(lastSolid) - 6}" y="${y(weeks[lastSolid]!.ordersSum) - 10}" class="dl" text-anchor="end">заказы</text><text x="${x(lastSolid) - 6}" y="${y(weeks[lastSolid]!.buyoutsSum) + 18}" class="dl" text-anchor="end">выкупы</text>
${labels}<line class="cross" x1="0" x2="0" y1="${TP}" y2="${H - B}"/><circle class="pt p1" r="4"/><circle class="pt p2" r="4"/>${hits}</svg>`;
}

function spark(values: number[]): string {
  if (values.length < 2) return "";
  const W = 120, H = 34, mn = Math.min(...values), mx = Math.max(...values), k = mx - mn || 1;
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true"><path d="${values.map((a, i) => `${i ? "L" : "M"}${((i * W) / (values.length - 1)).toFixed(1)},${(H - 3 - ((a - mn) / k) * (H - 6)).toFixed(1)}`).join("")}" class="ln c1"/></svg>`;
}

interface MonthBar {
  label: string;
  perDay: number;
  partial: boolean;
}

function monthBars(months: MonthBar[]): string {
  const max = Math.max(...months.map((m) => Math.abs(m.perDay)), 1);
  const hasNeg = months.some((m) => m.perDay < 0), hasPos = months.some((m) => m.perDay > 0);
  // Под столбцом вниз — его сумма, ниже — название месяца: им нужно место.
  const W = 420, H = 160, top = 22, bottom = hasNeg ? 42 : 26;
  // Ноль посередине, только если есть и плюс, и минус.
  const zero = hasNeg && hasPos ? top + (H - top - bottom) / 2 : hasNeg ? top : H - bottom;
  const room = hasNeg && hasPos ? (H - top - bottom) / 2 : H - top - bottom;
  const bw = Math.min(70, (W / months.length) * 0.55), gap = (W - bw * months.length) / (months.length + 1);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Прибыль в день по месяцам"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" class="g0"/>${months
    .map((m, i) => {
      const h = Math.max((Math.abs(m.perDay) / max) * room, 1.5);
      const x = gap + i * (bw + gap);
      const y = m.perDay < 0 ? zero : zero - h;
      const ly = m.perDay < 0 ? y + h + 15 : y - 6;
      return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="3" class="${m.perDay < 0 ? "bneg" : "bpos"}${m.partial ? " part" : ""}"><title>${esc(m.label)}: ${rub(m.perDay)} в день</title></rect><text x="${x + bw / 2}" y="${Math.min(H - 2, Math.max(12, ly))}" class="vl" text-anchor="middle">${rub(m.perDay)}</text><text x="${x + bw / 2}" y="${H - 4}" class="ax" text-anchor="middle">${esc(m.label.replace(/ \d{4}$/, ""))}${m.partial ? " *" : ""}</text>`;
    })
    .join("")}</svg>`;
}

function panel(cls: string, title: string, hint: string, body: string): string {
  return `<div class="p ${cls}"><div class="h"><h2>${title}</h2>${hint ? `<span class="hint">${hint}</span>` : ""}</div>${body}</div>`;
}

function empty(title: string, text: string): string {
  return `<div class="p empty"><h2>${title}</h2><p>${text}</p></div>`;
}

/** Список слева, документ справа — офис и карточки. */
function docList(group: string, items: { id: string; name: string; sub: string; av: string; body: string }[]): string {
  return `<div class="office" data-g="${group}"><aside class="olist" role="tablist">${items
    .map((o, i) => `<button role="tab" class="oi" data-o="${esc(o.id)}" aria-selected="${i === 0}"><span class="oav">${esc(o.av)}</span><span class="on2">${esc(o.name)}<span class="os">${esc(o.sub)}</span></span></button>`)
    .join("")}</aside><div class="ocontent">${items.map((o, i) => `<article class="doc${i === 0 ? " on" : ""}" data-o="${esc(o.id)}">${o.body}</article>`).join("")}</div></div>`;
}

// ── Страница ──

export function renderPanel(src: PanelSources, builtAt = new Date()): string {
  const s = src.audit?.summary;
  const d = src.audit?.data;
  const e0 = s?.economics ?? null;
  // Нет рекламы или себестоимости в данных — в расчётах блоков считаем их нулём, подписи говорят честно.
  const e = e0 && { ...e0, ads: e0.ads ?? 0, costOfGoods: e0.costOfGoods ?? 0, tax: e0.tax ?? 0, stockValue: e0.stockValue ?? 0 };
  const take = e?.takeRate != null ? `WB и реклама забирают ${Math.round(e.takeRate)} коп. с рубля` : "";
  const findings = collectFindings(src);
  const D: Record<string, Drawer> = {};
  const officeIds = new Set(src.office?.parts.map((p) => p.id));
  const roleGo = (file: string): [string, string?] => (officeIds.has(file) ? ["office", file] : ["audit"]);
  const periodDays = s?.period.days ?? 30;
  const blocks: string[] = [];

  // Плитки сверху
  if (s && e) {
    const hasProfit = e.profit !== null;
    const main = hasProfit ? e.profit! : e.afterWbAndAds;
    D["k-profit"] = {
      title: hasProfit ? `Прибыль за ${periodDays} дней` : "После WB и рекламы",
      sub: hasProfit ? "после WB, рекламы, себестоимости и налога" : "до себестоимости — её нет в data/cost.csv",
      kv: [["Выручка", rub(e.revenue)], ["На руки от WB", rub(e.payout)], ["Реклама", rub(-e.ads)], ...(hasProfit ? ([["Себестоимость", rub(-e.costOfGoods)], ["Налог", rub(-e.tax)], ["Прибыль", rub(e.profit!)]] as [string, string][]) : ([["После WB и рекламы", rub(e.afterWbAndAds)]] as [string, string][]))],
      text: e.costCoverage < 100 && hasProfit ? `Себестоимость есть для ${e.costCoverage}% выручки — прибыль завышена.` : undefined,
      go: ["audit"], goLabel: "Деньги в аудите",
      ask: hasProfit ? (main < 0 ? "Почему магазин в минусе и что даст больше всего денег за неделю?" : "Что даст больше всего прибыли за неделю?") : "Помоги заполнить себестоимость в data/cost.csv, чтобы посчитать прибыль.",
    };
    const wk = d?.sales.ok ? d.sales.data.weekly : [];
    D["k-rev"] = { title: "Выручка", sub: "продажи минус возвраты, по финотчёту WB", kv: [["Выручка", rub(e.revenue)], ...(e.takeRate !== null ? ([["WB и реклама забирают", `${Math.round(e.takeRate)} коп. с рубля`]] as [string, string][]) : [])], text: "Финотчёт WB недельный: последние дни периода могут не попасть.", go: ["audit"], goLabel: "Открыть аудит", ask: "Какие товары тянут выручку вниз и почему?" };
    blocks.push(`<div class="p kpi hero span3 cl" data-d="k-profit" tabindex="0"><div class="k">${D["k-profit"].title}</div><div class="v${main < 0 ? " bad" : ""}">${rub(main)}</div><div class="f">${hasProfit && e.margin !== null ? `маржа ${pc(e.margin)}` : "впишите себестоимость — будет прибыль"}</div></div>`);
    blocks.push(`<div class="p kpi span3 cl" data-d="k-rev" tabindex="0"><div class="k">Выручка</div><div class="row"><div class="v">${short(e.revenue)} ₽</div>${spark(wk.slice(0, -1).map((w) => w.buyoutsSum))}</div><div class="f">${take}</div></div>`);
    if (e.drrBuyouts !== null) {
      const be = e.breakEvenDrr;
      const scale = Math.max(40, e.drrBuyouts * 1.25, (be ?? 0) * 1.25);
      const pos = (v: number) => Math.min(100, (v / scale) * 100).toFixed(1);
      const bad = be !== null && e.drrBuyouts > be;
      D["k-drr"] = { title: "ДРР от выкупов", sub: "реклама к деньгам от выкупов, а не от заказов", kv: [["ДРР сейчас", pc(e.drrBuyouts)], ...(be !== null ? ([[e.breakEvenIsUpperBound ? "Безубыточный (не выше)" : "Безубыточный", pc(be)]] as [string, string][]) : []), ["Реклама", rub(e.ads)]], text: bad ? "Выше безубыточного — каждый рубль рекламы уводит магазин в минус." : undefined, go: ["audit"], goLabel: "Реклама в аудите", ask: bad ? "Какие кампании отключить или урезать, чтобы ДРР стал ниже безубыточного?" : "Где реклама окупается лучше всего и куда добавить бюджет?" };
      blocks.push(`<div class="p kpi span3 cl" data-d="k-drr" tabindex="0"><div class="k">ДРР от выкупов</div><div class="v${bad ? " bad" : ""}">${pc(e.drrBuyouts)}</div><div class="gauge" style="--be:${be !== null ? pos(be) : 100}%">${be !== null ? `<div class="be" style="left:${pos(be)}%"></div>` : ""}<div class="val${bad ? "" : " okv"}" style="left:${pos(e.drrBuyouts)}%"></div></div><div class="gl"><span>0%</span>${be !== null ? `<span>безубыточный ${pc(be)}</span>` : ""}<span>${Math.round(scale)}%</span></div></div>`);
    }
    if (e.lostPerDay > 0) {
      D["k-lost"] = { title: "Теряем на пустых остатках", sub: "выкупы, которых нет, пока товар закончился", kv: [["В день", rub(e.lostPerDay)], ["В неделю", rub(e.lostPerDay * 7)], ["Денег в товаре на WB", rub(e.stockValue)]], go: ["audit"], goLabel: "Остатки в аудите", ask: "Что и сколько везти в ближайшую поставку?" };
      blocks.push(`<div class="p kpi span3 cl" data-d="k-lost" tabindex="0"><div class="k">Теряем на пустых остатках</div><div class="v bad">${rub(e.lostPerDay)}</div><div class="f">выкупов в день · в товаре на WB ${short(e.stockValue)} ₽</div></div>`);
    } else {
      D["k-lost"] = { title: "Деньги в товаре на WB", sub: e.stockValueAtCost ? "по себестоимости" : "частью по цене продажи", kv: [["В товаре", rub(e.stockValue)], ...(e.turnoverDays !== null ? ([["Распродастся за", `≈ ${e.turnoverDays} дн`]] as [string, string][]) : [])], go: ["audit"], goLabel: "Остатки в аудите", ask: "Какой товар лежит дольше всего и что с ним сделать?" };
      blocks.push(`<div class="p kpi span3 cl" data-d="k-lost" tabindex="0"><div class="k">Деньги в товаре на WB</div><div class="v">${short(e.stockValue)} ₽</div><div class="f">${e.turnoverDays !== null ? `распродастся за ≈ ${e.turnoverDays} дн` : ""}</div></div>`);
    }
  } else if (s) {
    // Финотчёта нет (ключ без категории «Финансы») — показываем, что есть.
    s.kpis.slice(0, 4).forEach((k, i) => {
      const v = k.value === null ? "—" : k.unit === "₽" ? rub(k.value) : k.unit === "%" ? pc(k.value) : `${nf(k.value, 1)}${k.unit ? ` ${k.unit}` : ""}`;
      blocks.push(`<div class="p kpi span3${i ? "" : " hero"}"><div class="k">${esc(k.label)}</div><div class="v${k.tone === "bad" ? " bad" : ""}">${v}</div><div class="f">${esc(k.hint ?? "")}</div></div>`);
    });
  }

  // График и консоль
  const weeks = d?.sales.ok ? d.sales.data.weekly : [];
  const chart = d ? weekChart(weeks, d.period.to) : "";
  if (chart) blocks.push(panel("span8", "Заказы и выкупы по неделям", "", `<div class="lg"><span><i style="background:var(--c1)"></i>заказы</span><span><i style="background:var(--c2)"></i>выкупы</span><span class="hint">пунктир — неделя идёт</span></div>${chart}`));
  findings.forEach((f, i) => {
    const r = PANEL_ROLES.find((x) => x.id === f.who)!;
    D["f-" + i] = { title: r.name, sub: "находка", text: f.text, go: roleGo(r.file), goLabel: officeIds.has(r.file) ? "Отчёт роли целиком" : "Открыть аудит", ask: `Разбери подробнее: «${f.text}». Что сделать по шагам?` };
  });
  const roleName = Object.fromEntries(PANEL_ROLES.map((r) => [r.id, r.name]));
  const conLines = findings.map((f, i) => `<p class="ln2 cl" data-d="f-${i}" tabindex="0"><span class="who ${f.lvl}">${esc(roleName[f.who]!)}</span> › ${esc(f.text)}</p>`).join("");
  blocks.push(panel(chart ? "span4" : "span12", "Консоль сотрудников", `<span id="lc">${findings.length} ${plural(findings.length, "находка", "находки", "находок")}</span>`, `<div class="console" id="con">${conLines || '<p class="ln2 muted">Пока пусто. Напишите в чате /audit или /office — сотрудники разберут магазин, а находки появятся здесь.</p>'}</div>`));

  // Сотрудники
  const roleCards = PANEL_ROLES.map((r) => {
    const mine = findings.filter((f) => f.who === r.id);
    const part = src.office?.parts.find((p) => p.id === r.file);
    const state = part ? "done" : "";
    const st = part ? `отчёт · ${mine.length} ${plural(mine.length, "находка", "находки", "находок")}` : mine.length ? `по аудиту · ${mine.length}` : "не запускался";
    D["ag-" + r.id] = {
      title: r.title, sub: r.desc,
      text: part ? firstParagraph(part.html) || undefined : mine.length ? "Отчёта роли ещё нет — ниже находки аудита по её части. Полный разбор: /office." : "Роль ещё не запускалась. Напишите в чате /office.",
      rows: mine.map((f) => [f.lvl, f.text]),
      go: roleGo(r.file), goLabel: part ? "Открыть отчёт роли" : "Открыть аудит",
      ask: `${r.title}: что из твоего разбора сделать первым и почему?`,
    };
    return `<div class="ag cl ${state}" id="ag-${r.id}" data-d="ag-${r.id}" tabindex="0"><div class="an">${r.name}<span class="cnt">${mine.length || ""}</span></div><div class="ad">${r.desc}</div><div class="track"></div><div class="st">${st}</div></div>`;
  }).join("");
  blocks.push(panel("span12", "Сотрудники", "ничего не меняют в кабинете без вашего «да»", `<div class="agents">${roleCards}</div>`));

  // Куда уходит выручка
  if (e && d?.finance.ok && e.revenue > 0) {
    const T = d.finance.data.totals;
    const wbAll = Math.max(0, e.revenue - e.payout);
    const commission = Math.min(wbAll, Math.max(0, T.wbKeptFromSales));
    const logistics = Math.min(wbAll - commission, Math.max(0, T.logistics));
    const segs: [string, number, string][] = [
      ["Комиссия WB", commission, "s1"],
      ["Логистика", logistics, "s2"],
      ["Хранение и прочее WB", wbAll - commission - logistics, "s3"],
      ["Реклама", e.ads, "s4"],
      ...(e.profit !== null ? ([["Себестоимость и налог", e.costOfGoods + e.tax, "s5"]] as [string, number, string][]) : []),
    ];
    const rest = (e.profit ?? e.afterWbAndAds);
    if (rest > 0) segs.push([e.profit !== null ? "Прибыль" : "Остаётся до себестоимости", rest, "keep"]);
    const total = segs.reduce((a, x) => a + x[1], 0) || 1;
    const flow = `<div class="flow">${segs.filter((x) => x[1] > 0).map(([l, v, c]) => `<div class="fseg ${c}" style="flex:${v}" title="${esc(l)}: ${rub(v)}"><span>${Math.round((v / total) * 100)}%</span></div>`).join("")}</div>
${rest < 0 ? `<div class="flowmark"><span style="left:${((e.revenue / total) * 100).toFixed(2)}%">выручка</span></div>` : ""}
<ul class="legend">${segs.map(([l, v, c]) => `<li><i class="${c}"></i>${esc(l)}<b>${rub(v)}</b></li>`).join("")}${rest < 0 ? `<li class="lossli"><i class="loss"></i>Убыток<b>${rub(rest)}</b></li>` : ""}</ul>`;
    const note = rest < 0 ? `Расходы больше выручки на ${rub(-rest)}: красная черта — где кончается выручка.` : e.profit === null ? "Себестоимости нет — это ещё не прибыль." : "";
    blocks.push(panel("span7", "Куда уходит выручка", `${rub(e.revenue)} за ${periodDays} дней`, `${flow}${note ? `<p class="note">${note}</p>` : ""}`));
  }

  // План: самые дорогие проблемы аудита
  const prio = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  const plan = [...(s?.issues ?? [])].sort((a, b) => (prio[a.priority] ?? 3) - (prio[b.priority] ?? 3) || (b.impactRub ?? 0) - (a.impactRub ?? 0)).slice(0, 5);
  plan.forEach((i: Issue, k) => {
    const r = PANEL_ROLES.find((x) => x.id === (ISSUE_ROLE[i.id] ?? "analyst"))!;
    D["plan-" + k] = {
      title: i.title, sub: i.impactRub ? `≈ ${rub(i.impactRub)}${i.impactLabel ? ` ${i.impactLabel}` : ""}` : r.name,
      text: `${i.detail} ${i.action}`,
      list: i.products.map((p) => `${p.vendorCode}${p.note ? ` — ${p.note}` : ""}`).concat(i.moreProducts ? [`и ещё ${i.moreProducts}`] : []),
      go: officeIds.has("план") ? ["office", "план"] : ["audit"], goLabel: officeIds.has("план") ? "План директора" : "Открыть аудит",
      ask: `Как выполнить шаг «${i.title}»? Если нужно менять кабинет — покажи «было → станет».`,
    };
  });
  if (plan.length) blocks.push(panel(blocks.some((b) => b.includes("Куда уходит выручка")) ? "span5" : "span12", "Что сделать в первую очередь", "по деньгам", `<ol class="plan">${plan.map((i, k) => `<li class="cl" data-d="plan-${k}" tabindex="0"><b>${esc(i.title)}</b>${i.impactRub ? `<span class="m">≈ ${short(i.impactRub)} ₽</span>` : ""}</li>`).join("")}</ol>`));

  // Товары
  const products = s?.topProducts ?? [];
  products.forEach((p: Product) => {
    D["p-" + p.vendorCode] = {
      title: p.vendorCode, sub: p.title,
      kv: [["Заказы", rub(p.ordersSum)], ...(p.ordersDelta !== null ? ([["К прошлому периоду", pc(p.ordersDelta)]] as [string, string][]) : []), ["Прибыль", p.profit === null ? "нет себестоимости" : rub(p.profit)], ["Маржа", p.margin === null ? "—" : pc(p.margin)], ["Выкуп", p.buyoutPercent === null ? "—" : pc(p.buyoutPercent)], ["Остаток", `${p.stock} шт`], ["Хватит на", p.daysOfStock === null ? "—" : `${p.daysOfStock} дн`], ["Средняя цена", p.avgPrice ? rub(p.avgPrice) : "—"]],
      go: ["audit"], goLabel: "Товар в аудите",
      ask: `Разбери товар ${p.vendorCode}: цена, реклама, остаток — что сделать?`,
    };
  });
  const sMax = 60;
  const stock = products.filter((p) => p.daysOfStock !== null).sort((a, b) => a.daysOfStock! - b.daysOfStock!).slice(0, 9);
  if (stock.length)
    blocks.push(panel("span4", "Запас на складе", "черта — 14 дней", stock.map((p) => {
      const dd = p.daysOfStock!, cls = dd <= 7 ? "bad" : dd <= 14 ? "warn" : "ok";
      return `<div class="rw cl" data-d="p-${esc(p.vendorCode)}" tabindex="0"><span class="rn" title="${esc(p.title)}">${esc(p.vendorCode)}</span><div class="rt"><div class="rf ${cls}" style="width:${Math.min(100, (dd / sMax) * 100).toFixed(1)}%"></div><div class="rmark" style="left:${((14 / sMax) * 100).toFixed(1)}%"></div></div><span class="rv ${cls}">${dd === 0 ? "нет" : `${dd} дн`}</span></div>`;
    }).join("")));
  // Лучшие и все убыточные (до 5): убыточные важнее всего, их нельзя обрезать.
  const withProfit = products.filter((p) => p.profit !== null).sort((a, b) => b.profit! - a.profit!);
  const losers = withProfit.filter((p) => p.profit! < 0).slice(-5);
  const prof = [...withProfit.filter((p) => p.profit! >= 0).slice(0, 10 - losers.length), ...losers];
  if (prof.length) {
    const pMax = Math.max(...prof.map((p) => Math.abs(p.profit!)), 1);
    blocks.push(panel("span4", "Прибыль по товарам", `${periodDays} дней, ₽`, prof.map((p) => `<div class="pb cl" data-d="p-${esc(p.vendorCode)}" tabindex="0"><span class="rn" title="${esc(p.title)}">${esc(p.vendorCode)}</span><div class="pt2"><div class="pz"></div><div class="pf ${p.profit! < 0 ? "neg" : "pos"}" style="${p.profit! < 0 ? "right:50%" : "left:50%"};width:${((Math.abs(p.profit!) / pMax) * 50).toFixed(1)}%"></div></div><span class="rv ${p.profit! < 0 ? "bad" : ""}">${short(p.profit!)}</span></div>`).join("")));
  }

  // Месяцы и реклама
  const monthsRaw = (s?.months ?? []).filter((m) => !m.unavailable);
  const monthDays = Object.fromEntries((d?.months ?? []).map((m) => [m.month, days(m.from, m.to)]));
  const months: MonthBar[] = monthsRaw
    .map((m) => ({ label: m.label, partial: m.partial, value: m.profit ?? m.afterWbAndAds, n: monthDays[m.month] }))
    .filter((m): m is { label: string; partial: boolean; value: number; n: number } => m.value !== null && !!m.n)
    .map((m) => ({ label: m.label, partial: m.partial, perDay: Math.round(m.value / m.n) }));
  const camps = d?.ads.ok ? [...d.ads.data.campaigns].sort((a, b) => b.spent - a.spent).slice(0, 6) : [];
  let side = "";
  if (months.length) side += `<div class="h"><h2>${monthsRaw.some((m) => m.profit === null) ? "После WB и рекламы в день" : "Прибыль в день по месяцам"}</h2><span class="hint">${months.some((m) => m.partial) ? "* месяц идёт" : ""}</span></div>${monthBars(months)}`;
  if (camps.length) {
    const cMax = Math.max(...camps.map((c) => c.spent), 1);
    side += `<div class="h"${months.length ? ' style="margin-top:16px"' : ""}><h2>Реклама</h2><span class="hint">расход за ${periodDays} дней</span></div>${camps.map((c) => `<div class="rw"><span class="rn wide" title="${esc(c.campName)}">${esc(c.campName)}</span><div class="rt"><div class="rf acc" style="width:${((c.spent / cMax) * 100).toFixed(1)}%"></div></div><span class="rv">${short(c.spent)}</span></div>`).join("")}`;
  }
  if (side) blocks.push(`<div class="p span4">${side}</div>`);

  if (!s) blocks.unshift(empty("Аудита ещё нет", "Напишите в чате Claude <b>/audit</b> — через пару минут здесь появятся цифры, графики и план. Посмотреть на выдуманном магазине: <b>/audit демо</b>."));

  // Вкладки
  const docs: Record<string, string> = {};
  const frame = (key: string, html: string, title: string) => {
    docs[key] = html;
    return `<iframe data-doc="${key}" scrolling="no" title="${esc(title)}"></iframe>`;
  };
  const issuesHigh = s?.issues.filter((i) => i.priority === "high").length ?? 0;
  const tabs: [string, string, string, number?][] = [["home", "Обзор", `<div class="g12">${blocks.join("\n")}</div>`]];
  tabs.push(["audit", "Аудит", src.audit?.html ? frame("audit", src.audit.html, "Аудит") : empty("Аудита ещё нет", "Напишите в чате <b>/audit</b>."), issuesHigh]);
  tabs.push([
    "office", "Офис",
    src.office?.parts.length
      ? docList("office", src.office.parts.map((p) => ({ id: p.id, name: p.name, sub: p.id === "план" ? "итог для вас" : "отчёт роли", av: p.id === "план" ? "★" : p.name[0]!, body: `<div class="p docp"><div class="dh"><h2>${esc(p.name)}</h2><span class="hint">${p.id === "план" ? "директор свёл отчёты ролей" : "отчёт роли"}</span></div>${p.html}</div>` })))
      : empty("Офис ещё не собирался", "Напишите в чате <b>/office</b> — шесть ролей разберут магазин, директор сведёт план. Вопрос можно задать сразу: <b>/office что с остатками</b>."),
  ]);
  tabs.push(["comp", "Конкуренты", src.competitors ? frame("comp", src.competitors.html, "Конкуренты") : empty("Конкурентов ещё не смотрели", "Напишите в чате <b>/competitors плед флисовый, плед вязаный</b> — Claude откроет поиск WB и сравнит места и цены.")]);
  tabs.push([
    "card", "Карточки",
    src.cards.length
      ? docList("card", src.cards.map((c, i) => ({ id: `c${i}`, name: c.vendorCode, sub: c.findings.length ? `${c.findings.length} ${plural(c.findings.length, "замечание", "замечания", "замечаний")}` : "разбор карточки", av: "▤", body: frame(`card-${i}`, c.html, `Карточка ${c.vendorCode}`) })))
      : empty("Карточки ещё не разбирали", "Напишите в чате <b>/card артикул</b> — Claude подберёт слова, которые ищут покупатели, и предложит название и описание."),
  ]);

  const shop = s?.shop?.tradeMark || s?.shop?.name || "Магазин";
  const built = builtAt.toISOString();
  const builtLabel = `${String(builtAt.getDate()).padStart(2, "0")}.${String(builtAt.getMonth() + 1).padStart(2, "0")} ${String(builtAt.getHours()).padStart(2, "0")}:${String(builtAt.getMinutes()).padStart(2, "0")}`;
  const meta = [s ? `${periodDays} дней по ${ruD(s.period.to)}` : "", `собрано ${builtLabel}`].filter(Boolean).join(" · ");

  // Демо-прогон: шаги, которые покажет баннер «Claude работает».
  const cardsCount = d?.cards.ok ? d.cards.data.list.length : 0;
  const unanswered = s?.kpis.find((k) => k.key === "unanswered")?.value ?? 0;
  const demoSteps = [
    "Собираю продажи и финотчёт WB",
    ...(cardsCount ? [`Проверяю карточки: фото, описания — ${Math.ceil(cardsCount / 3)} из ${cardsCount}`, `Проверяю карточки — ${cardsCount} из ${cardsCount}`] : []),
    "Считаю рекламу и ДРР по кампаниям",
    ...(unanswered ? [`Читаю ${unanswered} отзывов и вопросов без ответа`] : []),
    "Смотрю цены конкурентов",
    "Собираю план на неделю",
  ];
  const payload = {
    built, demo: src.demo,
    roles: PANEL_ROLES.map((r) => ({ id: r.id, file: r.file, name: r.name, title: r.title })),
    findings: findings.map((f, i) => ({ ...f, i })),
    steps: demoSteps,
    summary: `${findings.length} ${plural(findings.length, "находка", "находки", "находок")}${plan[0] ? `, первым делом — ${plan[0].title.replace(/:.*$/, "").toLowerCase()}` : ""}`,
    D,
  };
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Панель — ${esc(shop)}</title>
<style>${PANEL_CSS}</style></head><body>
<header><div class="bar"><h1>${esc(shop)}</h1>${src.demo ? '<span class="tagd">ДЕМО</span>' : ""}<span class="meta">${meta}</span><span class="sp"></span>
<span class="live" id="live"><span class="dot"></span><span id="livet">сотрудники свободны</span></span>${src.demo ? '<button class="btn" id="replay">Разобрать заново</button>' : ""}<button class="btn" id="theme" title="Светлая или тёмная тема" aria-label="Тема">◐</button></div>
<nav role="tablist">${tabs.map(([id, name, , n], i) => `<button role="tab" aria-selected="${i === 0}" data-t="${id}">${name}${n ? `<span class="n">${n}</span>` : ""}</button>`).join("")}</nav></header>
<div class="work off" id="work"><div class="wi"><span class="spin"></span><div class="wt"><b id="wtitle">Claude работает</b><span id="wstep"></span></div><div class="wp"><div class="wbar"><div id="wfill"></div></div><span id="wpct"></span></div></div></div>
<main>${tabs.map(([id, , body], i) => `<section class="tab${i === 0 ? " on" : ""}" id="${id}">${body}</section>`).join("\n")}</main>
<footer>${src.demo ? "Демо на выдуманном магазине. " : ""}Цифры — из последних отчётов в папке reports. Сотрудники только смотрят и советуют: изменения в кабинете Claude делает после вашего «да» в чате.</footer>
<div id="tip"></div>
<div id="scrim"></div><aside id="drawer" aria-hidden="true"><div class="dr-h"><div><div class="dr-t" id="drt"></div><div class="dr-s" id="drs"></div></div><button class="btn" id="drx" aria-label="Закрыть">✕</button></div><div class="dr-b" id="drb"></div>
<div class="dr-f"><button class="btn pri" id="drask">Спросить Claude</button><button class="btn" id="drgo"></button></div><div class="dr-n" id="drn"></div></aside>
${Object.entries(docs).map(([k, h]) => `<script type="text/plain" id="doc-${k}">${h.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}
<script>const P=${json(payload)};
${PANEL_JS}</script></body></html>`;
}

// ── Сборка и статус ──

export const PANEL_DIR = (root: string) => join(root, "reports", "panel");
export const panelFile = (root: string, demo: boolean) => join(PANEL_DIR(root), demo ? "Панель ДЕМО.html" : "Панель.html");
const STATUS = (root: string) => join(PANEL_DIR(root), "status.js");

export interface PanelStatus {
  run?: string;
  step?: string;
  pct?: number;
  done?: boolean;
  agents?: Record<string, "wait" | "run" | "done">;
  log?: ([string, string, string] | { who: string; lvl?: string; text: string })[];
  built?: string;
}

export function readStatus(root: string): PanelStatus | undefined {
  const p = STATUS(root);
  if (!existsSync(p)) return undefined;
  const m = readFileSync(p, "utf8").match(/=\s*([\s\S]*?);?\s*$/);
  try {
    return m ? (JSON.parse(m[1]!) as PanelStatus) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStatus(root: string, st: PanelStatus): void {
  mkdirSync(PANEL_DIR(root), { recursive: true });
  writeFileSync(STATUS(root), `window.WB_STATUS = ${JSON.stringify(st, null, 1)};\n`);
}

/** Собрать панель из последних отчётов. Открытая страница сама перезагрузится. */
export function buildPanel(root: string, demo: boolean, now = new Date()): { path: string; sources: PanelSources } {
  const sources = findSources(root, demo);
  const path = panelFile(root, demo);
  mkdirSync(PANEL_DIR(root), { recursive: true });
  writeFileSync(path, renderPanel(sources, now));
  // Сигнал открытой панели: «есть новая сборка — перечитай страницу».
  writeStatus(root, { ...(readStatus(root) ?? { done: true }), built: now.toISOString() });
  return { path, sources };
}

/** Тихо обновить панель после отчёта: ошибка панели не должна ломать сам отчёт. */
export function refreshPanel(root: string, demo: boolean): void {
  try {
    const { path } = buildPanel(root, demo);
    console.log(`  панель:  ${path.slice(root.length + 1).replace(/\\/g, "/")}`);
  } catch (err) {
    console.error(`Панель не обновилась: ${err instanceof Error ? err.message : err}`);
  }
}

const PANEL_CSS = `:root{--bg:#f3efe6;--panel:#fbf9f4;--panel2:#f6f2ea;--line:#e6dfd2;--line2:#d6cdbd;--ink:#2b2620;--muted:#76695b;--faint:#a89a89;--c1:#c15f3c;--c2:#e2a283;--good:#2f7d32;--bad:#b42318;--warn:#b7791f;--bad-s:#f8e5e1;--warn-s:#f7ecd8;--good-s:#e4f0e1;--acc-s:#f6e4da;--s1:#4a4036;--s2:#6e6254;--s3:#958877;--s4:#b8ab99;--s5:#d3c8b7;--neu:#8f8273;--mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;color-scheme:light}
:root[data-theme="dark"]{--bg:#1c1a17;--panel:#24211d;--panel2:#2a2722;--line:#35312b;--line2:#443f37;--ink:#eee9e0;--muted:#a69b8d;--faint:#756b5f;--c1:#e0855f;--c2:#9a5236;--good:#6cc070;--bad:#f07a6a;--warn:#e3b04f;--bad-s:#3b2420;--warn-s:#382d18;--good-s:#1f3020;--acc-s:#3a281f;--s1:#ece6dc;--s2:#c8bfb2;--s3:#9e9486;--s4:#71685d;--s5:#4f4840;--neu:#a69b8d;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1a17;--panel:#24211d;--panel2:#2a2722;--line:#35312b;--line2:#443f37;--ink:#eee9e0;--muted:#a69b8d;--faint:#756b5f;--c1:#e0855f;--c2:#9a5236;--good:#6cc070;--bad:#f07a6a;--warn:#e3b04f;--bad-s:#3b2420;--warn-s:#382d18;--good-s:#1f3020;--acc-s:#3a281f;--s1:#ece6dc;--s2:#c8bfb2;--s3:#9e9486;--s4:#71685d;--s5:#4f4840;--neu:#a69b8d;color-scheme:dark}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
header{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.bar{max-width:1320px;margin:0 auto;padding:12px 20px 0;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.bar h1{font-size:17px;margin:0;font-weight:700}.tagd{font:600 10px/1 var(--mono);letter-spacing:.08em;color:var(--muted);border:1px solid var(--line2);border-radius:4px;padding:3px 5px}
.meta{color:var(--muted);font-size:12px}.sp{flex:1}
.live{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);font-family:var(--mono)}.dot{width:7px;height:7px;border-radius:50%;background:var(--good)}.live.run .dot{background:var(--c1);animation:pulse 1.2s infinite}
@keyframes pulse{50%{opacity:.25}}
.btn{all:unset;cursor:pointer;font-size:12px;color:var(--muted);border:1px solid var(--line2);border-radius:6px;padding:4px 9px}.btn:hover{color:var(--ink);border-color:var(--faint)}.btn:focus-visible{outline:2px solid var(--c1);outline-offset:2px}
nav{max-width:1320px;margin:0 auto;padding:0 12px;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}nav::-webkit-scrollbar{display:none}
nav button{all:unset;cursor:pointer;padding:10px 10px 9px;font-size:13px;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap}nav button:hover{color:var(--ink)}nav button[aria-selected="true"]{color:var(--ink);border-color:var(--c1);font-weight:600}nav button:focus-visible{outline:2px solid var(--c1)}
nav .n{font:600 10px var(--mono);color:var(--bad);margin-left:5px}
main{max-width:1320px;margin:0 auto;padding:16px 20px 24px}.tab{display:none}.tab.on{display:block}
footer{max-width:1320px;margin:0 auto;padding:0 20px 32px;font-size:12px;color:var(--faint)}
.g12{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px}
.p{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
.h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}.h h2{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0}.hint{font-size:12px;color:var(--faint)}
.span3{grid-column:span 3}.span4{grid-column:span 4}.span5{grid-column:span 5}.span7{grid-column:span 7}.span8{grid-column:span 8}.span12{grid-column:span 12}
.empty{grid-column:span 12;padding:28px}.empty h2{margin:0 0 6px;font-size:18px}.empty p{margin:0;color:var(--muted);max-width:70ch}
.kpi .k{font-size:12px;color:var(--muted)}.kpi .v{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpi .v.bad{color:var(--bad)}.kpi .f{font-size:12px;color:var(--muted)}.kpi .row{display:flex;justify-content:space-between;align-items:flex-end;gap:10px}
.kpi.hero .v{font-size:40px}
.spark{width:96px;height:34px;flex:none}.kpi .row .v{min-width:0;font-size:clamp(22px,2.3vw,30px)}.chart{width:100%;height:auto;display:block}
.gauge{position:relative;height:8px;border-radius:4px;background:linear-gradient(90deg,var(--good-s) 0 var(--be),var(--bad-s) var(--be) 100%);margin:12px 0 6px}
.gauge .be{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--muted)}.gauge .val{position:absolute;top:-5px;width:4px;height:18px;border-radius:2px;background:var(--bad);transform:translateX(-50%)}.gauge .val.okv{background:var(--good)}
.gl{display:flex;justify-content:space-between;font-size:11px;color:var(--faint);font-family:var(--mono)}
.ax{font:11px var(--mono);fill:var(--faint)}.dl{font:600 11px system-ui;fill:var(--muted)}.vl{font:600 12px system-ui;fill:var(--ink)}
.g{stroke:var(--line);stroke-width:1}.g0{stroke:var(--line2);stroke-width:1}
.ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.c1{stroke:var(--c1)}.c2{stroke:var(--c2)}.dash{stroke-dasharray:3 4}
.draw{stroke-dasharray:2000;stroke-dashoffset:2000;animation:draw 1.4s ease-out forwards}@keyframes draw{to{stroke-dashoffset:0}}
.cross{stroke:var(--faint);stroke-dasharray:2 3;opacity:0}.pt{opacity:0;stroke:var(--panel);stroke-width:2}.pt.p1{fill:var(--c1)}.pt.p2{fill:var(--c2)}.hit{fill:transparent;cursor:crosshair}
.lg{display:flex;gap:14px;font-size:12px;color:var(--muted);margin:-4px 0 6px;flex-wrap:wrap}.lg i{display:inline-block;width:12px;height:2px;vertical-align:middle;margin-right:6px}
#tip{position:fixed;pointer-events:none;z-index:20;background:var(--ink);color:var(--bg);font-size:12px;border-radius:6px;padding:7px 9px;line-height:1.5;opacity:0;transition:opacity .1s;white-space:nowrap}
.console{font:12.5px/1.55 var(--mono);height:262px;overflow:auto;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;scroll-behavior:smooth}
.span12 .console{height:auto;max-height:262px}
.console .ln2{margin:0 0 8px;animation:in .35s ease-out}.console .muted{color:var(--muted)}.console .who{font-weight:700}.console .who.bad{color:var(--bad)}.console .who.warn{color:var(--warn)}.console .who.ok{color:var(--good)}.console .t{color:var(--faint);margin-right:6px}
.console .sep{color:var(--faint);border-top:1px dashed var(--line2);padding-top:6px}
@keyframes in{from{opacity:0;transform:translateY(4px)}}
.agents{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
.ag{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--panel2)}.ag .an{font-weight:600;font-size:13px;display:flex;justify-content:space-between;align-items:center}.ag .ad{font-size:11px;color:var(--muted);margin:1px 0 9px}
.ag .st{font:11px var(--mono);color:var(--muted)}.ag.done .st{color:var(--good)}.ag.run .st{color:var(--c1)}
.track{height:3px;border-radius:2px;background:var(--line);overflow:hidden;position:relative;margin-bottom:6px}
.ag.run .track::after{content:"";position:absolute;inset:0 auto 0 0;width:35%;background:var(--c1);border-radius:2px;animation:run 1.1s ease-in-out infinite}
.ag.done .track{background:var(--good)}@keyframes run{0%{left:-35%}100%{left:100%}}
.ag .cnt{font:600 11px var(--mono);color:var(--muted)}
.flow{display:flex;gap:2px;height:30px;border-radius:5px;overflow:hidden}.fseg{display:flex;align-items:center;padding-left:6px;font:600 11px var(--mono);color:var(--bg);min-width:0;overflow:hidden;white-space:nowrap}
.s1{background:var(--s1)}.s2{background:var(--s2)}.s3{background:var(--s3)}.s4{background:var(--s4)}.s5{background:var(--s5)}.keep{background:var(--good)}.loss{background:var(--bad)}
.s4 span,.s5 span{color:var(--ink)}
.flowmark{position:relative;height:18px}.flowmark span{position:absolute;top:2px;transform:translateX(-100%);font:600 11px system-ui;color:var(--bad);border-right:2px solid var(--bad);padding-right:5px;line-height:14px;white-space:nowrap}
.legend{list-style:none;margin:6px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 16px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px;vertical-align:-1px}.legend b{color:var(--ink);margin-left:6px;font-weight:600}.lossli b{color:var(--bad)}
.rw,.pb{display:grid;grid-template-columns:118px minmax(0,1fr) 62px;gap:10px;align-items:center;padding:4px 0;font-size:12px}
.rn{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rn.wide{font-family:inherit;font-size:12px;color:var(--ink)}
.rt{position:relative;height:8px;border-radius:4px;background:var(--line)}.rf{height:100%;border-radius:4px;transform-origin:left;animation:grow .9s ease-out both}
.rf.ok{background:var(--neu)}.rf.acc{background:var(--c1)}.rf.warn{background:var(--warn)}.rf.bad{background:var(--bad)}@keyframes grow{from{transform:scaleX(0)}}
.rmark{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--muted)}
.rv{text-align:right;font:600 12px var(--mono);white-space:nowrap}.rv.bad{color:var(--bad)}.rv.warn{color:var(--warn)}
.pt2{position:relative;height:10px}.pz{position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--line2)}.pf{position:absolute;top:0;bottom:0;border-radius:3px;animation:grow .9s ease-out both}.pf.pos{background:var(--good)}.pf.neg{background:var(--bad);transform-origin:right}
.bneg{fill:var(--bad)}.bpos{fill:var(--good)}.part{opacity:.55}
.note{font-size:12px;color:var(--faint);margin:8px 0 0}
.plan{margin:0;padding-left:20px;font-size:13px}.plan li{margin:0 0 7px}.plan b{font-weight:600}.plan .m{color:var(--muted);font-family:var(--mono);font-size:12px;margin-left:6px;white-space:nowrap}
iframe{display:block;width:100%;border:0;background:transparent;min-height:400px}
.office{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;align-items:start}
.olist{position:sticky;top:110px;display:flex;flex-direction:column;gap:4px}
.oi{all:unset;cursor:pointer;display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;border:1px solid transparent}.oi:hover{background:var(--panel)}.oi:focus-visible{outline:2px solid var(--c1)}
.oi[aria-selected="true"]{background:var(--panel);border-color:var(--line)}
.oav{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:13px;background:var(--acc-s);color:var(--c1);flex:none}
.on2{font-size:13px;font-weight:600;line-height:1.25;min-width:0;overflow-wrap:anywhere}.os{display:block;font-size:11px;font-weight:400;color:var(--muted)}
.doc{display:none;min-width:0}.doc.on{display:block;animation:in .25s ease-out}
.docp{padding:20px 26px;font-size:14.5px;line-height:1.6}
.dh{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:6px}.dh h2{margin:0;font-size:20px}
.docp>h2,.docp>h3,.docp>h4{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:22px 0 8px}
.docp p{margin:8px 0;max-width:78ch}.docp ul,.docp ol{padding-left:22px;margin:8px 0;max-width:80ch}.docp li{margin:0 0 6px}.docp li::marker{color:var(--c1)}.docp strong{font-weight:650}
.docp table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px}.docp th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--line2);padding:6px 8px}.docp td{border-bottom:1px solid var(--line);padding:8px;vertical-align:top}.docp .table-wrap{overflow-x:auto}
.docp code{font-family:var(--mono);font-size:.92em;background:var(--panel2);padding:1px 4px;border-radius:4px}
.work{background:var(--acc-s);border-bottom:1px solid var(--line);overflow:hidden;max-height:60px;transition:max-height .4s,opacity .4s}.work.off{max-height:0;opacity:0;border:0}
.wi{max-width:1320px;margin:0 auto;padding:9px 20px;display:flex;align-items:center;gap:12px}.wt{flex:1;min-width:0;display:flex;gap:10px;align-items:baseline;font-size:13px}.wt span{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line2);border-top-color:var(--c1);animation:sp .8s linear infinite;flex:none}@keyframes sp{to{transform:rotate(360deg)}}
.work.fin .spin{animation:none;border-color:var(--good)}.work.stale .spin{animation:none;border-color:var(--warn)}
.wp{display:flex;align-items:center;gap:8px;font:600 11px var(--mono);color:var(--muted)}.wbar{width:160px;height:4px;border-radius:2px;background:var(--line);overflow:hidden;position:relative}#wfill{height:100%;width:0;border-radius:2px;background:var(--c1);transition:width .5s}
.work.ind #wfill{width:35%!important;position:absolute;animation:run 1.3s ease-in-out infinite}
@media (max-width:640px){.wbar{width:70px}.wt span{display:none}}
.cl{cursor:pointer;transition:border-color .15s,background .15s}.p.cl:hover,.ag.cl:hover{border-color:var(--c1)}.rw.cl:hover,.pb.cl:hover{background:var(--panel2)}.rw.cl,.pb.cl{border-radius:6px;margin:0 -6px;padding-left:6px;padding-right:6px}
.plan li.cl{padding:2px 4px;margin-left:-4px;border-radius:6px}.plan li.cl:hover{background:var(--panel2)}.console .ln2.cl:hover{background:var(--panel);border-radius:4px}
.cl:focus-visible{outline:2px solid var(--c1);outline-offset:2px}
#scrim{position:fixed;inset:0;background:rgba(20,16,12,.25);opacity:0;pointer-events:none;transition:opacity .2s;z-index:30}#scrim.on{opacity:1;pointer-events:auto}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:var(--panel);border-left:1px solid var(--line);z-index:31;transform:translateX(100%);transition:transform .25s ease-out;display:flex;flex-direction:column;visibility:hidden}#drawer.on{transform:none;visibility:visible}
.dr-h{display:flex;justify-content:space-between;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--line)}.dr-t{font-size:18px;font-weight:700;overflow-wrap:anywhere}.dr-s{font-size:12px;color:var(--muted);margin-top:2px}
.dr-b{flex:1;overflow:auto;padding:14px 20px;font-size:14px}.dr-b p{margin:0 0 12px}.dr-b ul{margin:0 0 12px;padding-left:18px;font-size:13px}.kv{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}.kv b{font-variant-numeric:tabular-nums;text-align:right}
.fi{border-left:3px solid var(--line2);padding:4px 0 4px 10px;margin:0 0 10px}.fi.bad{border-color:var(--bad)}.fi.warn{border-color:var(--warn)}.fi.ok{border-color:var(--good)}
.dr-f{display:flex;gap:8px;padding:12px 20px;border-top:1px solid var(--line);flex-wrap:wrap}.btn.pri{background:var(--c1);color:#fff;border-color:var(--c1)}.btn.pri:hover{color:#fff;filter:brightness(1.08)}
.dr-n{font-size:12px;color:var(--muted);padding:0 20px 14px;min-height:18px}
@media (max-width:1100px){.agents{grid-template-columns:repeat(3,minmax(0,1fr))}.span3{grid-column:span 6}.span4,.span5,.span7,.span8{grid-column:span 12}}
@media (max-width:820px){.office{grid-template-columns:minmax(0,1fr)}.olist{position:sticky;top:92px;z-index:4;flex-direction:row;overflow-x:auto;background:var(--bg);padding:4px 0;scrollbar-width:none}.olist::-webkit-scrollbar{display:none}.oi{flex:none;padding:6px 10px}.os{display:none}.oav{width:24px;height:24px;font-size:11px}.docp{padding:16px}}
@media (max-width:640px){main{padding:12px}.bar{padding:10px 12px 0}footer{padding:0 12px 24px}.span3{grid-column:span 12}.agents{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi.hero .v{font-size:34px}.rw,.pb{grid-template-columns:96px minmax(0,1fr) 54px}.meta{display:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

/** Поведение страницы: вкладки, отчёты во всю высоту, подсказки, подробности, живой статус. */
const PANEL_JS = String.raw`const $=q=>document.querySelector(q),R=document.documentElement;
const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
// Вкладки
const tabs=[...document.querySelectorAll('nav button')];
function show(t){if(!document.getElementById(t))return;tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===t));document.querySelectorAll('.tab').forEach(s=>s.classList.toggle('on',s.id===t));document.querySelectorAll('#'+t+' > iframe, #'+t+' .doc.on iframe').forEach(f=>{if(!f.srcdoc)loadDoc(f)});try{history.replaceState(null,'','#'+t)}catch(e){}scrollTo(0,0)}
tabs.forEach(b=>b.onclick=()=>show(b.dataset.t));
// Список слева, документ справа (офис, карточки)
function pick(g,id){const box=document.querySelector('.office[data-g="'+g+'"]');if(!box)return;let hit=false;box.querySelectorAll('.oi').forEach(x=>{const on=x.dataset.o===id;hit=hit||on;x.setAttribute('aria-selected',on)});if(!hit)return;box.querySelectorAll('.doc').forEach(d=>{const on=d.dataset.o===id;d.classList.toggle('on',on);if(on)d.querySelectorAll('iframe').forEach(f=>{if(!f.srcdoc)loadDoc(f)})});if(box.getBoundingClientRect().top<0)scrollTo({top:box.getBoundingClientRect().top+scrollY-110})}
document.querySelectorAll('.office').forEach(box=>box.querySelectorAll('.oi').forEach(b=>b.onclick=()=>pick(box.dataset.g,b.dataset.o)));
// Отчёт целиком в странице: высота по содержимому, цвета панели
function themeCss(){const cs=getComputedStyle(R),v=n=>cs.getPropertyValue('--'+n).trim();return ':root[data-theme]{--bg:transparent;--card:'+v('panel')+';--text:'+v('ink')+';--muted:'+v('muted')+';--faint:'+v('faint')+';--line:'+v('line')+';--line-strong:'+v('line2')+';--accent:'+v('c1')+';--accent2:'+v('c2')+';--accent-soft:'+v('acc-s')+';--good:'+v('good')+';--bad:'+v('bad')+';--warn:'+v('warn')+';--bad-soft:'+v('bad-s')+';--warn-soft:'+v('warn-s')+';--good-soft:'+v('good-s')+';--chip-low:'+v('line')+';--seg1:'+v('s1')+';--seg2:'+v('s2')+';--seg3:'+v('s3')+';--seg4:'+v('s4')+';--seg5:'+v('s5')+'}html,body{background:transparent!important;overflow:hidden}';}
function isDark(){const t=R.dataset.theme;return t?t==='dark':matchMedia('(prefers-color-scheme:dark)').matches}
function fit(f){const d=f.contentDocument;if(d&&d.documentElement)f.style.height=d.documentElement.scrollHeight+'px'}
function paint(f){const d=f.contentDocument;if(!d||!d.head)return;d.documentElement.dataset.theme=isDark()?'dark':'light';let st=d.getElementById('panel-theme');if(!st){st=d.createElement('style');st.id='panel-theme';d.head.appendChild(st)}st.textContent=themeCss();fit(f)}
function loadDoc(f){const src=document.getElementById('doc-'+f.dataset.doc);if(!src)return;f.onload=()=>{paint(f);const d=f.contentDocument;try{new ResizeObserver(()=>fit(f)).observe(d.body)}catch(e){setInterval(()=>fit(f),1000)}d.querySelectorAll('a[href^="#"]').forEach(a=>a.onclick=ev=>{ev.preventDefault();const t=d.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));if(t)scrollTo({top:f.getBoundingClientRect().top+scrollY+t.getBoundingClientRect().top-110,behavior:'smooth'})})};f.srcdoc=src.textContent}
const repaint=()=>document.querySelectorAll('iframe').forEach(f=>f.srcdoc&&paint(f));matchMedia('(prefers-color-scheme:dark)').addEventListener('change',repaint);
// Тема: по системе, кнопка переключает и запоминает
try{const t=localStorage.getItem('wbkit-theme');if(t)R.dataset.theme=t}catch(e){}
$('#theme').onclick=()=>{R.dataset.theme=isDark()?'light':'dark';try{localStorage.setItem('wbkit-theme',R.dataset.theme)}catch(e){}repaint()};
const h0=location.hash.slice(1);if(h0)show(h0);
// Подсказка на графике
const tip=$('#tip'),svg=$('#wk');
if(svg)svg.querySelectorAll('.hit').forEach(h=>{h.onmousemove=ev=>{tip.innerHTML=h.dataset.tip.split('|').map((l,i)=>i?l:'<b>'+l+'</b>').join('<br>');tip.style.opacity=1;const w=tip.offsetWidth;tip.style.left=Math.min(innerWidth-w-8,ev.clientX+14)+'px';tip.style.top=ev.clientY+14+'px';
 const c=svg.querySelector('.cross');c.setAttribute('x1',h.dataset.x);c.setAttribute('x2',h.dataset.x);c.style.opacity=1;[['p1',h.dataset.y1],['p2',h.dataset.y2]].forEach(([k,y])=>{const p=svg.querySelector('.'+k);p.setAttribute('cx',h.dataset.x);p.setAttribute('cy',y);p.style.opacity=1})};
 h.onmouseleave=()=>{tip.style.opacity=0;svg.querySelectorAll('.cross,.pt').forEach(x=>x.style.opacity=0)}});
// Подробности по клику
const D=P.D;let cur=null;const DR=$('#drawer'),SC=$('#scrim');
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function openD(key){const d=D[key];if(!d)return;cur=d;$('#drt').textContent=d.title;$('#drs').textContent=d.sub||'';const b=$('#drb');b.innerHTML='';
 if(d.text)b.appendChild(el('p','',d.text));
 if(d.list&&d.list.length){const u=el('ul');d.list.forEach(t=>u.appendChild(el('li','',t)));b.appendChild(u)}
 if(d.rows){if(d.rows.length)d.rows.forEach(([l,t])=>b.appendChild(el('div','fi '+l,t)));else if(!d.text)b.appendChild(el('p','','Пока без находок.'))}
 if(d.kv)d.kv.forEach(([k,v])=>{const r=el('div','kv');r.appendChild(el('span','',k));r.appendChild(el('b','',v));b.appendChild(r)});
 $('#drgo').textContent=d.goLabel||'Открыть';$('#drgo').style.display=d.go?'':'none';$('#drn').textContent='';DR.classList.add('on');SC.classList.add('on');DR.setAttribute('aria-hidden','false');$('#drx').focus()}
function closeD(){DR.classList.remove('on');SC.classList.remove('on');DR.setAttribute('aria-hidden','true')}
document.addEventListener('click',ev=>{const c=ev.target.closest('.cl[data-d]');if(c)openD(c.dataset.d)});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeD();if(ev.key==='Enter'||ev.key===' '){const c=document.activeElement&&document.activeElement.closest&&document.activeElement.closest('.cl[data-d]');if(c){ev.preventDefault();openD(c.dataset.d)}}});
$('#drx').onclick=closeD;SC.onclick=closeD;
$('#drgo').onclick=()=>{if(!cur||!cur.go)return;closeD();show(cur.go[0]);if(cur.go[1])pick(cur.go[0],cur.go[1])};
$('#drask').onclick=async()=>{if(!cur)return;let ok=false;try{await navigator.clipboard.writeText(cur.ask);ok=true}catch(e){try{const t=document.createElement('textarea');t.value=cur.ask;document.body.appendChild(t);t.select();ok=document.execCommand('copy');t.remove()}catch(e2){}}
 $('#drn').textContent=ok?'Вопрос скопирован — вставьте его в чат Claude (Ctrl+V).':'Скопируйте вопрос в чат Claude: '+cur.ask};
// Живой статус: что делает Claude прямо сейчас
const roleOf=w=>P.roles.find(r=>r.id===w||r.file===w||r.name===w||r.title===w);
const plur=(n,a,b,c)=>{const m=n%10,h=n%100;return m===1&&h!==11?a:m>=2&&m<=4&&(h<12||h>14)?b:c};
const staticCon=$('#con').innerHTML,staticAg={};P.roles.forEach(r=>{const e=$('#ag-'+r.id);staticAg[r.id]=[e.className,e.querySelector('.st').textContent]});
let shown=0,lastSig='',sigAt=Date.now(),first=true,live=false,finTimer=0;
function norm(l){return Array.isArray(l)?{who:l[0],lvl:l[1],text:l[2]}:l}
function render(st,sim){
 const W=$('#work');clearTimeout(finTimer);
 const agents=st.agents||{};const log=(st.log||[]).map(norm).filter(l=>l&&l.text);
 // Сотрудники
 let runN=0,known=0;P.roles.forEach(r=>{const s=agents[r.id]||agents[r.file];const e=$('#ag-'+r.id);if(!s){if(!live){e.className=staticAg[r.id][0];e.querySelector('.st').textContent=staticAg[r.id][1]}else{e.className='ag cl';e.querySelector('.st').textContent='не участвует'}return}known++;
  const mine=log.filter(l=>{const x=roleOf(l.who);return x&&x.id===r.id}).length;
  e.className='ag cl '+(s==='run'?'run':s==='done'?'done':'');if(s==='run')runN++;
  e.querySelector('.st').textContent=s==='run'?'работает…':s==='done'?'готово'+(mine?' · '+mine+' '+plur(mine,'находка','находки','находок'):''):'ждёт'});
 // Консоль
 const con=$('#con');if(log.length<shown){shown=0}
 if(shown===0&&log.length){con.innerHTML=''}
 for(;shown<log.length;shown++){const l=log[shown],r=roleOf(l.who),k='live-'+shown;D[k]={title:r?r.title:l.who,sub:'находка',text:l.text,go:r?['office',r.file]:null,goLabel:'Отчёт роли',ask:'Разбери подробнее: «'+l.text+'». Что сделать по шагам?'};
  const p=el('p','ln2 cl');p.dataset.d=k;p.tabIndex=0;p.appendChild(el('span','t',new Date().toTimeString().slice(0,5)));p.appendChild(el('span','who '+(l.lvl||'ok'),r?r.name:l.who));p.appendChild(document.createTextNode(' › '+l.text));con.appendChild(p);con.scrollTop=con.scrollHeight}
 if(log.length)$('#lc').textContent=log.length+' '+plur(log.length,'находка','находки','находок');
 // Баннер
 const L=$('#live'),pct=typeof st.pct==='number'?Math.max(0,Math.min(100,st.pct)):null;
 W.classList.remove('off','fin','stale');W.classList.toggle('ind',pct===null&&!st.done);
 $('#wtitle').textContent=st.done?'Готово':(st.run||'Claude работает');$('#wstep').textContent=st.step||'';
 $('#wfill').style.width=(st.done?100:pct||0)+'%';$('#wpct').textContent=st.done?'100%':pct===null?'':pct+'%';
 if(st.done){W.classList.add('fin');L.classList.remove('run');$('#livet').textContent='разбор готов';finTimer=setTimeout(()=>W.classList.add('off'),sim?3000:6000)}
 else{L.classList.add('run');$('#livet').textContent=runN?('работают '+runN+' из '+known):'Claude работает'}
}
// Опрос reports/panel/status.js: файл пишет Claude, страница его читает (работает и без сервера).
function poll(){const s=document.createElement('script');s.src='status.js?'+Date.now();s.onload=()=>{s.remove();const st=window.WB_STATUS;window.WB_STATUS=null;if(st)onStatus(st)};s.onerror=()=>s.remove();document.head.appendChild(s)}
function onStatus(st){if(st.built&&st.built>P.built){location.reload();return}const {built,...rest}=st;const sig=JSON.stringify(rest);
 if(first){first=false;lastSig=sig;if(st.done)return}else if(sig===lastSig){if(live&&!st.done&&Date.now()-sigAt>20*60e3){const W=$('#work');W.classList.add('stale');W.classList.remove('ind');$('#wtitle').textContent='Статус давно не обновлялся';$('#wstep').textContent='Возможно, Claude ждёт вашего ответа в чате или разбор прервался.';$('#live').classList.remove('run')}return}
 lastSig=sig;sigAt=Date.now();stopSim();live=true;render(st,false)}
setInterval(poll,3000);poll();
// Демо: прогон «сотрудники работают параллельно» на находках этой панели
let simT=[];function stopSim(){simT.forEach(clearTimeout);simT=[]}
function sim(){stopSim();live=true;shown=0;const k=reduce?0:1,ids=P.roles.map(r=>r.id),ag={};ids.forEach(i=>ag[i]='run');const log=[],steps=P.steps,n=steps.length;
 const at=(ms,fn)=>simT.push(setTimeout(fn,ms*k));const st=()=>({run:'Claude работает в фоне',step:cur.step,pct:cur.pct,agents:{...ag},log:[...log]});const cur={step:steps[0],pct:0};
 $('#con').innerHTML='';render(st(),true);
 steps.forEach((s,i)=>at(i*900,()=>{cur.step=s;cur.pct=Math.round((i+1)/(n+1)*100);render(st(),true)}));
 ids.forEach((id,j)=>at(2200+j*800,()=>{ag[id]='done';P.findings.filter(f=>f.who===id).slice(0,3).forEach(f=>log.push([f.who,f.lvl,f.text]));render(st(),true)}));
 at(Math.max(n*900,2200+ids.length*800)+400,()=>{render({done:true,step:P.summary,agents:{...ag},log:[...log,['Claude','ok','План на неделю готов — вкладка «Обзор», блок «Что сделать в первую очередь».']]},true);live=false})}
if(P.demo){$('#replay').onclick=sim;sim()}`;
