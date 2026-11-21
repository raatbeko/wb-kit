/**
 * Excel-версия аудита: те же данные, что в HTML, но в таблицах, которые можно
 * фильтровать, сортировать и дописывать (например, себестоимость).
 */
import ExcelJS from "exceljs";
import type { AuditReport } from "./analyze.js";

const RUB = '#,##0" ₽"';
const INT = "#,##0";
const PCT = '0.0"%"';
const PRIORITY = { high: "Срочно", medium: "Важно", low: "Можно позже" } as const;

type Col = { header: string; key: string; width: number; numFmt?: string };

function sheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
  for (const r of rows) ws.addRow(r);
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEEEA" } };
  head.alignment = { vertical: "middle", wrapText: true };
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

export async function renderXlsx(r: AuditReport, file: string): Promise<void> {
  const d = r.data;
  const wb = new ExcelJS.Workbook();
  wb.creator = "wb-kit";
  wb.created = new Date(d.generatedAt);

  // Сводка: показатели и список проблем.
  const sum = wb.addWorksheet("Сводка");
  sum.columns = [{ width: 34 }, { width: 22 }, { width: 18 }, { width: 70 }];
  sum.addRow([`Аудит кабинета WB${d.demo ? " (ДЕМО)" : ""}`]).font = { bold: true, size: 14 };
  sum.addRow([`Период: ${d.period.from} — ${d.period.to} (${d.period.days} дн.), сравнение с ${d.previous.from} — ${d.previous.to}`]);
  sum.addRow([]);
  sum.addRow(["Показатель", "Значение", "К прошлому периоду", "Пояснение"]).font = { bold: true };
  for (const k of r.kpis) {
    const row = sum.addRow([k.label, k.value, k.delta === undefined || k.delta === null ? null : k.delta, k.hint ?? ""]);
    row.getCell(2).numFmt = k.unit === "₽" ? RUB : k.unit === "%" ? PCT : k.unit === "★" ? "0.00" : INT;
    row.getCell(3).numFmt = '+0.0"%";-0.0"%"';
  }
  sum.addRow([]);
  sum.addRow(["Что сделать", "Важность", "", "Действие"]).font = { bold: true };
  for (const i of r.issues) {
    const row = sum.addRow([i.title, PRIORITY[i.priority], "", i.action]);
    row.alignment = { wrapText: true, vertical: "top" };
  }
  if (r.unavailable.length) {
    sum.addRow([]);
    sum.addRow(["Нет в отчёте", "Причина"]).font = { bold: true };
    for (const u of r.unavailable) sum.addRow([u.section, u.reason]);
  }

  sheet(
    wb,
    "Товары",
    [
      { header: "Артикул WB", key: "nmId", width: 13 },
      { header: "Артикул продавца", key: "vendorCode", width: 20 },
      { header: "Название", key: "title", width: 34 },
      { header: "Предмет", key: "subject", width: 16 },
      { header: "ABC", key: "abc", width: 6 },
      { header: "Заказы, шт", key: "orders", width: 11, numFmt: INT },
      { header: "Заказы, ₽", key: "ordersSum", width: 13, numFmt: RUB },
      { header: "К прошлому периоду, %", key: "ordersDelta", width: 12, numFmt: PCT },
      { header: "Выкупы, шт", key: "buyouts", width: 11, numFmt: INT },
      { header: "Выкупы, ₽", key: "buyoutsSum", width: 13, numFmt: RUB },
      { header: "Возвраты, шт", key: "returns", width: 11, numFmt: INT },
      { header: "Выкуп, %", key: "buyoutPercent", width: 10, numFmt: PCT },
      { header: "Заказов в день", key: "perDay", width: 10, numFmt: "0.0" },
      { header: "Остаток WB, шт", key: "stock", width: 11, numFmt: INT },
      { header: "Дней запаса", key: "daysOfStock", width: 10, numFmt: INT },
      { header: "Переходы", key: "openCount", width: 11, numFmt: INT },
      { header: "В корзину, %", key: "addToCartPercent", width: 10, numFmt: PCT },
      { header: "Корзина → заказ, %", key: "cartToOrderPercent", width: 11, numFmt: PCT },
      { header: "Рейтинг", key: "rating", width: 8, numFmt: "0.0" },
      { header: "Отзывов", key: "feedbacks", width: 8, numFmt: INT },
      { header: "Негативных", key: "negative", width: 10, numFmt: INT },
      { header: "К перечислению, ₽", key: "forPay", width: 14, numFmt: RUB },
      { header: "Логистика, ₽", key: "logistics", width: 12, numFmt: RUB },
      { header: "Штрафы, ₽", key: "penalties", width: 10, numFmt: RUB },
      { header: "После логистики, ₽", key: "afterLogistics", width: 14, numFmt: RUB },
      { header: "Продано (финотчёт), шт", key: "soldUnits", width: 11, numFmt: INT },
      { header: "Средняя цена, ₽", key: "avgPrice", width: 12, numFmt: RUB },
      { header: "Логистика на штуку, ₽", key: "logisticsPerUnit", width: 12, numFmt: RUB },
      { header: "Себестоимость, ₽", key: "cost", width: 13, numFmt: RUB },
      { header: "Прибыль до рекламы, ₽", key: "profit", width: 14, numFmt: RUB },
      { header: "Прибыль на штуку, ₽", key: "profitPerUnit", width: 12, numFmt: RUB },
      { header: "Маржа, %", key: "margin", width: 9, numFmt: PCT },
      { header: "Минимальная цена, ₽", key: "minPrice", width: 12, numFmt: RUB },
      { header: "Фото", key: "photos", width: 6 },
      { header: "Видео", key: "video", width: 7 },
      { header: "Описание, симв.", key: "descriptionLength", width: 10, numFmt: INT },
      { header: "Характеристик", key: "characteristics", width: 10 },
    ],
    r.products.map((p) => ({ ...p, video: p.video === null ? null : p.video ? "да" : "нет" })),
  );

  if (d.abc.ok) {
    sheet(
      wb,
      "ABC",
      [
        { header: "Артикул WB", key: "nmId", width: 13 },
        { header: "Артикул продавца", key: "vendorCode", width: 20 },
        { header: "Предмет", key: "subject", width: 18 },
        { header: "Класс", key: "class", width: 7 },
        { header: "Выручка, ₽", key: "revenue", width: 14, numFmt: RUB },
        { header: "Доля, %", key: "revenueShare", width: 9, numFmt: PCT },
        { header: "Выкупы, шт", key: "buyouts", width: 11, numFmt: INT },
      ],
      d.abc.data.items,
    );
  }

  if (d.finance.ok) {
    const t = d.finance.data.totals;
    const ws = wb.addWorksheet("Деньги");
    ws.columns = [{ width: 44 }, { width: 18 }];
    ws.addRow(["Статья", "Сумма"]).font = { bold: true };
    const lines: [string, number][] = [
      ["Продажи (по цене со скидкой)", t.sales],
      ["Возвраты", -t.returns],
      ["Удержал WB с продаж (комиссия, эквайринг)", -t.wbKeptFromSales],
      ["Логистика", -t.logistics],
      ["Хранение", -t.storage],
      ["Платная приёмка", -t.acceptance],
      ["Штрафы", -t.penalties],
      ["Прочие удержания", -t.deductions],
      ["Доплаты от WB", t.additionalPayments],
      ["На руки (оценка, до себестоимости, налогов и рекламы)", t.netPayoutEstimate],
    ];
    const e = r.economics;
    if (e) {
      if (e.ads !== null) lines.push(["Реклама", -e.ads]);
      if (e.costOfGoods !== null) lines.push(["Себестоимость проданного", -e.costOfGoods], ["Налог", -(e.tax ?? 0)]);
      lines.push([e.profit !== null ? `Прибыль${e.costCoverage < 100 ? ` (себестоимость есть для ${e.costCoverage}% выручки)` : ""}` : "После WB и рекламы (себестоимость не вписана)", e.profit ?? e.afterWbAndAds]);
    }
    for (const [a, b] of lines) ws.addRow([a, b]).getCell(2).numFmt = RUB;
    ws.getRow(ws.rowCount).font = { bold: true };
  }

  if (r.months.some((m) => !m.unavailable)) {
    const days = (m: (typeof r.months)[number]) => Math.round((Date.parse(m.to) - Date.parse(m.from)) / 86_400_000) + 1;
    sheet(wb, "По месяцам", [
      { header: "Месяц", key: "label", width: 22 },
      { header: "Период", key: "period", width: 24 },
      { header: "Выручка", key: "revenue", width: 14, numFmt: RUB },
      { header: "Продано, шт", key: "soldUnits", width: 12 },
      { header: "На руки по финотчёту", key: "payout", width: 16, numFmt: RUB },
      { header: "Реклама", key: "ads", width: 14, numFmt: RUB },
      { header: "Себестоимость", key: "costOfGoods", width: 15, numFmt: RUB },
      { header: "Налог", key: "tax", width: 12, numFmt: RUB },
      { header: "Прибыль (или после WB и рекламы)", key: "result", width: 18, numFmt: RUB },
      { header: "Маржа", key: "margin", width: 9, numFmt: PCT },
      { header: "В день", key: "perDay", width: 12, numFmt: RUB },
      { header: "Примечание", key: "note", width: 50 },
    ], r.months.map((m) => {
      const result = m.unavailable ? null : (m.profit ?? m.afterWbAndAds);
      return {
        label: m.label,
        period: `${m.from} — ${m.to}`,
        revenue: m.unavailable ? null : m.revenue,
        soldUnits: m.unavailable ? null : m.soldUnits,
        payout: m.unavailable ? null : m.payout,
        ads: m.ads,
        costOfGoods: m.costOfGoods,
        tax: m.tax,
        result,
        margin: m.margin,
        perDay: result === null ? null : Math.round(result / days(m)),
        note: m.unavailable ? `нет данных: ${m.unavailable}` : [m.partial ? "месяц ещё идёт" : "", m.profit === null ? "себестоимость не вписана — до себестоимости" : m.costCoverage < 100 ? `себестоимость есть для ${m.costCoverage}% выручки` : ""].filter(Boolean).join("; "),
      };
    }));
  }

  if (d.feedbacks.ok) {
    sheet(
      wb,
      "Негативные отзывы",
      [
        { header: "Дата", key: "createdDate", width: 12 },
        { header: "Оценка", key: "rating", width: 8 },
        { header: "Артикул продавца", key: "vendorCode", width: 20 },
        { header: "Товар", key: "product", width: 30 },
        { header: "Текст", key: "text", width: 70 },
        { header: "Недостатки", key: "cons", width: 40 },
        { header: "Есть ответ", key: "answered", width: 10 },
      ],
      r.negativeFeedbacks.map((f) => ({ ...f, createdDate: f.createdDate.slice(0, 10), answered: f.answered ? "да" : "нет" })),
    );
  }

  if (d.ads.ok) {
    sheet(
      wb,
      "Реклама",
      [
        { header: "ID кампании", key: "advertId", width: 13 },
        { header: "Кампания", key: "campName", width: 40 },
        { header: "Потрачено, ₽", key: "spent", width: 14, numFmt: RUB },
      ],
      d.ads.data.campaigns,
    );
  }

  await wb.xlsx.writeFile(file);
}
