/**
 * Демо-магазин: выдуманный продавец «Уютный дом» и подменный клиент, который
 * отвечает на те же пути API WB, что и настоящий. Аудит в демо-режиме проходит
 * ровно тот же код, что и с настоящим ключом, — поэтому демо заодно служит тестом.
 *
 * Данные детерминированы (сид), но привязаны к сегодняшней дате, чтобы отчёт
 * выглядел свежим. В магазин специально заложены типовые проблемы: товар
 * закончился, затоваривание, мёртвый остаток, слабая карточка, низкий выкуп,
 * жалобы в отзывах, дорогая реклама.
 */
import { HOSTS, type WBClient } from "../mcp/wb/src/client.js";

type Row = Record<string, unknown>;

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

interface DemoProduct {
  nmId: number;
  vendorCode: string;
  title: string;
  subject: string;
  price: number; // цена со скидкой продавца
  perDay: number; // заказов в день
  trend: number; // множитель последних 30 дней к прошлым
  buyout: number; // доля выкупа
  addToCart: number; // % переходов в корзину
  cartToOrder: number; // % корзин в заказ
  stock: number; // остаток на складах WB
  rating: number; // средняя оценка
  photos: number;
  video: boolean;
  descriptionLength: number;
  characteristics: number;
  complaint?: string;
}

const P = (
  nmId: number, vendorCode: string, title: string, subject: string, price: number, perDay: number,
  o: Partial<DemoProduct> = {},
): DemoProduct => ({
  nmId, vendorCode, title, subject, price, perDay,
  // Небольшой разброс по артикулу, чтобы у «нормальных» товаров цифры не были одинаковыми.
  trend: 1, buyout: 0.78 + (nmId % 7) * 0.02, addToCart: 7 + (nmId % 5), cartToOrder: 28 + (nmId % 9), stock: Math.round(perDay * 45) + 5, rating: Math.round((4.6 + (nmId % 4) * 0.1) * 10) / 10,
  photos: 8, video: true, descriptionLength: 1800, characteristics: 18, ...o,
});

/** Ассортимент: сначала хиты, потом середина, в конце хвост. Проблемы заложены в параметрах. */
export const DEMO_PRODUCTS: DemoProduct[] = [
  P(201450001, "PLAID-GREY-150", "Плед флисовый 150×200 серый", "Пледы", 1490, 14, { stock: 120, trend: 1.15 }),
  P(201450002, "PLAID-BEIGE-200", "Плед вязаный 200×220 бежевый", "Пледы", 2890, 7, { stock: 0, trend: 1.05 }), // закончился
  P(201450003, "PILLOW-50x70", "Подушка 50×70 бамбук", "Подушки", 990, 11, { stock: 60, buyout: 0.9 }),
  P(201450004, "TOWEL-SET-3", "Набор полотенец 3 шт хлопок", "Полотенца", 1290, 9, { stock: 1400, trend: 0.8 }), // затоварено
  P(201450005, "MUG-CERAMIC-400", "Кружка керамическая 400 мл", "Кружки", 590, 8, { addToCart: 3.1, photos: 3, video: false, descriptionLength: 240, characteristics: 6 }), // слабая карточка
  P(201450006, "SLIPPERS-38-39", "Тапочки домашние меховые", "Тапочки", 790, 7, { buyout: 0.41, rating: 4.1, complaint: "размер" }), // низкий выкуп
  P(201450007, "CANDLE-SOY-200", "Свеча соевая в банке 200 г", "Свечи", 690, 6, { stock: 25, trend: 1.3 }),
  P(201450008, "BLANKET-KIDS", "Одеяло детское 110×140", "Одеяла", 1890, 5, { trend: 0.62 }), // просели продажи
  P(201450009, "ORGANIZER-6", "Органайзер для белья 6 ячеек", "Органайзеры", 450, 5, { rating: 3.9, complaint: "брак" }),
  P(201450010, "BATHROBE-M", "Халат махровый женский", "Халаты", 2490, 3, { buyout: 0.55, complaint: "размер" }),
  P(201450011, "NAPKIN-LINEN-4", "Салфетки льняные 4 шт", "Салфетки", 890, 3),
  P(201450012, "VASE-GLASS-25", "Ваза стеклянная 25 см", "Вазы", 1190, 2.5, { photos: 4, video: false }),
  P(201450013, "DIFFUSER-100", "Диффузор ароматический 100 мл", "Ароматы для дома", 990, 2.2, { stock: 4 }),
  P(201450014, "CURTAIN-BLACK", "Штора блэкаут 150×270", "Шторы", 1690, 2, { addToCart: 4, descriptionLength: 380 }),
  P(201450015, "RUG-BATH-50", "Коврик для ванной 50×80", "Коврики", 690, 1.8),
  P(201450016, "BOX-STORAGE-3", "Короба для хранения 3 шт", "Короба", 1090, 1.5, { stock: 600 }), // затоварено
  P(201450017, "THERMOS-1L", "Термос 1 л стальной", "Термосы", 1390, 1.2, { rating: 4.4 }),
  P(201450018, "APRON-COTTON", "Фартук кухонный хлопок", "Фартуки", 490, 1, { photos: 2, video: false, descriptionLength: 150, characteristics: 5 }),
  P(201450019, "HOOKS-SET-10", "Крючки самоклеящиеся 10 шт", "Крючки", 290, 0.8),
  P(201450020, "TABLECLOTH-140", "Скатерть 140×180 водоотталкивающая", "Скатерти", 1290, 0.6),
  P(201450021, "PILLOWCASE-2", "Наволочки 50×70 2 шт сатин", "Наволочки", 690, 0.4),
  P(201450022, "LAMP-NIGHT", "Ночник светодиодный", "Ночники", 890, 0, { stock: 85 }), // мёртвый остаток
  P(201450023, "FRAME-PHOTO-A4", "Рамка для фото А4", "Рамки", 390, 0, { stock: 140 }), // мёртвый остаток
  P(201450024, "BASKET-JUTE", "Корзина джутовая 30 см", "Корзины", 990, 0.3),
];

