/**
 * HTML-отчёт аудита: один самодостаточный файл без внешних ссылок — открывается
 * двойным щелчком, без интернета, пересылается в мессенджере. Светлая и тёмная тема.
 */
import type { AuditReport, Issue, Kpi, ProductLine } from "./analyze.js";
import { THRESHOLDS } from "./analyze.js";
import type { WeekPoint } from "./collect.js";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
export const rub = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${fmt(Math.round(n))} ₽`);
export const ruDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y}`;
};

/** Общие стили отчётов wb-kit: аудит и конкуренты выглядят одинаково. */
export const BASE_CSS = `:root{--bg:#f6f5f2;--card:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e4e2dc;--accent:#7b2cbf;--accent2:#c9a8ee;--good:#1f8a4c;--bad:#c62f3a;--warn:#b86e00;--chip-high:#fde7e9;--chip-med:#fff1d6;--chip-low:#eef0f3}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1d1d21;--text:#ececef;--muted:#9a9aa3;--line:#2e2e34;--accent:#b07cf0;--accent2:#5b3a85;--good:#4cc27e;--bad:#ff6b73;--warn:#f0a63a;--chip-high:#3a1e22;--chip-med:#3a2e17;--chip-low:#26282d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 16px 48px}
header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:flex-end;margin-bottom:20px}
h1{font-size:26px;margin:0}h2{font-size:19px;margin:0 0 14px}h3{font-size:16px;margin:6px 0}
.sub{color:var(--muted)}.badge{background:var(--accent);color:#fff;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600;margin-left:8px;vertical-align:middle}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi-label{color:var(--muted);font-size:13px}.kpi-value{font-size:22px;font-weight:650;margin:2px 0;font-variant-numeric:tabular-nums}
.kpi-foot{font-size:12px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap}.delta.up{color:var(--good)}.delta.down{color:var(--bad)}
.insights{border-left:4px solid var(--accent)}.insights p,.insights li{max-width:75ch}
.issues{display:grid;gap:12px}.issue{border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.issue.high{border-left:4px solid var(--bad)}.issue.medium{border-left:4px solid var(--warn)}.issue.low{border-left:4px solid var(--line)}
.issue-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.num{font-weight:700;color:var(--muted)}
.chip{font-size:12px;border-radius:999px;padding:2px 9px;font-weight:600}.chip.high{background:var(--chip-high);color:var(--bad)}.chip.medium{background:var(--chip-med);color:var(--warn)}.chip.low{background:var(--chip-low);color:var(--muted)}
.impact{font-size:12px;color:var(--bad);font-weight:600}.action{background:var(--bg);border-radius:8px;padding:8px 10px}
.products{margin:8px 0 0;padding-left:18px}.products li{margin:2px 0}details summary{cursor:pointer;color:var(--accent);margin-top:4px}
.muted{color:var(--muted)}.small{font-size:12px}.note{color:var(--muted);font-size:13px;margin:10px 0 0}
.chart{width:100%;height:auto}.chart .grid{stroke:var(--line)}.chart .axis{fill:var(--muted);font-size:11px}
.bar-orders{fill:var(--accent)}.bar-buyouts{fill:var(--accent2)}.partial{opacity:.45}
.legend{display:flex;gap:16px;font-size:13px;color:var(--muted);flex-wrap:wrap}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}.sw.orders{background:var(--accent)}.sw.buyouts{background:var(--accent2)}
.abc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.abc-card{border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:2px}
.abc-card b{font-size:22px}.abc-card small{color:var(--muted)}
.abc{display:inline-block;min-width:22px;border-radius:6px;font-weight:700;font-size:12px;padding:1px 6px}.abc.A{background:var(--accent);color:#fff}.abc.B{background:var(--accent2)}.abc.C{background:var(--chip-low);color:var(--muted)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px;white-space:nowrap;position:sticky;top:0;background:var(--card)}
td{border-bottom:1px solid var(--line);padding:7px 8px;vertical-align:top}td.r,th.r{text-align:right}td.c{text-align:center}td.bad{color:var(--bad);font-weight:600}tfoot td{font-weight:650}
.products-table td:first-child{min-width:190px}
.money{display:grid;gap:6px}.money-row{display:grid;grid-template-columns:minmax(150px,280px) 1fr minmax(110px,auto);gap:10px;align-items:center}
.money-bar{background:var(--bg);border-radius:4px;height:12px;overflow:hidden}.money-bar i{display:block;height:100%;border-radius:4px}
.money-row.pos i{background:var(--good)}.money-row.neg i{background:var(--bad)}.money-row.total i{background:var(--accent)}.money-row.total{font-weight:700;border-top:1px solid var(--line);padding-top:6px}.money-val{text-align:right;font-variant-numeric:tabular-nums}
.reviews{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}blockquote{margin:0;border:1px solid var(--line);border-radius:10px;padding:10px 12px}.stars{color:var(--warn);font-size:13px;margin-bottom:4px}
code{background:var(--bg);border-radius:4px;padding:1px 5px}footer{color:var(--muted);font-size:13px;text-align:center;margin-top:24px}
@media (max-width:600px){.money-row{grid-template-columns:1fr auto}.money-bar{grid-column:1/-1;order:3}h1{font-size:22px}.kpis{grid-template-columns:1fr 1fr}.kpi-value{font-size:18px}section{padding:16px}}
@media print{body{background:#fff}section{break-inside:avoid}}
`;

