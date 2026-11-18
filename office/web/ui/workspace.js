/**
 * «Рабочий стол» сотрудника — то, что он выдаёт. Четыре вкладки:
 *   Сводка  — главный вывод одной фразой с цифрой, плашки, график, его проблемы и решения;
 *   Таблица — его данные: сортировка, поиск, «только проблемные», CSV, клик по строке — карточка товара;
 *   Отчёты  — список и просмотр прямо здесь (HTML-отчёт в песочнице);
 *   Диалог  — вопросы сотруднику и его ответы, последние шаги.
 *
 * Что показывать каждому — в ROLES. Пороги — те же, что в аудите (THRESHOLDS).
 */
import { attachChartTips, barChart, hbars } from "./chart.js";
import { createTable, esc, fmt } from "./table.js";

/** Пороги аудита (audit/analyze.ts → THRESHOLDS) — подсветка ячеек совпадает с выводами. */
export const T = { lowStockDays: 14, overstockDays: 120, lowBuyout: 60, drrWarn: 15, drrHigh: 25, minPhotos: 5, minDescription: 1000, minCharacteristics: 10, dropProduct: -30, logisticsShare: 15 };

const PRIORITY = { high: "срочно", medium: "важно", low: "можно позже" };
const nf = new Intl.NumberFormat("ru-RU");
const rub = (v) => fmt.rub(v);
const kpi = (s, key) => s?.kpis?.find((k) => k.key === key);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

function weeklyChart(s, title = "Заказы по неделям") {
  const end = s?.period?.to ? Date.parse(s.period.to) : Date.now();
  const pts = (s?.weekly ?? []).map((w) => {
    // Неделя, которая ещё не закончилась, — бледным: её короткий столбик не «обвал», а неполные дни.
    const partial = Date.parse(w.week) + 6 * 86400000 > end;
    return {
      label: new Date(w.week).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }),
      value: w.ordersSum,
      partial,
      hint: `выкупы ${nf.format(Math.round(w.buyoutsSum))} ₽${partial ? " · неделя ещё идёт" : ""}`,
    };
  });
  return barChart(pts, { title, unit: "₽" }) + (pts.at(-1)?.partial ? `<p class="muted small">Последний столбик бледный: неделя ещё не закончилась.</p>` : "");
}

const stockTone = (p) => (p.daysOfStock === null || p.perDay <= 0 ? "" : p.stock === 0 ? "bad" : p.daysOfStock < T.lowStockDays ? "bad" : p.daysOfStock > T.overstockDays ? "warn" : "ok");
const deltaTone = (v) => (v === null || v === undefined ? "" : v <= T.dropProduct ? "bad" : v < 0 ? "warn" : "ok");

