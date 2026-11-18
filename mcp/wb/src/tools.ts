/**
 * Инструменты MCP для Wildberries Seller API.
 *
 * Основа — theYahia/wildberries-mcp (MIT). Все методы заново сверены со Swagger
 * WB (снимок 2026-05-01): часть исходных инструментов ходила в удалённые методы
 * (cards/detail, supplier/incomes), со старыми параметрами (остатки по sku вместо
 * chrtId, даты FBS строкой вместо unix) или в устаревшие версии (nm-report v2,
 * fullstats v2, reportDetailByPeriod). Где WB пометил метод устаревшим, взят его преемник.
 *
 * Правила:
 * - `write: true` — инструмент меняет данные в кабинете. Claude Code спрашивает
 *   разрешение на каждый вызов (см. .claude/settings.json), а описание прямо
 *   требует показать изменения человеку до вызова.
 * - Большие выгрузки режутся (`maxRows`), персональные данные покупателей
 *   (адреса, имена) в ответ не попадают.
 */
import { HOSTS, LIMITER_KEYS, type WBClient } from "./client.js";
import { pingAll } from "./diagnostics.js";
import { inRange, limitRows, num, previousPeriod, round2, toDate, toUnix, daysBetween } from "./util.js";

type JsonSchema = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
};

export interface ToolDefinition {
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Меняет данные в кабинете продавца. */
  readonly write?: boolean;
}

const WRITE_NOTE =
  " ИЗМЕНЯЕТ ДАННЫЕ В КАБИНЕТЕ WB. Перед вызовом покажи человеку, что именно изменится, и получи явное «да».";

const date = (description: string) => ({ type: "string", description: `${description} (ГГГГ-ММ-ДД)` });
const maxRows = (def: number) => ({
  type: "integer",
  minimum: 1,
  maximum: 5000,
  description: `Сколько строк вернуть (по умолчанию ${def}). Полный объём выгрузки всё равно указан в totalRows.`,
});
const noArgs: JsonSchema = { type: "object", properties: {} };

// ---------- Определения ----------

