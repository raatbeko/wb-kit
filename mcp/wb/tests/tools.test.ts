import { describe, it, expect, vi, beforeEach } from "vitest";
import { toolDefinitions, handleTool, WRITE_TOOLS, summarizeSales, abcFromSales, summarizeFinance, type ToolName } from "../src/tools.js";
import { HOSTS, type WBClient } from "../src/client.js";
import { toDate, toUnix, previousPeriod, daysBetween } from "../src/util.js";

type Method = "get" | "post" | "put" | "patch";

function mockClient(overrides: Partial<Record<Method, unknown>> = {}): WBClient {
  return {
    token: "a.b.c",
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    pollUntil: vi.fn().mockImplementation(async (o: { fn: () => Promise<unknown> }) => o.fn()),
    ...overrides,
  } as unknown as WBClient;
}

const calls = (c: WBClient, m: Method) => (c[m] as unknown as ReturnType<typeof vi.fn>).mock.calls;

describe("определения инструментов", () => {
  it("у каждого инструмента есть описание и схема-объект", () => {
    for (const [name, def] of Object.entries(toolDefinitions)) {
      expect(def.description, name).toBeTruthy();
      expect(def.inputSchema.type, name).toBe("object");
    }
  });

  it("инструменты, меняющие кабинет, помечены и предупреждают в описании", () => {
    expect([...WRITE_TOOLS].sort()).toEqual(
      [
        "add_orders_to_fbs_supply",
        "create_fbs_supply",
        "deliver_fbs_supply",
        "reply_feedback",
        "reply_question",
        "update_fbs_stocks",
        "update_prices",
      ].sort(),
    );
    for (const n of WRITE_TOOLS) expect(toolDefinitions[n].description).toMatch(/ИЗМЕНЯЕТ ДАННЫЕ/);
  });
});

/**
 * Маршрут каждого инструмента сверен со Swagger WB (снимок 2026-05-01).
 * Тест держит их на месте: если путь «починят» обратно на старый, он упадёт.
 */