/** Колонки товарных таблиц — общие кирпичики. */
const C = {
  title: { key: "title", label: "Товар", wide: true },
  vendor: { key: "vendorCode", label: "Артикул продавца" },
  abc: { key: "abc", label: "ABC" },
  ordersSum: { key: "ordersSum", label: "Заказы, ₽", num: true, fmt: fmt.rub },
  orders: { key: "orders", label: "Заказы, шт", num: true, fmt: fmt.int },
  ordersDelta: { key: "ordersDelta", label: "К прошлому периоду", num: true, fmt: fmt.delta, tone: (r) => deltaTone(r.ordersDelta) },
  perDay: { key: "perDay", label: "В день, шт", num: true, fmt: (v) => (v === null ? "—" : nf.format(Math.round(v * 10) / 10)) },
  openCount: { key: "openCount", label: "Переходы", num: true, fmt: fmt.int },
  addToCart: { key: "addToCartPercent", label: "В корзину", num: true, fmt: fmt.pct },
  cartToOrder: { key: "cartToOrderPercent", label: "Корзина → заказ", num: true, fmt: fmt.pct },
  buyout: { key: "buyoutPercent", label: "Выкуп", num: true, fmt: fmt.pct, tone: (r) => (r.buyoutPercent !== null && r.buyoutPercent < T.lowBuyout ? "bad" : "") },
  stock: { key: "stock", label: "На складах WB", num: true, fmt: fmt.int, tone: (r) => (r.stock === 0 && r.perDay > 0 ? "bad" : "") },
  inWay: { key: "inWayToClient", label: "В пути к клиенту", num: true, fmt: fmt.int },
  days: { key: "daysOfStock", label: "Хватит на", num: true, fmt: fmt.days, tone: stockTone },
  forPay: { key: "forPay", label: "К перечислению", num: true, fmt: fmt.rub },
  logistics: { key: "logistics", label: "Логистика", num: true, fmt: fmt.rub },
  penalties: { key: "penalties", label: "Штрафы", num: true, fmt: fmt.rub, tone: (r) => (r.penalties > 0 ? "warn" : "") },
  afterLogistics: { key: "afterLogistics", label: "После логистики", num: true, fmt: fmt.rub, tone: (r) => (r.afterLogistics !== null && r.afterLogistics < 0 ? "bad" : "") },
  logShare: { key: "logShare", label: "Логистика, % продаж", num: true, fmt: fmt.pct, tone: (r) => (r.logShare > T.logisticsShare ? "warn" : "") },
  rating: { key: "rating", label: "Рейтинг", num: true, fmt: fmt.star },
  feedbacks: { key: "feedbacks", label: "Отзывов", num: true, fmt: fmt.int },
  negative: { key: "negative", label: "Негатив", num: true, fmt: fmt.int, tone: (r) => (r.negative > 0 ? "warn" : "") },
  photos: { key: "photos", label: "Фото", num: true, fmt: fmt.int, tone: (r) => (r.photos !== null && r.photos < T.minPhotos ? "bad" : "") },
  video: { key: "video", label: "Видео", fmt: (v) => (v === null ? "—" : v ? "есть" : "нет"), tone: (r) => (r.video === false ? "warn" : "") },
  descr: { key: "descriptionLength", label: "Описание, знаков", num: true, fmt: fmt.int, tone: (r) => (r.descriptionLength !== null && r.descriptionLength < T.minDescription ? "bad" : "") },
  chars: { key: "characteristics", label: "Характеристик", num: true, fmt: fmt.int, tone: (r) => (r.characteristics !== null && r.characteristics < T.minCharacteristics ? "bad" : "") },
};

/** Товары с проблемой этого сотрудника — для фильтра «только проблемные». */
function problemIds(s, agentId) {
  return new Set((s?.issues ?? []).filter((i) => i.owner === agentId).flatMap((i) => i.products.map((p) => p.nmId)));
}

