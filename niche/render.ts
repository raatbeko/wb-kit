/**
 * Отчёт по нише: вердикт, сегменты, лидеры и новинки — сеткой фото, как витрина WB.
 */
import ExcelJS from "exceljs";
import { BASE_CSS, esc } from "../audit/render-html.js";
import { photoUrl } from "../competitors/cdn.js";
import type { NicheCard, NicheQuery, NicheReport } from "./niche.js";

const nf = (v: number) => Math.round(v).toLocaleString("ru-RU");
const rub = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${nf(v)} ₽`);
const short = (v: number) => (v >= 1e6 ? `${(v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн` : v >= 1e4 ? `${nf(v / 1e3)} тыс` : nf(v));

const CSS = `.wrap{max-width:1180px}
.verdict{display:flex;gap:14px;align-items:flex-start;border-radius:10px;padding:14px 16px;margin:4px 0 14px}.verdict.go{background:var(--good-soft)}.verdict.careful{background:var(--warn-soft)}.verdict.hard{background:var(--bad-soft)}
.verdict b{font-size:17px;display:block}.verdict.go b{color:var(--good)}.verdict.careful b{color:var(--warn)}.verdict.hard b{color:var(--bad)}.verdict ul{margin:4px 0 0;padding-left:18px;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,46%),1fr));gap:12px;margin-top:10px}
.it{position:relative;font-size:13px;line-height:1.35}.it img,.it .ph{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:8px;background:var(--chip-low);display:block}
.it .ph{display:flex;align-items:center;justify-content:center;color:var(--faint);font-weight:700}
.it .pos{position:absolute;top:6px;left:6px;background:var(--card);border-radius:4px;padding:0 6px;font-weight:700;font-size:12px}
.it .nw{position:absolute;top:6px;right:6px;background:var(--accent);color:#fff;border-radius:4px;padding:0 6px;font-weight:700;font-size:11px}
.it.own img,.it.own .ph{outline:3px solid var(--accent);outline-offset:-3px}
.it .pr{font-weight:700;font-size:15px;margin-top:6px}.it .nm{color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.it .rt{color:var(--muted);font-size:12px}.it .sl{font-size:12px;font-weight:600}
.segs{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr));gap:8px;margin-top:10px}.seg{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.seg b{font-size:16px}.seg .bar{height:4px;border-radius:2px;background:var(--line);margin:6px 0}.seg .bar i{display:block;height:100%;border-radius:2px;background:var(--accent)}.seg small{color:var(--muted)}
.ladder{position:relative;height:34px;margin:16px 0 4px;border-radius:6px;background:linear-gradient(90deg,var(--accent-soft),var(--accent2))}.ladder span{position:absolute;top:-16px;transform:translateX(-50%);font-size:11px;color:var(--muted);white-space:nowrap}.ladder i{position:absolute;top:0;bottom:0;width:2px;background:var(--text)}
`;

function photo(c: NicheCard, baskets?: Record<string, number>): string {
  const b = baskets?.[String(c.nmId)];
  return b ? `<img loading="lazy" alt="" src="${photoUrl(c.nmId, b)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'фото'}))">` : `<div class="ph">${esc((c.brand ?? "WB").slice(0, 6))}</div>`;
}

function tile(c: NicheCard, baskets: Record<string, number> | undefined, withPos = true): string {
  return `<a class="it${c.own ? " own" : ""}" href="https://www.wildberries.ru/catalog/${c.nmId}/detail.aspx" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${photo(c, baskets)}${withPos ? `<span class="pos">${c.position}</span>` : ""}${c.isNew ? '<span class="nw">новинка</span>' : ""}
<div class="pr">${rub(c.price)}</div><div class="nm">${esc([c.brand, c.name].filter(Boolean).join(" / "))}</div><div class="rt">${c.rating ?? "—"}★ · ${c.reviews !== null ? nf(c.reviews) : 0} отз.</div>${c.revenue !== undefined ? `<div class="sl">${short(c.revenue)} ₽ · ${nf(c.sales ?? 0)} шт</div>` : ""}</a>`;
}

function queryHtml(q: NicheQuery, r: NicheReport): string {
  const b = r.input.baskets;
  const p = q.prices;
  const own = q.own.filter((o) => o.price !== null);
  const lo = Math.min(...[p.q25, ...own.map((o) => o.price)].filter((x): x is number => x !== null)) * 0.85;
  const hi = Math.max(...[p.q75, ...own.map((o) => o.price)].filter((x): x is number => x !== null)) * 1.1;
  const at = (v: number) => `${(((v - lo) / (hi - lo || 1)) * 100).toFixed(1)}%`;
  const ladder = p.median !== null && p.q25 !== null && p.q75 !== null
    ? `<div class="ladder">${[["четверть дешевле", p.q25], ["медиана", p.median], ["четверть дороже", p.q75]].map(([l, v]) => `<i style="left:${at(v as number)}"></i><span style="left:${at(v as number)}">${l} ${rub(v as number)}</span>`).join("")}${own.map((o) => `<i style="left:${at(o.price!)};background:var(--accent);width:4px"></i>`).join("")}</div><p class="note">Цены первых ${q.leaders.length} карточек${own.length ? ". Синие черты — ваши товары" : ""}.</p>`
    : "";
  const eco = q.economy;
  const ecoHtml = eco
    ? `<p class="note">По медианной цене ${rub(eco.price)}: ${eco.afterWb !== null ? `после комиссии, логистики и рекламы WB останется ≈ ${rub(eco.afterWb)} (по доле вашего магазина из аудита)` : "долю WB не знаем — сделайте /audit"}${eco.cost !== null ? `, минус себестоимость ${rub(eco.cost)} = <b>${rub(eco.margin)}</b> со штуки` : eco.afterWb !== null ? "; себестоимость подобного товара — впишите в data/cost.csv, и здесь будет прибыль со штуки" : ""}. Это оценка, не расчёт.</p>`
    : "";
  return `<section><h2>«${esc(q.query)}»</h2>
<div class="verdict ${q.verdict.level}"><div><b>${q.verdict.title}</b><ul>${q.verdict.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
<div class="kpis"><div class="kpi"><div class="kpi-label">Медианная цена лидеров</div><div class="kpi-value">${rub(p.median)}</div><div class="kpi-foot">от ${rub(p.q25)} до ${rub(p.q75)}</div></div>
<div class="kpi"><div class="kpi-label">Отзывов у первой десятки</div><div class="kpi-value">${q.medianReviewsTop10 !== null ? nf(q.medianReviewsTop10) : "—"}</div><div class="kpi-foot">медиана, рейтинг ${q.medianRating ?? "—"}</div></div>
<div class="kpi"><div class="kpi-label">Три бренда держат</div><div class="kpi-value">${Math.round(q.brandShareTop3 * 100)}%</div><div class="kpi-foot">${esc(q.brands.slice(0, 3).map((x) => x.brand).join(", "))}</div></div>
<div class="kpi"><div class="kpi-label">Новинок в топе</div><div class="kpi-value">${q.hasFresh ? q.newInTop.length : "—"}</div><div class="kpi-foot">${q.hasFresh ? "из сортировки «новинки»" : "новинки не смотрели"}</div></div>
${q.sales ? `<div class="kpi"><div class="kpi-label">Выручка лидеров</div><div class="kpi-value">${short(q.sales.leadersRevenue)} ₽</div><div class="kpi-foot">${q.sales.covered} карточек, ${esc(r.input.sales!.source)}</div></div>` : ""}</div>
${ladder}${ecoHtml}
${q.segments.length ? `<h3>Сегменты</h3><p class="lead">Чем различаются товары в выдаче: слово из названия, доля карточек, медианная цена и отзывы. Сегмент с высокой ценой и небольшим числом отзывов — кандидат для входа.</p><div class="segs">${q.segments.map((s) => `<div class="seg"><b>${esc(s.word)}</b><div class="bar"><i style="width:${Math.round(s.share * 100)}%"></i></div><small>${s.count} карт. (${Math.round(s.share * 100)}%) · ${rub(s.medianPrice)} · ${s.medianReviews !== null ? nf(s.medianReviews) : "—"} отз. · лучшее место ${s.bestPosition}</small></div>`).join("")}</div>` : ""}
<h3>Лидеры</h3><div class="grid">${[...q.leaders.slice(0, 18), ...q.ownCards.filter((c) => c.position > 18)].map((c) => tile(c, b)).join("")}</div>${q.ownCards.length ? `<p class="note">Синей рамкой — ваши товары${q.ownCards.some((c) => c.position > 18) ? " (показаны, даже если ниже первых 18)" : ""}.</p>` : ""}
${q.newInTop.length ? `<h3>Новинки, которые уже в топе</h3><p class="lead">Появились недавно и стоят в популярной выдаче — их стоит разобрать: цена, фото, чем отличаются.</p><div class="grid">${q.newInTop.map((c) => tile(c, b)).join("")}</div>` : ""}
${q.newcomers.length ? `<h3>Новинки, которые набирают отзывы</h3><div class="grid">${q.newcomers.map((c) => tile(c, b, false)).join("")}</div>` : q.hasFresh ? "" : `<p class="note">Новинки не смотрели: Claude снимает их сортировкой «по новинкам».</p>`}
</section>`;
}

export function renderNicheHtml(r: NicheReport, insightsMd?: string): string {
  const d = r.input;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ниша${d.demo ? " ДЕМО" : ""}</title><style>${BASE_CSS}${CSS}</style></head><body><div class="wrap">
<header><div><div class="eyebrow">Ниша на WB${d.demo ? '<span class="badge">ДЕМО</span>' : ""}</div><h1>${esc(r.queries.map((q) => q.query).join(", ")) || "Нет запросов"}</h1></div><div class="sub">выдача WB на ${d.generatedAt.slice(8, 10)}.${d.generatedAt.slice(5, 7)}${d.sales ? ` · продажи: ${esc(d.sales.source)}` : " · продаж нет — только с MPSTATS"}</div></header>
${insightsMd ? `<section class="insights"><h2>Выводы</h2>${insightsMd}</section>` : ""}
${r.queries.map((q) => queryHtml(q, r)).join("\n")}
<footer>Данные — видимые страницы поиска WB (у других покупателей места немного отличаются: регион, история). Вердикт — подсказка по цифрам выдачи, а не прогноз продаж: перед закупкой проверьте спрос и себестоимость. wb-kit</footer>
</div></body></html>`;
}

export async function renderNicheXlsx(r: NicheReport, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "wb-kit";
  for (const q of r.queries) {
    const ws = wb.addWorksheet(q.query.slice(0, 28).replace(/[\\/?*[\]:]/g, " "), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "Место", key: "pos", width: 7 }, { header: "Артикул", key: "nm", width: 12 }, { header: "Бренд", key: "brand", width: 16 },
      { header: "Название", key: "name", width: 44 }, { header: "Цена", key: "price", width: 10, style: { numFmt: '#,##0" ₽"' } },
      { header: "Рейтинг", key: "rating", width: 8 }, { header: "Отзывы", key: "reviews", width: 9 }, { header: "Новинка", key: "new", width: 9 },
      { header: "Продажи, шт", key: "sales", width: 11 }, { header: "Выручка", key: "rev", width: 13, style: { numFmt: '#,##0" ₽"' } },
      { header: "Ссылка", key: "url", width: 40 },
    ];
    for (const c of q.leaders) ws.addRow({ pos: c.position, nm: c.nmId, brand: c.brand, name: c.name, price: c.price, rating: c.rating, reviews: c.reviews, new: c.isNew ? "да" : "", sales: c.sales ?? "", rev: c.revenue ?? "", url: `https://www.wildberries.ru/catalog/${c.nmId}/detail.aspx` });
    ws.getRow(1).font = { bold: true };
  }
  if (!r.queries.length) wb.addWorksheet("Пусто");
  await wb.xlsx.writeFile(file);
}