/** Мини-markdown для выводов Claude: заголовки, списки, жирный, абзацы. Сначала экранируем. */
export function markdownToHtml(md: string): string {
  const lines = esc(md).split(/\r?\n/);
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      close();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      close();
      out.push(`<h3>${inline(h[2]!)}</h3>`);
    } else if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join("\n");
}

function kpiTile(k: Kpi): string {
  const value = k.unit === "₽" ? rub(k.value) : k.unit === "%" ? `${fmt(k.value, 1)}%` : k.unit === "★" ? `${fmt(k.value, 2)} ★` : k.unit === "шт" ? `${fmt(k.value)} шт` : fmt(k.value);
  let delta = "";
  if (k.delta !== undefined && k.delta !== null) {
    const cls = k.delta > 0 ? "up" : k.delta < 0 ? "down" : "";
    delta = `<span class="delta ${cls}">${k.delta > 0 ? "▲" : k.delta < 0 ? "▼" : ""} ${fmt(Math.abs(k.delta), 1)}%</span>`;
  }
  return `<div class="kpi"><div class="kpi-label">${esc(k.label)}</div><div class="kpi-value">${value}</div><div class="kpi-foot">${delta}${k.hint ? `<span>${esc(k.hint)}</span>` : ""}</div></div>`;
}

const PRIORITY: Record<Issue["priority"], string> = { high: "Срочно", medium: "Важно", low: "Можно позже" };

function issueCard(i: Issue, n: number): string {
  const items = i.products.map((p) => `<li><b>${esc(p.vendorCode || p.title)}</b>${p.vendorCode && p.title ? ` <span class="muted">${esc(p.title)}</span>` : ""}${p.note ? ` — ${esc(p.note)}` : ""}</li>`);
  const shown = items.slice(0, 6).join("");
  const rest = items.length > 6 ? `<details><summary>ещё ${items.length - 6}</summary><ul>${items.slice(6).join("")}</ul></details>` : "";
  return `<article class="issue ${i.priority}">
  <div class="issue-head"><span class="num">${n}</span><span class="chip ${i.priority}">${PRIORITY[i.priority]}</span>${i.impactRub ? `<span class="impact">≈ ${rub(i.impactRub)} за неделю</span>` : ""}</div>
  <h3>${esc(i.title)}</h3>
  <p>${esc(i.detail)}</p>
  <p class="action"><b>Что сделать:</b> ${esc(i.action)}</p>
  ${items.length ? `<ul class="products">${shown}</ul>${rest}` : ""}
</article>`;
}

