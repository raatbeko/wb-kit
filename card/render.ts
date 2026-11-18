/**
 * Отчёт `/card`: HTML (стили общие с аудитом) и Excel.
 */
import ExcelJS from "exceljs";
import { BASE_CSS, esc, fmt, markdownToHtml } from "../audit/render-html.js";
import { LIMITS, type CardReport, type Characteristic } from "./analyze.js";

const productUrl = (nmId: number) => `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const yes = (b: boolean) => (b ? '<span class="ok">✓</span>' : '<span class="no">—</span>');

function tile(label: string, value: string, foot = "", warn = false) {
  return `<div class="kpi${warn ? " warn-tile" : ""}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${foot ? `<div class="kpi-foot">${foot}</div>` : ""}</div>`;
}

function charsTable(rows: Characteristic[], highlight = new Set<string>()) {
  if (!rows.length) return '<p class="muted">Нет.</p>';
  return `<table class="chars"><tbody>${rows.map((c) => `<tr${highlight.has(c.name.toLowerCase()) ? ' class="new"' : ""}><td>${esc(c.name)}</td><td>${esc(c.value)}</td></tr>`).join("")}</tbody></table>`;
}

function proposalSection(r: CardReport): string {
  const p = r.proposal;
  if (!p) return "";
  const own = r.input.own;
  const ownNames = new Set(own.characteristics.map((c) => c.name.toLowerCase()));
  const changedChars = p.characteristics.filter((c) => {
    const was = own.characteristics.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
    return !was || was.value !== c.value;
  });
  const fresh = new Set(changedChars.map((c) => c.name.toLowerCase()));
  const delta = (before: number, after: number) => `${pct(before)} → <b>${pct(after)}</b>`;
  return `<section class="proposal"><h2>Предложение</h2>
${p.intro ? `<div class="intro">${markdownToHtml(p.intro)}</div>` : ""}
${p.warnings.length ? `<div class="warn-box">${p.warnings.map((w) => `<p>⚠ ${esc(w)}</p>`).join("")}</div>` : ""}
${r.input.searchTexts.length ? `<div class="kpis">${tile("Спрос, покрытый названием", delta(r.coverage.title, p.coverage.title))}${tile("Спрос, покрытый карточкой", delta(r.coverage.card, p.coverage.card))}</div>` : ""}
<div class="compare">
  <div><h3>Сейчас</h3><p class="title-box">${esc(own.title)}</p><p class="small muted">${own.title.length} из ${LIMITS.title} символов</p></div>
  <div><h3>Предлагаем</h3><p class="title-box new">${esc(p.title ?? own.title)}</p><p class="small ${p.title && p.title.length > LIMITS.title ? "bad" : "muted"}">${(p.title ?? own.title).length} из ${LIMITS.title} символов</p></div>
</div>
${p.description ? `<details open><summary>Описание: ${own.description.length} → ${p.description.length} символов</summary><div class="compare">
  <div><h3>Сейчас</h3><div class="desc">${esc(own.description) || '<span class="muted">пусто</span>'}</div></div>
  <div><h3>Предлагаем</h3><div class="desc new">${esc(p.description)}</div></div>
</div></details>` : ""}
${changedChars.length ? `<h3>Характеристики: добавить или поправить (${changedChars.length})</h3>${charsTable(changedChars, new Set([...fresh].filter((n) => !ownNames.has(n))))}<p class="note">Выделены новые поля. Значения выбирайте из справочника WB в кабинете — свободный текст WB может не принять.</p>` : ""}
${p.rest ? `<div class="rest">${markdownToHtml(p.rest)}</div>` : ""}
<p class="note">Текст в кабинет переносите сами: Карточка товара → Редактировать. wb-kit карточки не меняет. Проверьте, что каждое слово правда про этот товар.</p>
</section>`;
}

