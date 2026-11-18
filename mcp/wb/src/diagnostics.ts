/**
 * Диагностика ключа WB: срок действия из самого токена и проверка доступа
 * к каждой категории API через /ping. Используется и инструментом
 * check_connection, и скриптом `npm run check`.
 */
import { HOSTS, type WBHost } from "./client.js";

/** Категории так, как они называются в кабинете WB (Настройки → Доступ к API). */
export const CATEGORIES: { key: string; title: string; host: WBHost; usedFor: string }[] = [
  { key: "content", title: "Контент", host: HOSTS.content, usedFor: "карточки товаров" },
  { key: "prices", title: "Цены и скидки", host: HOSTS.prices, usedFor: "цены, изменение цен" },
  { key: "marketplace", title: "Маркетплейс", host: HOSTS.marketplace, usedFor: "склады продавца, FBS-заказы и поставки" },
  { key: "statistics", title: "Статистика", host: HOSTS.statistics, usedFor: "заказы и продажи, ABC-анализ" },
  { key: "analytics", title: "Аналитика", host: HOSTS.analytics, usedFor: "воронка, остатки на складах WB, поисковые запросы, платное хранение" },
  { key: "finance", title: "Финансы", host: HOSTS.finance, usedFor: "финансовый отчёт, баланс" },
  { key: "promotion", title: "Продвижение", host: HOSTS.advert, usedFor: "реклама: кампании, расходы, статистика" },
  { key: "feedbacks", title: "Вопросы и отзывы", host: HOSTS.feedbacks, usedFor: "отзывы, вопросы, рейтинг продавца" },
  { key: "returns", title: "Возвраты покупателями", host: HOSTS.returns, usedFor: "заявки на возврат" },
  { key: "supplies", title: "Поставки", host: HOSTS.supplies, usedFor: "поставки FBW" },
  { key: "chat", title: "Чат с покупателями", host: HOSTS.chat, usedFor: "чат с покупателями" },
  { key: "documents", title: "Документы", host: HOSTS.documents, usedFor: "закрывающие документы" },
  { key: "common", title: "Тарифы и общее", host: HOSTS.common, usedFor: "комиссии, тарифы, данные продавца (доступно с любым ключом)" },
];

export interface TokenInfo {
  valid: boolean;
  expiresAt?: string;
  daysLeft?: number;
  sellerId?: string;
  isTest?: boolean;
  problem?: string;
}

/**
 * Токен WB — это JWT. Подпись мы не проверяем (это делает WB), читаем только
 * срок действия, чтобы заранее предупредить: ключ живёт 180 дней.
 */
export function decodeToken(token: string): TokenInfo {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, problem: "Это не похоже на ключ WB: ключ состоит из трёх частей, разделённых точками." };
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const exp = typeof payload["exp"] === "number" ? payload["exp"] : undefined;
    const info: TokenInfo = { valid: true };
    if (exp) {
      info.expiresAt = new Date(exp * 1000).toISOString().slice(0, 10);
      info.daysLeft = Math.floor((exp * 1000 - Date.now()) / 86_400_000);
      if (info.daysLeft < 0) {
        info.valid = false;
        info.problem = `Срок действия ключа закончился ${info.expiresAt}. Создайте новый ключ в кабинете WB.`;
      }
    }
    if (payload["oid"] !== undefined) info.sellerId = String(payload["oid"]);
    if (payload["t"] === true) info.isTest = true;
    return info;
  } catch {
    return { valid: false, problem: "Ключ повреждён: не получается прочитать его содержимое. Скопируйте ключ заново целиком." };
  }
}

export interface PingResult {
  key: string;
  title: string;
  usedFor: string;
  ok: boolean;
  status?: number;
  reason?: string;
}

/** Пингуем все категории параллельно: у /ping свой лимит на каждом хосте, один запрос его не задевает. */
export async function pingAll(token: string, timeoutMs = 15_000): Promise<PingResult[]> {
  return Promise.all(
    CATEGORIES.map(async (c): Promise<PingResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`https://${c.host}/ping`, {
          headers: { Authorization: token.trim() },
          signal: controller.signal,
        });
        const base = { key: c.key, title: c.title, usedFor: c.usedFor, status: res.status };
        if (res.ok) return { ...base, ok: true };
        if (res.status === 401) return { ...base, ok: false, reason: "в ключе нет этой категории или ключ недействителен" };
        if (res.status === 429) return { ...base, ok: false, reason: "слишком частые проверки, повторите через минуту" };
        return { ...base, ok: false, reason: `WB ответил кодом ${res.status}` };
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
          key: c.key,
          title: c.title,
          usedFor: c.usedFor,
          ok: false,
          reason: aborted ? "WB не ответил вовремя" : "нет связи с WB (интернет, VPN или блокировка)",
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
