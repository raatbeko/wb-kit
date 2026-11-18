/**
 * Отчёт о конкурентах: HTML (стили общие с аудитом) и Excel.
 */
import ExcelJS from "exceljs";
import { BASE_CSS, esc, fmt, markdownToHtml, rub } from "../audit/render-html.js";
import type { CompetitorReport, QueryReport, SalesData, SearchCard } from "./analyze.js";

const PRIORITY = { high: "Срочно", medium: "Важно", low: "К сведению" } as const;
const productUrl = (nmId: number) => `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`;

/** Точечная шкала цен по выдаче: видно, где рынок и где товар продавца. */
function priceStrip(q: QueryReport, cards: SearchCard[]): string {
  const prices = cards.map((c) => c.price).filter((p): p is number => p !== null);
  if (prices.length < 2) return "";
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const W = 720, pad = 16;
  const x = (p: number) => pad + ((p - min) / Math.max(1, max - min)) * (W - pad * 2);
  const ownIds = new Set(q.own.map((o) => o.nmId));
  const priced = q.own.filter((o) => o.card?.price);
  // Подписи своих товаров — каждая в своей строке над шкалой, чтобы не наезжали друг на друга.
  const top = 14 * Math.max(1, priced.length);
  const H = top + 60;
  const mid = top + 20;
  const dots = cards
    .filter((c) => c.price !== null && !ownIds.has(c.nmId))
    .map((c) => `<circle cx="${x(c.price!).toFixed(1)}" cy="${mid + ((c.position * 7) % 15) - 7}" r="${c.position <= 10 ? 4 : 2.5}" class="${c.position <= 10 ? "dot-leader" : "dot"}"><title>${esc(c.brand)} — ${rub(c.price)}, место ${c.position}</title></circle>`)
    .join("");
  const own = priced
    .map((o, i) => {
      const px = x(o.card!.price!);
      const ly = 10 + i * 14;
      // У краёв выравниваем подпись внутрь, чтобы не наезжала на min/max.
      const anchor = px > W * 0.8 ? "end" : px < W * 0.2 ? "start" : "middle";
      return `<g><line x1="${px}" x2="${px}" y1="${ly + 4}" y2="${mid + 18}" class="own-line"/><text x="${px}" y="${ly}" text-anchor="${anchor}" class="own-label">${esc(o.vendorCode || o.nmId)} ${rub(o.card!.price)}</text></g>`;
    })
    .join("");
  const band = q.price.p25 !== null && q.price.p75 !== null ? `<rect x="${x(q.price.p25)}" y="${mid - 12}" width="${x(q.price.p75) - x(q.price.p25)}" height="24" rx="4" class="band"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Цены в выдаче">${band}${dots}${own}
<text x="${pad}" y="${H - 6}" class="axis">${rub(min)}</text><text x="${W - pad}" y="${H - 6}" class="axis" text-anchor="end">${rub(max)}</text></svg>
<div class="legend"><span><i class="sw leader"></i>первая десятка</span><span><i class="sw other"></i>остальные</span><span><i class="sw band-sw"></i>средние 50% цен</span></div>`;
}

