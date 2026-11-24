import { describe, it, expect } from "vitest";
import type { SearchCard } from "../competitors/analyze.js";
import { buildNiche, nicheSummary, segmentsOf } from "./niche.js";
import { demoNicheInput } from "./demo.js";
import { renderNicheHtml } from "./render.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const c = (position: number, name: string, price: number, reviews = 10): SearchCard => ({ position, nmId: position, brand: "B", name, price, oldPrice: null, priceIsWallet: false, rating: 4.8, reviews, delivery: null, labels: [], ad: false });

describe("ниша", () => {
  it("сегменты — слова из названий, кроме слов запроса и размеров", () => {
    const cards = [
      ...Array.from({ length: 10 }, (_, i) => c(i + 1, "Плед флисовый 150х200", 1000)),
      ...Array.from({ length: 6 }, (_, i) => c(i + 11, "Пледы вязаные 200х220", 2500)),
      ...Array.from({ length: 4 }, (_, i) => c(i + 17, "Плед", 1200)),
    ];
    const s = segmentsOf(cards, "плед");
    expect(s.map((x) => x.word)).toEqual(["флисовый", "вязаные"]);
    expect(s[1]).toMatchObject({ count: 6, medianPrice: 2500, bestPosition: 11 });
  });

  it("демо: новинки в топе, сегменты, вердикт, свои товары", () => {
    const r = buildNiche(demoNicheInput(NOW));
    const q = r.queries[0]!;
    expect(r.queries).toHaveLength(1); // «новинки» — не отдельный запрос, а вторая сортировка
    expect(q.hasFresh).toBe(true);
    expect(q.newInTop.map((x) => x.position)).toEqual([6, 15, 41]);
    expect(q.segments[0]!.word).toBe("флисовый");
    expect(q.own[0]).toMatchObject({ position: 23 });
    expect(q.verdict.level).toBe("go");
    expect(q.economy?.margin).toBeGreaterThan(0);
    expect(q.sales?.covered).toBe(30);
    expect(nicheSummary(r).findings.length).toBeGreaterThan(0);
  });

  it("без новинок вывод помечен неполным", () => {
    const input = demoNicheInput(NOW);
    const r = buildNiche({ ...input, snapshots: input.snapshots.filter((s) => !s.url.includes("sort=newly")) });
    expect(r.queries[0]!.verdict.reasons.join(" ")).toMatch(/новинки не смотрели/);
  });

  it("отчёт без пустых чисел, с карточками и ссылками на WB", () => {
    const html = renderNicheHtml(buildNiche(demoNicheInput(NOW)));
    expect(html).not.toMatch(/NaN|undefined|Infinity|\[object/);
    expect(html).toContain("Можно пробовать");
    expect(html).toContain("wildberries.ru/catalog/201450001/detail.aspx");
  });
});