export function renderCardHtml(r: CardReport): string {
  const o = r.input.own;
  const m = r.metrics;
  const cm = m.competitors;
  const date = new Date(r.input.generatedAt).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
  const hasQ = r.input.searchTexts.length > 0;
  const kpis = [
    hasQ ? tile("Спрос в названии", pct(r.coverage.title), "доля обращений, все слова запроса есть в названии") : "",
    hasQ ? tile("Спрос в карточке", pct(r.coverage.card), "название + описание + характеристики") : "",
    tile("Название", `${m.titleLength}<small> / ${LIMITS.title}</small>`, "символов", m.titleLength > LIMITS.title),
    tile("Описание", fmt(m.descriptionLength), cm.descriptionMedian ? `у конкурентов ~${fmt(cm.descriptionMedian)}` : "символов", Boolean(cm.descriptionMedian && m.descriptionLength < cm.descriptionMedian * 0.5)),
    tile("Характеристик", fmt(m.characteristics), cm.characteristicsMedian ? `у конкурентов ~${cm.characteristicsMedian}` : "", Boolean(cm.characteristicsMedian && m.characteristics < cm.characteristicsMedian * 0.7)),
    tile("Фото", fmt(m.photos), cm.photosMedian ? `у конкурентов ~${cm.photosMedian}${cm.count ? `, видео у ${cm.withVideo} из ${cm.count}` : ""}` : "", Boolean(cm.photosMedian && m.photos < cm.photosMedian * 0.7)),
  ].join("");

  const queries = r.queries
    .map((q) => `<tr><td>${esc(q.text)}</td><td class="r">${fmt(q.frequency)}</td><td class="r">${q.avgPosition ?? "—"}</td><td class="r">${fmt(q.openCard)}</td><td class="r">${fmt(q.orders)}</td><td class="c">${yes(q.inTitle)}</td><td class="c">${yes(q.inCard)}</td><td>${q.missing.length ? `<span class="bad">${q.missing.map(esc).join(", ")}</span>` : ""}</td></tr>`)
    .join("");
  const words = r.words
    .slice(0, 40)
    .map((w) => `<tr><td>${esc(w.word)}</td><td class="r">${fmt(w.demand)}</td><td class="r">${w.queries}</td><td class="c">${yes(w.inTitle)}</td><td class="c">${yes(w.inCard)}</td></tr>`)
    .join("");
  const comps = r.input.competitors
    .map((c) => `<tr><td><a href="${productUrl(c.nmId)}">${c.nmId}</a></td><td>${esc(c.title)}</td><td class="r">${fmt(c.title.length)}</td><td class="r">${fmt(c.description.length)}</td><td class="r">${c.characteristics.length}</td><td class="r">${c.photos}</td><td class="c">${c.hasVideo ? "да" : ""}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Карточка ${esc(o.vendorCode || o.nmId)} — тексты и поисковые запросы</title>
<style>
${BASE_CSS}
a{color:var(--accent)}.ok{color:var(--good);font-weight:700}.no{color:var(--muted)}.bad{color:var(--bad)}
.kpi small{font-size:13px;color:var(--muted);font-weight:400}.warn-tile{border-color:var(--warn)}.warn-tile .kpi-value{color:var(--warn)}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0}.title-box{font-weight:600;font-size:16px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0}
.desc{border:1px solid var(--line);border-radius:10px;padding:10px 12px;white-space:pre-wrap;font-size:14px;max-height:420px;overflow:auto}
.new{border-color:var(--good)}tr.new td{color:var(--good)}.warn-box{border:1px solid var(--warn);border-radius:10px;padding:4px 12px;margin-bottom:12px;color:var(--warn)}
.chars td:first-child{color:var(--muted);width:40%}.findings li{margin:4px 0}.intro{border-left:4px solid var(--accent);padding-left:12px;margin-bottom:12px}.intro p{max-width:80ch}.rest{margin-top:12px}
@media (max-width:700px){.compare{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<header><div><h1>Карточка товара${r.input.demo ? '<span class="badge">ДЕМО</span>' : ""}</h1><div class="sub">${esc(o.title)} · <a href="${productUrl(o.nmId)}">${o.nmId}</a>${o.vendorCode ? ` · ${esc(o.vendorCode)}` : ""} · ${esc(o.subject)}</div></div><div class="sub">${esc(date)}</div></header>
${proposalSection(r)}
<section><h2>Что видно</h2><div class="kpis">${kpis}</div>${r.findings.length ? `<ul class="findings">${r.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}</section>
${hasQ ? `<section><h2>Поисковые запросы покупателей</h2><p class="note" style="margin:0 0 10px">По данным WB за ${esc(r.input.period.from)} — ${esc(r.input.period.to)}: запросы, по которым показывался этот товар. «Нет слов» — каких слов запроса нет нигде в карточке.</p>
<div class="table-wrap"><table><thead><tr><th>Запрос</th><th class="r">Обращений</th><th class="r">Ср. позиция</th><th class="r">Переходов</th><th class="r">Заказов</th><th class="c">В названии</th><th class="c">В карточке</th><th>Нет слов</th></tr></thead><tbody>${queries}</tbody></table></div></section>
<section><h2>Слова, которые ищут</h2><p class="note" style="margin:0 0 10px">Обращения по всем запросам, где встречается слово. Чем выше — тем важнее, чтобы слово было в названии.</p>
<div class="table-wrap"><table><thead><tr><th>Слово</th><th class="r">Обращений</th><th class="r">Запросов</th><th class="c">В названии</th><th class="c">В карточке</th></tr></thead><tbody>${words}</tbody></table></div></section>` : ""}
${r.competitorWords.length ? `<section><h2>Есть у конкурентов, нет у вас</h2><p>${r.competitorWords.map((w) => `<span class="chip low">${esc(w.word)} · ${w.competitors}</span>`).join(" ")}</p><p class="note">Слова из названий и характеристик конкурентов; цифра — у скольких из ${cm.count} они есть. Брать только то, что правда про ваш товар.</p></section>` : ""}
${comps ? `<section><h2>Конкуренты</h2><p class="note" style="margin:0 0 10px">${esc(r.input.competitorsFrom ?? "")}</p><div class="table-wrap"><table><thead><tr><th>Артикул</th><th>Название</th><th class="r">Длина назв.</th><th class="r">Описание</th><th class="r">Характ.</th><th class="r">Фото</th><th class="c">Видео</th></tr></thead><tbody>${comps}</tbody></table></div></section>` : ""}
<section><h2>Карточка сейчас</h2><h3>Описание (${fmt(o.description.length)} символов)</h3><div class="desc">${esc(o.description) || '<span class="muted">пусто</span>'}</div><h3 style="margin-top:14px">Характеристики</h3>${charsTable(o.characteristics)}</section>
<footer>${r.input.demo ? "Демо-отчёт на выдуманных данных. " : ""}Поисковые запросы — из аналитики WB по ключу продавца; карточки конкурентов — из открытых данных WB. Слова сравниваются по основе: «пледы» и «плед» — одно слово.</footer>
</div></body></html>`;
}

export async function renderCardXlsx(r: CardReport, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "wb-kit";
  const head = (ws: ExcelJS.Worksheet) => {
    const row = ws.getRow(1);
    row.font = { bold: true };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE7F6" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const mark = (b: boolean) => (b ? "да" : "");

  if (r.proposal) {
    const p = wb.addWorksheet("Предложение");
    p.columns = [{ header: "Поле", key: "f", width: 22 }, { header: "Сейчас", key: "was", width: 70 }, { header: "Предлагаем", key: "now", width: 70 }];
    const o = r.input.own;
    p.addRow({ f: "Название", was: o.title, now: r.proposal.title ?? "" });
    p.addRow({ f: "Описание", was: o.description, now: r.proposal.description ?? "" });
    for (const c of r.proposal.characteristics) p.addRow({ f: c.name, was: o.characteristics.find((x) => x.name.toLowerCase() === c.name.toLowerCase())?.value ?? "", now: c.value });
    p.eachRow((row, i) => i > 1 && (row.alignment = { wrapText: true, vertical: "top" }));
    head(p);
  }

  const q = wb.addWorksheet("Запросы");
  q.columns = [
    { header: "Запрос", key: "text", width: 36 }, { header: "Обращений", key: "frequency", width: 12, style: { numFmt: "#,##0" } }, { header: "Ср. позиция", key: "avgPosition", width: 11 },
    { header: "Переходов", key: "openCard", width: 11 }, { header: "Заказов", key: "orders", width: 9 }, { header: "В названии", key: "inTitle", width: 11 }, { header: "В карточке", key: "inCard", width: 11 },
    { header: "Нет слов", key: "missing", width: 30 },
  ];
  for (const x of r.queries) q.addRow({ ...x, inTitle: mark(x.inTitle), inCard: mark(x.inCard), missing: x.missing.join(", ") });
  head(q);
  q.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: q.columnCount } };

  const w = wb.addWorksheet("Слова");
  w.columns = [{ header: "Слово", key: "word", width: 22 }, { header: "Обращений", key: "demand", width: 12, style: { numFmt: "#,##0" } }, { header: "Запросов", key: "queries", width: 10 }, { header: "В названии", key: "inTitle", width: 11 }, { header: "В карточке", key: "inCard", width: 11 }];
  for (const x of r.words) w.addRow({ ...x, inTitle: mark(x.inTitle), inCard: mark(x.inCard) });
  head(w);

  const c = wb.addWorksheet("Конкуренты");
  c.columns = [
    { header: "Артикул WB", key: "nmId", width: 13 }, { header: "Название", key: "title", width: 60 }, { header: "Описание, симв.", key: "desc", width: 12 },
    { header: "Характеристик", key: "chars", width: 12 }, { header: "Фото", key: "photos", width: 7 }, { header: "Видео", key: "video", width: 7 }, { header: "Описание", key: "text", width: 80 }, { header: "Ссылка", key: "url", width: 50 },
  ];
  for (const x of r.input.competitors) c.addRow({ nmId: x.nmId, title: x.title, desc: x.description.length, chars: x.characteristics.length, photos: x.photos, video: mark(x.hasVideo), text: x.description, url: productUrl(x.nmId) });
  head(c);

  await wb.xlsx.writeFile(file);
}