function querySection(q: QueryReport, cards: SearchCard[], salesData?: SalesData): string {
  const sales = (id: number) => salesData?.items[String(id)];
  const tile = (label: string, value: string, hint = "") => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-foot"><span>${hint}</span></div></div>`;
  const own = q.own.length
    ? q.own
        .map((o) => {
          const move =
            o.position !== null && o.prevPosition !== null && o.position !== o.prevPosition
              ? `<span class="delta ${o.position < o.prevPosition ? "up" : "down"}">${o.position < o.prevPosition ? "▲" : "▼"} было ${o.prevPosition}</span>`
              : "";
          return `<article class="issue ${o.position === null || o.position > 30 ? "high" : o.gaps.length ? "medium" : "low"}">
<div class="issue-head"><b>${esc(o.vendorCode || o.nmId)}</b><span class="muted">${esc(o.title)}</span></div>
<h3>${o.position === null ? `Нет в первых ${q.scanned}` : `Место ${o.position}`} ${move}</h3>
${o.card ? `<p class="muted">${rub(o.card.price)} · рейтинг ${fmt(o.card.rating, 1)} · отзывов ${fmt(o.card.reviews)}${sales(o.nmId) ? ` · продаж ${fmt(sales(o.nmId)!.sales)} шт на ${rub(sales(o.nmId)!.revenue)}` : ""}</p>` : ""}
${o.gaps.length ? `<ul class="products">${o.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : "<p>По основным признакам не уступает лидерам.</p>"}
</article>`;
        })
        .join("")
    : `<p class="muted">Товаров продавца в этой выдаче нет${q.scanned ? ` (просмотрено ${q.scanned} карточек)` : ""}.</p>`;

  const leaders = q.leaders
    .map(
      (c) => `<tr><td class="c">${c.position}</td><td><a href="${productUrl(c.nmId)}" target="_blank" rel="noopener">${esc(c.brand ?? "—")}</a><div class="muted small">${esc(c.name)} · ${c.nmId}</div></td>
<td class="r">${rub(c.price)}</td><td class="r">${fmt(c.rating, 1)}</td><td class="r">${fmt(c.reviews)}</td>${salesData ? `<td class="r">${fmt(sales(c.nmId)?.sales)}</td><td class="r">${rub(sales(c.nmId)?.revenue)}</td>` : ""}
<td class="r">${fmt(c.details?.photos)}</td><td class="r">${fmt(c.details?.descriptionLength)}</td><td class="r">${fmt(c.details?.characteristics)}</td><td>${c.labels.map((l) => `<span class="chip low">${esc(l)}</span>`).join(" ")}</td></tr>`,
    )
    .join("");

  return `<section><h2>«${esc(q.query)}»</h2>
<p class="sub">Просмотрено ${q.scanned} карточек выдачи · <a href="${esc(q.url)}" target="_blank" rel="noopener">открыть поиск на WB</a></p>
<div class="kpis">
${tile("Цена лидеров", rub(q.price.leadersMedian), "медиана первой десятки")}
${tile("Цены в выдаче", `${rub(q.price.p25)} – ${rub(q.price.p75)}`, "средние 50%")}
${tile("Рейтинг лидеров", fmt(q.leadersRatingMedian, 1), "медиана")}
${tile("Отзывов у лидеров", fmt(q.leadersReviewsMedian), "медиана")}
${tile("В акции", `${q.promoShare}%`, "карточек с плашкой акции")}
${salesData && q.leadersSalesMedian !== null ? tile("Продажи лидеров", `${fmt(q.leadersSalesMedian)} шт`, `медиана, ${esc(salesData.source)}`) : ""}
</div>
${priceStrip(q, cards)}
<h3>Ваши товары</h3>${own}
<h3>Первая десятка</h3>
<div class="table-wrap"><table><thead><tr><th>Место</th><th>Бренд и товар</th><th class="r">Цена</th><th class="r">Рейтинг</th><th class="r">Отзывов</th>${salesData ? `<th class="r">Продажи, шт</th><th class="r">Выручка</th>` : ""}<th class="r">Фото</th><th class="r">Описание, симв.</th><th class="r">Характ.</th><th>Плашки</th></tr></thead><tbody>${leaders}</tbody></table></div>
<p class="note">Бренды в выдаче: ${q.brands.slice(0, 6).map((b) => `${esc(b.brand)} — ${b.cards} (лучшее место ${b.bestPosition})`).join(", ")}.</p>
${q.changes.hasPrevious && (q.changes.newLeaders.length || q.changes.leaderPriceChanges.length) ? `<p class="note">С прошлой проверки: ${[q.changes.newLeaders.length ? `новых в первой десятке — ${q.changes.newLeaders.length}` : "", ...q.changes.leaderPriceChanges.map((c) => `${esc(c.brand ?? c.nmId)}: ${rub(c.was)} → ${rub(c.now)}`)].filter(Boolean).join("; ")}.</p>` : ""}
</section>`;
}

export function renderCompetitorHtml(r: CompetitorReport, insightsMd?: string): string {
  const date = new Date(r.input.generatedAt).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
  const snaps = new Map(r.input.snapshots.map((s) => [s.query, s.cards]));
  const findings = r.findings.length
    ? `<div class="issues">${r.findings
        .map((f, i) => `<article class="issue ${f.priority}"><div class="issue-head"><span class="num">${i + 1}</span><span class="chip ${f.priority}">${PRIORITY[f.priority]}</span><span class="muted">«${esc(f.query)}»</span></div><p>${esc(f.text)}</p>${f.details?.length ? `<ul class="products">${f.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}</article>`)
        .join("")}</div>`
    : "<p>Серьёзных отставаний от лидеров не найдено.</p>";
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Конкуренты WB — ${esc(r.queries.map((q) => q.query).join(", "))}</title>
<style>
${BASE_CSS}
.dot{fill:var(--muted);opacity:.5}.dot-leader{fill:var(--accent)}.band{fill:var(--accent2);opacity:.35}.own-line{stroke:var(--bad);stroke-width:2.5}.own-label{fill:var(--bad);font-size:11px;font-weight:600}
.sw.leader{background:var(--accent)}.sw.other{background:var(--muted)}.sw.band-sw{background:var(--accent2)}
a{color:var(--accent)}
</style></head><body><div class="wrap">
<header><div><h1>Конкуренты на WB${r.input.demo ? '<span class="badge">ДЕМО</span>' : ""}</h1><div class="sub">Запросы: ${r.queries.map((q) => `«${esc(q.query)}»`).join(", ")}</div></div><div class="sub">Проверено ${esc(date)}</div></header>
${insightsMd?.trim() ? `<section class="insights"><h2>Главное</h2>${markdownToHtml(insightsMd)}</section>` : ""}
<section><h2>Что важно</h2>${findings}</section>
${r.queries.map((q) => querySection(q, snaps.get(q.query) ?? [], r.input.sales)).join("\n")}
<footer>${r.input.demo ? "Демо-отчёт на выдуманных данных. " : ""}Выдача снята со страницы поиска WB так, как её видел покупатель в момент проверки. Позиции зависят от региона доставки и истории покупателя, поэтому у разных людей немного отличаются. Описания карточек — из открытых данных WB.${r.input.sales ? ` Продажи — ${esc(r.input.sales.source)} за ${esc(r.input.sales.period.from)} — ${esc(r.input.sales.period.to)}.` : ""}</footer>
</div></body></html>`;
}

export async function renderCompetitorXlsx(r: CompetitorReport, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "wb-kit";
  const head = (ws: ExcelJS.Worksheet) => {
    const row = ws.getRow(1);
    row.font = { bold: true };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE7F6" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };

  const f = wb.addWorksheet("Что важно");
  f.columns = [{ header: "Важность", key: "p", width: 12 }, { header: "Запрос", key: "q", width: 24 }, { header: "Что", key: "t", width: 120 }];
  for (const x of r.findings) f.addRow({ p: PRIORITY[x.priority], q: x.query, t: [x.text, ...(x.details ?? [])].join("\n• ") }).alignment = { wrapText: true, vertical: "top" };
  head(f);

  const own = wb.addWorksheet("Мои товары");
  own.columns = [
    { header: "Запрос", key: "query", width: 24 }, { header: "Артикул WB", key: "nmId", width: 13 }, { header: "Артикул продавца", key: "vendorCode", width: 18 },
    { header: "Место", key: "position", width: 8 }, { header: "Было", key: "prevPosition", width: 8 }, { header: "Цена", key: "price", width: 10, style: { numFmt: '#,##0" ₽"' } },
    { header: "Рейтинг", key: "rating", width: 8 }, { header: "Отзывов", key: "reviews", width: 9 }, { header: "Чем уступает лидерам", key: "gaps", width: 100 },
  ];
  for (const q of r.queries) for (const o of q.own) own.addRow({ query: q.query, nmId: o.nmId, vendorCode: o.vendorCode, position: o.position, prevPosition: o.prevPosition, price: o.card?.price, rating: o.card?.rating, reviews: o.card?.reviews, gaps: o.gaps.join("; ") });
  head(own);

  // Вся выдача одним листом: удобно фильтровать по запросу и сравнивать с прошлым разом.
  const all = wb.addWorksheet("Выдача");
  all.columns = [
    { header: "Запрос", key: "query", width: 24 }, { header: "Место", key: "position", width: 8 }, { header: "Артикул WB", key: "nmId", width: 13 },
    { header: "Бренд", key: "brand", width: 18 }, { header: "Название", key: "name", width: 44 }, { header: "Цена", key: "price", width: 10, style: { numFmt: '#,##0" ₽"' } },
    { header: "Цена до скидки", key: "oldPrice", width: 12, style: { numFmt: '#,##0" ₽"' } }, { header: "Рейтинг", key: "rating", width: 8 }, { header: "Отзывов", key: "reviews", width: 9 },
    { header: "Доставка", key: "delivery", width: 12 }, { header: "Плашки", key: "labels", width: 20 }, { header: "Мой товар", key: "mine", width: 10 },
    { header: "Фото", key: "photos", width: 7 }, { header: "Описание, симв.", key: "descriptionLength", width: 11 }, { header: "Характеристик", key: "characteristics", width: 11 },
    { header: "Продажи, шт (MPSTATS)", key: "sales", width: 12 }, { header: "Выручка (MPSTATS)", key: "revenue", width: 14, style: { numFmt: '#,##0" ₽"' } },
    { header: "Ссылка", key: "url", width: 50 },
  ];
  const ownIds = new Set(r.input.own.map((o) => o.nmId));
  for (const s of r.input.snapshots) {
    for (const c of s.cards) {
      const d = r.input.details[String(c.nmId)];
      const sl = r.input.sales?.items[String(c.nmId)];
      all.addRow({ query: s.query, ...c, labels: c.labels.join(", "), mine: ownIds.has(c.nmId) ? "да" : "", photos: d?.photos, descriptionLength: d?.descriptionLength, characteristics: d?.characteristics, sales: sl?.sales, revenue: sl?.revenue, url: productUrl(c.nmId) });
    }
  }
  head(all);
  all.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: all.columnCount } };

  await wb.xlsx.writeFile(file);
}