describe("маршруты по Swagger WB", () => {
  let c: WBClient;
  beforeEach(() => {
    c = mockClient();
  });

  const cases: [ToolName, Record<string, unknown>, Method, string, string][] = [
    ["get_seller_info", {}, "get", HOSTS.common, "/api/v1/seller-info"],
    ["get_seller_rating", {}, "get", HOSTS.feedbacks, "/api/common/v1/rating"],
    ["get_jam_subscription", {}, "get", HOSTS.common, "/api/common/v1/subscriptions"],
    ["list_products", {}, "post", HOSTS.content, "/content/v2/get/cards/list"],
    ["get_prices", {}, "get", HOSTS.prices, "/api/v2/list/goods/filter"],
    ["update_prices", { prices: [{ nmID: 1, price: 100 }] }, "post", HOSTS.prices, "/api/v2/upload/task"],
    ["list_seller_warehouses", {}, "get", HOSTS.marketplace, "/api/v3/warehouses"],
    ["get_fbs_stocks", { warehouseId: 7, chrtIds: [1] }, "post", HOSTS.marketplace, "/api/v3/stocks/7"],
    ["update_fbs_stocks", { warehouseId: 7, stocks: [{ chrtId: 1, amount: 2 }] }, "put", HOSTS.marketplace, "/api/v3/stocks/7"],
    ["get_fbs_new_orders", {}, "get", HOSTS.marketplace, "/api/v3/orders/new"],
    ["get_fbs_orders", {}, "get", HOSTS.marketplace, "/api/v3/orders"],
    ["list_fbs_supplies", {}, "get", HOSTS.marketplace, "/api/v3/supplies"],
    ["create_fbs_supply", { name: "x" }, "post", HOSTS.marketplace, "/api/v3/supplies"],
    ["add_orders_to_fbs_supply", { supplyId: "WB-GI-1", orderIds: [5] }, "patch", HOSTS.marketplace, "/api/marketplace/v3/supplies/WB-GI-1/orders"],
    ["deliver_fbs_supply", { supplyId: "WB-GI-1" }, "patch", HOSTS.marketplace, "/api/v3/supplies/WB-GI-1/deliver"],
    ["get_fbs_supply_barcode", { supplyId: "WB-GI-1" }, "get", HOSTS.marketplace, "/api/v3/supplies/WB-GI-1/barcode"],
    ["get_wb_stocks", {}, "post", HOSTS.analytics, "/api/analytics/v1/stocks-report/wb-warehouses"],
    ["get_funnel", { dateFrom: "2026-11-01", dateTo: "2026-11-07" }, "post", HOSTS.analytics, "/api/analytics/v3/sales-funnel/products"],
    ["get_funnel_history", { dateFrom: "2026-11-01", dateTo: "2026-11-07", nmIds: [1] }, "post", HOSTS.analytics, "/api/analytics/v3/sales-funnel/products/history"],
    ["get_search_texts", { dateFrom: "2026-11-01", dateTo: "2026-11-07", nmIds: [1] }, "post", HOSTS.analytics, "/api/v2/search-report/product/search-texts"],
    ["get_finance_report_rows", { dateFrom: "2026-11-01", dateTo: "2026-11-07" }, "post", HOSTS.finance, "/api/finance/v1/sales-reports/detailed"],
    ["get_account_balance", {}, "get", HOSTS.finance, "/api/v1/account/balance"],
    ["get_commission", {}, "get", HOSTS.common, "/api/v1/tariffs/commission"],
    ["get_box_tariffs", { date: "2026-11-01" }, "get", HOSTS.common, "/api/v1/tariffs/box"],
    ["get_acceptance_coefficients", {}, "get", HOSTS.common, "/api/tariffs/v1/acceptance/coefficients"],
    ["get_feedbacks", {}, "get", HOSTS.feedbacks, "/api/v1/feedbacks"],
    ["reply_feedback", { id: "f1", text: "Спасибо" }, "post", HOSTS.feedbacks, "/api/v1/feedbacks/answer"],
    ["get_questions", {}, "get", HOSTS.feedbacks, "/api/v1/questions"],
    ["reply_question", { id: "q1", text: "Да" }, "patch", HOSTS.feedbacks, "/api/v1/questions"],
    ["get_returns", {}, "get", HOSTS.returns, "/api/v1/claims"],
    ["list_campaigns", {}, "get", HOSTS.advert, "/adv/v1/promotion/count"],
    ["get_campaigns_info", {}, "get", HOSTS.advert, "/api/advert/v2/adverts"],
    ["get_ad_balance", {}, "get", HOSTS.advert, "/adv/v1/balance"],
    ["get_campaign_stats", { campaignIds: [1], dateFrom: "2026-11-01", dateTo: "2026-11-07" }, "get", HOSTS.advert, "/adv/v3/fullstats"],
    ["get_ad_costs", { dateFrom: "2026-11-01", dateTo: "2026-11-07" }, "get", HOSTS.advert, "/adv/v1/upd"],
    ["get_promotions", { dateFrom: "2026-11-01", dateTo: "2026-11-30" }, "get", HOSTS.calendar, "/api/v1/calendar/promotions"],
  ];

  it.each(cases)("%s → %s %s%s", async (tool, args, method, host, path) => {
    await handleTool(c, tool, args);
    const [first] = calls(c, method);
    expect(first?.[0]).toBe(host);
    expect(first?.[1]).toBe(path);
  });

  it("остатки FBS запрашиваются по chrtIds, а не по sku", async () => {
    await handleTool(c, "get_fbs_stocks", { warehouseId: 1, chrtIds: [11, 12] });
    expect(calls(c, "post")[0]![2]).toEqual({ chrtIds: [11, 12] });
  });

  it("даты FBS-заказов уходят unix-временем, курсор и лимит передаются всегда", async () => {
    await handleTool(c, "get_fbs_orders", { dateFrom: "2026-11-01", dateTo: "2026-11-02" });
    expect(calls(c, "get")[0]![2]).toEqual({ limit: "200", next: "0", dateFrom: "1793491200", dateTo: "1793663999" });
  });

  it("ответ на вопрос публикуется со state=wbRu", async () => {
    await handleTool(c, "reply_question", { id: "q1", text: "Да" });
    expect(calls(c, "patch")[0]![2]).toEqual({ id: "q1", answer: { text: "Да" }, state: "wbRu" });
  });

  it("воронка по умолчанию сравнивает с прошлым периодом той же длины", async () => {
    await handleTool(c, "get_funnel", { dateFrom: "2026-11-08", dateTo: "2026-11-14" });
    const body = calls(c, "post")[0]![2];
    expect(body.selectedPeriod).toEqual({ start: "2026-11-08", end: "2026-11-14" });
    expect(body.pastPeriod).toEqual({ start: "2026-11-01", end: "2026-11-07" });
  });

  it("статистика рекламы больше 31 дня — понятная ошибка, без запроса", async () => {
    await expect(handleTool(c, "get_campaign_stats", { campaignIds: [1], dateFrom: "2026-01-01", dateTo: "2026-03-01" })).rejects.toThrow(/31 день/);
    expect(c.get).not.toHaveBeenCalled();
  });

  it("без ключа check_connection подсказывает, что делать", async () => {
    const noKey = { ...mockClient(), token: "" } as unknown as WBClient;
    await expect(handleTool(noKey, "check_connection", {})).rejects.toThrow(/\.env/);
  });
});

describe("персональные данные покупателей не уходят в ответ", () => {
  it("адрес из FBS-заказа вырезается", async () => {
    const c = mockClient({ get: vi.fn().mockResolvedValue({ orders: [{ id: 1, nmId: 2, address: { fullAddress: "ул. Ленина, 1" } }] }) });
    const res = (await handleTool(c, "get_fbs_new_orders", {})) as { orders: Record<string, unknown>[] };
    expect(res.orders[0]).toEqual({ id: 1, nmId: 2 });
  });

  it("имя покупателя в отзыве не возвращается", async () => {
    const c = mockClient({
      get: vi.fn().mockResolvedValue({ data: { feedbacks: [{ id: "f", userName: "Анна", text: "ок", productValuation: 5, productDetails: { nmId: 3 } }] } }),
    });
    const res = (await handleTool(c, "get_feedbacks", {})) as { feedbacks: Record<string, unknown>[] };
    expect(JSON.stringify(res)).not.toContain("Анна");
    expect(res.feedbacks[0]).toMatchObject({ id: "f", rating: 5, nmId: 3 });
  });
});

