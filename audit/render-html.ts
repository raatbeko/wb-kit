/**
 * HTML-отчёт аудита: один самодостаточный файл без внешних ссылок — открывается
 * двойным щелчком, без интернета, пересылается в мессенджере. Светлая и тёмная тема.
 *
 * Порядок — как читает владелец магазина: сначала «зарабатываю ли я и куда уходят
 * деньги», потом что сделать (по срочности, с суммами), потом подробности.
 */
import type { AuditReport, Economics, Issue, Kpi, MonthLine, ProductLine } from "./analyze.js";
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

/**
 * Общие стили отчётов wb-kit: аудит, конкуренты, карточка и офис выглядят одинаково.
 * Тихая бумажная основа, один акцентный синий, красный и зелёный — только когда
 * они значат «плохо» и «хорошо». Цвета графиков проверены на различимость (dataviz).
 */
export const BASE_CSS = `:root{color-scheme:light;--bg:#f6f5f1;--card:#fdfdfb;--text:#1b1b19;--muted:#686660;--faint:#8f8c84;--line:#e3e0d8;--line-strong:#cfcbc1;
--accent:#256abf;--accent2:#86b6ef;--accent-soft:#e8f0fb;--good:#137a13;--bad:#bf2f2f;--warn:#a25a00;--bad-soft:#fbeceb;--warn-soft:#fbf1e1;--good-soft:#e7f4e7;
--chip-high:var(--bad-soft);--chip-med:var(--warn-soft);--chip-low:#eeede8;--seg1:#3b3a36;--seg2:#5f5d57;--seg3:#85827b;--seg4:#a9a69e;--seg5:#c6c3bb;--seg-good:#2a8a2a;--seg-text-dark:#fff;--seg-text-light:#1b1b19}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--bg:#141413;--card:#1c1c1a;--text:#efeee9;--muted:#a9a69d;--faint:#85827a;--line:#2e2d2a;--line-strong:#45433e;
--accent:#6da7ec;--accent2:#1c5cab;--accent-soft:#1a2738;--good:#4cbf4c;--bad:#f07070;--warn:#e9a23b;--bad-soft:#3a1f1f;--warn-soft:#382a14;--good-soft:#173117;
--chip-low:#2a2a27;--seg1:#e3e1da;--seg2:#bdbab2;--seg3:#97948b;--seg4:#726f68;--seg5:#55534d;--seg-good:#3fae3f;--seg-text-dark:#141413;--seg-text-light:#efeee9}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:40px 20px 56px}
header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;align-items:flex-end;padding-bottom:20px;margin-bottom:8px;border-bottom:1px solid var(--line-strong)}
.eyebrow{font-size:13px;color:var(--muted);margin-bottom:4px}
h1{font-size:28px;line-height:1.2;margin:0;font-weight:650;letter-spacing:-.01em}h2{font-size:19px;line-height:1.3;margin:0 0 4px;font-weight:650}
h3{font-size:16px;margin:16px 0 6px;font-weight:650}h4{font-size:16px;margin:0;font-weight:600;line-height:1.35}
.sub{color:var(--muted);font-size:14px}.lead{color:var(--muted);margin:0 0 16px;font-size:14px;max-width:72ch}
.badge{display:inline-block;border:1px solid var(--line-strong);color:var(--muted);border-radius:4px;padding:0 6px;font-size:12px;font-weight:600;letter-spacing:.04em;margin-left:10px;vertical-align:4px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px;margin:16px 0}
section>h2+.lead{margin-top:2px}
a{color:var(--accent)}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin:16px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.kpi-label{color:var(--muted);font-size:13px}.kpi-value{font-size:24px;font-weight:650;margin:2px 0 2px;letter-spacing:-.01em}
.kpi-foot{font-size:12px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;line-height:1.4}.delta{font-weight:600;white-space:nowrap}.delta.up{color:var(--good)}.delta.down{color:var(--bad)}
.kpi.bad .kpi-value{color:var(--bad)}.kpi.good .kpi-value{color:var(--good)}
.insights{background:var(--accent-soft);border-color:transparent}.insights p,.insights li{max-width:75ch}.insights h3:first-of-type{margin-top:8px}
.issues{display:grid;gap:12px;margin:0;padding:0;list-style:none}
.issue{border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.issue-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.num{font-weight:650;color:var(--faint);font-variant-numeric:tabular-nums}
.chip{font-size:12px;border-radius:4px;padding:1px 7px;font-weight:600}.chip.high{background:var(--chip-high);color:var(--bad)}.chip.medium{background:var(--chip-med);color:var(--warn)}.chip.low{background:var(--chip-low);color:var(--muted)}
.action{margin:8px 0 0}.products{margin:8px 0 0;padding-left:18px}.products li{margin:2px 0}
details summary{cursor:pointer;color:var(--accent);margin-top:6px;font-size:14px;width:max-content}
.muted{color:var(--muted)}.small{font-size:12px}.note{color:var(--muted);font-size:13px;margin:14px 0 0;max-width:80ch}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--line)}.chart .base{stroke:var(--line-strong)}.chart .axis{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.bar-orders{fill:var(--accent)}.bar-buyouts{fill:var(--accent2)}.partial{opacity:.4}
.legend{display:flex;gap:6px 18px;font-size:13px;color:var(--muted);flex-wrap:wrap;margin-top:8px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}.sw.orders{background:var(--accent)}.sw.buyouts{background:var(--accent2)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line-strong);padding:6px 8px;white-space:nowrap;background:var(--card)}
td{border-bottom:1px solid var(--line);padding:8px;vertical-align:top}tbody tr:last-child td{border-bottom:0}td.r,th.r{text-align:right;white-space:nowrap}td.c,th.c{text-align:center}td.bad{color:var(--bad);font-weight:600}td.good{color:var(--good)}tfoot td{font-weight:650;border-top:1px solid var(--line-strong);border-bottom:0}
.reviews{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:10px;margin-top:12px}blockquote{margin:0;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:14px}.stars{color:var(--warn);font-size:13px;margin-bottom:4px;letter-spacing:1px}
code{background:var(--chip-low);border-radius:4px;padding:1px 5px;font-size:.92em}
footer{color:var(--faint);font-size:13px;margin-top:28px;padding-top:16px;border-top:1px solid var(--line)}
@media (max-width:640px){.wrap{padding:24px 16px 40px}h1{font-size:23px}section{padding:18px 16px}.kpis{grid-template-columns:1fr 1fr}.kpi{padding:12px}.kpi-value{font-size:19px}}
@media print{body{background:#fff}section{break-inside:avoid;border-color:#ddd}details{display:block}details>summary{display:none}}
`;