export const toolDefinitions = {
  // ----- Общее -----
  check_connection: {
    description:
      "Проверить ключ WB: к каким категориям API есть доступ, а к каким нет. Начинай с него, если другие инструменты отвечают 401.",
    inputSchema: noArgs,
  },
  get_seller_info: {
    description: "Название продавца, ИНН и торговая марка.",
    inputSchema: noArgs,
  },
  get_seller_rating: {
    description: "Рейтинг продавца и число отзывов о нём.",
    inputSchema: noArgs,
  },
  get_jam_subscription: {
    description: "Подписка «Джем»: активна ли и какого уровня. От неё зависят лимиты отчёта по поисковым запросам.",
    inputSchema: noArgs,
  },

  // ----- Товары и цены -----
  list_products: {
    description:
      "Карточки товаров продавца: артикул WB (nmID), артикул продавца, бренд, название, предмет, размеры с chrtID и баркодами. До 100 за запрос; для следующей страницы передай cursorUpdatedAt и cursorNmID из ответа.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Сколько карточек (до 100, по умолчанию 100)" },
        textSearch: { type: "string", description: "Поиск по артикулу WB, артикулу продавца или баркоду" },
        cursorUpdatedAt: { type: "string", description: "cursor.updatedAt из прошлого ответа" },
        cursorNmID: { type: "integer", description: "cursor.nmID из прошлого ответа" },
        full: { type: "boolean", description: "Вернуть карточку целиком (описание, характеристики, фото). По умолчанию — сокращённо." },
      },
    },
  },
  get_prices: {
    description: "Цены и скидки товаров: цена до скидки, скидка продавца, цены по размерам.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Сколько товаров (до 1000, по умолчанию 1000)" },
        offset: { type: "integer", minimum: 0, description: "Сдвиг для следующей страницы" },
        nmId: { type: "integer", description: "Только этот артикул WB" },
      },
    },
  },
  update_prices: {
    description: "Установить цену (до скидки, в рублях) и/или скидку продавца в процентах для товаров." + WRITE_NOTE,
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        prices: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: {
            type: "object",
            properties: {
              nmID: { type: "integer", description: "Артикул WB" },
              price: { type: "integer", minimum: 1, description: "Цена до скидки, ₽" },
              discount: { type: "integer", minimum: 0, maximum: 99, description: "Скидка продавца, %" },
            },
            required: ["nmID"],
          },
        },
      },
      required: ["prices"],
    },
  },
  list_seller_warehouses: {
    description: "Склады продавца (для FBS): их id нужны для остатков FBS.",
    inputSchema: noArgs,
  },
  get_fbs_stocks: {
    description: "Остатки на складе продавца (FBS) по chrtID размеров. chrtID берутся из list_products (sizes[].chrtID).",
    inputSchema: {
      type: "object",
      properties: {
        warehouseId: { type: "integer", description: "id склада продавца из list_seller_warehouses" },
        chrtIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 1000, description: "chrtID размеров" },
      },
      required: ["warehouseId", "chrtIds"],
    },
  },
  update_fbs_stocks: {
    description: "Записать остатки на складе продавца (FBS)." + WRITE_NOTE,
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        warehouseId: { type: "integer", description: "id склада продавца" },
        stocks: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: {
            type: "object",
            properties: {
              chrtId: { type: "integer", description: "chrtID размера" },
              amount: { type: "integer", minimum: 0, description: "Остаток, шт" },
            },
            required: ["chrtId", "amount"],
          },
        },
      },
      required: ["warehouseId", "stocks"],
    },
  },

  // ----- Заказы и продажи -----
  get_sales_summary: {
    description:
      "Сводка по каждому товару за период: заказы (шт, ₽), отмены, выкупы (шт, ₽), возвраты, к перечислению продавцу, процент выкупа. Главный инструмент для «как идут продажи». Данные WB хранит 90 дней. Медленный: два отчёта по 1 запросу в минуту.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало периода"),
        dateTo: date("Конец периода, по умолчанию сегодня"),
        maxProducts: { type: "integer", minimum: 1, maximum: 5000, description: "Сколько товаров показать (по умолчанию 100)" },
      },
      required: ["dateFrom"],
    },
  },
  get_abc_analysis: {
    description:
      "ABC-анализ по выручке выкупов за период: A — товары, дающие 80% выручки, B — следующие 15%, C — последние 5%. Выручка = выкупы минус возвраты по цене со скидкой продавца. Данные WB хранит 90 дней.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало периода"),
        dateTo: date("Конец периода, по умолчанию сегодня"),
      },
      required: ["dateFrom"],
    },
  },
  get_orders: {
    description:
      "Сырые строки заказов (все схемы: FBW, FBS, DBS) начиная с даты изменения. Одна строка — одна единица товара. Для сводки используй get_sales_summary.",
    inputSchema: {
      type: "object",
      properties: { dateFrom: date("С какой даты (по дате изменения записи)"), maxRows: maxRows(200) },
      required: ["dateFrom"],
    },
  },
  get_sales: {
    description:
      "Сырые строки продаж и возвратов начиная с даты изменения. saleID на S — продажа, на R — возврат. Для сводки используй get_sales_summary.",
    inputSchema: {
      type: "object",
      properties: { dateFrom: date("С какой даты (по дате изменения записи)"), maxRows: maxRows(200) },
      required: ["dateFrom"],
    },
  },
  get_fbs_new_orders: {
    description: "Новые сборочные задания FBS, которые нужно собрать.",
    inputSchema: noArgs,
  },
  get_fbs_orders: {
    description: "Сборочные задания FBS за период (до 30 дней).",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Сколько заданий (по умолчанию 200)" },
        next: { type: "integer", description: "Курсор next из прошлого ответа (по умолчанию 0)" },
      },
    },
  },
  list_fbs_supplies: {
    description: "Поставки FBS.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Сколько (по умолчанию 100)" },
        next: { type: "integer", description: "Курсор next (по умолчанию 0)" },
      },
    },
  },
  create_fbs_supply: {
    description: "Создать поставку FBS." + WRITE_NOTE,
    write: true,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Название поставки" } },
      required: ["name"],
    },
  },
  add_orders_to_fbs_supply: {
    description: "Добавить сборочные задания в поставку FBS." + WRITE_NOTE,
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        supplyId: { type: "string", description: "ID поставки, например WB-GI-1234567" },
        orderIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 100, description: "ID сборочных заданий" },
      },
      required: ["supplyId", "orderIds"],
    },
  },
  deliver_fbs_supply: {
    description: "Закрыть поставку FBS и передать в доставку. После этого в неё ничего не добавить." + WRITE_NOTE,
    write: true,
    inputSchema: {
      type: "object",
      properties: { supplyId: { type: "string", description: "ID поставки" } },
      required: ["supplyId"],
    },
  },
  get_fbs_supply_barcode: {
    description: "QR-код поставки FBS (доступен после передачи в доставку). Файл приходит в base64.",
    inputSchema: {
      type: "object",
      properties: {
        supplyId: { type: "string", description: "ID поставки" },
        type: { type: "string", enum: ["svg", "zplv", "zplh", "png"], description: "Формат (по умолчанию svg)" },
      },
      required: ["supplyId"],
    },
  },

  // ----- Остатки -----
  get_wb_stocks: {
    description:
      "Остатки на складах WB: по каждому товару — количество, в пути к клиенту и от клиента, разбивка по складам. Без nmIds — по всем товарам.",
    inputSchema: {
      type: "object",
      properties: {
        nmIds: { type: "array", items: { type: "integer" }, maxItems: 1000, description: "Только эти артикулы WB" },
        groupByProduct: { type: "boolean", description: "Сложить склады: итог по каждому товару (по умолчанию true)" },
        maxRows: maxRows(500),
      },
    },
  },
  get_paid_storage: {
    description:
      "Платное хранение за период (до 8 дней): сколько стоило хранение каждого товара. Отчёт готовится на стороне WB, займёт 1–3 минуты.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        groupByProduct: { type: "boolean", description: "Итог по товарам (по умолчанию true)" },
        maxRows: maxRows(300),
      },
      required: ["dateFrom", "dateTo"],
    },
  },

  // ----- Аналитика -----
  get_funnel: {
    description:
      "Воронка карточек за период (до 365 дней назад): переходы в карточку, корзины, заказы, выкупы, отмены, конверсии, средняя цена, остатки. По умолчанию сравнивает с предыдущим периодом той же длины.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        nmIds: { type: "array", items: { type: "integer" }, maxItems: 1000, description: "Только эти артикулы (по умолчанию все)" },
        comparePrevious: { type: "boolean", description: "Сравнить с прошлым периодом (по умолчанию true)" },
        orderBy: {
          type: "string",
          enum: ["openCard", "addToCart", "orderCount", "orderSum", "buyoutCount", "buyoutSum", "cancelCount", "avgPrice", "stockWbQty", "stockMpQty"],
          description: "Сортировка по убыванию (по умолчанию orderSum)",
        },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Сколько товаров (по умолчанию 100)" },
        offset: { type: "integer", minimum: 0, description: "Сдвиг" },
      },
      required: ["dateFrom", "dateTo"],
    },
  },
  get_funnel_history: {
    description: "Воронка по дням или неделям для 1–20 товаров: показывает, когда просели переходы, корзины или заказы.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        nmIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 20, description: "Артикулы WB" },
        aggregationLevel: { type: "string", enum: ["day", "week"], description: "По дням или неделям (по умолчанию day)" },
      },
      required: ["dateFrom", "dateTo", "nmIds"],
    },
  },
  get_search_texts: {
    description:
      "Поисковые запросы, по которым покупатели находят товары: частота, средняя и медианная позиция, переходы, корзины, заказы, видимость. Без подписки «Джем» — до 30 запросов на товар, с тарифами Продвинутый/Премиум — до 100.",
    inputSchema: {
      type: "object",
      properties: {
        nmIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50, description: "Артикулы WB" },
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Запросов на товар (по умолчанию 30)" },
        orderBy: {
          type: "string",
          enum: ["avgPosition", "openCard", "addToCart", "openToCart", "orders", "cartToOrder", "visibility"],
          description: "Сортировка (по умолчанию orders)",
        },
      },
      required: ["nmIds", "dateFrom", "dateTo"],
    },
  },

  // ----- Финансы -----
  get_finance_summary: {
    description:
      "Деньги за период по финансовому отчёту WB: продажи и возвраты, удержано WB с продаж (комиссия и эквайринг), логистика, хранение, приёмка, штрафы, удержания, оценка «на руки» — итог и по каждому товару. Данные с 29.01.2024. Отчёты формируются раз в неделю, последние дни могут отсутствовать. Лимит WB — 1 запрос в минуту.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        period: { type: "string", enum: ["weekly", "daily"], description: "Еженедельные или ежедневные отчёты (по умолчанию weekly)" },
        topProducts: { type: "integer", minimum: 0, maximum: 1000, description: "Сколько товаров показать в разбивке (по умолчанию 50)" },
      },
      required: ["dateFrom", "dateTo"],
    },
  },
  get_finance_report_rows: {
    description:
      "Сырые строки финансового отчёта (для сверки конкретных операций). Для итогов используй get_finance_summary. Лимит WB — 1 запрос в минуту.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        period: { type: "string", enum: ["weekly", "daily"], description: "По умолчанию weekly" },
        rrdId: { type: "integer", description: "Курсор: rrdId последней строки прошлого ответа (по умолчанию 0)" },
        maxRows: maxRows(200),
      },
      required: ["dateFrom", "dateTo"],
    },
  },
  get_account_balance: {
    description: "Баланс продавца: текущий и доступный к выводу.",
    inputSchema: noArgs,
  },

  // ----- Тарифы -----
  get_commission: {
    description: "Комиссия WB по предметам (категориям) для каждой схемы работы, в процентах.",
    inputSchema: {
      type: "object",
      properties: {
        subjectName: { type: "string", description: "Фильтр по названию предмета или родительской категории (часть слова)" },
      },
    },
  },
  get_box_tariffs: {
    description: "Тарифы на логистику и хранение коробов по складам WB на дату.",
    inputSchema: { type: "object", properties: { date: date("Дата, по умолчанию сегодня") } },
  },
  get_acceptance_coefficients: {
    description: "Коэффициенты приёмки по складам WB на ближайшие 14 дней: где сейчас бесплатно или дёшево сдать поставку.",
    inputSchema: {
      type: "object",
      properties: { warehouseIDs: { type: "array", items: { type: "integer" }, description: "Только эти склады WB" } },
    },
  },

  // ----- Отзывы, вопросы, возвраты -----
  get_unanswered_counts: {
    description: "Сколько отзывов и вопросов без ответа (всего и за сегодня).",
    inputSchema: noArgs,
  },
  get_feedbacks: {
    description: "Отзывы покупателей: оценка, текст, плюсы, минусы, ответ продавца, товар. Имена покупателей не возвращаются.",
    inputSchema: {
      type: "object",
      properties: {
        isAnswered: { type: "boolean", description: "true — с ответом, false — без ответа (по умолчанию false)" },
        take: { type: "integer", minimum: 1, maximum: 5000, description: "Сколько (по умолчанию 50)" },
        skip: { type: "integer", minimum: 0, description: "Сколько пропустить" },
        nmId: { type: "integer", description: "Только этот артикул WB" },
        order: { type: "string", enum: ["dateAsc", "dateDesc"], description: "По умолчанию dateDesc" },
        dateFrom: date("С даты"),
        dateTo: date("По дату"),
      },
    },
  },
  reply_feedback: {
    description: "Опубликовать ответ продавца на отзыв." + WRITE_NOTE,
    write: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "ID отзыва" }, text: { type: "string", description: "Текст ответа" } },
      required: ["id", "text"],
    },
  },
  get_questions: {
    description: "Вопросы покупателей о товарах.",
    inputSchema: {
      type: "object",
      properties: {
        isAnswered: { type: "boolean", description: "По умолчанию false — без ответа" },
        take: { type: "integer", minimum: 1, maximum: 10000, description: "Сколько (по умолчанию 50)" },
        skip: { type: "integer", minimum: 0, description: "Сколько пропустить" },
        nmId: { type: "integer", description: "Только этот артикул WB" },
        order: { type: "string", enum: ["dateAsc", "dateDesc"], description: "По умолчанию dateDesc" },
      },
    },
  },
  reply_question: {
    description: "Опубликовать ответ на вопрос покупателя (виден на сайте WB)." + WRITE_NOTE,
    write: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "ID вопроса" }, text: { type: "string", description: "Текст ответа" } },
      required: ["id", "text"],
    },
  },
  get_returns: {
    description: "Заявки покупателей на возврат товара.",
    inputSchema: {
      type: "object",
      properties: {
        isArchive: { type: "boolean", description: "Архивные заявки (по умолчанию false — активные)" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Сколько (по умолчанию 50)" },
        offset: { type: "integer", minimum: 0, description: "Сдвиг" },
        nmId: { type: "integer", description: "Только этот артикул WB" },
      },
    },
  },

  // ----- Реклама -----
  list_campaigns: {
    description: "Рекламные кампании, сгруппированные по типу и статусу, с их id.",
    inputSchema: noArgs,
  },
  get_campaigns_info: {
    description: "Подробности рекламных кампаний: название, тип оплаты (cpm/cpc), статус, товары и ставки.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "integer" }, maxItems: 50, description: "ID кампаний" },
        statuses: { type: "array", items: { type: "integer" }, description: "Статусы: 4 готова, 7 завершена, 9 активна, 11 на паузе, -1 удаляется" },
      },
    },
  },
  get_ad_balance: {
    description: "Рекламный кабинет: баланс, счёт, бонусы, кэшбэк.",
    inputSchema: noArgs,
  },
  get_campaign_stats: {
    description:
      "Статистика кампаний за период до 31 дня: показы, клики, CTR, CPC, корзины, заказы, расход, сумма заказов. Только для кампаний в статусах 7, 9, 11. Лимит WB — 3 запроса в минуту.",
    inputSchema: {
      type: "object",
      properties: {
        campaignIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 100, description: "ID кампаний" },
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        withDays: { type: "boolean", description: "Добавить разбивку по дням (по умолчанию false)" },
      },
      required: ["campaignIds", "dateFrom", "dateTo"],
    },
  },
  get_ad_costs: {
    description: "Списания на рекламу за период до 31 дня: сумма по каждой кампании и итог.",
    inputSchema: {
      type: "object",
      properties: { dateFrom: date("Начало"), dateTo: date("Конец") },
      required: ["dateFrom", "dateTo"],
    },
  },

  // ----- Акции -----
  get_promotions: {
    description: "Акции WB в календаре за период: название, тип, даты.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: date("Начало"),
        dateTo: date("Конец"),
        allPromo: { type: "boolean", description: "Все акции, а не только доступные продавцу (по умолчанию false)" },
      },
      required: ["dateFrom", "dateTo"],
    },
  },
} as const satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof toolDefinitions;

