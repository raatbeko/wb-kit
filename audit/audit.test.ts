import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createDemoClient } from "./demo.js";
import { collectAudit, weekStart, weeklySeries, explainFailure, monthRanges, type AuditData } from "./collect.js";
import { DEMO_COSTS } from "./demo.js";
import { parseCostCsv, serializeCostCsv, mergeCostRows } from "./cost.js";
import { buildReport, summaryForClaude, median, type AuditReport } from "./analyze.js";
import { renderHtml, markdownToHtml } from "./render-html.js";
import { renderXlsx } from "./render-xlsx.js";
import { HOSTS, type WBClient } from "../mcp/wb/src/client.js";

// Фиксированная дата: демо и отчёт не зависят от дня запуска теста.
const NOW = new Date("2026-11-18T12:00:00Z");

let data: AuditData;
let report: AuditReport;

beforeAll(async () => {
  data = await collectAudit(createDemoClient(NOW), { now: NOW, demo: true, costs: DEMO_COSTS });
  report = buildReport(data);
});

describe("аудит на демо-магазине", () => {
  it("все разделы собраны", () => {
    expect(report.unavailable).toEqual([]);
    expect(data.period).toEqual({ from: "2026-10-19", to: "2026-11-17", days: 30 });
    expect(data.previous).toEqual({ from: "2026-09-19", to: "2026-10-18", days: 30 });
  });

  it("находит проблемы, заложенные в демо", () => {
    const byId = Object.fromEntries(report.issues.map((i) => [i.id, i.products.map((p) => p.vendorCode)]));
    expect(byId["out_of_stock"]).toContain("PLAID-BEIGE-200");
    expect(byId["overstock"]).toEqual(expect.arrayContaining(["TOWEL-SET-3", "BOX-STORAGE-3"]));
    expect(byId["dead_stock"]).toEqual(expect.arrayContaining(["LAMP-NIGHT", "FRAME-PHOTO-A4"]));
    expect(byId["weak_cart_conversion"]).toContain("MUG-CERAMIC-400");
    expect(byId["low_buyout"]).toContain("SLIPPERS-38-39");
    expect(byId["negative_feedback"]).toContain("ORGANIZER-6");
    expect(byId["weak_cards"]).toEqual(expect.arrayContaining(["MUG-CERAMIC-400", "APRON-COTTON"]));
    expect(byId["sales_drop"]).toContain("BLANKET-KIDS");
    expect(Object.keys(byId)).toContain("high_drr");
    expect(byId["unprofitable"]).toEqual(expect.arrayContaining(["SLIPPERS-38-39", "ORGANIZER-6"]));
  });

  it("срочные проблемы идут первыми", () => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    const ranks = report.issues.map((i) => order[i.priority]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("ABC-классы проставлены в таблице товаров, хиты — в A", () => {
    const top = report.products[0]!;
    expect(top.abc).toBe("A");
    expect(report.products.filter((p) => p.abc === "A").length).toBeGreaterThan(0);
  });

  it("выжимка для Claude компактная и без имён покупателей", () => {
    const s = JSON.stringify(summaryForClaude(report));
    expect(s.length).toBeLessThan(60_000);
    expect(s).not.toContain("Покупатель");
  });
});

describe("раздел без доступа не роняет аудит", () => {
  it("401 в финансах → раздел недоступен с понятной причиной, остальное собрано", async () => {
    const demo = createDemoClient(NOW);
    const failing = {
      ...demo,
      post: async (host: string, path: string, body?: unknown, q?: unknown, o?: unknown) => {
        if (host === HOSTS.finance) throw new Error(`WB API POST ${HOSTS.finance}${path} → 401: unauthorized`);
        return (demo.post as (...a: unknown[]) => Promise<unknown>)(host, path, body, q, o);
      },
    } as unknown as WBClient;
    const d = await collectAudit(failing, { now: NOW, demo: true });
    const r = buildReport(d);
    expect(d.finance.ok).toBe(false);
    expect(r.unavailable).toEqual([{ section: "Деньги", reason: "нет доступа: в ключе WB нет категории «Финансы»" }]);
    expect(d.sales.ok && d.funnel.ok && d.stocks.ok).toBe(true);
    expect(renderHtml(r)).toContain("Чего нет в отчёте");
  });

  it("explainFailure переводит частые ошибки на человеческий", () => {
    expect(explainFailure(new Error(`WB API GET ${HOSTS.advert}/adv/v1/upd → 401: x`))).toMatch(/Продвижение/);
    expect(explainFailure(new Error("WB API GET x → 429: slow down"))).toMatch(/частоту/);
  });
});

describe("HTML", () => {
  it("экранирует текст из WB: отзыв не может внедрить скрипт", () => {
    const evil = structuredClone(data);
    if (evil.feedbacks.ok) evil.feedbacks.data.list[0] = { ...evil.feedbacks.data.list[0]!, rating: 1, text: "<script>alert(1)</script>" };
    const html = renderHtml(buildReport(evil));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("выводы Claude попадают в начало отчёта, без них блока нет", () => {
    expect(renderHtml(report)).not.toContain('class="insights"');
    const html = renderHtml(report, "### Главное\n- **Плед** закончился");
    expect(html).toContain('class="insights"');
    expect(html.indexOf("insights")).toBeLessThan(html.indexOf("Что сделать"));
  });

  it("мини-markdown: заголовки, списки, жирный, экранирование", () => {
    expect(markdownToHtml("### Итог\n- раз\n- **два**\n\n1. три\n<b>x</b>")).toBe(
      "<h3>Итог</h3>\n<ul>\n<li>раз</li>\n<li><strong>два</strong></li>\n</ul>\n<ol>\n<li>три</li>\n</ol>\n<p>&lt;b&gt;x&lt;/b&gt;</p>",
    );
  });

  it("демо помечено как демо", () => {
    expect(renderHtml(report)).toContain("ДЕМО");
  });
});

describe("Excel", () => {
  it("пишет книгу с листами отчёта", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "wbkit-")), "a.xlsx");
    await renderXlsx(report, file);
    expect(existsSync(file)).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Сводка", "Товары", "ABC", "Деньги", "По месяцам", "Негативные отзывы", "Реклама"]);
    expect(wb.getWorksheet("Товары")!.rowCount).toBe(report.products.length + 1);
  });
});