/** Стили только аудита: итог периода, куда уходит выручка, задачи, таблицы денег и товаров. */
const AUDIT_CSS = `.months td:first-child{white-space:nowrap;position:sticky;left:0;background:var(--card)}.months td.strong{font-weight:650}.months .neg{color:var(--bad)}.months tr.partial-row td{color:var(--muted)}.months tr.partial-row td.strong{color:inherit}
.hero{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.hero-top{display:flex;flex-wrap:wrap;gap:12px 40px;align-items:flex-end;justify-content:space-between}
.hero-label{font-size:14px;color:var(--muted)}.hero-value{font-size:52px;line-height:1.05;font-weight:650;letter-spacing:-.02em;margin:4px 0 6px}
.hero-value.bad{color:var(--bad)}.hero-text{margin:0;max-width:60ch}
.hero-side{display:grid;grid-template-columns:repeat(3,auto);gap:4px 28px}.hero-side .kpi-label{font-size:12px}.hero-side b{font-size:20px;font-weight:650;white-space:nowrap}.hero-side .bad{color:var(--bad)}
.split-title{font-size:14px;font-weight:600;margin:0 0 8px}
.split{position:relative;display:flex;gap:2px;height:28px}
.seg{position:relative;border-radius:4px;min-width:2px;color:var(--seg-text-dark);font-size:12px;font-weight:600;line-height:28px;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:clip}
.seg.light{color:var(--seg-text-light)}.seg.s1{background:var(--seg1)}.seg.s2{background:var(--seg2)}.seg.s3{background:var(--seg3)}.seg.s4{background:var(--seg4)}.seg.s5{background:var(--seg5)}.seg.profit{background:var(--seg-good);color:#fff}
.split-mark{position:absolute;top:-6px;bottom:-6px;width:0;border-left:2px solid var(--bad)}
.split-mark span{position:absolute;top:-18px;left:-1px;transform:translateX(-50%);font-size:11px;color:var(--bad);font-weight:600;white-space:nowrap}
.split-legend{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:10px;font-size:13px;color:var(--muted)}.split-legend b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.sw.s1{background:var(--seg1)}.sw.s2{background:var(--seg2)}.sw.s3{background:var(--seg3)}.sw.s4{background:var(--seg4)}.sw.s5{background:var(--seg5)}.sw.profit{background:var(--seg-good)}.sw.loss{background:var(--bad)}
.stats{display:flex;flex-wrap:wrap;gap:0;border-top:1px solid var(--line);margin:4px 0 0;padding-top:4px}
.stat{padding:10px 20px 6px 0;margin-right:20px;min-width:120px}.stat-label{font-size:12px;color:var(--muted)}.stat-value{font-size:17px;font-weight:600;white-space:nowrap}.stat-value.bad{color:var(--bad)}.stat-foot{font-size:12px;color:var(--muted)}
.todo-group{margin-top:22px}.todo-group:first-of-type{margin-top:12px}
.todo-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted);margin:0 0 10px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--faint)}.dot.high{background:var(--bad)}.dot.medium{background:var(--warn)}
.todo{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.todo>li{display:grid;grid-template-columns:28px minmax(0,1fr) minmax(120px,auto);gap:4px 14px;padding:14px 0;border-bottom:1px solid var(--line)}
.todo .num{padding-top:1px}.todo p{margin:4px 0 0;max-width:78ch}.todo .detail{color:var(--muted);font-size:14px}
.impact{text-align:right}.impact b{display:block;font-size:17px;font-weight:650;white-space:nowrap;font-variant-numeric:tabular-nums}.impact span{font-size:12px;color:var(--muted)}
.items{margin:8px 0 0;padding:0;list-style:none;font-size:14px}.items li{display:flex;gap:4px 10px;flex-wrap:wrap;padding:3px 0;border-top:1px dashed transparent}
.items .code{font-weight:600}.items .t{color:var(--muted)}.items .n{margin-left:auto;font-variant-numeric:tabular-nums}
.pl td:first-child{width:60%}.pl tr.sum td{font-weight:650;border-top:1px solid var(--line-strong)}.pl tr.sub td{color:var(--muted)}.pl .share{color:var(--muted);width:90px}
.abc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:8px}
.abc-card{border:1px solid var(--line);border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:2px}.abc-card b{font-size:20px}.abc-card small{color:var(--muted)}
.abc{display:inline-block;min-width:22px;text-align:center;border-radius:4px;font-weight:700;font-size:12px;padding:1px 5px}.abc.A{background:var(--accent);color:var(--card)}.abc.B{background:var(--accent-soft);color:var(--accent)}.abc.C,.abc.—{background:var(--chip-low);color:var(--muted)}
.products-table td:first-child,.products-table th:first-child{position:sticky;left:0;background:var(--card);min-width:200px;max-width:260px;box-shadow:1px 0 0 var(--line)}
.products-table .grp{border-left:1px solid var(--line)}
.tip{position:fixed;pointer-events:none;background:var(--text);color:var(--bg);font-size:12px;line-height:1.45;padding:6px 9px;border-radius:6px;max-width:260px;opacity:0;transition:opacity .08s;z-index:5}
.col-hit{fill:transparent}.col-hit:hover{fill:var(--line);opacity:.5}
@media (max-width:640px){.hero-value{font-size:40px}.hero-side{grid-template-columns:repeat(2,auto)}.todo>li{grid-template-columns:24px minmax(0,1fr)}.impact{grid-column:2;text-align:left}.impact b{display:inline;margin-right:6px}}
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
  // Таблица: подряд идущие строки «| a | b |», вторая — разделитель «|---|---|».
  const cells = (l: string) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("|") && /^\|?\s*:?-{2,}/.test(lines[i + 1]?.trim() ?? "")) {
      close();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!.trim()));
      i--;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
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

const kpiValue = (k: Kpi) =>
  k.unit === "₽" ? rub(k.value) : k.unit === "%" ? `${fmt(k.value, 1)}%` : k.unit === "★" ? `${fmt(k.value, 2)} ★` : k.unit === "шт" ? `${fmt(k.value)} шт` : k.unit === "дн" ? `${fmt(k.value)} дн.` : fmt(k.value);

function deltaHtml(k: Kpi): string {
  if (k.delta === undefined || k.delta === null) return "";
  const cls = k.delta > 0 ? "up" : k.delta < 0 ? "down" : "";
  return `<span class="delta ${cls}">${k.delta > 0 ? "+" : k.delta < 0 ? "−" : ""}${fmt(Math.abs(k.delta), 1)}%</span>`;
}

const PRIORITY: Record<Issue["priority"], string> = { high: "Срочно", medium: "Важно", low: "Можно позже" };

/** Строки товаров в задаче: первые пять видны, остальные — под «ещё». */
function itemsHtml(i: Issue): string {
  if (!i.products.length) return "";
  const li = (p: Issue["products"][number]) =>
    `<li><span class="code">${esc(p.vendorCode || p.title)}</span>${p.vendorCode && p.title ? `<span class="t">${esc(p.title)}</span>` : ""}${p.note ? `<span class="n">${esc(p.note)}</span>` : ""}</li>`;
  const shown = i.products.slice(0, 5).map(li).join("");
  const rest = i.products.length > 5 ? `<details><summary>ещё ${i.products.length - 5}</summary><ul class="items">${i.products.slice(5).map(li).join("")}</ul></details>` : "";
  return `<ul class="items">${shown}</ul>${rest}`;
}

function todoSection(issues: Issue[]): string {
  if (!issues.length) return `<section><h2>Что сделать</h2><p>Серьёзных проблем не найдено.</p></section>`;
  let n = 0;
  const groups = (["high", "medium", "low"] as const)
    .map((pr) => {
      const list = issues.filter((i) => i.priority === pr);
      if (!list.length) return "";
      const items = list
        .map((i) => {
          n++;
          return `<li><span class="num">${n}</span><div><h4>${esc(i.title)}</h4><p class="detail">${esc(i.detail)}</p><p class="action"><b>Что сделать:</b> ${esc(i.action)}</p>${itemsHtml(i)}</div>${
            i.impactRub ? `<div class="impact"><b>${rub(i.impactRub)}</b><span>${esc(i.impactLabel ?? "за неделю")}</span></div>` : "<div></div>"
          }</li>`;
        })
        .join("");
      return `<div class="todo-group"><div class="todo-title"><i class="dot ${pr}"></i>${PRIORITY[pr]} · ${list.length}</div><ol class="todo">${items}</ol></div>`;
    })
    .join("");
  return `<section><h2>Что сделать</h2><p class="lead">По срочности. Справа — сколько денег на кону, если сумму можно оценить.</p>${groups}<p class="note">Пороги — ориентиры из практики продавцов, а не правила WB: в разных категориях нормы разные.</p></section>`;
}

/** Куда уходит выручка: один сегментированный столбик, части подписаны в легенде. */
function revenueSplit(r: AuditReport, e: Economics): string {
  if (!r.data.finance.ok) return "";
  const t = r.data.finance.data.totals;
  const other = t.acceptance + t.penalties + t.deductions - t.additionalPayments;
  const parts: { label: string; v: number; cls: string }[] = [
    { label: "Комиссия WB", v: t.wbKeptFromSales, cls: "s1" },
    { label: "Логистика", v: t.logistics, cls: "s2" },
    { label: "Хранение, штрафы, прочее", v: t.storage + other, cls: "s3" },
  ];
  if (e.ads) parts.push({ label: "Реклама", v: e.ads, cls: "s4" });
  if (e.costOfGoods !== null) parts.push({ label: "Себестоимость и налог", v: e.costOfGoods + (e.tax ?? 0), cls: "s5" });
  const rest = e.profit ?? e.afterWbAndAds;
  const restLabel = e.profit !== null ? "Прибыль" : "Остаётся вам до себестоимости";
  const positive = parts.filter((p) => p.v > 0);
  const spent = positive.reduce((s, p) => s + p.v, 0);
  // В минусе расходы больше выручки: шкала — по расходам, красная метка показывает, где кончилась выручка.
  const total = rest >= 0 ? e.revenue : spent;
  const w = (v: number) => `${((v / total) * 100).toFixed(2)}%`;
  const share = (v: number) => `${fmt((v / e.revenue) * 100, 0)}%`;
  const blocks = [...positive.map((p) => ({ ...p })), ...(rest > 0 ? [{ label: restLabel, v: rest, cls: "profit" }] : [])]
    .map((p) => {
      const pctW = (p.v / total) * 100;
      const light = p.cls === "s4" || p.cls === "s5";
      return `<div class="seg ${p.cls}${light ? " light" : ""}" style="flex:0 0 calc(${w(p.v)} - 2px)" title="${esc(p.label)}: ${rub(p.v)}, ${share(p.v)} выручки">${pctW >= 7 ? share(p.v) : ""}</div>`;
    })
    .join("");
  const mark = rest < 0 ? `<div class="split-mark" style="left:${w(e.revenue)}"><span>выручка</span></div>` : "";
  const legend = [
    ...positive.map((p) => `<span><i class="sw ${p.cls}"></i>${esc(p.label)} <b>${rub(p.v)}</b></span>`),
    `<span><i class="sw ${rest >= 0 ? "profit" : "loss"}"></i>${rest >= 0 ? esc(restLabel) : "Убыток"} <b>${rest < 0 ? "−" : ""}${rub(Math.abs(rest))}</b></span>`,
  ].join("");
  return `<div><p class="split-title">Куда уходит выручка ${rub(e.revenue)}</p><div class="split" role="img" aria-label="Куда уходит выручка">${blocks}${mark}</div><div class="split-legend">${legend}</div></div>`;
}

function heroSection(r: AuditReport): string {
  const e = r.economics;
  const d = r.data;
  // ДРР уже стоит в итоге рядом с безубыточным — второй раз не повторяем.
  const tier2 = r.kpis.filter((k) => k.tier === 2 && !(r.economics && k.key === "drr"));
  const stats = tier2.length
    ? `<div class="stats">${tier2.map((k) => `<div class="stat"><div class="stat-label">${esc(k.label)}</div><div class="stat-value${k.tone === "bad" ? " bad" : ""}">${kpiValue(k)} ${deltaHtml(k)}</div>${k.hint ? `<div class="stat-foot">${esc(k.hint)}</div>` : ""}</div>`).join("")}</div>`
    : "";
  if (!e) {
    // Без финотчёта главной цифры нет — показываем операционные показатели.
    return `<section class="hero"><div><h2>Итог периода</h2><p class="lead">Денег по финотчёту в отчёте нет (${esc(r.unavailable.find((u) => u.section === "Деньги")?.reason ?? "нет данных")}), поэтому прибыль и удержания WB не посчитаны.</p></div>${stats}</section>`;
  }
  const main = e.profit ?? e.afterWbAndAds;
  const label = e.profit !== null ? `Прибыль за ${d.period.days} дней` : "После WB и рекламы";
  const sentence =
    e.profit !== null
      ? `${e.profit >= 0 ? "Магазин заработал" : "Магазин потерял"} ${rub(Math.abs(e.profit))} после удержаний WB, рекламы, себестоимости и налога — ${fmt(Math.abs(e.margin ?? 0), 1)}% выручки.${
          e.costCoverage < 100 ? ` Себестоимость вписана для ${e.costCoverage}% выручки, по остальным товарам прибыль не учтена.` : ""
        }`
      : "Себестоимость товаров не вписана, поэтому это ещё не прибыль: из этой суммы нужно заплатить за товар и налог. Впишите себестоимость в data/cost.csv — и здесь будет прибыль.";
  const side: string[] = [];
  side.push(`<div><div class="kpi-label">WB и реклама забирают</div><b>${fmt(e.takeRate, 0)} коп.</b><div class="kpi-label">с рубля выручки</div></div>`);
  if (e.drrBuyouts !== null && e.breakEvenDrr !== null) {
    side.push(`<div><div class="kpi-label">ДРР от выкупов</div><b class="${e.drrBuyouts > e.breakEvenDrr ? "bad" : ""}">${fmt(e.drrBuyouts, 1)}%</b><div class="kpi-label">безубыточный ${e.breakEvenIsUpperBound ? "≤ " : ""}${fmt(e.breakEvenDrr, 1)}%</div></div>`);
  }
  if (e.stockValue !== null) {
    side.push(`<div><div class="kpi-label">Деньги в товаре на WB</div><b>${rub(e.stockValue)}</b><div class="kpi-label">${e.turnoverDays !== null ? `распродастся за ≈ ${fmt(e.turnoverDays)} дн.` : e.stockValueAtCost ? "по себестоимости" : "частью по цене продажи"}</div></div>`);
  }
  return `<section class="hero">
