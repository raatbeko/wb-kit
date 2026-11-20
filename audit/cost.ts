/**
 * Себестоимость товаров: data/cost.csv, который заполняет продавец.
 *
 * В API WB себестоимости нет, а без неё нельзя честно сказать, зарабатывает ли
 * магазин. Файл открывается в Excel: разделитель «;», запятая в дробях, BOM —
 * как сохраняет русский Excel. Читаем терпимо: лишние колонки, пробелы, «₽»,
 * пустые строки и строки без цены просто пропускаются.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../mcp/wb/src/env.js";

export const COST_PATH = join(ROOT, "data", "cost.csv");

export interface CostRow {
  nmId: number;
  vendorCode: string;
  title: string;
  /** Себестоимость одной штуки, ₽: закупка, упаковка, доставка до склада WB. */
  cost: number | null;
  /** Налог, % от выручки (УСН «доходы» — 6). Пусто — без налога. */
  taxPercent: number | null;
}

export const COST_HEADER = ["Артикул WB", "Артикул продавца", "Название", "Себестоимость, ₽", "Налог, %"];

const toNum = (s: string | undefined): number | null => {
  const t = String(s ?? "").replace(/[\s ₽%]/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Делим строку CSV с учётом кавычек (Excel берёт в кавычки названия с «;»). */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export function parseCostCsv(text: string): CostRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  // Excel в русской локали сохраняет через «;», в английской — через «,».
  const sep = lines[0]!.includes(";") ? ";" : lines[0]!.includes("\t") ? "\t" : ",";
  const head = splitLine(lines[0]!, sep).map((h) => h.toLowerCase());
  const col = (re: RegExp, fallback: number) => {
    const i = head.findIndex((h) => re.test(h));
    return i >= 0 ? i : fallback;
  };
  const hasHeader = head.some((h) => /артикул|себест|nm|cost/.test(h));
  const iNm = col(/артикул wb|nm/, 0);
  const iVc = col(/артикул продавца|vendor/, 1);
  const iTitle = col(/назван|title/, 2);
  const iCost = col(/себест|cost/, 3);
  const iTax = col(/налог|tax/, 4);
  const rows: CostRow[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const c = splitLine(line, sep);
    const nmId = Math.trunc(toNum(c[iNm]) ?? 0);
    const vendorCode = c[iVc] ?? "";
    if (!nmId && !vendorCode) continue;
    rows.push({ nmId, vendorCode, title: c[iTitle] ?? "", cost: toNum(c[iCost]), taxPercent: toNum(c[iTax]) });
  }
  return rows;
}

const cell = (v: string | number | null) => {
  if (v === null) return "";
  const s = typeof v === "number" ? String(v).replace(".", ",") : v;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function serializeCostCsv(rows: CostRow[]): string {
  // BOM — чтобы Excel на Windows открыл кириллицу без «кракозябр».
  return "﻿" + [COST_HEADER.join(";"), ...rows.map((r) => [r.nmId || "", r.vendorCode, r.title, r.cost, r.taxPercent].map(cell).join(";"))].join("\r\n") + "\r\n";
}

/** Дописать в файл новые товары, не трогая уже вписанные цифры. */
export function mergeCostRows(existing: CostRow[], products: { nmId: number; vendorCode: string; title: string }[]): { rows: CostRow[]; added: number } {
  const rows = [...existing];
  const known = new Set(existing.flatMap((r) => [r.nmId ? `n${r.nmId}` : "", r.vendorCode ? `v${r.vendorCode}` : ""]).filter(Boolean));
  let added = 0;
  // Налог одинаков для всего магазина: если продавец вписал его хоть где-то — подставим новым строкам.
  const tax = existing.find((r) => r.taxPercent !== null)?.taxPercent ?? null;
  for (const p of products) {
    if (known.has(`n${p.nmId}`) || (p.vendorCode && known.has(`v${p.vendorCode}`))) continue;
    rows.push({ nmId: p.nmId, vendorCode: p.vendorCode, title: p.title, cost: null, taxPercent: tax });
    added++;
  }
  return { rows, added };
}

export function loadCosts(path = COST_PATH): CostRow[] | null {
  if (!existsSync(path)) return null;
  const rows = parseCostCsv(readFileSync(path, "utf8"));
  return rows.length ? rows : null;
}

/** Найти себестоимость товара: по артикулу WB, иначе по артикулу продавца. */
export function costLookup(rows: CostRow[] | null | undefined) {
  const byNm = new Map<number, CostRow>();
  const byVc = new Map<string, CostRow>();
  for (const r of rows ?? []) {
    if (r.cost === null) continue;
    if (r.nmId) byNm.set(r.nmId, r);
    if (r.vendorCode) byVc.set(r.vendorCode.toLowerCase(), r);
  }
  return (nmId: number, vendorCode: string) => byNm.get(nmId) ?? (vendorCode ? byVc.get(vendorCode.toLowerCase()) : undefined);
}
