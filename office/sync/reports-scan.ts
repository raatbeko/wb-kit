/**
 * Отчёты, которые сделал Claude Code (/audit, /office, /competitors, /card),
 * лежат папками в reports/. Офис находит новые и заносит в базу — чтобы их
 * можно было открыть со стола сотрудника.
 *
 * Одна папка — один отчёт. Отчёт пишется по частям (файлы ролей, потом план,
 * потом HTML; HTML аудита раньше summary.json), поэтому заносим папку, только
 * когда в ней есть HTML, а если позже появились выжимка или другой главный
 * файл — обновляем ту же запись, а не создаём новую.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OfficeStore } from "../core/ports.js";
import type { ReportKind } from "../core/types.js";

const KINDS: [RegExp, ReportKind, string, string | null][] = [
  // папка, тип, подпись, кто из офиса «автор»
  [/^audit-(\d{4}-\d{2}-\d{2})(-demo)?$/, "audit", "Аудит магазина", "analyst"],
  [/^office-(\d{4}-\d{2}-\d{2})(-demo)?$/, "office", "План офиса", "director"],
  [/^competitors-(\d{4}-\d{2}-\d{2})(-demo)?$/, "competitors", "Конкуренты", "scout"],
  [/^card-.*?(\d{4}-\d{2}-\d{2})(-demo)?$/, "card", "Карточка", "content"],
];

/** Главный файл готового отчёта — HTML. Нет HTML — отчёт ещё пишется. */
function mainFile(dir: string): string | null {
  return readdirSync(dir).find((f) => f.toLowerCase().endsWith(".html")) ?? null;
}

/** Короткая выжимка из summary.json: только то, что нужно подписи в офисе. */
function shortSummary(dir: string): Record<string, unknown> | null {
  const file = join(dir, "summary.json");
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const issues = Array.isArray(s.issues) ? (s.issues as { priority?: string }[]) : null;
    return {
      ...(issues ? { issues: issues.length, high: issues.filter((i) => i.priority === "high").length } : {}),
      ...(Array.isArray(s.kpis) ? { kpis: (s.kpis as unknown[]).slice(0, 8) } : {}),
    };
  } catch {
    return null; // файл ещё дописывается — возьмём при следующем проходе
  }
}

/** Занести новые отчёты и обновить дописанные. Возвращает, сколько добавлено. */
export function scanReports(store: OfficeStore, reportsDir: string): number {
  if (!existsSync(reportsDir)) return 0;
  let added = 0;
  for (const name of readdirSync(reportsDir)) {
    const dir = join(reportsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const kind = KINDS.find(([re]) => re.test(name));
    if (!kind) continue;
    const [re, type, label, agentId] = kind;
    const file = mainFile(dir);
    if (!file) continue;
    const path = `reports/${name}/${file}`;
    const summary = shortSummary(dir);

    const existing = store.findReportByFolder(`reports/${name}/`);
    if (existing) {
      if (existing.path !== path || JSON.stringify(existing.summary) !== JSON.stringify(summary)) store.updateReport(existing.id, { path, summary });
      continue;
    }
    const m = re.exec(name)!;
    const date = m[1]!;
    const demo = Boolean(m[2]);
    const r = store.addReport({
      kind: type,
      title: `${label}${demo ? " (демо)" : ""} — ${date.split("-").reverse().join(".")}`,
      path,
      summary,
      agentId,
      createdAt: statSync(dir).mtime.toISOString(),
    });
    store.addEvent({ kind: "report_added", agentId, message: `Новый отчёт: ${r.title}`, data: { reportId: r.id, path } });
    added++;
  }
  return added;
}