<div class="hero-top"><div><div class="hero-label">${esc(label)}</div><div class="hero-value${main < 0 ? " bad" : ""}">${main < 0 ? "−" : ""}${rub(Math.abs(main))}</div><p class="hero-text">${esc(sentence)}</p></div>
<div class="hero-side">${side.join("")}</div></div>
${revenueSplit(r, e)}
${stats}
</section>`;
}

/** Столбик со скруглённым верхом и плоским низом: данные растут от оси. */
const barPath = (x: number, y: number, w: number, base: number) => {
  const h = base - y;
  if (h <= 0) return "";
  const rr = Math.min(3, h, w / 2);
  return `M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${base}Z`;
};

function weeklyChart(weeks: WeekPoint[], periodTo: string): string {
  if (!weeks.length) return "";
  const W = 720, H = 230, padL = 52, padR = 8, padB = 26, padT = 14;
  const base = H - padB;
  const rawMax = Math.max(...weeks.map((w) => w.ordersSum), 1);
  // Круглые деления оси: 1, 2, 2.5, 5 × 10^k.
  const mag = 10 ** Math.floor(Math.log10(rawMax / 4));
  const stepV = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => rawMax / s <= 4) ?? mag * 10;
  const max = Math.ceil(rawMax / stepV) * stepV;
  const step = (W - padL - padR) / weeks.length;
  const bw = Math.min(22, Math.max(5, step * 0.32));
  const y = (v: number) => padT + (base - padT) * (1 - v / max);
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += stepV) ticks.push(v);
  const short = (v: number) => (v >= 1e6 ? `${fmt(v / 1e6, 1)} млн` : v >= 1000 ? `${fmt(v / 1000)} тыс` : fmt(v));
  const lastWeekPartial = (() => {
    const last = weeks[weeks.length - 1]!.weekStart;
    const end = new Date(Date.parse(`${last}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    return end > periodTo;
  })();
  const cols = weeks
    .map((w, i) => {
      const cx = padL + i * step + step / 2;
      const partial = lastWeekPartial && i === weeks.length - 1;
      const tip = `Неделя с ${ruDate(w.weekStart)}${partial ? " (ещё идёт)" : ""}|Заказы: ${rub(w.ordersSum)}, ${fmt(w.orders)} шт|Выкупы: ${rub(w.buyoutsSum)}, ${fmt(w.buyouts)} шт`;
      const label = i % Math.ceil(weeks.length / 8) === 0 || i === weeks.length - 1 ? `<text x="${cx}" y="${H - 8}" class="axis" text-anchor="middle">${ruDate(w.weekStart).slice(0, 5)}</text>` : "";
      return `<g><path d="${barPath(cx - bw - 1, y(w.ordersSum), bw, base)}" class="bar-orders${partial ? " partial" : ""}"/><path d="${barPath(cx + 1, y(w.buyoutsSum), bw, base)}" class="bar-buyouts${partial ? " partial" : ""}"/>${label}<rect class="col-hit" x="${padL + i * step}" y="${padT}" width="${step}" height="${base - padT}" data-tip="${esc(tip)}"><title>${esc(tip.replace(/\|/g, "\n"))}</title></rect></g>`;
    })
    .join("");
  const grid = ticks
    .map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? "base" : "grid"}"/><text x="${padL - 8}" y="${y(t) + 4}" class="axis" text-anchor="end">${short(t)}</text>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Заказы и выкупы по неделям, рубли">${grid}${cols}</svg>
