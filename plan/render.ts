/**
 * План закупки: HTML-отчёт (с фото товаров) и Excel, который можно править.
 */
import ExcelJS from "exceljs";
import { BASE_CSS, esc } from "../audit/render-html.js";
import { photoUrl } from "../competitors/cdn.js";
import { monthName, type PlanReport, type PlanRow } from "./plan.js";

const nf = (v: number) => Math.round(v).toLocaleString("ru-RU");
const rub = (v: number) => `${nf(v)} ₽`;
const ruD = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

const CSS = `.wrap{max-width:1180px}
.ph{width:44px;height:58px;border-radius:6px;object-fit:cover;background:var(--chip-low);display:block}
.ph.none{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--faint)}
.prod{display:flex;gap:10px;align-items:flex-start;min-width:240px}.prod b{display:block}.prod small{color:var(--muted);display:block;max-width:34ch;line-height:1.35}
.tag{display:inline-block;font-size:11px;font-weight:600;border-radius:4px;padding:0 6px;margin:3px 4px 0 0}.tag.loco{background:var(--accent-soft);color:var(--accent)}.tag.season{background:var(--chip-low);color:var(--muted)}.tag.urgent{background:var(--bad-soft);color:var(--bad)}
td.ship{font-weight:600}td.zero{color:var(--faint)}td.total{font-weight:700}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr));gap:10px;margin-top:12px}
.card{border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;gap:12px}.card .ph{width:64px;height:84px}.card b{display:block}.card .big{font-size:20px;font-weight:700;color:var(--bad)}.card small{color:var(--muted)}
.season{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:14px;margin-top:12px}.season svg{width:100%;height:auto}.season .b{fill:var(--accent2)}.season .b.cur{fill:var(--accent)}.season text{fill:var(--muted);font-size:9px}
`;

function photo(r: Pick<PlanRow, "nmId" | "vendorCode">, baskets: Record<string, number> | undefined, cls = "ph"): string {
  const b = baskets?.[String(r.nmId)];
  return b
    ? `<img class="${cls}" loading="lazy" alt="" src="${photoUrl(r.nmId, b)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cls} none',textContent:'фото'}))">`
    : `<div class="${cls} none">${esc(r.vendorCode.slice(0, 4))}</div>`;
}

