import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { demoCompetitorInput } from "./demo.js";
import { buildCompetitorReport, competitorSummary, quantile, type SearchSnapshot } from "./analyze.js";
import { CardFetcher, cardUrl, guessBasket, parseCard } from "./cdn.js";
import { renderCompetitorHtml, renderCompetitorXlsx } from "./render.js";
import { previousFor, validateSnapshot } from "../scripts/competitors.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const report = buildCompetitorReport(demoCompetitorInput(NOW));
const q = (name: string) => report.queries.find((x) => x.query === name)!;

describe("анализ выдачи на демо", () => {
  it("выпавший из выдачи товар — срочно", () => {
    expect(report.findings[0]).toMatchObject({ priority: "high", text: expect.stringContaining("PLAID-BEIGE-200: нет в первых 100") });
  });

  it("падение позиции на 10+ мест замечено", () => {
    const mug = q("кружка керамическая").own.find((o) => o.vendorCode === "MUG-CERAMIC-400")!;
    expect([mug.position, mug.prevPosition]).toEqual([47, 31]);
    expect(report.findings.some((f) => f.text === "MUG-CERAMIC-400: опустился с 31 на 47 место")).toBe(true);
  });

  it("слабая карточка: дороже лидеров, мало фото, короткое описание, нет видео, вне акции", () => {
    const gaps = q("кружка керамическая").own[0]!.gaps.join(" | ");
    for (const part of ["дороже лидеров", "фото 3", "описание 240", "характеристик 6", "нет видео", "не участвует в акции"]) expect(gaps).toContain(part);
  });

  it("изменения с прошлого раза — только заложенные: две цены лидеров на запрос", () => {
    for (const name of ["плед флисовый", "кружка керамическая"]) expect(q(name).changes.leaderPriceChanges).toHaveLength(2);
  });

  it("медианы округлены до целых — без «364,5 ₽»", () => {
    for (const x of report.queries) {
      expect(Number.isInteger(x.price.leadersMedian)).toBe(true);
      expect(Number.isInteger(x.leadersReviewsMedian)).toBe(true);
    }
  });

  it("выжимка для Claude содержит лидеров и свои товары", () => {
    const s = competitorSummary(report);
    expect(s.queries[0]!.leaders).toHaveLength(10);
    expect(s.queries.flatMap((x) => x.own.map((o) => o.vendorCode))).toEqual(expect.arrayContaining(["PLAID-GREY-150", "MUG-CERAMIC-400"]));
  });
});

describe("отчёт", () => {
  it("HTML экранирует данные со страницы WB", () => {
    const input = demoCompetitorInput(NOW);
    input.snapshots[0]!.cards[0]!.brand = '<img src=x onerror="alert(1)">';
    const html = renderCompetitorHtml(buildCompetitorReport(input));
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
  });

  it("Excel: три листа, вся выдача в одном", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "wbkit-")), "c.xlsx");
    await renderCompetitorXlsx(report, file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Что важно", "Мои товары", "Выдача"]);
    expect(wb.getWorksheet("Выдача")!.rowCount).toBe(201);
  });
});

describe("CDN карточек", () => {
  it("новые артикулы: сервер по опорным точкам (проверено на живом CDN 2026-11-18)", () => {
    const real: [number, number][] = [[506039674, 27], [889627358, 39], [1177266119, 43], [1477408043, 47], [1899027664, 53], [2046745832, 55], [2225801707, 57]];
    for (const [nm, b] of real) expect(Math.abs(guessBasket(nm) - b)).toBeLessThanOrEqual(2);
  });

  it("сервер по таблице и адрес файла", () => {
    expect(guessBasket(237359560)).toBe(15);
    expect(cardUrl(237359560, 15)).toBe("https://basket-15.wbbasket.ru/vol2373/part237359/237359560/info/ru/card.json");
  });

  it("разбор card.json", () => {
    const d = parseCard(1, { subj_name: "Пледы", imt_name: "Плед", description: "абв", options: [{}, {}], grouped_options: [{ options: [{}, {}, {}] }], media: { photo_count: 7, has_video: true } });
    expect(d).toMatchObject({ subject: "Пледы", descriptionLength: 3, characteristics: 3, photos: 7, hasVideo: true });
  });

  it("если таблица устарела — перебирает соседние серверы и запоминает найденный", async () => {
    const ok = (url: string) => url.includes("basket-16.");
    const fetchFn = vi.fn(async (url: string) => (ok(url) ? new Response(JSON.stringify({ media: { photo_count: 1 } })) : new Response("", { status: 404 })));
    const f = new CardFetcher(fetchFn as unknown as typeof fetch, 0);
    expect(await f.get(237359560)).not.toBeNull();
    const first = fetchFn.mock.calls.length;
    expect(first).toBeLessThanOrEqual(3); // 15, затем 14 и 16
    await f.get(237359561); // тот же vol — сразу нужный сервер
    expect(fetchFn.mock.calls.length).toBe(first + 1);
    // Ни одного запроса с поддельным браузерным User-Agent.
    for (const [, init] of fetchFn.mock.calls as unknown as [string, RequestInit][]) expect(String((init.headers as Record<string, string>)["User-Agent"])).toMatch(/^wb-kit\//);
  });
});

describe("снимки и история", () => {
  const snap = (query: string, scannedAt: string): SearchSnapshot => ({ query, scannedAt, url: "", cards: [{ position: 1, nmId: 1, brand: null, name: null, price: 1, oldPrice: null, priceIsWallet: false, rating: null, reviews: null, delivery: null, labels: [], ad: false }] });

  it("прошлый снимок — последний по запросу, но не сегодняшний", () => {
    const history = [snap("плед", "2026-11-01T10:00:00Z"), snap("плед", "2026-11-11T10:00:00Z"), snap("плед", "2026-11-18T08:00:00Z"), snap("кружка", "2026-11-10T10:00:00Z")];
    const prev = previousFor(history, [snap("плед", "2026-11-18T12:00:00Z")]);
    expect(prev.map((p) => p.scannedAt)).toEqual(["2026-11-11T10:00:00Z"]);
  });

  it("пустой или чужой файл — понятная ошибка", () => {
    expect(() => validateSnapshot({ foo: 1 }, "x.json")).toThrow(/не снимок выдачи/);
    expect(() => validateSnapshot({ query: "q", cards: [] }, "x.json")).toThrow(/нет карточек/);
  });

  it("квантили", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([], 0.5)).toBeNull();
  });
});
