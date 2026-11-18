/**
 * Отчёт офиса агентов: план директора и ответы ролей в один HTML.
 *
 *   npm run office -- --render reports/office-ГГГГ-ММ-ДД
 *
 * Markdown-файлы пишет Claude (команда /office): план.md и <роль>.md.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { ROOT } from "../mcp/wb/src/env.js";
import { BASE_CSS, esc, markdownToHtml } from "../audit/render-html.js";

/** Порядок и подписи ролей в отчёте. */
export const ROLES: [file: string, title: string][] = [
  ["аналитик", "Аналитик"],
  ["логист", "Логист"],
  ["отзывы", "Менеджер отзывов"],
  ["маркетолог", "Маркетолог"],
  ["разведчик", "Разведчик"],
  ["контент", "Контент-мейкер"],
];

export function renderOfficeHtml(dir: string, files: Record<string, string>): string {
  const name = basename(dir);
  const demo = name.endsWith("-demo");
  const date = name.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  const known = new Set(ROLES.map(([f]) => f));
  const roles = [
    ...ROLES.filter(([f]) => files[f]),
    // Роль, которой нет в списке (человек добавил своего агента), — в конце под своим именем.
    ...Object.keys(files)
      .filter((f) => f !== "план" && !known.has(f))
      .sort()
      .map((f) => [f, f[0]!.toUpperCase() + f.slice(1)] as [string, string]),
  ];
  const nav = roles.map(([f, t]) => `<a href="#${esc(f)}">${esc(t)}</a>`).join(" · ");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Офис — план ${esc(date)}</title>
<style>
${BASE_CSS}
a{color:var(--accent)}nav{margin:-8px 0 8px;font-size:14px}.role h2{display:flex;gap:8px;align-items:baseline}.role h2 small{color:var(--muted);font-weight:400;font-size:13px}
</style></head><body><div class="wrap">
<header><div><h1>Офис магазина${demo ? '<span class="badge">ДЕМО</span>' : ""}</h1><div class="sub">План директора и отчёты ролей</div></div><div class="sub">${esc(date)}</div></header>
${roles.length ? `<nav>${nav}</nav>` : ""}
${files["план"] ? `<section class="insights"><h2>План</h2>${markdownToHtml(files["план"])}</section>` : '<section><p class="muted">План директора ещё не написан (нет файла план.md).</p></section>'}
${roles.map(([f, t]) => `<section class="role" id="${esc(f)}"><h2>${esc(t)}<small>${esc(f)}.md</small></h2>${markdownToHtml(files[f]!)}</section>`).join("\n")}
<footer>${demo ? "Демо на выдуманном магазине. " : ""}Роли только смотрят данные и советуют; изменения в кабинете делаются после вашего согласия.</footer>
</div></body></html>`;
}

function main() {
  const i = process.argv.indexOf("--render");
  const arg = i >= 0 ? process.argv[i + 1] : undefined;
  if (!arg) throw new Error("Укажите папку: npm run office -- --render reports/office-ГГГГ-ММ-ДД");
  const dir = resolve(ROOT, arg);
  if (!existsSync(dir)) throw new Error(`Нет папки ${dir}`);
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith(".md")) files[f.slice(0, -3).toLowerCase()] = readFileSync(join(dir, f), "utf8");
  if (!Object.keys(files).length) throw new Error(`В ${dir} нет .md-файлов: сначала роли и директор пишут отчёты (команда /office)`);
  const date = basename(dir).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  const out = join(dir, `${["Офис", date, basename(dir).endsWith("-demo") ? "ДЕМО" : ""].filter(Boolean).join(" ")}.html`);
  writeFileSync(out, renderOfficeHtml(dir, files));
  console.log(`Готово: ${relative(ROOT, out)} (план: ${files["план"] ? "есть" : "нет"}, ролей: ${Object.keys(files).filter((f) => f !== "план").length})`);
}

if (process.argv[1] && /office\.ts$/.test(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`Ошибка: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
