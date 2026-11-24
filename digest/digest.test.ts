import { describe, it, expect, beforeAll } from "vitest";
import { createDemoClient } from "../audit/demo.js";
import { renderPanel } from "../panel/build.js";
import { analyzeDigest, collectDigest, DT, renderTelegram, summarizeOrders, type Digest, type DigestData } from "./digest.js";

const NOW = new Date("2026-11-18T12:00:00Z");
let data: DigestData;
let g: Digest;

beforeAll(async () => {
  data = await collectDigest(createDemoClient(NOW), { now: NOW, demo: true });
  g = analyzeDigest(data);
});

describe("утренняя сводка", () => {
  it("считает заказы по дням и неделям", () => {
    const o = (date: string, nmId: number) => ({ date: `${date}T10:00:00`, nmId, supplierArticle: `A${nmId}`, subject: "Пледы", priceWithDisc: 100 });
    const s = summarizeOrders([o("2026-11-17", 1), o("2026-11-17", 1), o("2026-11-10", 1), o("2026-11-01", 1)], "2026-11-17");
    expect(s.days).toHaveLength(14);
    expect(s.days.at(-1)).toEqual({ date: "2026-11-17", orders: 2, sum: 200 });
    // 01.11 — за пределами двух недель.
    expect(s.products[0]).toMatchObject({ d1: 2, last7: 2, prev7: 1 });
  });

  it("находит заложенные в демо проблемы", () => {
    expect(g.day).toBe("2026-11-17");
    expect(g.unavailable).toEqual([]);
    expect(g.gone.map((x) => x.vendorCode)).toContain("PLAID-BEIGE-200");
    const diffuser = g.runout.find((x) => x.vendorCode === "DIFFUSER-100");
    expect(diffuser?.daysLeft).toBeLessThanOrEqual(DT.urgentDays);
    // Закончившийся товар не дублируется в «просели».
    expect(g.drops.map((x) => x.vendorCode)).not.toContain("PLAID-BEIGE-200");
    expect(g.todo.length).toBeGreaterThan(0);
    expect(g.todo.length).toBeLessThanOrEqual(3);
    expect(g.todo[0]!.who).toBe("logist");
  });

  it("сообщение для Telegram без пустых чисел и в пределах лимита", () => {
    const text = renderTelegram(g);
    expect(text).not.toMatch(/NaN|undefined|Infinity|null/);
    expect(text.length).toBeLessThan(4000);
    expect(text).toContain("ДЕМО");
    expect(text).toContain("PLAID-BEIGE-200");
  });

  it("раздел без доступа не ломает сводку", () => {
    const cut = analyzeDigest({ ...data, stocks: { ok: false, reason: "нет доступа: в ключе WB нет категории «Аналитика»" } });
    expect(cut.runout).toEqual([]);
    expect(cut.headline).not.toBeNull();
    expect(renderTelegram(cut)).toContain("Аналитика");
  });

  it("панель показывает блок «Сегодня»", () => {
    const html = renderPanel({ demo: true, cards: [], digest: g }, NOW);
    expect(html).toContain("Сделать сегодня");
    expect(html).toContain("DIFFUSER-100");
    expect(html).not.toMatch(/NaN|undefined/);
  });
});