export const WRITE_TOOLS: ToolName[] = (Object.entries(toolDefinitions) as [ToolName, ToolDefinition][])
  .filter(([, d]) => d.write)
  .map(([n]) => n);

// ---------- Выгрузки и расчёты ----------

type Row = Record<string, unknown>;

/**
 * Отчёты «Заказы» и «Продажи» отдают до 80 000 строк за запрос, начиная с даты
 * изменения записи. Если строк ровно столько — дочитываем с lastChangeDate последней.
 */
export async function fetchStatAll(client: WBClient, path: string, limiterKey: string, dateFrom: string): Promise<Row[]> {
  const all: Row[] = [];
  let cursor = dateFrom;
  for (let page = 0; page < 20; page++) {
    const rows = await client.get<Row[]>(HOSTS.statistics, path, { dateFrom: cursor, flag: "0" }, { limiterKey });
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 80_000) break;
    const last = String(rows[rows.length - 1]!["lastChangeDate"] ?? "");
    if (!last || last === cursor) break;
    cursor = last;
  }
  return all;
}

export interface ProductSales {
  nmId: number;
  vendorCode: string;
  brand: string;
  subject: string;
  orders: number;
  ordersSum: number;
  cancels: number;
  buyouts: number;
  buyoutsSum: number;
  returns: number;
  returnsSum: number;
  forPay: number;
  buyoutPercent: number | null;
}

