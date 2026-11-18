/**
 * Человеческие подписи к шагам агентов: «смотрю остатки», а не
 * «mcp__wb__get_wb_stocks». Неизвестный инструмент WB — общая подпись.
 */

const WB: Record<string, string> = {
  check_connection: "проверяю ключ WB",
  get_seller_info: "смотрю данные продавца",
  list_products: "смотрю список товаров",
  get_prices: "смотрю цены",
  get_sales_summary: "считаю продажи",
  get_abc_analysis: "делаю ABC-анализ",
  get_funnel: "смотрю воронку карточек",
  get_funnel_history: "смотрю воронку по дням",
  get_finance_summary: "разбираю финотчёт WB",
  get_finance_report_rows: "читаю строки финотчёта",
  get_account_balance: "смотрю баланс",
  get_commission: "смотрю комиссии WB",
  get_box_tariffs: "смотрю тарифы логистики",
  get_returns: "смотрю возвраты",
  get_wb_stocks: "смотрю остатки на складах WB",
  get_fbs_stocks: "смотрю остатки FBS",
  get_ad_costs: "считаю расходы на рекламу",
  get_campaign_stats: "смотрю статистику кампаний",
  list_feedbacks: "читаю отзывы",
  list_questions: "читаю вопросы покупателей",
  update_prices: "меняю цены",
  update_fbs_stocks: "меняю остатки FBS",
  create_fbs_supply: "создаю поставку FBS",
  add_orders_to_fbs_supply: "добавляю заказы в поставку FBS",
  deliver_fbs_supply: "передаю поставку FBS в доставку",
  reply_feedback: "отвечаю на отзыв",
  reply_question: "отвечаю на вопрос",
};

const NPM: [RegExp, string][] = [
  [/npm run audit/, "собираю аудит магазина"],
  [/npm run competitors/, "проверяю конкурентов"],
  [/npm run card/, "разбираю карточку"],
  [/npm run office/, "собираю отчёт офиса"],
  [/npm run check/, "проверяю, всё ли работает"],
];

/** Что агент делает этим инструментом. `important` — стоит ли писать событие в ленту. */
export function describeTool(tool: string, input: Record<string, unknown> = {}): { text: string; important: boolean } {
  if (tool.startsWith("mcp__wb__")) {
    const name = tool.slice("mcp__wb__".length);
    return { text: WB[name] ?? `запрос к WB: ${name}`, important: true };
  }
  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    for (const [re, text] of NPM) if (re.test(cmd)) return { text, important: true };
    return { text: "выполняю команду", important: false };
  }
  if (tool === "Skill") {
    const skill = String(input.skill ?? input.name ?? "");
    if (/mpstats/i.test(skill)) return { text: "смотрю данные MPSTATS", important: true };
    if (/photo/i.test(skill)) return { text: "готовлю фото карточки", important: true };
    return { text: `использую навык ${skill}`.trim(), important: false };
  }
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return { text: "читаю отчёты", important: false };
  if (tool === "Write" || tool === "Edit") return { text: "пишу отчёт", important: false };
  if (tool === "WebFetch" || tool === "WebSearch" || tool.includes("browser") || tool.includes("chrome"))
    return { text: "смотрю страницу WB в браузере", important: false };
  return { text: "работаю", important: false };
}

/**
 * Прячем всё, похожее на ключ: длинные строки из букв, цифр и «._-».
 * Ключи попадают в команды (`npm run set-key -- WB_API_TOKEN …`) и в текст
 * вопросов, а лента офиса видна на экране и лежит в базе.
 */
export function maskSecrets(s: string): string {
  // От 20 символов: ключи WB, MPSTATS, Claude API длиннее, а обычные слова латиницей — короче.
  return s.replace(/[A-Za-z0-9._\-+/=]{20,}/g, "•••");
}

/** Короткая строка для ленты: первая непустая строка, без markdown-шума, не длиннее `max`. */
export function short(s: string | undefined | null, max = 160): string {
  const line =
    String(s ?? "")
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "").trim())
      .find(Boolean) ?? "";
  const m = maskSecrets(line);
  return m.length > max ? m.slice(0, max - 1).trimEnd() + "…" : m;
}