export const ROLES = {
  director: {
    headline(s) {
      if (!s) return null;
      const high = s.issues.filter((i) => i.priority === "high");
      const loss = sum(s.issues.map((i) => i.impactRub));
      return high.length
        ? `Срочных задач: ${high.length}${loss ? `. Под угрозой ≈ ${rub(loss)} заказов в неделю` : ""}`
        : "Срочного нет — магазин в порядке";
    },
    charts: (s) => weeklyChart(s) + `<h4>Проблемы по сотрудникам</h4>` + hbars(Object.entries(s.issues.reduce((m, i) => ((m[i.owner] = (m[i.owner] ?? 0) + 1), m), {})).map(([k, v]) => ({ label: STAFF_NAME[k] ?? k, value: v })).sort((a, b) => b.value - a.value)),
    table: (s) => ({
      title: "Все проблемы магазина",
      rows: s.issues.map((i) => ({ ...i, priorityLabel: PRIORITY[i.priority], ownerName: STAFF_NAME[i.owner] ?? i.owner, productsCount: i.products.length, prio: { high: 3, medium: 2, low: 1 }[i.priority] })),
      columns: [
        { key: "prio", label: "Срочность", num: true, fmt: (_v, r) => r.priorityLabel, tone: (r) => ({ high: "bad", medium: "warn" })[r.priority] ?? "" },
        { key: "title", label: "Проблема", wide: true },
        { key: "ownerName", label: "Кто занимается" },
        { key: "impactRub", label: "Потери в неделю", num: true, fmt: fmt.rub },
        { key: "productsCount", label: "Товаров", num: true, fmt: fmt.int },
        { key: "action", label: "Что сделать", wide: true },
      ],
      sort: { key: "prio", dir: -1 },
    }),
  },
  analyst: {
    headline(s) {
      const o = kpi(s, "ordersSum");
      if (!o) return null;
      const down = s.products.filter((p) => (p.abc === "A" || p.abc === "B") && p.ordersDelta !== null && p.ordersDelta <= T.dropProduct);
      const d = o.delta;
      return `Заказы ${d === null || d === undefined ? "" : `${fmt.delta(d)} `}за ${s.period.days} дней — ${rub(o.value)}${down.length ? `. Тянут вниз товаров группы A/B: ${down.length}` : ""}`;
    },
    charts: (s) =>
      weeklyChart(s) +
      `<h4>Воронка магазина за период</h4>` +
      (() => {
        const opens = sum(s.products.map((p) => p.openCount));
        const carts = sum(s.products.map((p) => (p.openCount ?? 0) * ((p.addToCartPercent ?? 0) / 100)));
        const orders = sum(s.products.map((p) => p.orders));
        const buyouts = sum(s.products.map((p) => p.buyouts));
        return hbars(
          [
            { label: "Переходы в карточку", value: opens },
            { label: "Добавили в корзину", value: carts, sub: opens ? `${fmt.pct((carts / opens) * 100)} от переходов` : "" },
            { label: "Заказали", value: orders, sub: carts ? `${fmt.pct((orders / carts) * 100)} от корзин` : "" },
            { label: "Выкупили", value: buyouts, sub: orders ? `${fmt.pct((buyouts / orders) * 100)} от заказов` : "" },
          ],
          { unit: "шт", limit: 4 },
        );
      })(),
    table: (s) => ({
      title: "Продажи и воронка по товарам",
      rows: s.products,
      columns: [C.title, C.abc, C.ordersSum, C.ordersDelta, C.perDay, C.openCount, C.addToCart, C.cartToOrder, C.buyout],
      sort: { key: "ordersSum", dir: -1 },
    }),
  },
  finance: {
    headline(s) {
      const f = s?.finance;
      if (!f) return s ? "Финотчёта WB нет — нужна категория «Финансы» в ключе" : null;
      const kept = f.sales ? (f.wbKeptFromSales / f.sales) * 100 : null;
      return `На руки ≈ ${rub(f.netPayoutEstimate)}${kept !== null ? `. WB удержал ${fmt.pct(kept)} от продаж` : ""}`;
    },
    charts: (s) => {
      const f = s.finance;
      if (!f) return `<p class="muted">Финотчёт WB недоступен.</p>`;
      return (
        `<h4>Куда ушли деньги с продаж</h4>` +
        hbars(
          [
            { label: "Продажи", value: f.sales },
            { label: "К перечислению за товар", value: f.forPaySales - f.forPayReturns },
            { label: "Логистика", value: f.logistics },
            { label: "Хранение", value: f.storage },
            { label: "Платная приёмка", value: f.acceptance },
            { label: "Штрафы", value: f.penalties },
            { label: "Прочие удержания", value: f.deductions },
            { label: "На руки (оценка)", value: Math.max(0, f.netPayoutEstimate) },
          ],
          { unit: "₽", max: f.sales, limit: 8 },
        ) +
        `<p class="muted small">Финотчёт WB недельный — последние дни могут ещё не попасть. Себестоимости в WB нет: её можно записать в data/cost.json.</p>`
      );
    },
    table: (s) => ({
      title: "Деньги по товарам",
      rows: s.products.filter((p) => p.forPay !== null).map((p) => ({ ...p, logShare: p.buyoutsSum ? ((p.logistics ?? 0) / p.buyoutsSum) * 100 : null })),
      columns: [C.title, C.abc, { key: "buyoutsSum", label: "Выкупы, ₽", num: true, fmt: fmt.rub }, C.forPay, C.logistics, C.logShare, C.penalties, C.afterLogistics],
      sort: { key: "afterLogistics", dir: 1 },
      empty: "Финотчёт WB за период пуст или недоступен",
    }),
  },
  logist: {
    headline(s) {
      if (!s) return null;
      const out = s.products.filter((p) => p.stock === 0 && p.perDay > 0).length;
      const soon = s.products.filter((p) => p.stock > 0 && p.daysOfStock !== null && p.daysOfStock < T.lowStockDays && p.perDay > 0).length;
      return out || soon ? `${out ? `Закончились: ${out}. ` : ""}Кончатся раньше чем через ${T.lowStockDays} дней: ${soon}` : "Остатков хватает на ближайшие две недели";
    },
    charts: (s) =>
      `<h4>Остатки по складам WB</h4>` +
      hbars(s.warehouses.map((w) => ({ label: w.name, value: w.quantity })), { unit: "шт" }) +
      `<h4>Меньше всего дней запаса</h4>` +
      hbars(
        s.products
          .filter((p) => p.daysOfStock !== null && p.perDay > 0)
          .sort((a, b) => a.daysOfStock - b.daysOfStock)
          .map((p) => ({ label: p.title, value: p.daysOfStock, sub: `${nf.format(p.stock ?? 0)} шт, ${nf.format(Math.round(p.perDay * 10) / 10)} в день` })),
        { unit: "дн", max: T.overstockDays, limit: 6 },
      ),
    table: (s) => ({
      title: "Остатки по товарам",
      rows: s.products,
      columns: [C.title, C.abc, C.stock, C.inWay, C.perDay, C.days],
      sort: { key: "daysOfStock", dir: 1 },
    }),
  },
  marketer: {
    headline(s) {
      const d = kpi(s, "drr");
      if (!d || d.value === null) return s ? "Данных о рекламе нет — нужна категория «Продвижение» в ключе" : null;
      return `ДРР ${fmt.pct(d.value)} при норме до ${T.drrWarn}% — ${d.value > T.drrHigh ? "реклама съедает маржу" : d.value > T.drrWarn ? "дороговато, есть что срезать" : "в норме"}`;
    },
    charts: (s) =>
      s.ads
        ? `<h4>Расход по кампаниям</h4>` + hbars(s.ads.campaigns.map((c) => ({ label: c.campName, value: c.spent })), { unit: "₽" })
        : `<p class="muted">Нет данных о рекламе.</p>`,
    table: (s) => ({
      title: "Рекламные кампании",
      rows: (s.ads?.campaigns ?? []).map((c) => ({ ...c, share: s.ads.total ? (c.spent / s.ads.total) * 100 : null })),
      columns: [
        { key: "campName", label: "Кампания", wide: true },
        { key: "advertId", label: "ID" },
        { key: "spent", label: "Расход", num: true, fmt: fmt.rub },
        { key: "share", label: "Доля расходов", num: true, fmt: fmt.pct },
      ],
      sort: { key: "spent", dir: -1 },
      empty: "Нет данных о рекламе",
      product: false,
    }),
  },
  reviews: {
    headline(s) {
      const f = s?.feedbacks;
      if (!f) return s ? "Отзывы недоступны — нужна категория «Вопросы и отзывы» в ключе" : null;
      const r = kpi(s, "rating");
      return `Без ответа: отзывов ${f.unansweredFeedbacks}, вопросов ${f.unansweredQuestions}${r?.value ? `. Рейтинг продавца ${r.value}★` : ""}`;
    },
    charts: (s) =>
      `<h4>Негативные отзывы по товарам</h4>` +
      hbars(
        s.products.filter((p) => p.negative > 0).sort((a, b) => b.negative - a.negative).map((p) => ({ label: p.title, value: p.negative, sub: p.rating ? `рейтинг ${p.rating}★` : "" })),
        { unit: "шт" },
      ),
    table: (s) => ({
      title: "Негативные отзывы",
      rows: (s.feedbacks?.negative ?? []).map((f) => ({ ...f, status: f.answered ? "есть ответ" : "без ответа" })),
      columns: [
        { key: "createdDate", label: "Дата", fmt: fmt.date },
        { key: "rating", label: "Оценка", num: true, fmt: fmt.star, tone: (r) => (r.rating <= 2 ? "bad" : "warn") },
        { key: "product", label: "Товар" },
        { key: "text", label: "Отзыв", wide: true },
        { key: "cons", label: "Недостатки", wide: true },
        { key: "status", label: "Ответ", tone: (r) => (r.answered ? "ok" : "warn") },
      ],
      sort: { key: "createdDate", dir: -1 },
      empty: "Негативных отзывов нет",
      product: false,
    }),
  },
  content: {
    headline(s) {
      if (!s) return null;
      const weak = s.issues.find((i) => i.id === "weak_cards")?.products.length ?? 0;
      return weak ? `Слабых карточек: ${weak} — мало фото, короткое описание или пустые характеристики` : "Карточки заполнены по минимуму WB";
    },
    charts: (s) => {
      const withData = s.products.filter((p) => p.photos !== null);
      const n = withData.length || 1;
      const ok = (f) => withData.filter(f).length;
      return (
        `<h4>Заполненность карточек</h4>` +
        hbars(
          [
            { label: `Фото ≥ ${T.minPhotos}`, value: ok((p) => p.photos >= T.minPhotos), sub: `из ${withData.length}` },
            { label: "Есть видео", value: ok((p) => p.video), sub: `из ${withData.length}` },
            { label: `Описание ≥ ${T.minDescription} знаков`, value: ok((p) => p.descriptionLength >= T.minDescription), sub: `из ${withData.length}` },
            { label: `Характеристик ≥ ${T.minCharacteristics}`, value: ok((p) => p.characteristics >= T.minCharacteristics), sub: `из ${withData.length}` },
          ],
          { unit: "шт", max: n, limit: 4 },
        )
      );
    },
    table: (s) => ({
      title: "Карточки товаров",
      rows: s.products,
      columns: [C.title, C.abc, C.photos, C.video, C.descr, C.chars, C.addToCart, C.rating],
      sort: { key: "photos", dir: 1 },
    }),
  },
  scout: {
    headline: (s, ctx) => {
      const last = ctx.reports.find((r) => r.kind === "competitors");
      return last ? `Последняя проверка конкурентов: ${last.title}` : "Проверки конкурентов ещё не было — в Claude Code: /competitors <запросы>";
    },
    charts: () => `<p class="muted">Разведчик читает выдачу WB через браузер (/competitors) и, если подключён MPSTATS, продажи конкурентов. Его отчёты — во вкладке «Отчёты».</p>`,
    table: null,
  },
  reports: {
    headline: (_s, ctx) => `Готово отчётов: ${ctx.reports.length}`,
    charts: () => `<p class="muted">Отчётник собирает таблицу по запросу словами — например, «продажи по категориям за месяц». В Claude Code: «отчётник, …». Готовые отчёты — во вкладке «Отчёты».</p>`,
    table: (_s, ctx) => ({
      title: "Все отчёты",
      rows: ctx.reports.map((r) => ({ ...r, author: STAFF_NAME[r.agentId] ?? "—", format: r.path ? r.path.split(".").pop().toUpperCase() : "ответ" })),
      columns: [
        { key: "createdAt", label: "Дата", fmt: (v) => new Date(v).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) },
        { key: "title", label: "Отчёт", wide: true },
        { key: "author", label: "Автор" },
        { key: "format", label: "Формат" },
      ],
      sort: { key: "createdAt", dir: -1 },
      product: false,
      noSnapshot: true,
    }),
  },
};

