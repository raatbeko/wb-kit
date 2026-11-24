/**
 * Демо-ниша «плед» для /niche без браузера: популярная выдача и выдача «новинки».
 * Заложено: явные сегменты (флисовый, вязаный, с рукавами…), три новинки уже в топе,
 * бренды не доминируют, товар демо-магазина стоит на 23-м месте.
 */
import { DEMO_COSTS, DEMO_PRODUCTS } from "../audit/demo.js";
import type { SearchCard, SearchSnapshot } from "../competitors/analyze.js";
import type { NicheInput } from "./niche.js";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRANDS = ["LOVEBERRY", "Василиса", "СпимХорошо", "ТианаХоум", "DREAMBOX", "Home Comfort", "Текстиль Иваново", "Soft Dream", "Mona Liza", "Cozy Home", "Нет бренда", "ARYA", "Пушистик", "SleepWell"];
/** Сегменты: слово в названии, доля в выдаче, множитель цены. */
const KINDS: [string, number, number][] = [
  ["флисовый", 0.32, 0.8],
  ["вязаный", 0.2, 1.6],
  ["плюшевый", 0.16, 1.1],
  ["с рукавами", 0.1, 1.3],
  ["муслиновый", 0.08, 1.4],
  ["детский", 0.14, 0.9],
];
const SIZES = ["150х200", "200х220", "180х200", "220х240"];

function pickKind(r: () => number): [string, number] {
  let x = r();
  for (const [w, share, k] of KINDS) {
    if ((x -= share) <= 0) return [w, k];
  }
  return [KINDS[0]![0], KINDS[0]![2]];
}

function card(r: () => number, position: number, nmId: number, fresh: boolean): SearchCard {
  const strength = Math.max(0.04, 1 - position / 110);
  const [kind, k] = pickKind(r);
  const price = Math.round(1350 * k * (0.75 + r() * 0.5));
  return {
    position, nmId,
    brand: BRANDS[Math.floor(r() * BRANDS.length)]!,
    name: `Плед ${kind} ${SIZES[Math.floor(r() * SIZES.length)]}`,
    price, oldPrice: Math.round(price * 1.8), priceIsWallet: true,
    rating: Math.round((4.5 + strength * 0.4 + r() * 0.1) * 10) / 10,
    reviews: fresh ? Math.round(r() * r() * 60) : Math.round(strength * strength * 2600 * (0.4 + r())),
    delivery: "Послезавтра", labels: [], ad: false,
  };
}

export function demoNicheInput(now = new Date()): NicheInput {
  const scannedAt = now.toISOString();
  const r = rng(4242);
  const popular: SearchCard[] = [];
  const own = DEMO_PRODUCTS.find((p) => p.vendorCode === "PLAID-GREY-150")!;
  // Три новинки уже в топе: на 6, 15 и 41 месте.
  const newAt = new Map([[6, 900_000_001], [15, 900_000_002], [41, 900_000_003]]);
  for (let pos = 1; pos <= 100; pos++) {
    if (pos === 23) {
      popular.push({ position: pos, nmId: own.nmId, brand: "Уютный дом", name: own.title, price: 1490, oldPrice: 2390, priceIsWallet: true, rating: 4.8, reviews: 312, delivery: "Послезавтра", labels: [], ad: false });
      continue;
    }
    const id = newAt.get(pos) ?? 800_000_000 + pos;
    const c = card(r, pos, id, false);
    if (newAt.has(pos)) c.reviews = 40 + pos;
    popular.push(c);
  }
  const fresh: SearchCard[] = [];
  for (let i = 1; i <= 60; i++) {
    const c = card(r, i, 900_000_000 + i, true);
    // Новинки из топа — те же артикулы и цены.
    const inTop = popular.find((p) => p.nmId === c.nmId);
    fresh.push(inTop ? { ...inTop, position: i } : c);
  }
  const url = (sort?: string) => `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent("плед")}${sort ? `&sort=${sort}` : ""}`;
  const snapshots: SearchSnapshot[] = [
    { query: "плед", url: url(), scannedAt, cards: popular },
    { query: "плед", url: url("newly"), scannedAt, cards: fresh },
  ];
  const items: Record<string, { sales: number; revenue: number }> = {};
  for (const c of popular.slice(0, 30)) {
    const n = Math.round(4200 / (c.position + 3));
    items[String(c.nmId)] = { sales: n, revenue: n * (c.price ?? 0) };
  }
  return {
    generatedAt: scannedAt,
    demo: true,
    snapshots,
    own: [own.nmId],
    sales: { source: "MPSTATS (демо)", period: { from: new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10), to: scannedAt.slice(0, 10) }, items },
    economy: { takeRate: 47, costs: Object.fromEntries(DEMO_COSTS.filter((c) => c.cost !== null).map((c) => [String(c.nmId), c.cost!])) },
  };
}