<div class="legend"><span><i class="sw orders"></i>Заказы, ₽</span><span><i class="sw buyouts"></i>Выкупы, ₽</span>${lastWeekPartial ? `<span>последняя неделя ещё идёт — она бледнее</span>` : ""}</div>`;
}

/** Деньги как отчёт о прибылях: строка, сумма, доля выручки. */
function moneyTable(r: AuditReport): string {
  if (!r.data.finance.ok) return "";
  const t = r.data.finance.data.totals;
  const e = r.economics;
  const revenue = t.sales - t.returns;
  const rows: [string, number, "row" | "sum" | "sub"][] = [
    ["Продажи по цене со скидкой", t.sales, "sub"],
    ["Возвраты", -t.returns, "sub"],
    ["Выручка", revenue, "sum"],
    ["Комиссия и эквайринг WB", -t.wbKeptFromSales, "row"],
    ["Логистика", -t.logistics, "row"],
    ["Хранение", -t.storage, "row"],
    ["Платная приёмка", -t.acceptance, "row"],
    ["Штрафы", -t.penalties, "row"],
    ["Прочие удержания", -t.deductions, "row"],
    ["Доплаты от WB", t.additionalPayments, "row"],
    ["На руки по финотчёту", t.netPayoutEstimate, "sum"],
  ];
  if (e?.ads) rows.push(["Реклама", -e.ads, "row"]);
  if (e?.costOfGoods != null) rows.push(["Себестоимость проданного", -e.costOfGoods, "row"], ["Налог", -(e.tax ?? 0), "row"]);
  if (e) rows.push([e.profit !== null ? "Прибыль" : "После WB и рекламы", e.profit ?? e.afterWbAndAds, "sum"]);
  const body = rows
    .filter(([, v, k]) => v !== 0 || k === "sum")
    .map(([label, v, k]) => `<tr class="${k}"><td>${esc(label)}</td><td class="r${k === "sum" && v < 0 ? " bad" : ""}">${v < 0 ? "−" : ""}${rub(Math.abs(v))}</td><td class="r share">${revenue > 0 && k !== "sub" ? `${fmt((Math.abs(v) / revenue) * 100, 1)}%` : ""}</td></tr>`)
    .join("");
  return `<div class="table-wrap"><table class="pl"><thead><tr><th>Статья</th><th class="r">Сумма</th><th class="r">Доля выручки</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Деньги по календарным месяцам: строка — месяц. «В день» честно сравнивает неполный месяц с полными. */