/** Чистый расчёт сводки по уже скачанным строкам — отдельно, чтобы покрыть тестами. */
export function summarizeSales(orders: Row[], sales: Row[], from: string, to: string) {
  const map = new Map<number, ProductSales>();
  const get = (r: Row): ProductSales => {
    const id = Number(r["nmId"]);
    let p = map.get(id);
    if (!p) {
      p = {
        nmId: id,
        vendorCode: String(r["supplierArticle"] ?? ""),
        brand: String(r["brand"] ?? ""),
        subject: String(r["subject"] ?? ""),
        orders: 0, ordersSum: 0, cancels: 0, buyouts: 0, buyoutsSum: 0, returns: 0, returnsSum: 0, forPay: 0, buyoutPercent: null,
      };
      map.set(id, p);
    }
    return p;
  };
  for (const r of orders) {
    if (!inRange(r["date"] as string, from, to)) continue;
    const p = get(r);
    p.orders += 1;
    p.ordersSum += num(r["priceWithDisc"]);
    if (r["isCancel"] === true) p.cancels += 1;
  }
  for (const r of sales) {
    if (!inRange(r["date"] as string, from, to)) continue;
    const p = get(r);
    const price = Math.abs(num(r["priceWithDisc"]));
    const forPay = Math.abs(num(r["forPay"]));
    if (String(r["saleID"] ?? "").startsWith("R")) {
      p.returns += 1;
      p.returnsSum += price;
      p.forPay -= forPay;
    } else {
      p.buyouts += 1;
      p.buyoutsSum += price;
      p.forPay += forPay;
    }
  }
  const products = [...map.values()]
    .map((p) => ({
      ...p,
      ordersSum: round2(p.ordersSum),
      buyoutsSum: round2(p.buyoutsSum),
      returnsSum: round2(p.returnsSum),
      forPay: round2(p.forPay),
      // Приблизительно: выкупы периода частично относятся к заказам до его начала.
      buyoutPercent: p.orders - p.cancels > 0 ? round2((p.buyouts / (p.orders - p.cancels)) * 100) : null,
    }))
    .sort((a, b) => b.ordersSum - a.ordersSum || b.buyoutsSum - a.buyoutsSum);
  const sum = (k: "orders" | "ordersSum" | "cancels" | "buyouts" | "buyoutsSum" | "returns" | "returnsSum" | "forPay") =>
    round2(products.reduce((s, p) => s + p[k], 0));
  return {
    period: { from, to, days: daysBetween(from, to) },
    totals: {
      products: products.length,
      orders: sum("orders"),
      ordersSum: sum("ordersSum"),
      cancels: sum("cancels"),
      buyouts: sum("buyouts"),
      buyoutsSum: sum("buyoutsSum"),
      returns: sum("returns"),
      returnsSum: sum("returnsSum"),
      forPay: sum("forPay"),
    },
    note: "Суммы — по цене со скидкой продавца. Процент выкупа приблизительный: выкупы периода частично относятся к заказам до его начала. Статистика WB обновляется раз в 30 минут и хранится 90 дней.",
    products,
  };
}

export async function buildSalesSummary(client: WBClient, from: string, to: string) {
  const orders = await fetchStatAll(client, "/api/v1/supplier/orders", LIMITER_KEYS.statOrders, from);
  const sales = await fetchStatAll(client, "/api/v1/supplier/sales", LIMITER_KEYS.statSales, from);
  return summarizeSales(orders, sales, from, to);
}

