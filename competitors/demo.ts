/**
 * Демо-выдача WB для двух запросов и снимок недельной давности — чтобы показать
 * /competitors без браузера и проверить анализ тестами. Товары демо-магазина
 * «Уютный дом» стоят в выдаче с типовыми проблемами: бежевый плед закончился и
 * выпал из выдачи, кружка сползла с 31 на 47 место и дороже лидеров, у неё слабая карточка.
 */
import { DEMO_PRODUCTS } from "../audit/demo.js";
import type { CardDetails } from "./cdn.js";
import type { CompetitorInput, OwnProduct, SearchCard, SearchSnapshot } from "./analyze.js";

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

const BRANDS = ["LOVEBERRY", "Василиса", "СпимХорошо", "ТианаХоум", "DREAMBOX", "Home Comfort", "Текстиль Иваново", "Soft Dream", "Mona Liza", "Cozy Home", "Нет бренда", "ARYA"];

interface Spec {
  query: string;
  basePrice: number;
  noun: string;
  own: { nmId: number; position: number | null; prevPosition: number | null; price: number; rating: number; reviews: number; labels: string[] }[];
  seed: number;
}

const SPECS: Spec[] = [
  {
    query: "плед флисовый",
    basePrice: 1200,
    noun: "Плед флисовый",
    seed: 11,
    own: [
      { nmId: 201450001, position: 14, prevPosition: 8, price: 1490, rating: 4.8, reviews: 312, labels: ["ЧЁРНАЯ ПЯТНИЦА"] },
      // Закончился — в текущей выдаче его нет, неделю назад был девятым.
      { nmId: 201450002, position: null, prevPosition: 9, price: 2890, rating: 4.9, reviews: 540, labels: [] },
    ],
  },
  {
    query: "кружка керамическая",
    basePrice: 450,
    noun: "Кружка керамическая",
    seed: 22,
    own: [{ nmId: 201450005, position: 47, prevPosition: 31, price: 590, rating: 4.7, reviews: 38, labels: [] }],
  },
];

function card(r: () => number, position: number, nmId: number, spec: Spec): SearchCard {
  // Чем выше в выдаче, тем больше отзывов и чуть выше рейтинг — как в жизни.
  const strength = Math.max(0.05, 1 - position / 110);
  const price = Math.round(spec.basePrice * (0.65 + r() * 0.7));
  const promo = r() < 0.65;
  return {
    position,
    nmId,
    brand: BRANDS[Math.floor(r() * BRANDS.length)]!,
    name: `${spec.noun} ${["однотонный", "с узором", "подарочный", "большой", "мягкий"][Math.floor(r() * 5)]}`,
    price,
    oldPrice: Math.round(price * (1.4 + r())),
    priceIsWallet: true,
    rating: Math.round((4.4 + strength * 0.5 + r() * 0.1) * 10) / 10,
    reviews: Math.round(strength * strength * 6000 * (0.5 + r())),
    delivery: ["Завтра", "Послезавтра", "21 ноября"][Math.floor(r() * 3)]!,
    labels: promo ? ["ЧЁРНАЯ ПЯТНИЦА"] : [],
    ad: false,
  };
}

function snapshot(spec: Spec, scannedAt: string, prev: boolean): SearchSnapshot {
  const ownAt = new Map<number, Spec["own"][number]>();
  for (const o of spec.own) {
    const pos = prev ? o.prevPosition : o.position;
    if (pos) ownAt.set(pos, o);
  }
  const cards: SearchCard[] = [];
  for (let pos = 1; pos <= 100; pos++) {
    const o = ownAt.get(pos);
    if (o) {
      const p = DEMO_PRODUCTS.find((x) => x.nmId === o.nmId)!;
      cards.push({ position: pos, nmId: o.nmId, brand: "Уютный дом", name: p.title, price: o.price, oldPrice: Math.round(o.price * 1.6), priceIsWallet: true, rating: o.rating, reviews: o.reviews, delivery: "Послезавтра", labels: o.labels, ad: false });
    } else {
      // Неделю назад первая десятка была немного другой: два новых лидера появились за неделю.
      const id = 300_000_000 + spec.seed * 1000 + (prev && pos <= 2 ? pos + 500 : pos);
      // Свой генератор на каждую позицию: снимки отличаются только тем, что заложено специально.
      cards.push(card(rng(spec.seed * 1000 + pos), pos, id, spec));
    }
  }
  // Двое лидеров снизили цену за неделю.
  if (!prev) {
    cards[2]!.price = Math.round(cards[2]!.price! * 0.85);
    cards[4]!.price = Math.round(cards[4]!.price! * 0.9);
  }
  const q = encodeURIComponent(spec.query);
  return { query: spec.query, url: `https://www.wildberries.ru/catalog/0/search.aspx?search=${q}`, scannedAt, cards };
}

function details(snaps: SearchSnapshot[], own: OwnProduct[]): Record<string, CardDetails> {
  const out: Record<string, CardDetails> = {};
  const r = rng(99);
  for (const s of snaps) {
    for (const c of s.cards.slice(0, 10)) {
      out[String(c.nmId)] = {
        nmId: c.nmId, subject: s.query, title: c.name ?? "", descriptionLength: Math.round(1200 + r() * 1200),
        characteristics: Math.round(12 + r() * 8), photos: Math.round(8 + r() * 6), hasVideo: r() < 0.7, colors: 1 + Math.floor(r() * 4),
      };
    }
  }
  for (const o of own) {
    const p = DEMO_PRODUCTS.find((x) => x.nmId === o.nmId)!;
    out[String(o.nmId)] = { nmId: p.nmId, subject: p.subject, title: p.title, descriptionLength: p.descriptionLength, characteristics: p.characteristics, photos: p.photos, hasVideo: p.video, colors: 1 };
  }
  return out;
}

export function demoCompetitorInput(now = new Date()): CompetitorInput {
  const scannedAt = now.toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const own: OwnProduct[] = DEMO_PRODUCTS.map((p) => ({ nmId: p.nmId, vendorCode: p.vendorCode, title: p.title }));
  const snapshots = SPECS.map((s) => snapshot(s, scannedAt, false));
  // Продажи «как из MPSTATS»: у лидеров сотни штук, у слабой кружки — несколько десятков.
  const items: Record<string, { sales: number; revenue: number }> = {};
  for (const sn of snapshots) {
    for (const c of sn.cards.slice(0, 10)) {
      const n = Math.round(3000 / (c.position + 2));
      items[String(c.nmId)] = { sales: n, revenue: n * (c.price ?? 0) };
    }
    for (const o of SPECS.find((x) => x.query === sn.query)!.own) {
      if (!o.position) continue;
      const n = o.nmId === 201450005 ? 40 : 420;
      items[String(o.nmId)] = { sales: n, revenue: n * o.price };
    }
  }
  const from = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    generatedAt: scannedAt,
    demo: true,
    snapshots,
    own,
    details: details(snapshots, own),
    previous: SPECS.map((s) => snapshot(s, weekAgo, true)),
    sales: { source: "MPSTATS (демо)", period: { from, to: scannedAt.slice(0, 10) }, items },
  };
}