function monthsTable(months: MonthLine[]): string {
  const ok = months.filter((m) => !m.unavailable);
  if (!ok.length) return "";
  const withProfit = ok.some((m) => m.profit !== null);
  const days = (m: MonthLine) => Math.round((Date.parse(m.to) - Date.parse(m.from)) / 86_400_000) + 1;
  const money = (v: number | null, bad = false) => (v === null ? "—" : `<span${bad && v < 0 ? ' class="neg"' : ""}>${v < 0 ? "−" : ""}${rub(Math.abs(v))}</span>`);
  const head = `<tr><th>Месяц</th><th class="r">Выручка</th><th class="r">На руки</th><th class="r">Реклама</th>${
    withProfit ? `<th class="r">Себестоимость и налог</th><th class="r">Прибыль</th><th class="r">Маржа</th><th class="r">Прибыль в день</th>` : `<th class="r">После WB и рекламы</th><th class="r">В день</th>`
  }</tr>`;
  const body = months
    .map((m) => {
      const name = `${esc(m.label)}${m.partial ? `<div class="small">идёт, по ${ruDate(m.to).slice(0, 5)}</div>` : ""}`;
      if (m.unavailable) return `<tr><td>${name}</td><td colspan="${withProfit ? 7 : 5}" class="muted">нет данных: ${esc(m.unavailable)}</td></tr>`;
      const result = m.profit ?? m.afterWbAndAds;
      const perDay = Math.round(result / days(m));
      const cells = withProfit
        ? `<td class="r">${m.costOfGoods === null ? "—" : `−${rub((m.costOfGoods ?? 0) + (m.tax ?? 0))}`}</td><td class="r strong">${money(m.profit, true)}</td><td class="r">${m.margin === null ? "—" : `${m.margin < 0 ? "−" : ""}${fmt(Math.abs(m.margin), 1)}%`}</td><td class="r">${money(perDay, true)}</td>`
        : `<td class="r strong">${money(m.afterWbAndAds, true)}</td><td class="r">${money(perDay, true)}</td>`;
      return `<tr${m.partial ? ' class="partial-row"' : ""}><td>${name}</td><td class="r">${rub(m.revenue)}</td><td class="r">${money(m.payout, true)}</td><td class="r">${m.ads === null ? "—" : m.ads ? `−${rub(m.ads)}` : "0 ₽"}</td>${cells}</tr>`;
    })
    .join("");
  const lowCoverage = withProfit && ok.some((m) => m.revenue > 0 && m.costCoverage < 100);
  return `<div class="table-wrap"><table class="months"><thead>${head}</thead><tbody>${body}</tbody></table></div>
<p class="note">${monthsNote(months)}${lowCoverage ? " У части товаров себестоимость не вписана — в таких месяцах прибыль завышена." : ""}</p>`;
}