describe("расчёты", () => {
  const orders = [
    { date: "2026-11-02T10:00:00", nmId: 1, supplierArticle: "A1", priceWithDisc: 1000, isCancel: false },
    { date: "2026-11-02T11:00:00", nmId: 1, supplierArticle: "A1", priceWithDisc: 1000, isCancel: true },
    { date: "2026-11-03T11:00:00", nmId: 2, supplierArticle: "B2", priceWithDisc: 500, isCancel: false },
    { date: "2026-10-01T11:00:00", nmId: 2, supplierArticle: "B2", priceWithDisc: 500, isCancel: false }, // вне периода
  ];
  const sales = [
    { date: "2026-11-04T10:00:00", nmId: 1, saleID: "S1", priceWithDisc: 1000, forPay: 800 },
    { date: "2026-11-05T10:00:00", nmId: 2, saleID: "S2", priceWithDisc: 500, forPay: 400 },
    { date: "2026-11-06T10:00:00", nmId: 2, saleID: "R3", priceWithDisc: -500, forPay: -400 },
  ];

  it("сводка продаж: заказы, отмены, выкупы, возвраты, к перечислению", () => {
    const s = summarizeSales(orders, sales, "2026-11-01", "2026-11-07");
    expect(s.totals).toMatchObject({ products: 2, orders: 3, ordersSum: 2500, cancels: 1, buyouts: 2, returns: 1, forPay: 800 });
    expect(s.products.find((p) => p.nmId === 1)!.buyoutPercent).toBe(100);
  });

  it("ABC: самый крупный товар всегда A, доли в сумме 100%", () => {
    const abc = abcFromSales([
      { nmId: 1, vendorCode: "a", subject: "", buyoutsSum: 7000, returnsSum: 0, buyouts: 7 },
      { nmId: 2, vendorCode: "b", subject: "", buyoutsSum: 2000, returnsSum: 0, buyouts: 2 },
      { nmId: 3, vendorCode: "c", subject: "", buyoutsSum: 900, returnsSum: 0, buyouts: 1 },
      { nmId: 4, vendorCode: "d", subject: "", buyoutsSum: 100, returnsSum: 0, buyouts: 1 },
      { nmId: 5, vendorCode: "e", subject: "", buyoutsSum: 100, returnsSum: 100, buyouts: 1 }, // выручка 0 — не участвует
    ]);
    expect(abc.items.map((i) => i.class)).toEqual(["A", "A", "B", "C"]);
    expect(abc.summary.A.revenueShare + abc.summary.B.revenueShare + abc.summary.C.revenueShare).toBeCloseTo(100, 1);
  });

  it("финотчёт: суммы строками, логистика, хранение и штрафы вычитаются из «на руки»", () => {
    const f = summarizeFinance(
      [
        { docTypeName: "Продажа", quantity: 1, retailPriceWithDisc: "1000", forPay: "800", deliveryService: "0", nmId: 1, sellerOperName: "Продажа" },
        { docTypeName: "Возврат", quantity: 1, retailPriceWithDisc: "1000", forPay: "800", deliveryService: "0", nmId: 1, sellerOperName: "Возврат" },
        { docTypeName: "Продажа", quantity: 1, retailPriceWithDisc: "500", forPay: "400", nmId: 2, sellerOperName: "Продажа" },
        { docTypeName: "", deliveryService: "60", nmId: 1, sellerOperName: "Логистика" },
        { docTypeName: "", penalty: "100", sellerOperName: "Штраф" },
        { docTypeName: "", paidStorage: "15", sellerOperName: "Хранение" },
      ],
      10,
    );
    expect(f.totals.sales).toBe(1500);
    expect(f.totals.returns).toBe(1000);
    expect(f.totals.netPayoutEstimate).toBe(800 - 800 + 400 - 60 - 100 - 15);
    expect(f.products.find((p) => p.nmId === 1)?.afterLogistics).toBe(-60);
  });
});

describe("даты", () => {
  it("принимает ГГГГ-ММ-ДД и RFC3339, отвергает мусор понятной ошибкой", () => {
    expect(toDate("2026-11-18", "d")).toBe("2026-11-18");
    expect(toDate("2026-11-18T10:00:00Z", "d")).toBe("2026-11-18");
    expect(() => toDate("18.11.2026", "dateFrom")).toThrow(/ГГГГ-ММ-ДД/);
  });
  it("unix-время начала и конца суток UTC", () => {
    expect(toUnix("2026-11-01", "d")).toBe(1793491200);
    expect(toUnix("2026-11-01", "d", true)).toBe(1793577599);
  });
  it("прошлый период и длина", () => {
    expect(daysBetween("2026-11-01", "2026-11-30")).toBe(30);
    expect(previousPeriod("2026-11-01", "2026-11-30")).toEqual({ start: "2026-10-02", end: "2026-10-31" });
  });
});