const COMPLAINTS: Record<string, string[]> = {
  размер: [
    "Маломерят на размер, пришлось вернуть.",
    "Размер не соответствует таблице, очень маленькие.",
    "Заказала свой размер — не налезли. Возврат.",
  ],
  брак: [
    "Пришёл с браком: одна ячейка порвана.",
    "Швы расходятся через неделю, качество слабое.",
    "Тонкий материал, держит форму плохо.",
  ],
  общее: ["Цвет не совпадает с фото.", "Долгая доставка.", "Упаковка помята, но товар целый."],
};
const PRAISE = ["Отличный товар, всё как на фото!", "Очень мягкий и приятный, рекомендую.", "Качество хорошее за свою цену.", "Уже второй раз заказываю, всё отлично.", "Пришло быстро, упаковано аккуратно."];

const WAREHOUSES = ["Коледино", "Электросталь", "Казань", "Краснодар", "Новосибирск"];
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 19);
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);

interface Generated {
  orders: Row[];
  sales: Row[];
  feedbacks: Row[];
  adCosts: Row[];
}

function generate(now: Date): Generated {
  const r = rng(20261118);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const orders: Row[] = [];
  const sales: Row[] = [];
  const feedbacks: Row[] = [];
  let srid = 1;
  for (const p of DEMO_PRODUCTS) {
    for (let d = 90; d >= 0; d--) {
      const dayT = today - d * DAY;
      // Последние 30 дней — с трендом товара, у закончившегося товара заказов нет последние 9 дней.
      const recent = d <= 30;
      if (p.stock === 0 && d <= 9) continue;
      const lambda = p.perDay * (recent ? p.trend : 1) * (0.75 + r() * 0.5);
      let n = Math.floor(lambda) + (r() < lambda - Math.floor(lambda) ? 1 : 0);
      for (; n > 0; n--) {
        const t = dayT + Math.floor(r() * DAY * 0.95);
        const price = Math.round(p.price * (0.95 + r() * 0.1));
        const cancel = r() < 0.04;
        const id = `D${srid++}`;
        orders.push({
          date: iso(t), lastChangeDate: iso(t + 3600_000), warehouseName: WAREHOUSES[Math.floor(r() * WAREHOUSES.length)],
          supplierArticle: p.vendorCode, nmId: p.nmId, subject: p.subject, brand: "Уютный дом", category: "Дом",
          totalPrice: Math.round(price / 0.7), discountPercent: 30, priceWithDisc: price, finishedPrice: Math.round(price * 0.85),
          isCancel: cancel, srid: id,
        });
        if (cancel) continue;
        const delivered = t + (3 + Math.floor(r() * 5)) * DAY;
        if (delivered > today + DAY) continue;
        if (r() < p.buyout) {
          const forPay = Math.round(price * 0.74);
          sales.push({ date: iso(delivered), lastChangeDate: iso(delivered + 3600_000), supplierArticle: p.vendorCode, nmId: p.nmId, subject: p.subject, brand: "Уютный дом", saleID: `S${id}`, priceWithDisc: price, forPay, srid: id });
          if (r() < 0.03 && delivered + 5 * DAY < today) {
            sales.push({ date: iso(delivered + 5 * DAY), lastChangeDate: iso(delivered + 5 * DAY), supplierArticle: p.vendorCode, nmId: p.nmId, subject: p.subject, brand: "Уютный дом", saleID: `R${id}`, priceWithDisc: -price, forPay: -forPay, srid: id });
          }
          // Примерно каждый восьмой выкуп оставляет отзыв.
          if (r() < 0.12 && delivered + 2 * DAY < today) {
            // Доля негатива: у товара с рейтингом 4,8 — около 4%, у 3,9 — около 24%.
            const bad = r() < (5 - p.rating) / 4.5;
            const rating = bad ? 1 + Math.floor(r() * 3) : r() < 0.85 ? 5 : 4;
            const pool = bad ? COMPLAINTS[p.complaint ?? "общее"]! : PRAISE;
            const createdT = delivered + 2 * DAY;
            const answered = today - createdT > 4 * DAY || r() < 0.2;
            feedbacks.push({
              id: `fb${feedbacks.length + 1}`, createdDate: iso(createdT), productValuation: rating,
              text: pool[Math.floor(r() * pool.length)], pros: "", cons: bad ? pool[Math.floor(r() * pool.length)] : "",
              answer: answered ? { text: "Спасибо за отзыв!" } : null, userName: "Покупатель", photoLinks: [], wasViewed: answered,
              productDetails: { nmId: p.nmId, productName: p.title, supplierArticle: p.vendorCode, brandName: "Уютный дом" },
            });
          }
        }
      }
    }
  }
  // Реклама: три кампании, одна из них тратит много при слабой отдаче.
  const adCosts: Row[] = [];
  const camps = [
    { advertId: 31001, campName: "Пледы — поиск", perDay: 6000 },
    { advertId: 31002, campName: "Кружки — поиск", perDay: 4000 },
    { advertId: 31003, campName: "Тапочки — каталог", perDay: 9000 },
  ];
  for (let d = 90; d >= 1; d--) {
    for (const c of camps) {
      adCosts.push({ updNum: adCosts.length + 1, updTime: iso(today - d * DAY + 12 * 3600_000), updSum: Math.round(c.perDay * (0.7 + r() * 0.6)), advertId: c.advertId, campName: c.campName, advertType: 9, paymentType: "Баланс", advertStatus: 9 });
    }
  }
  return { orders, sales, feedbacks, adCosts };
}

