/**
 * Публичное описание карточки WB с CDN (basket-NN.wbbasket.ru/.../info/ru/card.json):
 * описание, характеристики, число фото. Это те же статические файлы, которые
 * загружает страница товара; авторизация не нужна.
 *
 * Правила вежливости: честное имя клиента (не притворяемся браузером), пауза между
 * запросами, только карточки, нужные для сравнения (десятки, не тысячи).
 */

export interface CardDetails {
  nmId: number;
  subject: string;
  title: string;
  descriptionLength: number;
  characteristics: number;
  photos: number;
  hasVideo: boolean;
  colors: number;
}

const USER_AGENT = "wb-kit/0.1 (competitor overview; +https://github.com)";

/**
 * Номер сервера basket-NN по диапазону vol (артикул ÷ 100 000). Таблица растёт
 * вместе с WB и устаревает — поэтому есть перебор с запоминанием найденного.
 * Источник таблицы — скрипты mpstats-io/claude-code-skills (MIT), 2026-05.
 */
const BASKET_RANGES: [number, number][] = [
  [143, 1], [287, 2], [431, 3], [719, 4], [1007, 5], [1061, 6], [1115, 7], [1169, 8], [1313, 9], [1601, 10],
  [1655, 11], [1919, 12], [2045, 13], [2189, 14], [2405, 15], [2621, 16], [2837, 17], [3053, 18], [3269, 19],
  [3485, 20], [3701, 21], [3917, 22], [4133, 23], [4349, 24], [4565, 25], [4781, 26],
];
/**
 * Для новых артикулов таблицы нет: опорные точки vol → basket, найденные перебором
 * 2026-11-18. Между ними номер растёт почти линейно, интерполяция попадает в ±2.
 */
const ANCHORS: [number, number][] = [
  [4781, 26], [5060, 27], [8896, 39], [11772, 43], [14774, 47], [18990, 53], [20467, 55], [22258, 57],
];
const MAX_BASKET = 99;
/** Сколько соседних серверов пробовать в каждую сторону, если угаданный не подошёл. */
const PROBE_RADIUS = 8;

export function guessBasket(nmId: number): number {
  const vol = Math.floor(nmId / 100_000);
  for (const [max, n] of BASKET_RANGES) if (vol <= max) return n;
  for (let i = 1; i < ANCHORS.length; i++) {
    const [v0, b0] = ANCHORS[i - 1]!;
    const [v1, b1] = ANCHORS[i]!;
    if (vol <= v1) return Math.round(b0 + ((vol - v0) / (v1 - v0)) * (b1 - b0));
  }
  // Дальше последней точки — продолжаем тем же наклоном.
  const [va, ba] = ANCHORS[ANCHORS.length - 2]!;
  const [vb, bb] = ANCHORS[ANCHORS.length - 1]!;
  return Math.min(MAX_BASKET, Math.round(bb + ((vol - vb) / (vb - va)) * (bb - ba)));
}

export function cardUrl(nmId: number, basket: number): string {
  const vol = Math.floor(nmId / 100_000);
  const part = Math.floor(nmId / 1000);
  return `https://basket-${String(basket).padStart(2, "0")}.wbbasket.ru/vol${vol}/part${part}/${nmId}/info/ru/card.json`;
}

/** Фото товара с того же сервера: 1.webp — главное фото, c246x328 — размер превью в каталоге. */
export function photoUrl(nmId: number, basket: number, n = 1, size: "c246x328" | "big" = "c246x328"): string {
  const vol = Math.floor(nmId / 100_000);
  const part = Math.floor(nmId / 1000);
  return `https://basket-${String(basket).padStart(2, "0")}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/${size}/${n}.webp`;
}

