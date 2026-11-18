/**
 * Мелкие помощники для инструментов: даты, обрезка больших ответов.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Проверяет дату вида ГГГГ-ММ-ДД. Claude иногда присылает RFC3339 — берём из неё дату. */
export function toDate(value: unknown, field: string): string {
  const s = String(value ?? "").trim();
  const d = s.slice(0, 10);
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new Error(`${field}: нужна дата в формате ГГГГ-ММ-ДД, получено "${s}"`);
  }
  return d;
}

/** Unix-время начала (или конца) суток по UTC: часть методов WB принимает даты числом. */
export function toUnix(value: unknown, field: string, endOfDay = false): number {
  const d = toDate(value, field);
  const t = Date.parse(`${d}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  return Math.floor(t / 1000);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Период той же длины прямо перед заданным — для сравнения «было / стало». */
export function previousPeriod(from: string, to: string): { start: string; end: string } {
  const len = daysBetween(from, to);
  const end = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000);
  const start = new Date(end.getTime() - (len - 1) * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function inRange(dateTime: string | undefined, from: string, to: string): boolean {
  if (!dateTime) return false;
  const d = dateTime.slice(0, 10);
  return d >= from && d <= to;
}

/**
 * Большие выгрузки WB (десятки тысяч строк) нельзя целиком отдавать в контекст
 * модели: это дорого и бесполезно. Отдаём первые строки и честно пишем, сколько их всего.
 */
export function limitRows<T>(rows: T[], maxRows: number): { totalRows: number; returnedRows: number; truncated: boolean; rows: T[] } {
  const slice = rows.slice(0, maxRows);
  return { totalRows: rows.length, returnedRows: slice.length, truncated: rows.length > slice.length, rows: slice };
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? n : 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
