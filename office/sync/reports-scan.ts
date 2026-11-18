/**
 * Отчёты, которые сделал Claude Code (/audit, /office, /competitors, /card),
 * лежат папками в reports/. Офис находит новые и заносит в базу — чтобы их
 * можно было открыть со стола сотрудника.
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

/** Главный файл отчёта: HTML (его откроет браузер), иначе план.md. */
function mainFile(dir: string): string | null {
  const files = readdirSync(dir);
  const html = files.find((f) => f.endsWith(".html"));
  if (html) return html;
  return files.find((f) => f === "план.md") ?? files.find((f) => f.endsWith(".md")) ?? null;
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
    return null;
  }
}

/** Занести новые отчёты. Возвращает, сколько добавлено. */
export function scanReports(store: OfficeStore, reportsDir: string): number {
  if (!existsSync(reportsDir)) return 0;
  let added = 0;
  for (const name of readdirSync(reportsDir)) {
    const dir = join(reportsDir, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const kind = KINDS.find(([re]) => re.test(name));
    if (!kind) continue;
    const [re, type, label, agentId] = kind;
    const file = mainFile(dir);
    if (!file) continue; // отчёт ещё пишется
    const path = `reports/${name}/${file}`;
    if (store.findReportByPath(path)) continue;
    const m = re.exec(name)!;
    const date = m[1]!;
    const demo = Boolean(m[2]);
    const r = store.addReport({
      kind: type,
      title: `${label}${demo ? " (демо)" : ""} — ${date.split("-").reverse().join(".")}`,
      path,
      summary: shortSummary(dir),
      agentId,
      createdAt: statSync(dir).mtime.toISOString(),
    });
    store.addEvent({ kind: "report_added", agentId, message: `Новый отчёт: ${r.title}`, data: { reportId: r.id, path } });
    added++;
  }
  return added;
}
