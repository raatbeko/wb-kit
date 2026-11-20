/**
 * Себестоимость товаров — data/cost.csv.
 *
 *   npm run cost                — сколько товаров с себестоимостью и где её не хватает
 *   npm run cost -- --init      — создать файл со всеми артикулами магазина (или дописать новые)
 *   npm run cost -- --init --demo — то же на демо-магазине, без ключа
 *
 * Файл открывается в Excel. Уже вписанные цифры никогда не перезаписываются:
 * --init только добавляет новые артикулы в конец.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { WBClient } from "../mcp/wb/src/client.js";
import { ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { fetchCards } from "../audit/collect.js";
import { createDemoClient } from "../audit/demo.js";
import { COST_PATH, mergeCostRows, parseCostCsv, serializeCostCsv } from "../audit/cost.js";

async function main() {
  const init = process.argv.includes("--init");
  const demo = process.argv.includes("--demo");
  const existing = existsSync(COST_PATH) ? parseCostCsv(readFileSync(COST_PATH, "utf8")) : [];
  const rel = relative(ROOT, COST_PATH);

  if (!init) {
    if (!existing.length) {
      console.log(`Файла ${rel} ещё нет. Создать со всеми артикулами магазина: npm run cost -- --init`);
      return;
    }
    const filled = existing.filter((r) => r.cost !== null);
    console.log(`${rel}: себестоимость вписана у ${filled.length} из ${existing.length} товаров.`);
    const empty = existing.filter((r) => r.cost === null);
    if (empty.length) console.log(`Без себестоимости: ${empty.slice(0, 15).map((r) => r.vendorCode || r.nmId).join(", ")}${empty.length > 15 ? ` и ещё ${empty.length - 15}` : ""}`);
    if (!existing.some((r) => r.taxPercent !== null)) console.log("Налог не указан ни у одного товара — прибыль будет без налога. Например, для УСН «доходы» впишите 6.");
    return;
  }

  let client;
  if (demo) client = createDemoClient();
  else {
    loadEnv();
    const token = readKey("WB_API_TOKEN");
    if (!token) {
      console.error("Ключ WB не настроен — не из чего взять список товаров. Запустите /setup или попробуйте: npm run cost -- --init --demo");
      process.exitCode = 1;
      return;
    }
    client = new WBClient({ token });
  }
  const cards = await fetchCards(client);
  const { rows, added } = mergeCostRows(existing, cards);
  mkdirSync(dirname(COST_PATH), { recursive: true });
  try {
    writeFileSync(COST_PATH, serializeCostCsv(rows));
  } catch (err) {
    console.error(`Не удалось записать ${rel} (возможно, файл открыт в Excel — закройте его и повторите): ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  console.log(existing.length ? `Дописано новых товаров: ${added}. Всего в ${rel}: ${rows.length}.` : `Создан ${rel}, товаров в нём: ${rows.length}.`);
  console.log("Откройте файл в Excel и впишите себестоимость одной штуки (закупка, упаковка, доставка до склада WB) и налог в % от выручки. Потом пересоберите аудит.");
}

if (process.argv[1] && /cost\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`Ошибка: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
