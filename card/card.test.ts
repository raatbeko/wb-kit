import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { HOSTS, type WBClient } from "../mcp/wb/src/client.js";
import type { SearchSnapshot } from "../competitors/analyze.js";
import { parseCardText, type CardFetcher } from "../competitors/cdn.js";
import { buildCardReport, cardSummary, parseProposal } from "./analyze.js";
import { collectCard, competitorsFromHistory, parseSearchTexts } from "./collect.js";
import { demoCardInput } from "./demo.js";
import { renderCardHtml, renderCardXlsx } from "./render.js";
import { stems, words } from "./text.js";
import { parseIds } from "../scripts/card.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const input = demoCardInput(NOW);
const report = buildCardReport(input);

const PROPOSAL = `Коротко: добавили «большая», «для чая и кофе».

## Название
Кружка керамическая большая для чая и кофе 400 мл матовая

## Описание
Большая керамическая кружка на 400 мл для чая и кофе. Матовая бежевая глазурь. Хороший подарок. Чашка в скандинавском стиле.

## Характеристики
- Назначение посуды: для чая; для кофе
- **Стиль дизайна**: скандинавский

## Фото и инфографика
1. Кружка в руке.`;

describe("слова", () => {
  it("формы одного слова сводятся к основе, размеры и ё нормализуются", () => {
    expect(stems("Пледы флисовые 200x220")).toEqual(stems("плед флисовый 200х220"));
    expect(stems("Кружка керамическая")).toEqual(stems("кружки керамические"));
    expect(words("Плед для дивана и кровати")).toEqual(["плед", "дивана", "кровати"]);
    expect(stems("ёлочная")).toEqual(stems("елочная"));
    expect(stems("для чая")).toEqual(stems("чай"));
  });
});

describe("анализ карточки на демо", () => {
  it("покрытие спроса: название меньше, чем вся карточка", () => {
    expect(report.coverage.title).toBeGreaterThan(0.5);
    expect(report.coverage.card).toBeGreaterThan(report.coverage.title);
  });

  it("недостающие слова — как в запросе, а не основы", () => {
    const lid = report.queries.find((q) => q.text === "кружка с крышкой")!;
    expect(lid.missing).toEqual(["крышкой"]);
    expect(report.queries.find((q) => q.text === "кружка для чая")!.notInTitle).toEqual(["чая"]);
    expect(report.queries.find((q) => q.text === "кружка для чая")!.inCard).toBe(true);
  });

  it("слова лидеров, которых нет у продавца, и отставания по карточке", () => {
    expect(report.competitorWords.map((w) => w.word)).toContain("большая");
    const f = report.findings.join(" | ");
    for (const part of ["Описание 222 символов", "характеристик 6", "Фото 3", "Нет видео"]) expect(f).toContain(part);
  });

  it("без поисковых запросов — причина в выводах, без деления на ноль", () => {
    const r = buildCardReport({ ...input, searchTexts: [], searchTextsError: "нет доступа: в ключе WB нет категории «Аналитика»" });
    expect(r.coverage).toEqual({ title: 0, card: 0 });
    expect(r.findings[0]).toContain("нет категории «Аналитика»");
  });
});

describe("предложение (proposal.md)", () => {
  it("разбор разделов", () => {
    const p = parseProposal(PROPOSAL);
    expect(p.intro).toContain("Коротко");
    expect(p.title).toBe("Кружка керамическая большая для чая и кофе 400 мл матовая");
    expect(p.characteristics).toEqual([{ name: "Назначение посуды", value: "для чая; для кофе" }, { name: "Стиль дизайна", value: "скандинавский" }]);
    expect(p.rest).toContain("## Фото и инфографика");
  });

  it("покрытие после правки выше, лимиты проверяются", () => {
    const r = buildCardReport(input, PROPOSAL);
    expect(r.proposal!.warnings).toEqual([]);
    expect(r.proposal!.coverage.title).toBeGreaterThan(r.coverage.title);
    expect(r.proposal!.coverage.card).toBeGreaterThan(r.coverage.card);
    const long = buildCardReport(input, PROPOSAL.replace("матовая\n", "матовая бежевая в скандинавском стиле\n"));
    expect(long.proposal!.warnings[0]).toMatch(/больше лимита WB в 60/);
    expect(buildCardReport(input, "просто текст").proposal!.warnings).toHaveLength(2);
  });

  it("выжимка для Claude: текущий текст, недостающие слова, лимиты", () => {
    const s = cardSummary(buildCardReport(input, PROPOSAL));
    expect(s.current.title).toBe(input.own.title);
    expect(s.missingWords.map((w) => w.word)).toContain("крышкой");
    expect(s.limits.title).toBe(60);
    expect(s.proposal?.titleLength).toBeLessThanOrEqual(60);
  });
});

