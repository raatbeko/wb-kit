// Читает карточки со страницы поиска Wildberries — ровно то, что видит покупатель.
// Запускается в открытой вкладке браузера (Claude выполняет этот код на странице поиска).
// Внутренние API WB не вызывает: только текст уже показанных карточек.
// Возвращает компактный объект { query, url, scannedAt, fields, rows }: строки — массивы
// значений в порядке fields. Так ответ вдвое короче, а Claude переносит его в файл целиком.
(() => {
  const toNum = (s) => {
    const n = Number(String(s).replace(/[^\d,]/g, "").replace(",", "."));
    return Number.isFinite(n) && String(s).match(/\d/) ? n : null;
  };
  const leaves = (el) =>
    [...el.querySelectorAll("*")]
      .filter((e) => e.children.length === 0)
      .map((e) => e.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean);

  // Первой сотни хватает для сравнения; дальше покупатели почти не листают.
  const LIMIT = 100;
  const seen = new Set();
  const articles = [...document.querySelectorAll("article[data-nm-id]")].filter((a) => {
    const id = a.getAttribute("data-nm-id");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const cards = articles.slice(0, LIMIT).map((a, i) => {
    const t = leaves(a);
    const prices = t.filter((s) => /^\d[\d\s]*₽$/.test(s)).map(toNum);
    const slash = t.indexOf("/");
    // Рейтинг стоит прямо перед «· N оценок» и бывает целым («5»), поэтому ищем его по соседству.
    const reviewsIdx = t.findIndex((s) => /оцен/i.test(s));
    const reviewsText = reviewsIdx >= 0 ? t[reviewsIdx] : undefined;
    const beforeReviews = reviewsIdx > 0 ? t[reviewsIdx - 1] : undefined;
    const ratingText = beforeReviews && /^[1-5]([,.]\d)?$/.test(beforeReviews) ? beforeReviews : t.find((s) => /^[1-5][,.]\d$/.test(s));
    const delivery = t.find((s) => /^(сегодня|завтра|послезавтра|\d{1,2} [а-я]+)$/i.test(s));
    const wallet = t.some((s) => /кошельк/i.test(s));
    const labels = t.filter((s) => s === s.toUpperCase() && /[А-ЯЁ]{3,}/.test(s) && !/₽/.test(s)).slice(0, 4);
    // Бренд и название обычно разделены «/»; если разделителя нет — название = самая длинная строка карточки.
    const name =
      slash >= 0
        ? t[slash + 1] ?? null
        : t.filter((s) => !/₽|оцен|кошельк/i.test(s) && !labels.includes(s) && s !== delivery && s.length > 8).sort((x, y) => y.length - x.length)[0] ?? null;
    return [
      Number(a.getAttribute("data-card-index") ?? i) + 1,
      Number(a.getAttribute("data-nm-id")),
      slash > 0 ? t[slash - 1] : null,
      name,
      prices[0] ?? null,
      prices.length > 1 ? prices[1] : null,
      ratingText ? toNum(ratingText) : null,
      reviewsText ? toNum(reviewsText) : null,
      delivery ?? null,
      labels,
      wallet ? 1 : 0,
    ];
  });

  const params = new URLSearchParams(location.search);
  return {
    query: params.get("search") ?? document.title,
    url: location.href,
    scannedAt: new Date().toISOString(),
    fields: ["position", "nmId", "brand", "name", "price", "oldPrice", "rating", "reviews", "delivery", "labels", "wallet"],
    rows: cards,
  };
})();