const inDates = (v: unknown, from: string, to: string) => {
  const d = String(v ?? "").slice(0, 10);
  return d >= from && d <= to;
};

function funnelFor(g: Generated, p: DemoProduct, start: string, end: string) {
  const ord = g.orders.filter((o) => o["nmId"] === p.nmId && inDates(o["date"], start, end));
  const orderCount = ord.length;
  const orderSum = ord.reduce((s, o) => s + Number(o["priceWithDisc"]), 0);
  const cancelCount = ord.filter((o) => o["isCancel"]).length;
  const buy = g.sales.filter((s) => s["nmId"] === p.nmId && String(s["saleID"]).startsWith("S") && inDates(s["date"], start, end));
  const cartCount = Math.round(orderCount / (p.cartToOrder / 100));
  const openCount = Math.round(cartCount / (p.addToCart / 100)) + 3;
  const days = (Date.parse(end) - Date.parse(start)) / DAY + 1;
  return {
    period: { start, end }, openCount, cartCount, orderCount, orderSum, buyoutCount: buy.length,
    buyoutSum: buy.reduce((s, b) => s + Number(b["priceWithDisc"]), 0), cancelCount, cancelSum: 0,
    avgPrice: orderCount ? Math.round(orderSum / orderCount) : p.price, avgOrdersCountPerDay: Math.round((orderCount / days) * 10) / 10,
    conversions: {
      addToCartPercent: openCount ? Math.round((cartCount / openCount) * 100) : 0,
      cartToOrderPercent: cartCount ? Math.round((orderCount / cartCount) * 100) : 0,
      buyoutPercent: Math.round(p.buyout * 100),
    },
  };
}

