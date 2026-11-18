/**
 * Проверки конфигурации набора: то, что ломается тихо и без тестов
 * обнаружилось бы только у клиента.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../mcp/wb/src/env.js";
import { WRITE_TOOLS, toolDefinitions } from "../mcp/wb/src/tools.js";
import { setKey } from "./set-key.js";
import { featureMap, FEATURES } from "./check.js";
import { CATEGORIES } from "../mcp/wb/src/diagnostics.js";

const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8")) as {
  permissions: { allow: string[]; ask: string[]; deny: string[] };
};

describe(".claude/settings.json", () => {
  it("на каждый инструмент записи Claude спрашивает разрешение", () => {
    const ask = settings.permissions.ask.filter((p) => p.startsWith("mcp__wb__")).map((p) => p.replace("mcp__wb__", ""));
    expect(ask.sort()).toEqual([...WRITE_TOOLS].sort());
  });
  it("в ask нет несуществующих инструментов", () => {
    for (const p of settings.permissions.ask) {
      if (p.startsWith("mcp__wb__")) expect(toolDefinitions).toHaveProperty(p.replace("mcp__wb__", ""));
    }
  });
  it("чтение .env запрещено", () => {
    expect(settings.permissions.deny).toContain("Read(./.env)");
  });
});

describe("set-key", () => {
  it("заменяет существующую строку и не трогает остальные", () => {
    const before = "# комментарий\nWB_API_TOKEN=\nMPSTATS_TOKEN=old\n";
    expect(setKey(before, "MPSTATS_TOKEN", "new")).toBe("# комментарий\nWB_API_TOKEN=\nMPSTATS_TOKEN=new\n");
  });
  it("добавляет строку, если её не было", () => {
    expect(setKey("A=1\n", "WB_API_TOKEN", "x.y.z")).toBe("A=1\nWB_API_TOKEN=x.y.z\n");
  });
  it("не путает похожие имена", () => {
    expect(setKey("XWB_API_TOKEN=1\nWB_API_TOKEN=2", "WB_API_TOKEN", "3")).toBe("XWB_API_TOKEN=1\nWB_API_TOKEN=3");
  });
});

describe("карта возможностей", () => {
  it("каждая возможность ссылается на существующую категорию ключа", () => {
    const keys = new Set(CATEGORIES.map((c) => c.key));
    for (const f of FEATURES) for (const n of f.needs) expect(keys.has(n), `${f.name}: ${n}`).toBe(true);
  });
  it("возможность доступна только при всех нужных категориях", () => {
    const pings = CATEGORIES.map((c) => ({ key: c.key, title: c.title, usedFor: c.usedFor, ok: c.key === "statistics" }));
    const m = featureMap(pings);
    expect(m.find((f) => f.name.startsWith("Аудит: продажи"))?.available).toBe(true);
    expect(m.find((f) => f.name.startsWith("Отзывы"))?.available).toBe(false);
  });
});
