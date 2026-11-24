import { describe, it, expect, beforeAll } from "vitest";
import { createDemoClient, DEMO_COSTS } from "../audit/demo.js";
import { buildPlan, collectPlan, historyMonths, seasonIndex, type MonthPoint, type PlanData } from "./plan.js";
import { renderPlanHtml } from "./render.js";

const NOW = new Date("2026-11-18T12:00:00Z");
let data: PlanData;

beforeAll(async () => {
  data = await collectPlan(createDemoClient(NOW), { now: NOW, demo: true, costs: DEMO_COSTS });
});

const month = (ym: string, orders: number): MonthPoint => ({ month: ym, from: `${ym}-01`, to: `${ym}-30`, days: 30, byNm: { "1": { orders, buyouts: orders } } });

describe("план закупки", () => {
  it("история — не старше 365 дней, без коротких хвостов", () => {
    const m = historyMonths("2026-11-17");
    expect(m[0]!.from >= "2025-11-18").toBe(true);
    expect(m.at(-1)).toEqual({ month: "2026-11", from: "2026-11-01", to: "2026-11-17" });
    // Хвост ноября 2025 (18–30) длиннее недели — берём; меньше недели — нет.
    expect(historyMonths("2026-11-26")[0]!.month).toBe("2025-12");
  });

  it("сезон видит только настоящие колебания", () => {
    const flat = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"].map((m) => month(`2026-${m}`, 30));
    expect(seasonIndex(flat, [1])).toBeNull();
    const winter = flat.map((m, i) => ({ ...m, byNm: { "1": { orders: [60, 50, 30, 20, 15, 15, 15, 20, 30, 45, 60, 70][i]!, buyouts: 0 } } }));
    const idx = seasonIndex(winter, [1])!;
    expect(idx[12]! > 1.5).toBe(true);
    expect(idx[6]! < 0.6).toBe(true);
    // Мало месяцев — сезона нет.
    expect(seasonIndex(winter.slice(0, 5), [1])).toBeNull();
  });

  it("на демо-магазине: срочное, локомотив, лишний остаток, сезон", () => {
    const r = buildPlan(data);
    const by = (vc: string) => r.rows.find((x) => x.vendorCode === vc)!;
    expect(r.monthsList).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(by("PLAID-BEIGE-200").urgent).toBe(true);
    expect(by("PLAID-BEIGE-200").toOrder).toBeGreaterThan(0);
    expect(by("PLAID-GREY-150").locomotive).toBe(true);
    expect(by("TOWEL-SET-3").overstock).toBe(true);
    expect(by("TOWEL-SET-3").toOrder).toBe(0);
    expect(r.season["Пледы"]).toBeDefined();
    expect(r.season["Кружки"]).toBeUndefined();
    // Свой склад учитывается в остатке.
    expect(by("PILLOW-50x70").stock).toBe(by("PILLOW-50x70").stockWb + 40);
    // Остаток вычитается из ранних месяцев: в первый месяц у подушки ничего везти не надо.
    const pl = by("PILLOW-50x70");
    expect(pl.months[0]!.ship).toBe(Math.max(0, pl.months[0]!.need - pl.stock));
    expect(r.totals.money).toBeGreaterThan(0);
  });

  it("без истории — честная пометка, расчёт всё равно есть", async () => {
    const d = await collectPlan(createDemoClient(NOW), { now: NOW, demo: true, season: false });
    const r = buildPlan(d);
    expect(r.notes.join(" ")).toMatch(/Сезонность не учтена/);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("отчёт собирается без пустых чисел", () => {
    const html = renderPlanHtml(buildPlan(data, { months: 4, leadDays: 30 }));
    expect(html).not.toMatch(/NaN|undefined|Infinity|\[object/);
    expect(html).toContain("PLAID-BEIGE-200");
    expect(html).toContain("локомотив");
    expect(html).toContain("Февраль");
  });
});
