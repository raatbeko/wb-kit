import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoClient, DEMO_COSTS } from "../audit/demo.js";
import { collectAudit, type AuditData } from "../audit/collect.js";
import { buildReport, summaryForClaude } from "../audit/analyze.js";
import { renderHtml } from "../audit/render-html.js";
import { buildPanel, collectFindings, findSources, ISSUE_ROLE, PANEL_ROLES, readStatus, renderPanel, writeStatus, type PanelSources } from "./build.js";
import { ROLES } from "../scripts/office.js";

const NOW = new Date("2026-11-18T12:00:00Z");
let data: AuditData;
let root: string;

/** Папка набора с демо-аудитом и офисом, как после /audit демо и /office демо. */
function fakeRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "wbkit-panel-"));
  const report = buildReport(data);
  const a = join(r, "reports", "audit-2026-11-18-demo");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "data.json"), JSON.stringify(data));
  writeFileSync(join(a, "summary.json"), JSON.stringify(summaryForClaude(report)));
  writeFileSync(join(a, "Аудит WB ДЕМО 2026-11-18.html"), renderHtml(report));
  const o = join(r, "reports", "office-2026-11-18-demo");
  mkdirSync(o);
  writeFileSync(join(o, "план.md"), "Коротко: магазин в минусе из-за рекламы тапочек и пустого пледа.\n\n## Срочно\n1. Поставка пледа.");
  writeFileSync(join(o, "логист.md"), "Плед бежевый закончился, ещё четыре товара закончатся за неделю — поставку начать с пледа.\n\n- диффузор — 2 дня");
  return r;
}

beforeAll(async () => {
  data = await collectAudit(createDemoClient(NOW), { now: NOW, demo: true, costs: DEMO_COSTS });
  root = fakeRoot();
});

describe("панель", () => {
  it("находит последние демо-отчёты и не берёт настоящие", () => {
    const src = findSources(root, true);
    expect(src.audit?.summary.demo).toBe(true);
    expect(src.office?.parts.map((p) => p.id)).toEqual(["план", "логист"]);
    expect(findSources(root, false).audit).toBeUndefined();
  });

  it("собирает страницу без пустых и сломанных чисел", () => {
    const html = renderPanel(findSources(root, true), NOW);
    expect(html).not.toMatch(/NaN|undefined|Infinity|\[object/);
    for (const tab of ["Обзор", "Аудит", "Офис", "Конкуренты", "Карточки"]) expect(html).toContain(`>${tab}`);
    // Отчёт аудита встроен целиком, а закрывающий тег скрипта в нём не ломает страницу.
    expect(html).toContain('id="doc-audit"');
    expect(html.match(/<\/script>/g)!.length).toBe(html.match(/<script type="text\/plain"/g)!.length + 1);
    expect(html).toContain("Логист");
    expect(html).toContain("status.js");
  });

  it("каждая проблема аудита попадает к сотруднику, а сотрудники совпадают с ролями офиса", () => {
    const issues = summaryForClaude(buildReport(data)).issues;
    for (const i of issues) expect(ISSUE_ROLE[i.id], i.id).toBeDefined();
    expect(PANEL_ROLES.map((r) => r.file).sort()).toEqual(ROLES.map(([f]) => f).sort());
    const f = collectFindings(findSources(root, true));
    expect(f.length).toBe(issues.length);
    expect(f[0]!.lvl).toBe("bad");
  });

  it("без отчётов подсказывает, с чего начать", () => {
    const empty: PanelSources = { demo: false, cards: [] };
    const html = renderPanel(empty, NOW);
    expect(html).toContain("Аудита ещё нет");
    expect(html).toContain("/office");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("сборка пишет страницу и метку для открытой панели, не трогая статус работы", () => {
    writeStatus(root, { run: "Разбор недели", step: "Логист смотрит остатки", agents: { логист: "run" } });
    const { path } = buildPanel(root, true, NOW);
    expect(existsSync(path)).toBe(true);
    const st = readStatus(root)!;
    expect(st.step).toBe("Логист смотрит остатки");
    expect(st.built).toBe(NOW.toISOString());
    expect(readFileSync(path, "utf8")).toContain(NOW.toISOString());
  });
});