export const STAFF_NAME = { director: "Директор", finance: "Финансист", analyst: "Аналитик", scout: "Разведчик", reviews: "Отзывы", logist: "Логист", marketer: "Маркетолог", content: "Контент", reports: "Отчётник" };

/** Главный вывод сотрудника — для подсказки в 3D и для монитора. */
export function headlineFor(agentId, s, ctx) {
  try {
    return ROLES[agentId]?.headline?.(s, ctx) ?? null;
  } catch {
    return null;
  }
}

/* ---------- Карточка товара ---------- */

export function productCardHtml(p, s) {
  const issues = (s?.issues ?? []).filter((i) => i.products.some((x) => x.nmId === p.nmId));
  const row = (label, v) => `<div class="kv"><span>${esc(label)}</span><b>${esc(v)}</b></div>`;
  const group = (title, rows) => `<section><h4>${esc(title)}</h4>${rows.join("")}</section>`;
  return `<div class="pcard">
    <h2>${esc(p.title)}</h2>
    <p class="sub">Артикул WB ${esc(p.nmId)} · ${esc(p.vendorCode)} · ${esc(p.subject)} · группа ${esc(p.abc)}</p>
    ${issues.length ? `<div class="pc-issues">${issues.map((i) => `<div class="issue"><span class="p p-${esc(i.priority)}">${esc(PRIORITY[i.priority])}</span> <b>${esc(i.title)}</b> <span class="muted">— ${esc(STAFF_NAME[i.owner] ?? i.owner)}</span><div class="a">${esc(i.action)}</div></div>`).join("")}</div>` : ""}
    <div class="pc-grid">
      ${group("Продажи", [row("Заказы", `${fmt.int(p.orders)} шт · ${fmt.rub(p.ordersSum)}`), row("К прошлому периоду", fmt.delta(p.ordersDelta)), row("Выкупы", `${fmt.int(p.buyouts)} шт · ${fmt.rub(p.buyoutsSum)}`), row("Выкуп", p.buyoutPercent > 100 ? `${fmt.pct(p.buyoutPercent)} (выкупили и прошлые заказы)` : fmt.pct(p.buyoutPercent)), row("Возвраты", fmt.int(p.returns))])}
      ${group("Остатки", [row("На складах WB", fmt.int(p.stock)), row("В пути к клиенту", fmt.int(p.inWayToClient)), row("Продаётся в день", fmt.int(p.perDay)), row("Хватит на", fmt.days(p.daysOfStock))])}
      ${group("Воронка", [row("Переходы", fmt.int(p.openCount)), row("В корзину", fmt.pct(p.addToCartPercent)), row("Корзина → заказ", fmt.pct(p.cartToOrderPercent))])}
      ${group("Деньги", [row("К перечислению", fmt.rub(p.forPay)), row("Логистика", fmt.rub(p.logistics)), row("Штрафы", fmt.rub(p.penalties)), row("После логистики", fmt.rub(p.afterLogistics))])}
      ${group("Карточка", [row("Фото", fmt.int(p.photos)), row("Видео", p.video === null ? "—" : p.video ? "есть" : "нет"), row("Описание", `${fmt.int(p.descriptionLength)} знаков`), row("Характеристик", fmt.int(p.characteristics))])}
      ${group("Отзывы", [row("Рейтинг", fmt.star(p.rating)), row("Отзывов", fmt.int(p.feedbacks)), row("Негативных", fmt.int(p.negative))])}
    </div>
  </div>`;
}