function monthsNote(months: MonthLine[]): string {
  const partial = months.find((m) => m.partial);
  return `${partial ? `${partial.label} ещё идёт: в нём данные по вчерашний день, а финотчёт WB за последнюю неделю может ещё не прийти — сравнивайте месяцы по колонке «в день». ` : ""}Нужны другие месяцы — попросите Claude, например: «покажи деньги по месяцам за полгода».`;
}

function productsTable(products: ProductLine[], withProfit: boolean): string {
  const T = THRESHOLDS;
  // Класс ячейки одной строкой: два атрибута class браузер не складывает, а берёт первый.
  const cls = (bad: boolean) => (bad ? " bad" : "");
  const signed = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v))}%`);
  const rows = products
    .map(
      (p) => `<tr>
<td><b>${esc(p.vendorCode || p.nmId)}</b><div class="muted small">${esc(p.title || p.subject)} · ${p.nmId}</div></td>
<td class="c"><span class="abc ${p.abc}">${p.abc}</span></td>
<td class="r">${rub(p.ordersSum)}<div class="muted small">${fmt(p.orders)} шт</div></td>
<td class="r${cls((p.ordersDelta ?? 0) <= T.salesDropProduct)}">${signed(p.ordersDelta)}</td>
<td class="r${cls(p.buyoutPercent !== null && p.orders >= T.minOrdersForBuyout && p.buyoutPercent < T.lowBuyoutPercent)}">${p.buyoutPercent === null ? "—" : `${fmt(p.buyoutPercent)}%`}</td>
${
  withProfit
    ? `<td class="r grp${cls((p.profitPerUnit ?? 0) < 0)}">${p.profitPerUnit === null ? "—" : `${p.profitPerUnit < 0 ? "−" : ""}${rub(Math.abs(p.profitPerUnit))}`}</td>
<td class="r${cls(p.margin !== null && p.margin < T.lowMarginPercent)}">${p.margin === null ? "—" : `${fmt(p.margin, 0)}%`}</td>
<td class="r">${p.minPrice === null ? "—" : rub(p.minPrice)}<div class="muted small">${p.avgPrice === null ? "" : `сейчас ${rub(p.avgPrice)}`}</div></td>`
    : ""
}
<td class="r grp${cls(p.stock === 0 && p.orders > 0)}">${fmt(p.stock)}</td>
<td class="r${cls(p.daysOfStock !== null && (p.daysOfStock < T.lowStockDays || p.daysOfStock > T.overstockDays))}">${fmt(p.daysOfStock)}</td>
<td class="r grp">${p.addToCartPercent === null ? "—" : `${fmt(p.addToCartPercent)}%`}</td>
<td class="r">${fmt(p.rating, 1)}</td>
<td class="r${cls(p.negative >= 3)}">${p.feedbacks ? `${p.negative} из ${p.feedbacks}` : "—"}</td>
</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="products-table">
<thead><tr><th>Товар</th><th class="c">ABC</th><th class="r">Заказы</th><th class="r">К прошлому</th><th class="r">Выкуп</th>${
    withProfit ? `<th class="r grp">Прибыль/шт</th><th class="r">Маржа</th><th class="r">Мин. цена</th>` : ""
  }<th class="r grp">Остаток</th><th class="r">Дней запаса</th><th class="r grp">В корзину</th><th class="r">Рейтинг</th><th class="r">Негатив</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

