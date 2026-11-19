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
// @ts-expect-error — фронт на чистом JS без типов
import { IDLE_KINDS, POSE_KEYS, WORK_KINDS, damp, kitchenRoute, pickIdle, pickWork, targetPose, turnTo } from "./web/anim.js";
// @ts-expect-error — фронт на чистом JS без типов
import { LAYOUT } from "./web/office3d.js";

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

describe("анимация сотрудников", () => {
  const finite = (P: Record<string, number>) => {
    for (const k of POSE_KEYS as string[]) expect(Number.isFinite(P[k]), k).toBe(true);
  };
  it("каждое состояние и действие даёт настоящую позу (без NaN), включая наложения", () => {
    for (let t = 0; t < 6; t += 0.37) {
      for (const status of ["idle", "working", "waiting", "error"]) {
        const base = { status, t, ph: t + 1.3, m: 1 };
        finite(targetPose(base));
        for (const kind of IDLE_KINDS) finite(targetPose({ ...base, action: { kind, start: 0, dur: 4 } }));
        for (const kind of WORK_KINDS) finite(targetPose({ ...base, work: { kind, start: 0, dur: 4 } }));
        finite(targetPose({ ...base, saying: true, wave: 0.5, cheer: 0.5, throwing: 0.3, look: { yaw: 2, pitch: -1 } }));
        finite(targetPose({ ...base, walk: { stand: 0.7, moving: true, phase: t * 8, carry: true, drinking: 0.4 } }));
      }
    }
  });

  it("сидит — ноги согнуты, стоит — выпрямлены; в покое поза не меняется от наложений", () => {
    const sit = targetPose({ status: "idle", t: 0, ph: 0 });
    expect(sit.hipL).toBeCloseTo(-Math.PI / 2);
    expect(sit.kneeL).toBeCloseTo(Math.PI / 2);
    const stand = targetPose({ status: "idle", t: 0, ph: 0, walk: { stand: 1, moving: false, phase: 0 } });
    expect(Math.abs(stand.hipL)).toBeLessThan(0.01);
    expect(stand.kneeL).toBeLessThan(0.2);
    // Действие в самом начале и в конце не дёргает позу (плавный вход и выход).
    const a = targetPose({ status: "idle", t: 0, ph: 0, action: { kind: "stretch", start: 0, dur: 2 } });
    expect(a.shLx).toBeCloseTo(sit.shLx);
  });

  it("выбор действий: прогулка только когда можно, гарнитура — только у тех, у кого она есть", () => {
    const seq = (vals: number[]) => {
      let i = 0;
      return () => vals[i++ % vals.length]!;
    };
    const kinds = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) kinds.add(pickIdle(seq([r]), {}).kind);
    expect(kinds.has("walk")).toBe(false);
    expect(kinds.has("call")).toBe(false);
    const withAll = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) withAll.add(pickIdle(seq([r]), { headset: true, canWalk: true }).kind);
    expect(withAll.has("walk")).toBe(true);
    expect(withAll.has("call")).toBe(true);
    const work = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) work.add(pickWork(seq([r]), "analyst").kind);
    expect(work.has("screen2")).toBe(true);
    expect(pickWork(seq([0.99]), "finance").kind).not.toBe("screen2");
  });

  it("путь к кухне не проходит сквозь чужие столы и стекло директора", () => {
    const desks = Object.entries(LAYOUT as Record<string, { x: number; z: number; big?: boolean }>).map(([id, l]) => ({ id, x: l.x, z: l.z, hw: (l.big ? 3 : 2.2) / 2 + 0.25, hd: 0.55 + 0.25 }));
    const hit = (x: number, z: number, self: string) =>
      desks.some((d) => d.id !== self && Math.abs(x - d.x) < d.hw && Math.abs(z - d.z) < d.hd) || (Math.abs(z + 3.5) < 0.3 && Math.abs(x) < 4.7);
    for (const [id, l] of Object.entries(LAYOUT) as [string, { x: number; z: number }][]) {
      if (id === "director") continue;
      for (const pick of [0.1, 0.9]) {
        const pts = [{ x: 0, z: -0.95 }, ...kitchenRoute({ x: l.x, z: l.z }, () => pick)].map((p) => ({ x: p.x + l.x, z: p.z + l.z }));
        for (let i = 1; i < pts.length; i++) {
          for (let k = 0; k <= 20; k++) {
            const x = pts[i - 1]!.x + ((pts[i]!.x - pts[i - 1]!.x) * k) / 20;
            const z = pts[i - 1]!.z + ((pts[i]!.z - pts[i - 1]!.z) * k) / 20;
            expect(hit(x, z, id), `${id}: точка ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(false);
          }
        }
      }
    }
  });

  it("поворот идёт по короткой дуге, damp сходится", () => {
    expect(turnTo(3, -3, 1)).toBeCloseTo(3 + (2 * Math.PI - 6));
    const cur = targetPose({ status: "idle", t: 0, ph: 0 });
    const tgt = targetPose({ status: "error", t: 0.5, ph: 0.5 });
    for (let i = 0; i < 200; i++) damp(cur, tgt, 0.2);
    expect(cur.torsoX).toBeCloseTo(tgt.torsoX);
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