describe("сбор данных", () => {
  const ownCard = { nmID: 555, vendorCode: "MUG/1", brand: "Б", title: "Кружка", subjectName: "Кружки", description: "текст", characteristics: [{ id: 1, name: "Цвет", value: ["белый", "черный"] }, { id: 2, name: "Объем", value: 400 }], photos: [{}, {}], video: "" };
  const searchItem = (nmId: number, text: string, frequency: number) => ({ text, nmId, frequency: { current: frequency, dynamics: 5 }, weekFrequency: 10, avgPosition: { current: 12 }, openCard: { current: 3 }, orders: { current: 1 } });

  function fakeClient(searchFails: (limit: number) => string | null): { client: WBClient; limits: number[] } {
    const limits: number[] = [];
    const client = {
      post: async (host: string, path: string, body: Record<string, unknown>) => {
        if (host === HOSTS.content) return { cards: [ownCard] };
        if (host === HOSTS.analytics) {
          limits.push(body["limit"] as number);
          const err = searchFails(body["limit"] as number);
          if (err) throw new Error(err);
          return { data: { items: [searchItem(555, "кружка", 100), searchItem(999, "кружка", 900), searchItem(555, "Кружка ", 50), searchItem(555, "кружка белая", 20)] } };
        }
        throw new Error(`не ожидали ${host}${path}`);
      },
    } as unknown as WBClient;
    return { client, limits };
  }
  const fetcher = { getRaw: async (nmId: number) => (nmId === 404 ? null : { imt_name: `Конкурент ${nmId}`, description: "описание", options: [], grouped_options: [], media: { photo_count: 5 } }) } as unknown as CardFetcher;

  it("свои запросы без подменённых артикулов, дубли схлопнуты", () => {
    const q = parseSearchTexts({ data: { items: [searchItem(555, "кружка", 100), searchItem(999, "кружка", 900), searchItem(555, "Кружка", 50)] } }, 555);
    expect(q).toEqual([{ text: "кружка", frequency: 100, weekFrequency: 10, avgPosition: 12, openCard: 3, orders: 1 }]);
  });

  it("без «Джема» WB не даёт 100 запросов — повтор с 30", async () => {
    const { client, limits } = fakeClient((l) => (l === 100 ? "WB API POST x → 400: limit" : null));
    const r = await collectCard({ client, id: "MUG/1", fetcher, history: [], competitorIds: [1, 404], now: NOW });
    expect(limits).toEqual([100, 30]);
    expect(r.own.characteristics).toEqual([{ name: "Цвет", value: "белый; черный" }, { name: "Объем", value: "400" }]);
    expect(r.searchTexts.map((q) => q.text)).toEqual(["кружка", "кружка белая"]);
    expect(r.competitors.map((c) => c.nmId)).toEqual([1]);
    expect(r.competitorsFrom).toBe("указаны вручную");
    expect(r.period).toEqual({ from: "2026-10-19", to: "2026-11-17" });
  });

  it("нет категории «Аналитика» — карточка всё равно разбирается", async () => {
    const { client } = fakeClient(() => `WB API POST ${HOSTS.analytics}/x → 401: unauthorized`);
    const r = await collectCard({ client, id: "555", fetcher, history: [], now: NOW });
    expect(r.searchTexts).toEqual([]);
    expect(r.searchTextsError).toContain("нет доступа");
  });

  it("чужой артикул — понятная ошибка", async () => {
    const { client } = fakeClient(() => null);
    await expect(collectCard({ client, id: "777", fetcher, history: [], now: NOW })).rejects.toThrow(/не найдена среди ваших товаров/);
  });

  it("конкуренты из истории /competitors — по самому частому запросу, без своего товара и рекламы", () => {
    const card = (nmId: number, ad = false) => ({ position: nmId, nmId, brand: null, name: null, price: 1, oldPrice: null, priceIsWallet: false, rating: null, reviews: null, delivery: null, labels: [], ad });
    const snap = (query: string, scannedAt: string, cards: ReturnType<typeof card>[]): SearchSnapshot => ({ query, scannedAt, url: "", cards });
    const many = Array.from({ length: 12 }, (_, i) => card(i + 10));
    const history = [
      snap("кружка белая", "2026-11-17T10:00:00Z", [card(1), card(2)]),
      snap("Кружка", "2026-11-10T10:00:00Z", [card(3)]),
      snap("кружки", "2026-11-17T10:00:00Z", [card(555), card(4, true), ...many]),
    ];
    const own = input.own.nmId === 555 ? input.own : { ...input.own, nmId: 555, title: "Кружка" };
    const r = competitorsFromHistory(history, own, [{ text: "кружка", frequency: 100, weekFrequency: null, avgPosition: null, openCard: null, orders: null }, { text: "кружка белая", frequency: 20, weekFrequency: null, avgPosition: null, openCard: null, orders: null }]);
    expect(r!.from).toContain("«кружки»");
    expect(r!.ids).toEqual(many.slice(0, 10).map((c) => c.nmId));
    expect(competitorsFromHistory([], own, [])).toBeNull();
  });

  it("текст карточки с CDN: характеристики из групп без повторов", () => {
    const t = parseCardText(1, { imt_name: "Плед", description: "Тёплый", options: [{ name: "Цвет", value: "серый" }], grouped_options: [{ options: [{ name: "Цвет", value: "серый" }, { name: "Размер", value: "200х220" }] }], media: { photo_count: 7, has_video: true } });
    expect(t).toMatchObject({ title: "Плед", description: "Тёплый", photos: 7, hasVideo: true, characteristics: [{ name: "Цвет", value: "серый" }, { name: "Размер", value: "200х220" }] });
  });

  it("артикулы конкурентов: числа и ссылки", () => {
    expect(parseIds("123456, https://www.wildberries.ru/catalog/987654321/detail.aspx 123456")).toEqual([123456, 987654321]);
    expect(() => parseIds("abc")).toThrow(/артикулы WB/);
  });
});

describe("отчёт", () => {
  it("HTML экранирует тексты карточек", () => {
    const evil = { ...input, competitors: [{ ...input.competitors[0]!, title: "<script>alert(1)</script>" }] };
    const html = renderCardHtml(buildCardReport(evil, PROPOSAL));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("Предложение");
    expect(html).toContain("61%");
  });

  it("Excel: предложение, запросы, слова, конкуренты", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "wbkit-card-")), "card.xlsx");
    await renderCardXlsx(buildCardReport(input, PROPOSAL), file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Предложение", "Запросы", "Слова", "Конкуренты"]);
    expect(wb.getWorksheet("Запросы")!.rowCount).toBe(input.searchTexts.length + 1);
  });
});