export function parseCard(nmId: number, j: Record<string, unknown>): CardDetails {
  const media = (j["media"] ?? {}) as Record<string, unknown>;
  const options = Array.isArray(j["options"]) ? (j["options"] as unknown[]) : [];
  const grouped = Array.isArray(j["grouped_options"]) ? (j["grouped_options"] as { options?: unknown[] }[]) : [];
  const groupedCount = grouped.reduce((s, g) => s + (Array.isArray(g.options) ? g.options.length : 0), 0);
  return {
    nmId,
    subject: String(j["subj_name"] ?? ""),
    title: String(j["imt_name"] ?? ""),
    descriptionLength: String(j["description"] ?? "").length,
    characteristics: Math.max(options.length, groupedCount),
    photos: Number(media["photo_count"] ?? 0),
    hasVideo: Boolean(media["has_video"]),
    colors: Array.isArray(j["nm_colors_names"]) ? (j["nm_colors_names"] as unknown[]).length : String(j["nm_colors_names"] ?? "").split(",").filter(Boolean).length,
  };
}

/** Текст карточки с CDN: название, описание, характеристики (по группам и без). */
export function parseCardText(nmId: number, j: Record<string, unknown>) {
  const media = (j["media"] ?? {}) as Record<string, unknown>;
  const chars = new Map<string, { name: string; value: string }>();
  const add = (o: unknown) => {
    const x = o as { name?: unknown; value?: unknown };
    if (x && typeof x.name === "string" && x.value !== undefined && x.value !== null) chars.set(x.name, { name: x.name, value: String(x.value) });
  };
  for (const o of Array.isArray(j["options"]) ? (j["options"] as unknown[]) : []) add(o);
  for (const g of Array.isArray(j["grouped_options"]) ? (j["grouped_options"] as { options?: unknown[] }[]) : []) for (const o of g.options ?? []) add(o);
  return {
    nmId,
    vendorCode: typeof j["vendor_code"] === "string" ? (j["vendor_code"] as string) : undefined,
    subject: String(j["subj_name"] ?? ""),
    title: String(j["imt_name"] ?? ""),
    description: String(j["description"] ?? ""),
    characteristics: [...chars.values()],
    photos: Number(media["photo_count"] ?? 0),
    hasVideo: Boolean(media["has_video"]),
  };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class CardFetcher {
  /** vol → найденный basket: соседние артикулы лежат на одном сервере. */
  private readonly volCache = new Map<number, number>();
  private last = 0;

  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly minIntervalMs = 300,
  ) {}

  private async pause() {
    const wait = this.last + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
  }

  private async tryBasket(nmId: number, basket: number): Promise<Record<string, unknown> | null> {
    await this.pause();
    try {
      const res = await this.fetchFn(cardUrl(nmId, basket), { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async get(nmId: number): Promise<CardDetails | null> {
    const j = await this.getRaw(nmId);
    return j ? parseCard(nmId, j) : null;
  }

  /** Номер сервера, на котором лежат карточка и фото (null — не нашли). */
  async basket(nmId: number): Promise<number | null> {
    const vol = Math.floor(nmId / 100_000);
    if (this.volCache.has(vol)) return this.volCache.get(vol)!;
    return (await this.getRaw(nmId)) ? this.volCache.get(vol)! : null;
  }

  /** card.json целиком — для разбора текста карточки (`/card`). */
  async getRaw(nmId: number): Promise<Record<string, unknown> | null> {
    const vol = Math.floor(nmId / 100_000);
    const first = this.volCache.get(vol) ?? guessBasket(nmId);
    // Если таблица устарела, нужный сервер обычно рядом с угаданным — перебираем от ближних,
    // но не дальше PROBE_RADIUS: не найдено за 17 попыток — пропускаем карточку.
    const order = Array.from({ length: MAX_BASKET }, (_, i) => i + 1)
      .filter((b) => Math.abs(b - first) <= PROBE_RADIUS)
      .sort((a, b) => Math.abs(a - first) - Math.abs(b - first) || a - b);
    for (const b of order) {
      const j = await this.tryBasket(nmId, b);
      if (j) {
        this.volCache.set(vol, b);
        return j;
      }
    }
    return null;
  }
}