function financeRows(g: Generated, from: string, to: string): Row[] {
  const rows: Row[] = [];
  let rrdId = 1;
  for (const s of g.sales) {
    if (!inDates(s["date"], from, to)) continue;
    const p = DEMO_PRODUCTS.find((x) => x.nmId === s["nmId"])!;
    const isReturn = String(s["saleID"]).startsWith("R");
    rows.push({
      rrdId: rrdId++, nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, subjectName: p.subject, brandName: "Уютный дом",
      docTypeName: isReturn ? "Возврат" : "Продажа", sellerOperName: isReturn ? "Возврат" : "Продажа", quantity: 1,
      retailPriceWithDisc: String(Math.abs(Number(s["priceWithDisc"]))), forPay: String(Math.abs(Number(s["forPay"]))),
      deliveryService: "0", penalty: "0", paidStorage: "0", paidAcceptance: "0", deduction: "0", additionalPayment: "0",
      acquiringFee: String(Math.round(Math.abs(Number(s["priceWithDisc"])) * 0.015)), rrDate: String(s["date"]).slice(0, 10),
    });
  }
  // Логистика — на каждый заказ, дороже у низкого выкупа (обратная логистика).
  for (const o of g.orders) {
    if (!inDates(o["date"], from, to) || o["isCancel"]) continue;
    const p = DEMO_PRODUCTS.find((x) => x.nmId === o["nmId"])!;
    const cost = 70 + (p.price > 2000 ? 40 : 0) + (1 - p.buyout) * 110;
    rows.push({ rrdId: rrdId++, nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, docTypeName: "", sellerOperName: "Логистика", quantity: 0, deliveryService: String(Math.round(cost)), forPay: "0", retailPriceWithDisc: "0" });
  }
  // Хранение — раз в день по остатку, штрафы — два случая.
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  for (const p of DEMO_PRODUCTS) {
    if (!p.stock) continue;
    rows.push({ rrdId: rrdId++, nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, docTypeName: "", sellerOperName: "Хранение", paidStorage: String(Math.round(p.stock * 0.9 * days)), forPay: "0" });
  }
  rows.push({ rrdId: rrdId++, nmId: 201450009, vendorCode: "ORGANIZER-6", docTypeName: "", sellerOperName: "Штраф", penalty: "1500", forPay: "0", bonusTypeName: "Несоответствие поставки" });
  rows.push({ rrdId: rrdId++, docTypeName: "", sellerOperName: "Платная приёмка", paidAcceptance: "2400", forPay: "0" });
  return rows;
}