/* ---------- Сам рабочий стол ---------- */

const TABS = [
  ["summary", "Сводка"],
  ["table", "Таблица"],
  ["reports", "Отчёты"],
  ["dialog", "Диалог"],
];

/**
 * Рабочий стол живёт, пока открыт сотрудник. `update(ctx)` вызывается при любых
 * новых данных; вкладка перерисовывается, только если изменилось то, что она
 * показывает (иначе сбивались бы сортировка, прокрутка и набранный текст).
 */
export function createWorkspace(host, { onOpenProduct, onOpenReport, onAsk, onDecide }) {
  let ctx = null;
  let agentId = null;
  let tab = "summary";
  const keys = {};
  let table = null;

  host.innerHTML = `<header class="ws-head"></header>
    <nav class="ws-tabs" role="tablist">${TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}">${label}</button>`).join("")}</nav>
    <div class="ws-body"></div>`;
  const head = host.querySelector(".ws-head");
  const tabs = host.querySelector(".ws-tabs");
  const body = host.querySelector(".ws-body");
  attachChartTips(body);

  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    for (const k of Object.keys(keys)) delete keys[k];
    render();
  });
  body.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-nm]");
    if (row) return onOpenProduct(Number(row.dataset.nm));
    const rep = e.target.closest("[data-report]");
    if (rep) {
      e.preventDefault();
      return onOpenReport(rep.dataset.report);
    }
    const goto = e.target.closest("[data-goto]");
    if (goto) {
      tab = goto.dataset.goto;
      for (const k of Object.keys(keys)) delete keys[k];
      return render();
    }
    const dec = e.target.closest("[data-approve],[data-reject]");
    if (dec && !dec.disabled) {
      dec.disabled = true;
      onDecide(dec.dataset.approve || dec.dataset.reject, dec.dataset.approve ? "approve" : "reject").finally(() => (dec.disabled = false));
    }
    const only = e.target.closest(".only-problems");
    if (only) render(true);
  });
  body.addEventListener("submit", async (e) => {
    if (!e.target.matches(".ask")) return;
    e.preventDefault();
    const q = new FormData(e.target).get("q");
    if (q && (await onAsk(agentId, String(q)))) e.target.reset();
  });

  function headHtml() {
    const a = ctx.agent;
    const s = ctx.snapshot;
    const h = headlineFor(a.id, s, ctx);
    const stats = (s?.desks?.[a.id] ?? []).map((d) => `<span class="stat ${esc(d.tone)}">${esc(d.label)}: <b>${esc(d.value)}</b></span>`).join("");
    const waiting = ctx.approvals.filter((x) => x.agentId === a.id && x.status === "pending").length;
    return `<div class="ws-who"><span class="avatar big" style="background:${esc(ctx.color)}">${esc(a.name[0])}</span>
      <div><h2>${esc(a.name)} <span class="ws-title">${esc(a.title)}</span></h2>
      <p class="st"><span class="dot ${esc(a.status)}"></span>${esc(a.status === "idle" ? "отдыхает" : a.activity || a.status)}${waiting ? ` · <b class="t-warn">ждёт вашего решения: ${waiting}</b>` : ""}</p></div></div>
      ${h ? `<p class="headline">${esc(h)}</p>` : `<p class="headline muted">${s ? "" : "Данных WB пока нет: впишите ключ (/setup) или откройте демо."}</p>`}
      <div class="stats">${stats}</div>`;
  }

  function summaryHtml() {
    const a = ctx.agent;
    const s = ctx.snapshot;
    const role = ROLES[a.id];
    const issues = (s?.issues ?? []).filter((i) => i.owner === a.id || (a.id === "director" && i.priority === "high"));
    const appr = ctx.approvals.filter((x) => x.agentId === a.id).slice(0, 5);
    let charts = "";
    try {
      charts = s && role?.charts ? role.charts(s, ctx) : "";
    } catch (err) {
      console.error(err);
    }
    return `${appr.length ? `<h3>Решения</h3>${appr.map(ctx.approvalHtml).join("")}` : ""}
      ${charts ? `<div class="ws-charts">${charts}</div>` : ""}
      <h3>${a.id === "director" ? "Срочное по магазину" : "Что нашёл в магазине"}</h3>
      ${issues.length ? issues.map((i) => `<div class="issue"><div><span class="p p-${esc(i.priority)}">${esc(PRIORITY[i.priority])}</span><span class="t">${esc(i.title)}</span>${i.impactRub ? ` <span class="muted">≈ ${esc(rub(i.impactRub))} в неделю</span>` : ""}</div>
        <div class="d">${esc(i.detail)}</div><div class="a">→ ${esc(i.action)}</div>
        ${i.products?.length ? `<div class="prods">${i.products.slice(0, 6).map((p) => `<button type="button" class="chip" data-nm-open="${esc(p.nmId)}">${esc(p.title)}</button>`).join("")}${i.products.length > 6 ? ` <span class="muted">и ещё ${i.products.length - 6}</span>` : ""}</div>` : ""}</div>`).join("") : `<p class="muted">${s ? "По его участку проблем нет." : "Данных WB пока нет."}</p>`}
      ${role?.table ? `<p><button type="button" class="btn" data-goto="table">Открыть таблицу →</button></p>` : ""}`;
  }

  function reportsHtml() {
    const mine = ["director", "reports"].includes(ctx.agent.id) ? ctx.reports : ctx.reports.filter((r) => r.agentId === ctx.agent.id);
    if (!mine.length) return `<p class="muted">Отчётов пока нет. В Claude Code: /audit (аудит), /office (план офиса), /competitors (конкуренты), /card (карточка).</p>`;
    return `<ul class="rep-list">${mine
      .map(
        (r) => `<li><button type="button" class="rep" data-report="${esc(r.id)}">
          <span class="rep-t">${esc(r.title)}</span>
          <span class="muted">${esc(new Date(r.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))} · ${esc(STAFF_NAME[r.agentId] ?? "")}${r.summary?.issues !== undefined ? ` · проблем ${esc(r.summary.issues)}, срочных ${esc(r.summary.high)}` : ""}</span>
        </button></li>`,
      )
      .join("")}</ul>`;
  }

  function dialogHtml() {
    const a = ctx.agent;
    const tasks = ctx.tasks.filter((t) => t.agentId === a.id).slice(0, 10);
    const reportById = new Map(ctx.reports.map((r) => [r.id, r]));
    const steps = ctx.events.filter((e) => e.agentId === a.id).slice(-12).reverse();
    const ask = ctx.mode.canAsk
      ? `<form class="ask"><textarea name="q" maxlength="2000" placeholder="Например: ${esc(ctx.example)}" required></textarea>
         <div class="row"><span class="muted">Ответ появится здесь и в ленте</span><button class="btn primary" type="submit">Спросить</button></div></form>`
      : `<div class="hint-box">Спросите в Claude Code (в папке набора), например: <b>«${esc(a.title)}, ${esc(ctx.example)}»</b> или командой <b>/office</b>. Здесь будет видно, как сотрудник работает, а его отчёты появятся во вкладке «Отчёты».
         <div class="muted small">Задавать вопросы прямо отсюда можно с ключом Claude API — см. README.</div></div>`;
    return `${ask}
      ${tasks.length ? `<h3>Вопросы и ответы</h3>${tasks.map((t) => {
        const ans = t.resultReportId ? reportById.get(t.resultReportId)?.summary?.text : null;
        return `<div class="qa"><div class="q">${esc(t.question)}</div>${ans ? `<div class="answer">${esc(ans)}</div>` : `<div class="muted">${esc({ queued: "в очереди", running: "работает…", failed: "не получилось", cancelled: "отменено", done: "готово" }[t.status] ?? t.status)}</div>`}</div>`;
      }).join("")}` : ""}
      <h3>Последние шаги</h3>
      <ul class="list">${steps.length ? steps.map((e) => `<li><span class="muted">${esc(new Date(e.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }))}</span> ${esc(e.message)}</li>`).join("") : `<li class="muted">Пока ничего</li>`}</ul>`;
  }

  /** Перерисовать то, что изменилось. force — пересобрать таблицу (переключили фильтр). */
  function render(force = false) {
    if (!ctx) return;
    for (const b of tabs.querySelectorAll("[data-tab]")) {
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
      if (b.dataset.tab === "table") b.hidden = !ROLES[ctx.agent.id]?.table;
    }
    if (tab === "table" && !ROLES[ctx.agent.id]?.table) tab = "summary";

    const hh = headHtml();
    if (keys.head !== hh) {
      keys.head = hh;
      head.innerHTML = hh;
    }

    const s = ctx.snapshot;
    if (tab === "summary") {
      const k = JSON.stringify([agentId, ctx.snapshotId, ctx.approvals.filter((x) => x.agentId === agentId), ctx.reports.length]);
      if (keys.body !== k) {
        keys.body = k;
        body.innerHTML = summaryHtml();
        table = null;
      }
    } else if (tab === "table") {
      const def = ROLES[agentId].table(s ?? { products: [], issues: [] }, ctx);
      const k = JSON.stringify([agentId, ctx.snapshotId, def.noSnapshot ? ctx.reports.length : 0]);
      const onlyBox = body.querySelector(".only-problems input");
      const only = onlyBox?.checked ?? false;
      if (keys.body !== k || force || !table) {
        keys.body = k;
        const pids = problemIds(s, agentId);
        const productTable = def.product !== false && !def.noSnapshot;
        if (!s && !def.noSnapshot) {
          body.innerHTML = `<p class="muted">Данных WB пока нет.</p>`;
          table = null;
          return;
        }
        body.innerHTML = `<div class="ws-table-head"><h3>${esc(def.title)}</h3>${productTable && pids.size ? `<label class="only-problems"><input type="checkbox" ${only ? "checked" : ""}> только проблемные (${pids.size})</label>` : ""}</div>
          ${productTable ? `<p class="muted small">Щёлкните строку — откроется карточка товара со всеми цифрами.</p>` : ""}<div class="tbl-host"></div>`;
        const rows = only ? def.rows.filter((r) => pids.has(r.nmId)) : def.rows;
        table = createTable(body.querySelector(".tbl-host"), { ...def, rows, filename: `${STAFF_NAME[agentId]} — ${def.title}`, rowNm: productTable ? (r) => r.nmId : undefined });
      }
    } else if (tab === "reports") {
      const k = JSON.stringify([agentId, ctx.reports.map((r) => [r.id, r.summary?.issues])]);
      if (keys.body !== k) {
        keys.body = k;
        body.innerHTML = reportsHtml();
      }
    } else {
      const k = JSON.stringify([agentId, ctx.mode.canAsk, ctx.tasks.filter((t) => t.agentId === agentId), ctx.events.filter((e) => e.agentId === agentId).slice(-12).map((e) => e.seq), ctx.reports.length]);
      if (keys.body !== k) {
        keys.body = k;
        // Набранный вопрос не теряем при обновлении.
        const ta = body.querySelector("textarea");
        const keep = ta ? { v: ta.value, f: document.activeElement === ta } : null;
        body.innerHTML = dialogHtml();
        const n = body.querySelector("textarea");
        if (keep && n) {
          n.value = keep.v;
          if (keep.f) n.focus();
        }
      }
    }
  }

  // Клик по «чипу» товара в сводке — карточка товара.
  body.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-nm-open]");
    if (chip) onOpenProduct(Number(chip.dataset.nmOpen));
  });

  return {
    open(id, nextTab) {
      if (id !== agentId) {
        agentId = id;
        tab = nextTab ?? "summary";
        for (const k of Object.keys(keys)) delete keys[k];
        host.scrollTop = 0;
      } else if (nextTab && nextTab !== tab) {
        tab = nextTab;
        for (const k of Object.keys(keys)) delete keys[k];
      }
    },
    update(next) {
      ctx = next;
      render();
    },
    get agentId() {
      return agentId;
    },
  };
}

