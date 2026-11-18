/**
 * Тексты карточки против поисковых запросов и конкурентов.
 *
 *   npm run card -- <артикул WB или продавца>          — собрать данные по ключу из .env
 *   npm run card -- <артикул> --competitors 111,222     — сравнить с этими карточками
 *   npm run card -- --demo                              — на выдуманной кружке, без ключа
 *   npm run card -- --render <папка>                    — пересобрать отчёт, добавив proposal.md
 *
 * Конкуренты без --competitors берутся из последней проверки /competitors по самому
 * частому запросу товара. Результат — reports/card-<артикул>-ГГГГ-ММ-ДД: HTML, Excel,
 * data.json и summary.json (по нему Claude пишет proposal.md). В кабинете ничего не меняется.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WBClient } from "../mcp/wb/src/client.js";
import { ROOT, loadEnv, readKey } from "../mcp/wb/src/env.js";
import { CardFetcher } from "../competitors/cdn.js";
import { buildCardReport, cardSummary, type CardInput } from "../card/analyze.js";
import { collectCard } from "../card/collect.js";
import { demoCardInput } from "../card/demo.js";
import { renderCardHtml, renderCardXlsx } from "../card/render.js";
import { readHistory } from "./competitors.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Первый аргумент без «--» и не значение флага. */
function positional(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      if (["--render", "--competitors", "--days"].includes(args[i]!)) i++;
      continue;
    }
    return args[i];
  }
  return undefined;
}

export function parseIds(s: string | undefined): number[] {
  if (!s) return [];
  const ids = s.split(/[\s,;]+/).filter(Boolean).map((x) => Number(x.match(/\d{5,}/)?.[0]));
  if (ids.some((x) => !Number.isInteger(x))) throw new Error(`--competitors: нужны артикулы WB через запятую (можно ссылки), получено «${s}»`);
  return [...new Set(ids)];
}

async function render(dir: string, input: CardInput) {
  const proposalPath = join(dir, "proposal.md");
  const proposal = existsSync(proposalPath) ? readFileSync(proposalPath, "utf8") : undefined;
  const report = buildCardReport(input, proposal);
  const base = `Карточка ${input.own.vendorCode || input.own.nmId}${input.demo ? " ДЕМО" : ""} ${input.generatedAt.slice(0, 10)}`;
  writeFileSync(join(dir, `${base}.html`), renderCardHtml(report));
  try {
    await renderCardXlsx(report, join(dir, `${base}.xlsx`));
  } catch (err) {
    console.error(`Не удалось записать Excel (возможно, файл открыт — закройте и повторите): ${err instanceof Error ? err.message : err}`);
  }
  writeFileSync(join(dir, "summary.json"), JSON.stringify(cardSummary(report), null, 2));
  const rel = (f: string) => relative(ROOT, join(dir, f));
  console.log(`\nГотово${proposal ? " (с предложением из proposal.md)" : ""}:`);
  console.log(`  отчёт:   ${rel(`${base}.html`)}`);
  console.log(`  Excel:   ${rel(`${base}.xlsx`)}`);
  console.log(`  выжимка: ${rel("summary.json")}`);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (input.searchTexts.length) {
    console.log(`\nСпрос в названии: ${pct(report.coverage.title)}${report.proposal ? ` → ${pct(report.proposal.coverage.title)}` : ""}; в карточке: ${pct(report.coverage.card)}${report.proposal ? ` → ${pct(report.proposal.coverage.card)}` : ""}.`);
  }
  for (const w of report.proposal?.warnings ?? []) console.log(`⚠ ${w}`);
}

async function main() {
  const renderDir = arg("--render");
  if (renderDir) {
    const dir = resolve(ROOT, renderDir);
    const dataPath = join(dir, "data.json");
    if (!existsSync(dataPath)) throw new Error(`Нет файла ${dataPath} — сначала соберите данные: npm run card -- <артикул>`);
    await render(dir, JSON.parse(readFileSync(dataPath, "utf8")) as CardInput);
    return;
  }

  const demo = process.argv.includes("--demo");
  let input: CardInput;
  if (demo) {
    input = demoCardInput();
  } else {
    const id = positional();
    if (!id) throw new Error("Укажите товар: npm run card -- <артикул WB или артикул продавца>. Без ключа: npm run card -- --demo");
    const days = Number(arg("--days") ?? 30);
    if (!Number.isInteger(days) || days < 7 || days > 90) throw new Error("--days: от 7 до 90");
    loadEnv();
    const token = readKey("WB_API_TOKEN");
    if (!token) {
      console.error("Ключ WB не настроен. Запустите /setup в Claude Code или впишите ключ в .env.\nПосмотреть пример без ключа: npm run card -- --demo");
      process.exitCode = 1;
      return;
    }
    console.error(`Собираю карточку «${id}», поисковые запросы за ${days} дней и карточки конкурентов. Это до минуты.`);
    input = await collectCard({
      client: new WBClient({ token }),
      id,
      fetcher: new CardFetcher(),
      history: readHistory(),
      competitorIds: parseIds(arg("--competitors")),
      days,
      log: (m) => console.error(m),
    });
  }
  // Артикул продавца бывает с «/» и пробелами — в имени папки они недопустимы.
  const name = `card-${input.own.vendorCode || input.own.nmId}-${input.generatedAt.slice(0, 10)}${demo ? "-demo" : ""}`.replace(/[\\/:*?"<>|\s]+/g, "_");
  const dir = join(ROOT, "reports", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), JSON.stringify(input));
  await render(dir, input);
}

if (process.argv[1] && /card\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`Ошибка: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