/** Подменный клиент WB. Отвечает только на пути, которые использует аудит и MCP. */
export function createDemoClient(now = new Date()): WBClient {
  const g = generate(now);
  const today = dayStr(now.getTime());
  const unixToDay = (v: unknown) => (v ? dayStr(Number(v) * 1000) : undefined);

  const get = async (host: string, path: string, query: Record<string, string | undefined> = {}) => {
    const key = `${host}${path}`;
    switch (key) {
      case `${HOSTS.common}/api/v1/seller-info`:
        return { name: "ИП Демо Д. Д.", sid: "demo", tin: "000000000000", tradeMark: "Уютный дом" };
      case `${HOSTS.feedbacks}/api/common/v1/rating`:
        return { feedbackCount: g.feedbacks.length * 3, valuation: 4.6 };
      case `${HOSTS.statistics}/api/v1/supplier/orders`:
        return g.orders.filter((o) => String(o["lastChangeDate"]) >= String(query.dateFrom));
      case `${HOSTS.statistics}/api/v1/supplier/sales`:
        return g.sales.filter((s) => String(s["lastChangeDate"]) >= String(query.dateFrom));
      case `${HOSTS.feedbacks}/api/v1/feedbacks/count-unanswered`: {
        const n = g.feedbacks.filter((f) => !f["answer"]).length;
        return { data: { countUnanswered: n, countUnansweredToday: Math.min(n, 2) } };
      }
      case `${HOSTS.feedbacks}/api/v1/questions/count-unanswered`:
        return { data: { countUnanswered: 4, countUnansweredToday: 1 } };
      case `${HOSTS.feedbacks}/api/v1/feedbacks`: {
        const answered = query.isAnswered === "true";
        const from = unixToDay(query.dateFrom) ?? "0000";
        const to = unixToDay(query.dateTo) ?? "9999";
        const list = g.feedbacks
          .filter((f) => Boolean(f["answer"]) === answered && inDates(f["createdDate"], from, to))
          .sort((a, b) => String(b["createdDate"]).localeCompare(String(a["createdDate"])));
        const skip = Number(query.skip ?? 0);
        return { data: { countUnanswered: g.feedbacks.filter((f) => !f["answer"]).length, countArchive: 0, feedbacks: list.slice(skip, skip + Number(query.take ?? 50)) } };
      }
      case `${HOSTS.advert}/adv/v1/upd`:
        return g.adCosts.filter((a) => inDates(a["updTime"], String(query.from), String(query.to)));
      default:
        throw new Error(`Демо: путь не поддерживается: GET ${key}`);
    }
  };

  const post = async (host: string, path: string, body: Row = {}) => {
    const key = `${host}${path}`;
    switch (key) {
      case `${HOSTS.content}/content/v2/get/cards/list`: {
        const cursor = ((body["settings"] as Row)?.["cursor"] ?? {}) as Row;
        const limit = Number(cursor["limit"] ?? 100);
        const after = Number(cursor["nmID"] ?? 0);
        const list = DEMO_PRODUCTS.filter((p) => !after || p.nmId > after).slice(0, limit);
        const last = list[list.length - 1];
        return {
          cards: list.map((p) => ({
            nmID: p.nmId, vendorCode: p.vendorCode, brand: "Уютный дом", title: p.title, subjectName: p.subject,
            photos: Array.from({ length: p.photos }, () => ({})), video: p.video ? "video.mp4" : "",
            description: "а".repeat(p.descriptionLength), characteristics: Array.from({ length: p.characteristics }, () => ({})),
            sizes: [{ chrtID: p.nmId * 10, techSize: "0", skus: [`46000${p.nmId}`] }], updatedAt: `${today}T00:00:00Z`,
          })),
          cursor: { updatedAt: `${today}T00:00:00Z`, nmID: last?.nmId ?? 0, total: list.length },
        };
      }
      case `${HOSTS.analytics}/api/analytics/v3/sales-funnel/products`: {
        const sel = body["selectedPeriod"] as { start: string; end: string };
        const past = body["pastPeriod"] as { start: string; end: string } | undefined;
        const offset = Number(body["offset"] ?? 0);
        const limit = Number(body["limit"] ?? 50);
        const products = DEMO_PRODUCTS.slice(offset, offset + limit).map((p) => ({
          product: { nmId: p.nmId, title: p.title, vendorCode: p.vendorCode, brandName: "Уютный дом", subjectName: p.subject, productRating: p.rating, feedbackRating: p.rating, stocks: { wb: p.stock, mp: 0, balanceSum: p.stock * p.price } },
          statistic: { selected: funnelFor(g, p, sel.start, sel.end), past: past ? funnelFor(g, p, past.start, past.end) : undefined },
        }));
        return { data: { products, currency: "RUB" } };
      }
      case `${HOSTS.analytics}/api/analytics/v1/stocks-report/wb-warehouses`: {
        const items: Row[] = [];
        for (const p of DEMO_PRODUCTS) {
          if (!p.stock) continue;
          const parts = p.stock > 100 ? 3 : 1;
          for (let i = 0; i < parts; i++) {
            items.push({ nmId: p.nmId, chrtId: p.nmId * 10, warehouseId: i + 1, warehouseName: WAREHOUSES[i]!, regionName: "Центральный", quantity: Math.round(p.stock / parts), inWayToClient: Math.round(p.perDay * 2), inWayFromClient: Math.round(p.perDay * (1 - p.buyout) * 2) });
          }
        }
        return { data: { items } };
      }
      case `${HOSTS.finance}/api/finance/v1/sales-reports/detailed`: {
        if (Number(body["rrdId"] ?? 0) > 0) return [];
        return financeRows(g, String(body["dateFrom"]), String(body["dateTo"]));
      }
      default:
        throw new Error(`Демо: путь не поддерживается: POST ${key}`);
    }
  };

  return {
    token: "demo",
    get,
    post,
    put: async () => undefined,
    patch: async () => undefined,
    request: async () => {
      throw new Error("Демо-режим: изменения в кабинете недоступны");
    },
    pollUntil: async <T>(o: { fn: () => Promise<T> }) => o.fn(),
  } as unknown as WBClient;
}
