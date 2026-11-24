/**
 * Панель магазина — одна страница со всеми отчётами.
 *
 *   npm run panel                 — собрать из последних отчётов в reports/ и открыть в браузере
 *   npm run panel -- --demo       — то же на демо-отчётах (сначала npm run audit -- --demo)
 *   npm run panel -- --no-open    — только собрать, не открывать
 *
 * Аудит, офис, конкуренты и карточки сами пересобирают панель в конце, а открытая
 * страница перечитывает себя. Живой статус работы Claude — файл reports/panel/status.js.
 */
import { spawn } from "node:child_process";
import { relative } from "node:path";
import { ROOT } from "../mcp/wb/src/env.js";
import { buildPanel } from "../panel/build.js";

function open(path: string) {
  // explorer и open сами выбирают браузер по умолчанию и понимают русские имена файлов.
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [path]] : process.platform === "darwin" ? ["open", [path]] : ["xdg-open", [path]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // Не открылось — путь всё равно напечатан.
  }
}

function main() {
  const demo = process.argv.includes("--demo");
  const { path, sources } = buildPanel(ROOT, demo);
  const have = [
    sources.audit && "аудит",
    sources.office && "офис",
    sources.competitors && "конкуренты",
    sources.cards.length && `карточки (${sources.cards.length})`,
  ].filter(Boolean);
  console.log(`Готово: ${relative(ROOT, path)}`);
  console.log(have.length ? `В панели: ${have.join(", ")}.` : "Отчётов пока нет — панель пустая. Начните с /audit (или /audit демо).");
  if (!sources.audit) console.log(demo ? "Нет демо-аудита: npm run audit -- --demo" : "Нет аудита: npm run audit");
  if (!process.argv.includes("--no-open")) open(path);
}

if (process.argv[1] && /panel\.ts$/.test(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`Ошибка: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