export function abcFromSales(products: Pick<ProductSales, "nmId" | "vendorCode" | "subject" | "buyoutsSum" | "returnsSum" | "buyouts">[]) {
  const items = products
    .map((p) => ({ nmId: p.nmId, vendorCode: p.vendorCode, subject: p.subject, revenue: round2(p.buyoutsSum - p.returnsSum), buyouts: p.buyouts }))
    .filter((p) => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
  const total = items.reduce((s, i) => s + i.revenue, 0);
  let cumulative = 0;
  const result = items.map((i) => {
    // Класс по доле ДО добавления товара: товар, который пересекает границу 80%,
    // ещё попадает в A — так ABC считают обычно, и самый крупный товар всегда A.
    const shareBefore = total > 0 ? cumulative / total : 0;
    cumulative += i.revenue;
    const cls = shareBefore < 0.8 ? "A" : shareBefore < 0.95 ? "B" : "C";
    return { ...i, revenueShare: total > 0 ? round2((i.revenue / total) * 100) : 0, class: cls };
  });
  const of = (c: string) => result.filter((r) => r.class === c);
  const share = (c: string) => round2(of(c).reduce((s, r) => s + r.revenueShare, 0));
  return {
    summary: {
      totalRevenue: round2(total),
      products: result.length,
      A: { products: of("A").length, revenueShare: share("A") },
      B: { products: of("B").length, revenueShare: share("B") },
      C: { products: of("C").length, revenueShare: share("C") },
    },
    items: result,
  };
}

export async function fetchFinanceRows(client: WBClient, from: string, to: string, period: string): Promise<Row[]> {
  const all: Row[] = [];
  let rrdId = 0;
  for (let page = 0; page < 50; page++) {
    const rows = await client.post<Row[] | null>(
      HOSTS.finance,
      "/api/finance/v1/sales-reports/detailed",
      { dateFrom: from, dateTo: to, period, limit: 100_000, rrdId },
      undefined,
      { limiterKey: LIMITER_KEYS.financeReport },
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 100_000) break;
    rrdId = num(rows[rows.length - 1]!["rrdId"]);
  }
  return all;
}

/**
 * Итоги финотчёта. Поля — из нового finance API (суммы приходят строками):
 * forPay — к перечислению за товар, deliveryService — логистика, paidStorage —
 * хранение, paidAcceptance — приёмка, penalty — штрафы, deduction — удержания,
 * additionalPayment — корректировки в пользу продавца.
 */
export function summarizeFinance(rows: Row[], topProducts: number) {
  const t = {
    salesCount: 0, returnsCount: 0, sales: 0, returns: 0, forPaySales: 0, forPayReturns: 0,
    logistics: 0, storage: 0, acceptance: 0, penalties: 0, deductions: 0, additionalPayments: 0, acquiring: 0,
  };
  type P = { nmId: number; vendorCode: string; title: string; salesCount: number; sales: number; returns: number; forPay: number; logistics: number; penalties: number };
  const byProduct = new Map<number, P>();
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const doc = String(r["docTypeName"] ?? "");
    const isSale = /продаж/i.test(doc);
    const isReturn = /возврат/i.test(doc);
    const qty = num(r["quantity"]) || 1;
    const amount = num(r["retailPriceWithDisc"]) * qty;
    const forPay = num(r["forPay"]);
    const logistics = num(r["deliveryService"]);
    const penalty = num(r["penalty"]);
    const reason = String(r["sellerOperName"] || "прочее");
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    t.logistics += logistics;
    t.storage += num(r["paidStorage"]);
    t.acceptance += num(r["paidAcceptance"]);
    t.penalties += penalty;
    t.deductions += num(r["deduction"]);
    t.additionalPayments += num(r["additionalPayment"]);
    t.acquiring += num(r["acquiringFee"]);
    if (isSale) {
      t.salesCount += qty;
      t.sales += amount;
      t.forPaySales += forPay;
    } else if (isReturn) {
      t.returnsCount += qty;
      t.returns += amount;
      t.forPayReturns += forPay;
    }
    const nmId = num(r["nmId"]);
    if (!nmId) continue;
    let p = byProduct.get(nmId);
    if (!p) {
      p = { nmId, vendorCode: String(r["vendorCode"] ?? ""), title: String(r["title"] || r["subjectName"] || ""), salesCount: 0, sales: 0, returns: 0, forPay: 0, logistics: 0, penalties: 0 };
      byProduct.set(nmId, p);
    }
    if (isSale) { p.salesCount += qty; p.sales += amount; p.forPay += forPay; }
    if (isReturn) { p.salesCount -= qty; p.returns += amount; p.forPay -= forPay; }
    p.logistics += logistics;
    p.penalties += penalty;
  }
  const r2 = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round2(v)])) as typeof t;
  // «На руки» до себестоимости, налогов и рекламы: к перечислению за выкупы минус
  // возвраты и все услуги WB, которые удерживаются отдельными строками.
  const netPayout = round2(r2.forPaySales - r2.forPayReturns - r2.logistics - r2.storage - r2.acceptance - r2.penalties - r2.deductions + r2.additionalPayments);
  const products = [...byProduct.values()]
    .map((p) => ({
      ...p,
      sales: round2(p.sales),
      returns: round2(p.returns),
      forPay: round2(p.forPay),
      logistics: round2(p.logistics),
      penalties: round2(p.penalties),
      afterLogistics: round2(p.forPay - p.logistics - p.penalties),
    }))
    .sort((a, b) => b.sales - a.sales);
  return {
    rows: rows.length,
    totals: {
      ...r2,
      wbKeptFromSales: round2(r2.sales - r2.returns - (r2.forPaySales - r2.forPayReturns)),
      netPayoutEstimate: netPayout,
    },
    operations: Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1])),
    products: products.slice(0, topProducts),
    productsTotal: products.length,
    note:
      "wbKeptFromSales — сколько WB удержал с выкупов (комиссия, эквайринг, скидки за счёт продавца). netPayoutEstimate — оценка «на руки» до себестоимости, налогов и рекламы (реклама списывается отдельно, см. get_ad_costs). Сверяйте с отчётом в кабинете.",
  };
}

function compactFeedback(f: Row) {
  const pd = (f["productDetails"] ?? {}) as Row;
  const ans = f["answer"] as Row | null | undefined;
  return {
    id: f["id"],
    createdDate: f["createdDate"],
    rating: f["productValuation"],
    text: f["text"],
    pros: f["pros"] || undefined,
    cons: f["cons"] || undefined,
    answer: ans?.["text"] ?? null,
    nmId: pd["nmId"],
    vendorCode: pd["supplierArticle"],
    product: pd["productName"],
    size: pd["size"] || undefined,
    matchingSize: f["matchingSize"] || undefined,
    photos: Array.isArray(f["photoLinks"]) ? (f["photoLinks"] as unknown[]).length : 0,
    wasViewed: f["wasViewed"],
  };
}

/** Адрес и координаты покупателя для анализа не нужны — в контекст модели их не отдаём. */
function stripOrderPii(o: Row): Row {
  const { address: _address, ...rest } = o;
  return rest;
}

// ---------- Обработчики ----------

