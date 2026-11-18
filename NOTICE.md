# Сторонний код и материалы

## theYahia/wildberries-mcp — MIT

https://github.com/theYahia/wildberries-mcp, коммит `2279973` (2026-09-06).
Copyright (c) 2026 theYahia. Текст лицензии: [`mcp/wb/LICENSE-theYahia`](mcp/wb/LICENSE-theYahia).

Из него взяты HTTP-клиент с лимитером запросов (`mcp/wb/src/client.ts`, `rate-limiter.ts`), конвертер схем (`schema.ts`) и тесты клиента. Изменено в wb-kit:

- набор инструментов переписан и сверен со Swagger WB (снимок 2026-05-01): удалённые и устаревшие методы заменены преемниками, исправлены параметры (остатки по `chrtId`, даты FBS unix-временем, новый метод ответа на отзыв, добавление заказов в поставку одним запросом);
- добавлены хосты finance, supplies, buyer-chat, documents, dp-calendar и лимиты отдельных методов;
- обработка 429 (раньше только 409), ключ в `Authorization` без `Bearer` по схеме Swagger;
- сводки вместо сырых выгрузок, вырезание персональных данных покупателей, сообщения на русском.

## Документация Wildberries Seller API

Маршруты сверены с официальной документацией WB (dev.wildberries.ru/openapi) по снимку из репозитория miilv/wb-seller-api-skill. Сам Swagger в wb-kit не включён: у того репозитория не указана лицензия.