function seasonChart(idx: Record<number, number>, cur: number): string {
  const max = Math.max(...Object.values(idx), 1);
  const w = 240, h = 70, bw = w / 12;
  const bars = Array.from({ length: 12 }, (_, i) => {
    const v = idx[i + 1]!;
    const bh = Math.max(2, (v / max) * (h - 16));
    return `<rect class="b${i + 1 === cur ? " cur" : ""}" x="${(i * bw + 2).toFixed(1)}" y="${(h - 12 - bh).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${cap(["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"][i]!)}: ×${v.toFixed(2)}</title></rect><text x="${(i * bw + bw / 2).toFixed(1)}" y="${h - 2}" text-anchor="middle">${"ЯФМАМИИАСОНД"[i]}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Сезонность по месяцам">${bars}</svg>`;
}

export function renderPlanHtml(r: PlanReport, insightsMd?: string): string {
  const d = r.data;
  const b = d.baskets;
  const t = r.totals;
  const months = r.monthsList;
  const period = months.length === 1 ? monthName(months[0]!) : `${monthName(months[0]!)} — ${monthName(months[months.length - 1]!)}`;
  const need = r.rows.filter((x) => x.toOrder > 0);
  const urgent = r.rows.filter((x) => x.urgent);
  const over = r.rows.filter((x) => x.overstock);

  const kpis = [
    ["Заказать всего", `${nf(t.toOrder)} шт`, `${need.length} ${plural(need.length, "товар", "товара", "товаров")}, с запасом ${Math.round(r.params.safety * 100)}%`, ""],
    ["Денег на закупку", t.money !== null ? rub(t.money) : "—", t.money === null ? "нет себестоимости в data/cost.csv" : t.costCoverage < 100 ? `себестоимость есть для ${t.costCoverage}% товаров` : "по себестоимости из data/cost.csv", ""],
    ["Заказать срочно", String(t.urgent), t.urgent ? "иначе не успеют приехать до конца остатка" : "успеваем по всем", t.urgent ? "bad" : "good"],
    ["Сезонность", Object.keys(r.season).length ? `${Object.keys(r.season).length} ${plural(Object.keys(r.season).length, "предмет", "предмета", "предметов")}` : "не учтена", Object.keys(r.season).length ? "по заказам за год" : "истории меньше года", ""],
  ].map(([l, v, f, c]) => `<div class="kpi ${c}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-foot">${esc(f!)}</div></div>`).join("");

  const urgentHtml = urgent.length
    ? `<section><h2>Заказать сегодня</h2><p class="lead">Остатка хватит меньше, чем на срок поставки (${r.params.leadDays} дн.) — если заказать позже, товар закончится и карточка просядет в поиске.</p><div class="cards">${urgent
        .map((x) => `<div class="card">${photo(x, b)}<div><b>${esc(x.vendorCode)}</b><small>${esc(x.title)}</small><div class="big">${nf(x.toOrder)} шт</div><small>${x.daysLeft === 0 ? "уже закончился" : `остатка на ${x.daysLeft} дн.`}</small></div></div>`)
        .join("")}</div></section>`
    : "";

  const head = `<tr><th>Товар</th><th class="r">Остаток</th><th class="r">Уходит в день</th><th class="r">Хватит</th><th class="r">Заказать до</th>${months.map((m) => `<th class="r">${cap(monthName(m))}</th>`).join("")}<th class="r">Итого с запасом</th><th class="r">Сумма</th></tr>`;
  const body = r.rows
    .filter((x) => x.toOrder > 0 || x.overstock)
    .map((x) => {
      const tags = [x.urgent ? `<span class="tag urgent">срочно</span>` : "", x.locomotive ? `<span class="tag loco">локомотив</span>` : "", x.seasonal ? `<span class="tag season">сезон</span>` : ""].join("");
      return `<tr><td><div class="prod">${photo(x, b)}<div><b>${esc(x.vendorCode)}</b><small>${esc(x.title)}</small>${tags}</div></div></td>
<td class="r">${nf(x.stock)}${x.stockOwn ? `<br><small class="muted">WB ${nf(x.stockWb)} · свой ${nf(x.stockOwn)}</small>` : ""}</td>
<td class="r">${x.perDay}<br><small class="muted">выкуп ${Math.round(x.buyout * 100)}%</small></td>
<td class="r${x.daysLeft !== null && x.daysLeft <= r.params.leadDays ? " bad" : ""}">${x.daysLeft === null ? "—" : `${x.daysLeft} дн.`}</td>
<td class="r${x.urgent ? " bad" : ""}">${x.orderBy === null || x.toOrder === 0 ? "—" : x.urgent ? "сегодня" : ruD(x.orderBy)}</td>
${x.months.map((m) => `<td class="r ${m.ship ? "ship" : "zero"}" title="уйдёт за месяц: ${nf(m.need)} шт">${m.ship ? nf(m.ship) : "—"}</td>`).join("")}
<td class="r total">${x.toOrder ? nf(x.toOrder) : x.overstock ? `<span class="muted">лишнее</span>` : "—"}</td><td class="r">${x.money !== null && x.toOrder ? rub(x.money) : "—"}</td></tr>`;
    })
    .join("");
  const foot = `<tr><td>Итого</td><td></td><td></td><td></td><td></td>${months.map((m) => `<td class="r">${nf(need.reduce((a, x) => a + (x.months.find((y) => y.month === m)?.ship ?? 0), 0))}</td>`).join("")}<td class="r">${nf(t.toOrder)}</td><td class="r">${t.money !== null ? rub(t.money) : "—"}</td></tr>`;

  const seasonHtml = Object.keys(r.season).length
    ? `<section><h2>Сезонность</h2><p class="lead">Заказы в день по месяцам к среднему за год, по всем товарам предмета. Тёмный столбец — текущий месяц.</p><div class="season">${Object.entries(r.season)
        .map(([s, idx]) => `<div><b>${esc(s)}</b>${seasonChart(idx, Number(d.today.slice(5, 7)))}</div>`)
        .join("")}</div></section>`
    : "";
  const overHtml = over.length
    ? `<section><h2>Лишний остаток</h2><p class="lead">Этого товара хватит дольше, чем на весь план. Новую партию не заказывать; если он лежит долго — акция или вывоз со склада, чтобы не платить за хранение.</p><ul class="products">${over.map((x) => `<li><b>${esc(x.vendorCode)}</b> — ${nf(x.stock)} шт, хватит на ${x.daysLeft ?? "∞"} дн.</li>`).join("")}</ul></section>`
    : "";

  const insights = insightsMd ? `<section class="insights"><h2>Выводы</h2>${insightsMd}</section>` : "";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>План закупки${d.demo ? " ДЕМО" : ""}</title><style>${BASE_CSS}${CSS}</style></head><body><div class="wrap">
<header><div><div class="eyebrow">План закупки${d.demo ? '<span class="badge">ДЕМО</span>' : ""}</div><h1>Что и сколько завезти: ${period}</h1></div><div class="sub">данные по ${ruD(d.today)} · срок поставки ${r.params.leadDays} дн.</div></header>
<div class="kpis">${kpis}</div>
${r.notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
${r.unavailable.map((u) => `<p class="note">Нет в плане: ${esc(u.section)} — ${esc(u.reason)}.</p>`).join("")}
${insights}
${urgentHtml}
<section><h2>По товарам и месяцам</h2><p class="lead">В колонках месяцев — сколько штук должно приехать на склад к этому месяцу, остаток уже вычтен. «Заказать до» — последний день, чтобы партия успела за ${r.params.leadDays} дн. «Локомотив» — товар, на котором держится предмет: его заказывают первым и с запасом.</p>
<div class="table-wrap"><table><thead>${head}</thead><tbody>${body || `<tr><td colspan="${8 + months.length}" class="muted">Закупать ничего не нужно — остатков хватает на весь план.</td></tr>`}</tbody><tfoot>${foot}</tfoot></table></div></section>
${seasonHtml}
${overHtml}
<footer>Как считали: расход со склада = заказы в день за 4 недели × доля выкупа (невыкупленное возвращается на склад) × сезонный коэффициент месяца. Остаток — на складах WB и ваш (FBS). Прогноз — оценка: проверьте его глазами перед заказом. wb-kit</footer>
</div></body></html>`;
}

export async function renderPlanXlsx(r: PlanReport, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "wb-kit";
  const ws = wb.addWorksheet("План закупки", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
  const months = r.monthsList;
  ws.columns = [
    { header: "Артикул", key: "vc", width: 18 },
    { header: "Товар", key: "title", width: 36 },
    { header: "Предмет", key: "subject", width: 16 },
    { header: "Остаток WB", key: "wb", width: 11 },
    { header: "Свой склад", key: "own", width: 11 },
    { header: "Уходит в день", key: "pd", width: 12 },
    { header: "Выкуп", key: "bo", width: 8, style: { numFmt: "0%" } },
    { header: "Хватит, дн.", key: "dl", width: 11 },
    { header: "Заказать до", key: "ob", width: 12 },
    ...months.map((m) => ({ header: cap(monthName(m)), key: m, width: 11, style: { numFmt: "#,##0" } })),
    { header: "Итого с запасом", key: "total", width: 14, style: { numFmt: "#,##0" } },
    { header: "Себестоимость", key: "cost", width: 13, style: { numFmt: '#,##0" ₽"' } },
    { header: "Сумма", key: "money", width: 14, style: { numFmt: '#,##0" ₽"' } },
    { header: "Пометки", key: "tags", width: 22 },
  ];
  for (const x of r.rows) {
    ws.addRow({
      vc: x.vendorCode, title: x.title, subject: x.subject, wb: x.stockWb, own: x.stockOwn, pd: x.perDay, bo: x.buyout,
      dl: x.daysLeft ?? "", ob: x.toOrder && x.orderBy ? (x.urgent ? "сегодня" : ruD(x.orderBy)) : "",
      ...Object.fromEntries(x.months.map((m) => [m.month, m.ship])),
      total: x.toOrder, cost: x.cost ?? "", money: x.money !== null && x.toOrder ? x.money : "",
      tags: [x.urgent && "срочно", x.locomotive && "локомотив", x.seasonal && "сезон", x.overstock && "лишний остаток"].filter(Boolean).join(", "),
    });
  }
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEEEA" } };
  head.alignment = { vertical: "middle", wrapText: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  await wb.xlsx.writeFile(file);
}