function weeklyChart(weeks: WeekPoint[], periodTo: string): string {
  if (!weeks.length) return "";
  const W = 720, H = 220, padL = 64, padB = 28, padT = 12;
  const max = Math.max(...weeks.map((w) => w.ordersSum), 1);
  const step = (W - padL - 8) / weeks.length;
  const bw = Math.max(6, step * 0.38);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const lastWeekPartial = (() => {
    const last = weeks[weeks.length - 1]!.weekStart;
    const end = new Date(Date.parse(`${last}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    return end > periodTo;
  })();
  const bars = weeks
    .map((w, i) => {
      const x = padL + i * step + step / 2;
      const partial = lastWeekPartial && i === weeks.length - 1;
      return `<g><title>Неделя с ${ruDate(w.weekStart)}: заказы ${rub(w.ordersSum)} (${w.orders} шт), выкупы ${rub(w.buyoutsSum)}${partial ? " — неделя ещё идёт" : ""}</title>
<rect x="${x - bw - 1}" y="${y(w.ordersSum)}" width="${bw}" height="${H - padB - y(w.ordersSum)}" rx="2" class="bar-orders${partial ? " partial" : ""}"/>
<rect x="${x + 1}" y="${y(w.buyoutsSum)}" width="${bw}" height="${H - padB - y(w.buyoutsSum)}" rx="2" class="bar-buyouts${partial ? " partial" : ""}"/>
<text x="${x}" y="${H - 8}" class="axis" text-anchor="middle">${ruDate(w.weekStart).slice(0, 5)}</text></g>`;
    })
    .join("");
  const grid = ticks
    .map((t) => `<line x1="${padL}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${padL - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${fmt(Math.round(t / 1000))} т</text>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Заказы и выкупы по неделям">${grid}${bars}</svg>
<div class="legend"><span><i class="sw orders"></i>Заказы, ₽</span><span><i class="sw buyouts"></i>Выкупы, ₽</span>${lastWeekPartial ? `<span class="muted">последняя неделя неполная</span>` : ""}</div>`;
}

function moneyBars(r: AuditReport): string {
  if (!r.data.finance.ok) return "";
  const t = r.data.finance.data.totals;
  const rows: [string, number, string][] = [
    ["Продажи (по цене со скидкой)", t.sales, "pos"],
    ["Возвраты", -t.returns, "neg"],
    ["Удержал WB с продаж (комиссия, эквайринг)", -t.wbKeptFromSales, "neg"],
    ["Логистика", -t.logistics, "neg"],
    ["Хранение", -t.storage, "neg"],
    ["Платная приёмка", -t.acceptance, "neg"],
    ["Штрафы", -t.penalties, "neg"],
    ["Прочие удержания", -t.deductions, "neg"],
    ["Доплаты от WB", t.additionalPayments, "pos"],
    ["На руки (оценка)", t.netPayoutEstimate, "total"],
  ];
  const max = Math.max(...rows.map((x) => Math.abs(x[1])), 1);
  return `<div class="money">${rows
    .filter(([, v, k]) => v !== 0 || k === "total")
    .map(([label, v, k]) => `<div class="money-row ${k}"><span class="money-label">${esc(label)}</span><span class="money-bar"><i style="width:${Math.max(1, (Math.abs(v) / max) * 100).toFixed(1)}%"></i></span><span class="money-val">${rub(v)}</span></div>`)
    .join("")}</div>`;
}

function productsTable(products: ProductLine[]): string {
  const T = THRESHOLDS;
  // Класс ячейки одной строкой: два атрибута class браузер не складывает, а берёт первый.
  const cls = (bad: boolean) => (bad ? " bad" : "");
  const rows = products
    .map(
      (p) => `<tr>
<td><b>${esc(p.vendorCode)}</b><div class="muted small">${esc(p.title || p.subject)} · ${p.nmId}</div></td>
<td class="c"><span class="abc ${p.abc}">${p.abc}</span></td>
<td class="r">${rub(p.ordersSum)}<div class="muted small">${fmt(p.orders)} шт</div></td>
<td class="r${cls((p.ordersDelta ?? 0) <= T.salesDropProduct)}">${p.ordersDelta === null ? "—" : `${p.ordersDelta > 0 ? "+" : ""}${fmt(p.ordersDelta)}%`}</td>
<td class="r${cls(p.buyoutPercent !== null && p.orders >= T.minOrdersForBuyout && p.buyoutPercent < T.lowBuyoutPercent)}">${p.buyoutPercent === null ? "—" : `${fmt(p.buyoutPercent)}%`}</td>
<td class="r${cls(p.stock === 0 && p.orders > 0)}">${fmt(p.stock)}</td>
<td class="r${cls(p.daysOfStock !== null && (p.daysOfStock < T.lowStockDays || p.daysOfStock > T.overstockDays))}">${fmt(p.daysOfStock)}</td>
<td class="r">${p.addToCartPercent === null ? "—" : `${fmt(p.addToCartPercent)}%`}</td>
<td class="r">${fmt(p.rating, 1)}</td>
<td class="r${cls(p.negative >= 3)}">${p.feedbacks ? `${p.negative}/${p.feedbacks}` : "—"}</td>
</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="products-table">
<thead><tr><th>Товар</th><th>ABC</th><th>Заказы</th><th>к прошлому</th><th>Выкуп</th><th>Остаток</th><th>Дней запаса</th><th>В корзину</th><th>Рейтинг</th><th>Негатив</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

export function renderHtml(r: AuditReport, insightsMd?: string): string {
  const d = r.data;
  const shop = d.seller.ok ? d.seller.data.tradeMark || d.seller.data.name : "Магазин на Wildberries";
  const periodText = `${ruDate(d.period.from)} — ${ruDate(d.period.to)}`;
  const generated = new Date(d.generatedAt).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });

  const abc = d.abc.ok ? d.abc.data.summary : null;
  const negatives = r.negativeFeedbacks.slice(0, 12);

  const sections: string[] = [];
  if (insightsMd?.trim()) sections.push(`<section class="insights"><h2>Главное</h2>${markdownToHtml(insightsMd)}</section>`);
  sections.push(
    `<section><h2>Что сделать</h2>${
      r.issues.length ? `<div class="issues">${r.issues.map((i, n) => issueCard(i, n + 1)).join("")}</div>` : "<p>Серьёзных проблем не найдено. Хорошая работа.</p>"
    }<p class="note">Пороги — ориентиры из практики продавцов, а не правила WB: в разных категориях нормы разные.</p></section>`,
  );
  if (d.sales.ok) sections.push(`<section><h2>Динамика по неделям</h2>${weeklyChart(d.sales.data.weekly, d.period.to)}</section>`);
  if (abc) {
    sections.push(`<section><h2>ABC-анализ</h2>
<div class="abc-grid">
<div class="abc-card A"><b>A</b><span>${abc.A.products} товаров</span><span>${fmt(abc.A.revenueShare, 1)}% выручки</span><small>основа магазина: остаток и реклама в первую очередь</small></div>
<div class="abc-card B"><b>B</b><span>${abc.B.products} товаров</span><span>${fmt(abc.B.revenueShare, 1)}% выручки</span><small>середина: кандидаты на рост</small></div>
<div class="abc-card C"><b>C</b><span>${abc.C.products} товаров</span><span>${fmt(abc.C.revenueShare, 1)}% выручки</span><small>хвост: проверить, стоит ли держать</small></div>
</div><p class="note">По выручке выкупов за период за вычетом возвратов. Выручка ${rub(abc.totalRevenue)}.</p></section>`);
  }
  if (r.products.length) sections.push(`<section><h2>Товары</h2>${productsTable(r.products)}<p class="note">Дней запаса = остаток на складах WB ÷ средние заказы в день за период. Красным — то, что выходит за ориентиры.</p></section>`);
  if (d.finance.ok) sections.push(`<section><h2>Деньги</h2>${moneyBars(r)}<p class="note">По отчёту о реализации WB за период. Отчёты формируются раз в неделю — последние дни могут ещё не попасть. Себестоимость, налоги и реклама не учтены.</p></section>`);
  if (d.feedbacks.ok) {
    sections.push(`<section><h2>Отзывы</h2>
<p>Без ответа: <b>${d.feedbacks.data.unansweredFeedbacks}</b> отзывов и <b>${d.feedbacks.data.unansweredQuestions}</b> вопросов. За период отзывов: ${d.feedbacks.data.list.length}, из них негативных (${THRESHOLDS.negativeRating}★ и ниже): ${r.negativeFeedbacks.length}.</p>
${negatives.length ? `<div class="reviews">${negatives.map((f) => `<blockquote><div class="stars">${"★".repeat(f.rating)}${"☆".repeat(5 - f.rating)} <b>${esc(f.vendorCode)}</b> <span class="muted">${esc(f.product)}</span></div>${esc(f.text || f.cons || "без текста")}</blockquote>`).join("")}</div>` : ""}
</section>`);
  }
  if (d.ads.ok && d.ads.data.campaigns.length) {
    sections.push(`<section><h2>Реклама</h2><div class="table-wrap"><table><thead><tr><th>Кампания</th><th>ID</th><th class="r">Потрачено</th></tr></thead><tbody>${d.ads.data.campaigns
      .map((c) => `<tr><td>${esc(c.campName)}</td><td>${c.advertId}</td><td class="r">${rub(c.spent)}</td></tr>`)
      .join("")}</tbody><tfoot><tr><td colspan="2">Итого</td><td class="r">${rub(d.ads.data.total)}</td></tr></tfoot></table></div></section>`);
  }
  if (r.unavailable.length) {
    sections.push(`<section class="unavailable"><h2>Чего нет в отчёте</h2><ul>${r.unavailable.map((u) => `<li><b>${esc(u.section)}</b> — ${esc(u.reason)}</li>`).join("")}</ul>
<p class="note">Недостающие категории добавляются при создании нового ключа: кабинет WB → Настройки → Доступ к API. Проверка ключа: <code>npm run check</code>.</p></section>`);
  }

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Аудит WB — ${esc(shop)} — ${periodText}</title>
<style>
${BASE_CSS}
</style></head>
<body><div class="wrap">
<header><div><h1>Аудит кабинета WB${d.demo ? '<span class="badge">ДЕМО</span>' : ""}</h1><div class="sub">${esc(shop)} · ${periodText} (${d.period.days} дн.) · сравнение с ${ruDate(d.previous.from)} — ${ruDate(d.previous.to)}</div></div>
<div class="sub">Сформирован ${esc(generated)}</div></header>
${r.kpis.length ? `<div class="kpis">${r.kpis.map(kpiTile).join("")}</div>` : ""}
${sections.join("\n")}
<footer>${d.demo ? "Демо-отчёт на выдуманных данных. " : ""}Данные — API Wildberries по ключу продавца. Отчёт сделан в wb-kit.</footer>
</div></body></html>`;
}
