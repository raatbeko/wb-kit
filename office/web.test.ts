/**
 * Фронт офиса без браузера: конфигурация каждого сотрудника (главный вывод,
 * графики, таблица) прогоняется на настоящем демо-снимке — если у кого-то
 * упадёт панель или окажется пустая колонка, это видно здесь, а не у клиента.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildReport } from "../audit/analyze.js";
import { collectAudit } from "../audit/collect.js";
import { createDemoClient } from "../audit/demo.js";
import { STAFF } from "./core/staff.js";
import { SNAPSHOT_SCHEMA, buildSnapshot, type Snapshot } from "./sync/snapshot.js";
import { isOutdatedSchema } from "./sync/sync.js";
// @ts-expect-error — фронт на чистом JS без типов
import { ROLES, SNAPSHOT_SCHEMA as WEB_SCHEMA, headlineFor, productCardHtml } from "./web/ui/workspace.js";
// @ts-expect-error — фронт на чистом JS без типов
import { barChart, hbars } from "./web/ui/chart.js";
// @ts-expect-error — фронт на чистом JS без типов
import { csvCell, esc, fmt } from "./web/ui/table.js";

let s: Snapshot;
const ctx = { reports: [{ id: "r1", kind: "competitors", title: "Конкуренты — 18.11.2026", agentId: "scout", createdAt: new Date().toISOString(), path: "reports/x/a.html", summary: null }] };

beforeAll(async () => {
  s = buildSnapshot(buildReport(await collectAudit(createDemoClient(), { demo: true })));
}, 60000);

describe("снимок для рабочих столов", () => {
  it("в снимке есть всё, что нужно таблицам сотрудников", () => {
    expect(s.finance?.sales).toBeGreaterThan(0);
    expect(s.ads?.campaigns.length).toBeGreaterThan(0);
    expect(s.feedbacks?.negative.length).toBeGreaterThan(0);
    expect(s.warehouses.length).toBeGreaterThan(0);
    expect(s.products[0]).toHaveProperty("addToCartPercent");
    expect(s.products[0]).toHaveProperty("afterLogistics");
    expect(s.products[0]).toHaveProperty("descriptionLength");
    // Имён покупателей в отзывах нет — только текст и товар.
    expect(Object.keys(s.feedbacks!.negative[0]!)).not.toContain("userName");
  });
});

describe("каждый сотрудник", () => {
  for (const a of STAFF) {
    it(`${a.id}: главный вывод, графики и таблица строятся`, () => {
      const role = ROLES[a.id];
      expect(role, a.id).toBeDefined();
      const h = headlineFor(a.id, s, ctx);
      expect(typeof h, a.id).toBe("string");
      expect(h.length).toBeGreaterThan(5);
      expect(h).not.toMatch(/undefined|NaN|null/);
      const charts = role.charts(s, ctx);
      expect(charts).not.toMatch(/undefined|NaN/);
      if (role.table) {
        const t = role.table(s, ctx);
        expect(t.columns.length).toBeGreaterThan(2);
        for (const row of t.rows.slice(0, 5)) {
          for (const c of t.columns) {
            const v = (c.fmt ?? fmt.text)(row[c.key], row);
            expect(String(v), `${a.id}.${c.key}`).not.toMatch(/undefined|NaN/);
          }
        }
      }
    });
  }

  it("без данных WB главный вывод честно говорит, а не падает", () => {
    for (const a of STAFF) expect(() => headlineFor(a.id, null, { reports: [] })).not.toThrow();
  });

  it("логист видит закончившийся товар демо-магазина, финансист — деньги", () => {
    expect(headlineFor("logist", s, ctx)).toMatch(/Закончились: 1/);
    expect(headlineFor("finance", s, ctx)).toMatch(/На руки/);
    expect(headlineFor("director", s, ctx)).toMatch(/Срочных задач: \d/);
  });
});

describe("карточка товара и графики", () => {
  it("карточка товара показывает все группы и экранирует текст", () => {
    const p = { ...s.products[0]!, title: '<img src=x onerror="alert(1)">' };
    const html = productCardHtml(p, s);
    for (const g of ["Продажи", "Остатки", "Воронка", "Деньги", "Карточка", "Отзывы"]) expect(html).toContain(g);
    expect(html).not.toContain("<img");
  });

  it("CSV: формула из отзыва покупателя не выполнится в Excel, числа остаются числами", () => {
    expect(csvCell('=HYPERLINK("http://x";"y")', { key: "text" })).toBe(`"'=HYPERLINK(""http://x"";""y"")"`);
    expect(csvCell("+7 999", { key: "text" })).toBe(`"'+7 999"`);
    expect(csvCell("@cmd", { key: "text" })).toBe(`"'@cmd"`);
    expect(csvCell(-5.2, { key: "d", num: true })).toBe(`"-5,2"`);
    expect(csvCell(3, { key: "prio", num: true, csvText: true, fmt: () => "срочно" })).toBe(`"срочно"`);
    expect(csvCell("Плед", { key: "title" })).toBe(`"Плед"`);
  });

  it("версия снимка во фронте совпадает с сервером; старый снимок — «обновляю», а не «нет категории»", () => {
    expect(WEB_SCHEMA).toBe(SNAPSHOT_SCHEMA);
    const old = { ...s, schema: undefined, finance: undefined };
    expect(headlineFor("finance", old, ctx)).toMatch(/Обновляю данные/);
    expect(isOutdatedSchema(old as never)).toBe(true);
    expect(isOutdatedSchema(s)).toBe(false);
  });

  it("графики экранируют подписи и не ломаются на пустых данных", () => {
    expect(hbars([{ label: "x", value: 0 }], { max: 0 })).not.toContain("NaN");
    expect(barChart([], {})).toContain("Нет данных");
    expect(barChart([{ label: "<b>", value: 5 }], { title: "x" })).not.toContain("<b>");
    expect(hbars([{ label: "<script>", value: 1 }])).not.toContain("<script>");
    expect(esc(`"<&>'`)).toBe("&quot;&lt;&amp;&gt;&#39;");
  });
});