describe("помощники", () => {
  it("неделя начинается с понедельника", () => {
    expect(weekStart("2026-11-18")).toBe("2026-11-16"); // среда → понедельник
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect(weekStart("2026-11-22")).toBe("2026-11-16"); // воскресенье
  });
  it("недельный ряд: возвраты не считаются выкупами", () => {
    const w = weeklySeries(
      [{ date: "2026-11-16T10:00:00", priceWithDisc: 100 }],
      [{ date: "2026-11-17T10:00:00", saleID: "S1", priceWithDisc: 100 }, { date: "2026-11-17T11:00:00", saleID: "R1", priceWithDisc: -100 }],
      "2026-11-16",
      "2026-11-22",
    );
    expect(w).toEqual([{ weekStart: "2026-11-16", orders: 1, ordersSum: 100, buyouts: 1, buyoutsSum: 100 }]);
  });
  it("медиана", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("окончания", async () => {
  const { plural } = await import("./analyze.js");
  it("1 отзыв, 2 отзыва, 5 отзывов, 11 отзывов, 21 отзыв", () => {
    expect([1, 2, 5, 11, 21, 104].map((n) => plural(n, "отзыв", "отзыва", "отзывов"))).toEqual([
      "1 отзыв", "2 отзыва", "5 отзывов", "11 отзывов", "21 отзыв", "104 отзыва",
    ]);
  });
});

describe("деньги: прибыль, ДРР, себестоимость", () => {
  it("прибыль магазина сходится: на руки − реклама − себестоимость − налог", () => {
    const e = report.economics!;
    expect(e.profit).toBeCloseTo(e.payout - e.ads! - e.costOfGoods! - e.tax!, 0);
    expect(e.breakEvenIsUpperBound).toBe(false);
    expect(e.missingCost).toBe(2); // у двух демо-товаров себестоимость не вписана
  });

  it("ДРР считается к выкупам, а не к заказам", () => {
    const e = report.economics!;
    const s = data.sales.ok ? data.sales.data.current.totals : null;
    expect(e.drrBuyouts).toBeCloseTo((e.ads! / s!.buyoutsSum) * 100, 1);
    expect(e.drrBuyouts!).toBeGreaterThan((e.ads! / s!.ordersSum) * 100);
  });

  it("минимальная цена убыточного товара выше текущей", () => {
    const slippers = report.products.find((p) => p.vendorCode === "SLIPPERS-38-39")!;
    expect(slippers.profit!).toBeLessThan(0);
    expect(slippers.minPrice!).toBeGreaterThan(slippers.avgPrice!);
  });

  it("без себестоимости прибыль не выдумывается, а отчёт просит её вписать", () => {
    const r = buildReport({ ...data, costs: null });
    expect(r.economics!.profit).toBeNull();
    expect(r.economics!.breakEvenIsUpperBound).toBe(true);
    expect(r.issues.map((i) => i.id)).toContain("no_costs");
    expect(r.issues.map((i) => i.id)).not.toContain("unprofitable");
    expect(r.kpis.find((k) => k.tier === 1)!.key).toBe("afterWbAndAds");
    expect(renderHtml(r)).toContain("После WB и рекламы");
  });

  it("пустой отчёт об остатках (FBS) не объявляет все товары закончившимися", () => {
    const fbs = structuredClone(data);
    if (fbs.stocks.ok) fbs.stocks.data = { products: [], total: 0 };
    const r = buildReport(fbs);
    expect(r.issues.map((i) => i.id)).not.toContain("out_of_stock");
  });
});

describe("деньги по месяцам", () => {
  it("три календарных месяца, последний — неполный, по вчера", () => {
    expect(monthRanges("2026-11-17", 3)).toEqual([
      { month: "2026-09", from: "2026-09-01", to: "2026-09-30", partial: false },
      { month: "2026-10", from: "2026-10-01", to: "2026-10-31", partial: false },
      { month: "2026-11", from: "2026-11-01", to: "2026-11-17", partial: true },
    ]);
    expect(monthRanges("2026-02-28", 2).map((m) => [m.month, m.to, m.partial])).toEqual([["2026-01", "2026-01-31", false], ["2026-02", "2026-02-28", false]]);
    expect(monthRanges("2027-01-05", 2)[0]!.month).toBe("2026-12");
  });

  it("каждый месяц считается так же, как «Деньги»: на руки − реклама − себестоимость − налог", () => {
    expect(report.months.map((m) => m.label)).toEqual(["Сентябрь 2026", "Октябрь 2026", "Ноябрь 2026"]);
    for (const m of report.months) {
      expect(m.unavailable).toBeNull();
      expect(m.revenue).toBeGreaterThan(0);
      expect(m.profit!).toBeCloseTo(m.payout - m.ads! - m.costOfGoods! - m.tax!, 0);
    }
    expect(report.months.at(-1)!.partial).toBe(true);
  });

  it("в HTML есть таблица по месяцам, без себестоимости — «после WB и рекламы»", () => {
    const html = renderHtml(report);
    expect(html).toContain("По месяцам");
    expect(html).toContain("Октябрь 2026");
    const noCost = renderHtml(buildReport({ ...data, costs: null }));
    expect(noCost).toMatch(/class="months"[\s\S]*После WB и рекламы/);
  });

  it("старый data.json без месяцев и раздел без доступа не ломают отчёт", () => {
    const old = buildReport({ ...data, months: undefined });
    expect(old.months).toEqual([]);
    expect(renderHtml(old)).not.toContain("По месяцам");
    const denied = structuredClone(data);
    denied.months![0] = { ...denied.months![0]!, finance: { ok: false, reason: "нет доступа" } };
    expect(renderHtml(buildReport(denied))).toContain("нет данных: нет доступа");
  });
});

describe("data/cost.csv", () => {
  it("читает файл из русского Excel: BOM, «;», запятая в дробях, ₽, кавычки", () => {
    const rows = parseCostCsv('﻿Артикул WB;Артикул продавца;Название;Себестоимость, ₽;Налог, %\r\n101;A-1;"Плед; серый";450,5 ₽;6\r\n102;A-2;Кружка;;\r\n');
    expect(rows).toEqual([
      { nmId: 101, vendorCode: "A-1", title: "Плед; серый", cost: 450.5, taxPercent: 6 },
      { nmId: 102, vendorCode: "A-2", title: "Кружка", cost: null, taxPercent: null },
    ]);
  });
  it("запись и чтение обратно дают то же самое", () => {
    const rows = [{ nmId: 1, vendorCode: "X;1", title: "Т \"кавычки\"", cost: 12.5, taxPercent: 6 }];
    expect(parseCostCsv(serializeCostCsv(rows))).toEqual(rows);
  });
  it("дописывает только новые товары и не трогает вписанные цифры", () => {
    const { rows, added } = mergeCostRows([{ nmId: 1, vendorCode: "A", title: "a", cost: 100, taxPercent: 6 }], [
      { nmId: 1, vendorCode: "A", title: "a" },
      { nmId: 2, vendorCode: "B", title: "b" },
    ]);
    expect(added).toBe(1);
    expect(rows).toEqual([
      { nmId: 1, vendorCode: "A", title: "a", cost: 100, taxPercent: 6 },
      { nmId: 2, vendorCode: "B", title: "b", cost: null, taxPercent: 6 },
    ]);
  });
});
