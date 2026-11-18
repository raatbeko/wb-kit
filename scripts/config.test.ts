/**
 * Проверки конфигурации набора: то, что ломается тихо и без тестов
 * обнаружилось бы только у клиента.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../mcp/wb/src/env.js";
import { WRITE_TOOLS, toolDefinitions } from "../mcp/wb/src/tools.js";
import { setKey } from "./set-key.js";
import { featureMap, FEATURES } from "./check.js";
import { CATEGORIES } from "../mcp/wb/src/diagnostics.js";
import { markdownToHtml } from "../audit/render-html.js";
import { renderOfficeHtml } from "./office.js";

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

describe("офис агентов (.claude/agents)", () => {
  const dir = join(ROOT, ".claude", "agents");
  const agents = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(fm)?.[1]?.trim();
      const list = (k: string) => (field(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      return { file: f, text, name: field("name"), description: field("description"), tools: list("tools"), disallowed: list("disallowedTools") };
    });

  it("шесть ролей, у каждой имя как у файла и описание", () => {
    expect(agents.map((a) => a.name).sort()).toEqual(["analyst", "content", "logist", "marketer", "reviews", "scout"]);
    for (const a of agents) {
      expect(a.file).toBe(`${a.name}.md`);
      expect(a.description!.length, a.file).toBeGreaterThan(80);
    }
  });

  it("роли не могут менять кабинет: все инструменты записи запрещены", () => {
    const writes = [...WRITE_TOOLS].map((t) => `mcp__wb__${t}`).sort();
    for (const a of agents) {
      for (const t of a.tools) expect(writes, `${a.file}: ${t}`).not.toContain(t);
      if (a.tools.some((t) => t.startsWith("mcp__wb__"))) expect([...a.disallowed].sort(), a.file).toEqual(writes);
    }
  });

  it("инструменты, названные в инструкциях ролей, существуют и только читают", () => {
    for (const a of agents) {
      for (const [, name] of a.text.matchAll(/`([a-z_]+)`/g)) {
        if (!/^(get|list|check)_/.test(name!)) continue;
        expect(toolDefinitions, `${a.file}: ${name}`).toHaveProperty(name!);
        expect((WRITE_TOOLS as string[]).includes(name!), `${a.file}: ${name}`).toBe(false);
      }
    }
  });

  it("директор (/office) знает всех", () => {
    const office = readFileSync(join(ROOT, ".claude", "commands", "office.md"), "utf8");
    for (const a of agents) expect(office, a.name).toContain(`\`${a.name}\``);
  });

  it("отчёт офиса: план первым, роли по порядку, данные экранированы", () => {
    const html = renderOfficeHtml("/x/office-2026-11-18-demo", { логист: "## Главное\n- мало", план: "Коротко: <b>ок</b>", аналитик: "| A | B |\n|---|---|\n| 1 | 2 |" });
    expect(html.indexOf("План")).toBeLessThan(html.indexOf("Аналитик"));
    expect(html.indexOf('id="аналитик"')).toBeLessThan(html.indexOf('id="логист"'));
    expect(html).not.toContain("<b>ок</b>");
    expect(html).toContain("ДЕМО");
  });

  it("markdown: таблицы", () => {
    expect(markdownToHtml("| Товар | Дней |\n|---|---:|\n| Плед | 9 |\n\nтекст")).toBe(
      '<div class="table-wrap"><table><thead><tr><th>Товар</th><th>Дней</th></tr></thead><tbody><tr><td>Плед</td><td>9</td></tr></tbody></table></div>\n<p>текст</p>',
    );
  });
});

describe(".env от клиента", () => {
  it("BOM от Блокнота, CRLF, кавычки и «Bearer» не ломают ключ", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadEnv, readKey } = await import("../mcp/wb/src/env.js");
    const file = join(mkdtempSync(join(tmpdir(), "wbkit-env-")), ".env");
    writeFileSync(file, "﻿WBKIT_TEST_A=abc.def\r\nWBKIT_TEST_B=«xyz»\r\nWBKIT_TEST_C=Bearer tok\r\nWBKIT_TEST_D=your_token_here\r\n");
    loadEnv(file);
    expect([readKey("WBKIT_TEST_A"), readKey("WBKIT_TEST_B"), readKey("WBKIT_TEST_C"), readKey("WBKIT_TEST_D")]).toEqual(["abc.def", "xyz", "tok", undefined]);
  });
});