/** Подсказка у графика: без библиотек, работает и без неё — у столбцов есть <title>. */
const TOOLTIP_JS = `(function(){var t=document.createElement("div");t.className="tip";document.body.appendChild(t);
document.addEventListener("mousemove",function(e){var el=e.target.closest&&e.target.closest("[data-tip]");if(!el){t.style.opacity=0;return}
t.innerHTML="";el.getAttribute("data-tip").split("|").forEach(function(s,i){var d=document.createElement("div");d.textContent=s;if(!i)d.style.fontWeight=600;t.appendChild(d)});
var x=e.clientX+14,y=e.clientY+14;if(x+270>innerWidth)x=e.clientX-270;t.style.left=x+"px";t.style.top=y+"px";t.style.opacity=1});
document.querySelectorAll("[data-tip] title").forEach(function(n){n.remove()});})();`;

export function renderHtml(r: AuditReport, insightsMd?: string): string {
  const d = r.data;
  const shop = d.seller.ok ? d.seller.data.tradeMark || d.seller.data.name : "Магазин на Wildberries";
  const periodText = `${ruDate(d.period.from)} — ${ruDate(d.period.to)}`;
  const generated = new Date(d.generatedAt).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
  const withProfit = r.products.some((p) => p.profitPerUnit !== null);

  const abc = d.abc.ok ? d.abc.data.summary : null;
  const negatives = r.negativeFeedbacks.slice(0, 12);

  const sections: string[] = [];
  sections.push(heroSection(r));
  if (insightsMd?.trim()) sections.push(`<section class="insights"><h2>Главное</h2>${markdownToHtml(insightsMd)}</section>`);
  sections.push(todoSection(r.issues));
  if (d.sales.ok) sections.push(`<section><h2>Заказы и выкупы по неделям</h2><p class="lead">Наведите на неделю, чтобы увидеть суммы.</p>${weeklyChart(d.sales.data.weekly, d.period.to)}</section>`);
  if (d.finance.ok) {
    sections.push(`<section><h2>Деньги</h2><p class="lead">По отчёту о реализации WB за период. Отчёт формируется раз в неделю — последние дни могут ещё не попасть.</p>${moneyTable(r)}${
      r.economics && r.economics.costOfGoods === null ? `<p class="note">Себестоимость не вписана, поэтому прибыли здесь нет. Файл для неё создаёт команда <code>npm run cost -- --init</code> — или попросите Claude.</p>` : ""
    }</section>`);
  }
  if (r.months.some((m) => !m.unavailable)) {
    sections.push(`<section><h2>По месяцам</h2><p class="lead">Сколько магазин заработал в каждом календарном месяце — тот же расчёт, что в «Деньгах».</p>${monthsTable(r.months)}</section>`);
  }
  if (r.products.length) {
    sections.push(`<section><h2>Товары</h2><p class="lead">Сначала то, что приносит больше заказов. Красным — то, что выходит за ориентиры.</p>${productsTable(r.products, withProfit)}<p class="note">Дней запаса — остаток на складах WB, делённый на средние заказы в день. ${
      withProfit ? "Прибыль на штуку — до рекламы. Минимальная цена — ниже неё товар в минусе с учётом удержаний WB, налога и рекламы магазина: ориентир для акций и скидок." : ""
    }</p></section>`);
  }
  if (abc) {
    sections.push(`<section><h2>ABC-анализ</h2><p class="lead">По выручке выкупов за период за вычетом возвратов, всего ${rub(abc.totalRevenue)}. Группа A приносит больше всего денег, но не обязательно прибыли — смотрите маржу в таблице товаров.</p>
<div class="abc-grid">
<div class="abc-card"><span><span class="abc A">A</span></span><b>${fmt(abc.A.revenueShare, 0)}% выручки</b><span>${abc.A.products} товаров</span><small>основа магазина: остаток и реклама в первую очередь</small></div>
<div class="abc-card"><span><span class="abc B">B</span></span><b>${fmt(abc.B.revenueShare, 0)}% выручки</b><span>${abc.B.products} товаров</span><small>середина: кандидаты на рост</small></div>
<div class="abc-card"><span><span class="abc C">C</span></span><b>${fmt(abc.C.revenueShare, 0)}% выручки</b><span>${abc.C.products} товаров</span><small>хвост: проверить, стоит ли держать</small></div>
</div></section>`);
  }
  if (d.feedbacks.ok) {
    sections.push(`<section><h2>Отзывы</h2>
<p class="lead">Без ответа: <b>${d.feedbacks.data.unansweredFeedbacks}</b> отзывов и <b>${d.feedbacks.data.unansweredQuestions}</b> вопросов. За период отзывов ${d.feedbacks.data.list.length}, из них негативных (${THRESHOLDS.negativeRating}★ и ниже) — ${r.negativeFeedbacks.length}.</p>
${negatives.length ? `<div class="reviews">${negatives.map((f) => `<blockquote><div class="stars">${"★".repeat(f.rating)}${"☆".repeat(5 - f.rating)}</div><div><b>${esc(f.vendorCode)}</b> <span class="muted">${esc(f.product)}</span></div>${esc(f.text || f.cons || "без текста")}</blockquote>`).join("")}</div>` : ""}
</section>`);
  }
  if (d.ads.ok && d.ads.data.campaigns.length) {
    sections.push(`<section><h2>Реклама</h2><div class="table-wrap"><table><thead><tr><th>Кампания</th><th>ID</th><th class="r">Потрачено</th><th class="r">Доля</th></tr></thead><tbody>${d.ads.data.campaigns
      .map((c) => `<tr><td>${esc(c.campName)}</td><td class="muted">${c.advertId}</td><td class="r">${rub(c.spent)}</td><td class="r muted">${d.ads.ok && d.ads.data.total ? `${fmt((c.spent / d.ads.data.total) * 100, 0)}%` : ""}</td></tr>`)
      .join("")}</tbody><tfoot><tr><td colspan="2">Итого</td><td class="r">${rub(d.ads.data.total)}</td><td></td></tr></tfoot></table></div></section>`);
  }
  if (r.unavailable.length) {
    sections.push(`<section class="unavailable"><h2>Чего нет в отчёте</h2><ul>${r.unavailable.map((u) => `<li><b>${esc(u.section)}</b> — ${esc(u.reason)}</li>`).join("")}</ul>
<p class="note">Недостающие категории добавляются при создании нового ключа: кабинет WB → Настройки → Доступ к API. Проверка ключа: <code>npm run check</code>.</p></section>`);
  }

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Аудит WB — ${esc(shop)} — ${periodText}</title>
<style>
${BASE_CSS}${AUDIT_CSS}
</style></head>
<body><div class="wrap">
<header><div><div class="eyebrow">Аудит кабинета Wildberries${d.demo ? '<span class="badge">ДЕМО</span>' : ""}</div><h1>${esc(shop)}</h1></div>
<div class="sub">${periodText} (${d.period.days} дн.) · сравнение с ${ruDate(d.previous.from)} — ${ruDate(d.previous.to)}<br>Сформирован ${esc(generated)}</div></header>
${sections.join("\n")}
<footer>${d.demo ? "Демо-отчёт на выдуманных данных. " : ""}Данные — API Wildberries по ключу продавца${d.costs ? ", себестоимость — data/cost.csv" : ""}. Отчёт сделан в wb-kit.</footer>
</div><script>${TOOLTIP_JS}</script></body></html>`;
}