export async function handleTool(client: WBClient, name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10);

  switch (name) {
    // ----- Общее -----
    case "check_connection": {
      if (!client.token) throw new Error("Ключ WB не настроен: вставьте его в .env после WB_API_TOKEN= или запустите /setup.");
      const results = await pingAll(client.token);
      return {
        available: results.filter((r) => r.ok).map((r) => `${r.title} — ${r.usedFor}`),
        unavailable: results.filter((r) => !r.ok).map((r) => `${r.title} — ${r.reason}`),
        hint: "Недостающие категории добавляются при создании нового ключа: кабинет WB → Настройки → Доступ к API.",
      };
    }
    case "get_seller_info":
      return client.get(HOSTS.common, "/api/v1/seller-info", undefined, { limiterKey: LIMITER_KEYS.sellerInfo });
    case "get_seller_rating":
      return client.get(HOSTS.feedbacks, "/api/common/v1/rating", undefined, { limiterKey: LIMITER_KEYS.sellerRating });
    case "get_jam_subscription":
      return client.get(HOSTS.common, "/api/common/v1/subscriptions");

    // ----- Товары и цены -----
    case "list_products": {
      const cursor: Row = { limit: (args.limit as number) ?? 100 };
      if (args.cursorUpdatedAt) cursor.updatedAt = args.cursorUpdatedAt;
      if (args.cursorNmID) cursor.nmID = args.cursorNmID;
      const filter: Row = { withPhoto: -1 };
      if (args.textSearch) filter.textSearch = String(args.textSearch);
      const res = await client.post<{ cards?: Row[]; cursor?: unknown }>(HOSTS.content, "/content/v2/get/cards/list", { settings: { cursor, filter } });
      if (args.full) return res;
      return {
        cursor: res?.cursor,
        cards: (res?.cards ?? []).map((c) => ({
          nmID: c["nmID"],
          vendorCode: c["vendorCode"],
          brand: c["brand"],
          title: c["title"],
          subjectName: c["subjectName"],
          photos: Array.isArray(c["photos"]) ? (c["photos"] as unknown[]).length : 0,
          video: Boolean(c["video"]),
          descriptionLength: String(c["description"] ?? "").length,
          characteristics: Array.isArray(c["characteristics"]) ? (c["characteristics"] as unknown[]).length : 0,
          sizes: Array.isArray(c["sizes"]) ? (c["sizes"] as Row[]).map((s) => ({ chrtID: s["chrtID"], techSize: s["techSize"], skus: s["skus"] })) : [],
          updatedAt: c["updatedAt"],
        })),
      };
    }
    case "get_prices": {
      const q: Record<string, string> = { limit: String(args.limit ?? 1000) };
      if (args.offset !== undefined) q.offset = String(args.offset);
      if (args.nmId !== undefined) q.filterNmID = String(args.nmId);
      return client.get(HOSTS.prices, "/api/v2/list/goods/filter", q);
    }
    case "update_prices":
      return client.post(HOSTS.prices, "/api/v2/upload/task", { data: args.prices });
    case "list_seller_warehouses":
      return client.get(HOSTS.marketplace, "/api/v3/warehouses");
    case "get_fbs_stocks":
      return client.post(HOSTS.marketplace, `/api/v3/stocks/${Number(args.warehouseId)}`, { chrtIds: args.chrtIds });
    case "update_fbs_stocks":
      await client.put(HOSTS.marketplace, `/api/v3/stocks/${Number(args.warehouseId)}`, { stocks: args.stocks });
      return { updated: (args.stocks as unknown[]).length, warehouseId: args.warehouseId };

    // ----- Заказы и продажи -----
    case "get_sales_summary": {
      const from = toDate(args.dateFrom, "dateFrom");
      const to = args.dateTo ? toDate(args.dateTo, "dateTo") : today;
      const s = await buildSalesSummary(client, from, to);
      const max = (args.maxProducts as number) ?? 100;
      return { ...s, products: s.products.slice(0, max), productsTotal: s.products.length };
    }
    case "get_abc_analysis": {
      const from = toDate(args.dateFrom, "dateFrom");
      const to = args.dateTo ? toDate(args.dateTo, "dateTo") : today;
      const s = await buildSalesSummary(client, from, to);
      return { period: s.period, ...abcFromSales(s.products) };
    }
    case "get_orders": {
      const rows = await fetchStatAll(client, "/api/v1/supplier/orders", LIMITER_KEYS.statOrders, toDate(args.dateFrom, "dateFrom"));
      return limitRows(rows, (args.maxRows as number) ?? 200);
    }
    case "get_sales": {
      const rows = await fetchStatAll(client, "/api/v1/supplier/sales", LIMITER_KEYS.statSales, toDate(args.dateFrom, "dateFrom"));
      return limitRows(rows, (args.maxRows as number) ?? 200);
    }
    case "get_fbs_new_orders": {
      const res = await client.get<{ orders?: Row[] }>(HOSTS.marketplace, "/api/v3/orders/new");
      return { orders: (res?.orders ?? []).map(stripOrderPii) };
    }
    case "get_fbs_orders": {
      const q: Record<string, string> = { limit: String(args.limit ?? 200), next: String(args.next ?? 0) };
      if (args.dateFrom) q.dateFrom = String(toUnix(args.dateFrom, "dateFrom"));
      if (args.dateTo) q.dateTo = String(toUnix(args.dateTo, "dateTo", true));
      const res = await client.get<{ next?: number; orders?: Row[] }>(HOSTS.marketplace, "/api/v3/orders", q);
      return { next: res?.next, orders: (res?.orders ?? []).map(stripOrderPii) };
    }
    case "list_fbs_supplies":
      return client.get(HOSTS.marketplace, "/api/v3/supplies", { limit: String(args.limit ?? 100), next: String(args.next ?? 0) });
    case "create_fbs_supply":
      return client.post(HOSTS.marketplace, "/api/v3/supplies", { name: args.name });
    case "add_orders_to_fbs_supply": {
      const id = encodeURIComponent(String(args.supplyId));
      await client.patch(HOSTS.marketplace, `/api/marketplace/v3/supplies/${id}/orders`, { orders: args.orderIds });
      return { supplyId: args.supplyId, added: args.orderIds };
    }
    case "deliver_fbs_supply": {
      const id = encodeURIComponent(String(args.supplyId));
      await client.patch(HOSTS.marketplace, `/api/v3/supplies/${id}/deliver`);
      return { supplyId: args.supplyId, delivered: true };
    }
    case "get_fbs_supply_barcode": {
      const id = encodeURIComponent(String(args.supplyId));
      return client.get(HOSTS.marketplace, `/api/v3/supplies/${id}/barcode`, { type: String(args.type ?? "svg") });
    }

    // ----- Остатки -----
    case "get_wb_stocks": {
      type Item = { nmId: number; chrtId: number; warehouseName: string; regionName: string; quantity: number; inWayToClient: number; inWayFromClient: number };
      const body: Row = { limit: 250_000, offset: 0 };
      if (args.nmIds) body.nmIds = args.nmIds;
      const res = await client.post<{ data?: { items?: Item[] } }>(HOSTS.analytics, "/api/analytics/v1/stocks-report/wb-warehouses", body, undefined, {
        limiterKey: LIMITER_KEYS.wbStocks,
      });
      const items = res?.data?.items ?? [];
      const max = (args.maxRows as number) ?? 500;
      if (args.groupByProduct === false) return limitRows(items, max);
      const byNm = new Map<number, { nmId: number; quantity: number; inWayToClient: number; inWayFromClient: number; warehouses: Record<string, number> }>();
      for (const i of items) {
        let p = byNm.get(i.nmId);
        if (!p) {
          p = { nmId: i.nmId, quantity: 0, inWayToClient: 0, inWayFromClient: 0, warehouses: {} };
          byNm.set(i.nmId, p);
        }
        p.quantity += num(i.quantity);
        p.inWayToClient += num(i.inWayToClient);
        p.inWayFromClient += num(i.inWayFromClient);
        if (i.quantity) p.warehouses[i.warehouseName] = (p.warehouses[i.warehouseName] ?? 0) + num(i.quantity);
      }
      const grouped = [...byNm.values()].sort((a, b) => b.quantity - a.quantity);
      return { totalQuantity: grouped.reduce((s, p) => s + p.quantity, 0), ...limitRows(grouped, max) };
    }
    case "get_paid_storage": {
      const from = toDate(args.dateFrom, "dateFrom");
      const to = toDate(args.dateTo, "dateTo");
      if (daysBetween(from, to) > 8) throw new Error("Отчёт о платном хранении строится максимум за 8 дней: разбейте период на части");
      const create = await client.get<{ data?: { taskId?: string } }>(HOSTS.analytics, "/api/v1/paid_storage", { dateFrom: from, dateTo: to }, {
        limiterKey: LIMITER_KEYS.paidStorageCreate,
      });
      const taskId = create?.data?.taskId;
      if (!taskId) throw new Error("WB не вернул номер задачи на отчёт о платном хранении");
      const seg = encodeURIComponent(taskId);
      const final = await client.pollUntil({
        fn: () =>
          client.get<{ data?: { status?: string } }>(HOSTS.analytics, `/api/v1/paid_storage/tasks/${seg}/status`, undefined, {
            limiterKey: LIMITER_KEYS.paidStorageStatus,
          }),
        done: (r) => ["done", "purged", "canceled"].includes(r?.data?.status ?? ""),
        intervalMs: 5000,
        timeoutMs: 180_000,
        label: `paid_storage ${taskId}`,
      });
      if (final?.data?.status !== "done") throw new Error(`Отчёт о платном хранении не сформирован: статус ${final?.data?.status}`);
      const rows = await client.get<Row[]>(HOSTS.analytics, `/api/v1/paid_storage/tasks/${seg}/download`, undefined, {
        limiterKey: LIMITER_KEYS.paidStorageDownload,
      });
      const list = Array.isArray(rows) ? rows : [];
      const total = round2(list.reduce((s, r) => s + num(r["warehousePrice"]), 0));
      const max = (args.maxRows as number) ?? 300;
      if (args.groupByProduct === false) return { period: { from, to }, total, ...limitRows(list, max) };
      const byNm = new Map<number, { nmId: number; vendorCode: string; subject: string; cost: number }>();
      for (const r of list) {
        const id = num(r["nmId"]);
        const p = byNm.get(id) ?? { nmId: id, vendorCode: String(r["vendorCode"] ?? ""), subject: String(r["subject"] ?? ""), cost: 0 };
        p.cost += num(r["warehousePrice"]);
        byNm.set(id, p);
      }
      const grouped = [...byNm.values()].map((p) => ({ ...p, cost: round2(p.cost) })).sort((a, b) => b.cost - a.cost);
      return { period: { from, to }, total, ...limitRows(grouped, max) };
    }

    // ----- Аналитика -----
    case "get_funnel": {
      const from = toDate(args.dateFrom, "dateFrom");
      const to = toDate(args.dateTo, "dateTo");
      const body: Row = {
        selectedPeriod: { start: from, end: to },
        nmIds: args.nmIds ?? [],
        orderBy: { field: (args.orderBy as string) ?? "orderSum", mode: "desc" },
        limit: (args.limit as number) ?? 100,
        offset: (args.offset as number) ?? 0,
      };
      if (args.comparePrevious !== false) body.pastPeriod = previousPeriod(from, to);
      return client.post(HOSTS.analytics, "/api/analytics/v3/sales-funnel/products", body, undefined, { limiterKey: LIMITER_KEYS.funnel });
    }
    case "get_funnel_history":
      return client.post(
        HOSTS.analytics,
        "/api/analytics/v3/sales-funnel/products/history",
        {
          selectedPeriod: { start: toDate(args.dateFrom, "dateFrom"), end: toDate(args.dateTo, "dateTo") },
          nmIds: args.nmIds,
          aggregationLevel: (args.aggregationLevel as string) ?? "day",
        },
        undefined,
        { limiterKey: LIMITER_KEYS.funnel },
      );
    case "get_search_texts": {
      const from = toDate(args.dateFrom, "dateFrom");
      const to = toDate(args.dateTo, "dateTo");
      const field = (args.orderBy as string) ?? "orders";
      return client.post(
        HOSTS.analytics,
        "/api/v2/search-report/product/search-texts",
        {
          currentPeriod: { start: from, end: to },
          pastPeriod: previousPeriod(from, to),
          nmIds: args.nmIds,
          topOrderBy: "orders",
          includeSubstitutedSKUs: true,
          includeSearchTexts: true,
          // Для позиции «лучше» — меньше, поэтому по возрастанию; остальное по убыванию.
          orderBy: { field, mode: field === "avgPosition" ? "asc" : "desc" },
          limit: (args.limit as number) ?? 30,
        },
        undefined,
        { limiterKey: LIMITER_KEYS.searchTexts },
      );
    }

    // ----- Финансы -----
    case "get_finance_summary": {
      const rows = await fetchFinanceRows(client, toDate(args.dateFrom, "dateFrom"), toDate(args.dateTo, "dateTo"), (args.period as string) ?? "weekly");
      return summarizeFinance(rows, (args.topProducts as number) ?? 50);
    }
    case "get_finance_report_rows": {
      const rows = await client.post<Row[] | null>(
        HOSTS.finance,
        "/api/finance/v1/sales-reports/detailed",
        {
          dateFrom: toDate(args.dateFrom, "dateFrom"),
          dateTo: toDate(args.dateTo, "dateTo"),
          period: (args.period as string) ?? "weekly",
          limit: 100_000,
          rrdId: (args.rrdId as number) ?? 0,
        },
        undefined,
        { limiterKey: LIMITER_KEYS.financeReport },
      );
      const out = limitRows(Array.isArray(rows) ? rows : [], (args.maxRows as number) ?? 200);
      const last = out.rows[out.rows.length - 1];
      return { ...out, nextRrdId: out.truncated && last ? last["rrdId"] : null };
    }
    case "get_account_balance":
      return client.get(HOSTS.finance, "/api/v1/account/balance", undefined, { limiterKey: LIMITER_KEYS.financeBalance });

    // ----- Тарифы -----
    case "get_commission": {
      const res = await client.get<{ report?: Row[] }>(HOSTS.common, "/api/v1/tariffs/commission", { locale: "ru" }, { limiterKey: LIMITER_KEYS.commission });
      const report = res?.report ?? [];
      const q = String(args.subjectName ?? "").toLowerCase().trim();
      const filtered = q ? report.filter((r) => `${r["subjectName"]} ${r["parentName"]}`.toLowerCase().includes(q)) : report;
      return limitRows(filtered, q ? 200 : 100);
    }
    case "get_box_tariffs":
      return client.get(HOSTS.common, "/api/v1/tariffs/box", { date: args.date ? toDate(args.date, "date") : today });
    case "get_acceptance_coefficients": {
      const q: Record<string, string> = {};
      if (Array.isArray(args.warehouseIDs) && args.warehouseIDs.length) q.warehouseIDs = (args.warehouseIDs as number[]).join(",");
      const rows = await client.get<Row[]>(HOSTS.common, "/api/tariffs/v1/acceptance/coefficients", q, { limiterKey: LIMITER_KEYS.acceptance });
      return limitRows(Array.isArray(rows) ? rows : [], 500);
    }

    // ----- Отзывы, вопросы, возвраты -----
    case "get_unanswered_counts": {
      const f = await client.get<{ data?: unknown }>(HOSTS.feedbacks, "/api/v1/feedbacks/count-unanswered");
      const q = await client.get<{ data?: unknown }>(HOSTS.feedbacks, "/api/v1/questions/count-unanswered");
      return { feedbacks: f?.data, questions: q?.data };
    }
    case "get_feedbacks": {
      const q: Record<string, string> = {
        isAnswered: String(args.isAnswered ?? false),
        take: String(args.take ?? 50),
        skip: String(args.skip ?? 0),
        order: String(args.order ?? "dateDesc"),
      };
      if (args.nmId !== undefined) q.nmId = String(args.nmId);
      if (args.dateFrom) q.dateFrom = String(toUnix(args.dateFrom, "dateFrom"));
      if (args.dateTo) q.dateTo = String(toUnix(args.dateTo, "dateTo", true));
      const res = await client.get<{ data?: { countUnanswered?: number; countArchive?: number; feedbacks?: Row[] } }>(HOSTS.feedbacks, "/api/v1/feedbacks", q);
      return {
        countUnanswered: res?.data?.countUnanswered,
        countArchive: res?.data?.countArchive,
        feedbacks: (res?.data?.feedbacks ?? []).map(compactFeedback),
      };
    }
    case "reply_feedback":
      await client.post(HOSTS.feedbacks, "/api/v1/feedbacks/answer", { id: args.id, text: args.text });
      return { id: args.id, answered: true };
    case "get_questions": {
      const q: Record<string, string> = {
        isAnswered: String(args.isAnswered ?? false),
        take: String(args.take ?? 50),
        skip: String(args.skip ?? 0),
        order: String(args.order ?? "dateDesc"),
      };
      if (args.nmId !== undefined) q.nmId = String(args.nmId);
      const res = await client.get<{ data?: { countUnanswered?: number; questions?: Row[] } }>(HOSTS.feedbacks, "/api/v1/questions", q);
      return {
        countUnanswered: res?.data?.countUnanswered,
        questions: (res?.data?.questions ?? []).map((x) => {
          const pd = (x["productDetails"] ?? {}) as Row;
          const ans = x["answer"] as Row | null | undefined;
          return { id: x["id"], createdDate: x["createdDate"], text: x["text"], answer: ans?.["text"] ?? null, nmId: pd["nmId"], vendorCode: pd["supplierArticle"], product: pd["productName"] };
        }),
      };
    }
    case "reply_question":
      await client.patch(HOSTS.feedbacks, "/api/v1/questions", { id: args.id, answer: { text: args.text }, state: "wbRu" });
      return { id: args.id, answered: true };
    case "get_returns": {
      const q: Record<string, string> = { is_archive: String(args.isArchive ?? false), limit: String(args.limit ?? 50), offset: String(args.offset ?? 0) };
      if (args.nmId !== undefined) q.nm_id = String(args.nmId);
      const res = await client.get<{ claims?: Row[]; total?: number }>(HOSTS.returns, "/api/v1/claims", q);
      return {
        total: res?.total,
        claims: (res?.claims ?? []).map((c) => ({
          id: c["id"], claimType: c["claim_type"], status: c["status"], nmId: c["nm_id"], product: c["imt_name"],
          userComment: c["user_comment"], wbComment: c["wb_comment"], dt: c["dt"], orderDt: c["order_dt"], price: c["price"],
          photos: Array.isArray(c["photos"]) ? (c["photos"] as unknown[]).length : 0, actions: c["actions"],
        })),
      };
    }

    // ----- Реклама -----
    case "list_campaigns":
      return client.get(HOSTS.advert, "/adv/v1/promotion/count");
    case "get_campaigns_info": {
      const q: Record<string, string> = {};
      if (Array.isArray(args.ids) && args.ids.length) q.ids = (args.ids as number[]).join(",");
      if (Array.isArray(args.statuses) && args.statuses.length) q.statuses = (args.statuses as number[]).join(",");
      return client.get(HOSTS.advert, "/api/advert/v2/adverts", q);
    }
    case "get_ad_balance":
      return client.get(HOSTS.advert, "/adv/v1/balance");
    case "get_campaign_stats": {
      const from = toDate(args.dateFrom, "dateFrom");
      const to = toDate(args.dateTo, "dateTo");
      if (daysBetween(from, to) > 31) throw new Error("Статистика рекламы отдаётся максимум за 31 день: разбейте период на части");
      const rows = await client.get<Row[]>(
        HOSTS.advert,
        "/adv/v3/fullstats",
        { ids: (args.campaignIds as number[]).join(","), beginDate: from, endDate: to },
        { limiterKey: LIMITER_KEYS.advertStats },
      );
      const list = Array.isArray(rows) ? rows : [];
      if (args.withDays) return list;
      return list.map(({ days: _days, boosterStats: _booster, ...rest }) => rest);
    }
    case "get_ad_costs": {
      const from = toDate(args.dateFrom, "dateFrom");
      const to = toDate(args.dateTo, "dateTo");
      if (daysBetween(from, to) > 31) throw new Error("История затрат отдаётся максимум за 31 день: разбейте период на части");
      const rows = await client.get<Row[]>(HOSTS.advert, "/adv/v1/upd", { from, to });
      const list = Array.isArray(rows) ? rows : [];
      const byCampaign = new Map<number, { advertId: number; campName: string; spent: number }>();
      for (const r of list) {
        const id = num(r["advertId"]);
        const c = byCampaign.get(id) ?? { advertId: id, campName: String(r["campName"] ?? ""), spent: 0 };
        c.spent += num(r["updSum"]);
        byCampaign.set(id, c);
      }
      return {
        period: { from, to },
        total: round2(list.reduce((s, r) => s + num(r["updSum"]), 0)),
        campaigns: [...byCampaign.values()].map((c) => ({ ...c, spent: round2(c.spent) })).sort((a, b) => b.spent - a.spent),
      };
    }

    // ----- Акции -----
    case "get_promotions":
      return client.get(HOSTS.calendar, "/api/v1/calendar/promotions", {
        startDateTime: `${toDate(args.dateFrom, "dateFrom")}T00:00:00Z`,
        endDateTime: `${toDate(args.dateTo, "dateTo")}T23:59:59Z`,
        allPromo: String(args.allPromo ?? false),
        limit: "1000",
      });

    default: {
      const never: never = name;
      throw new Error(`Неизвестный инструмент: ${String(never)}`);
    }
  }
}
