/**
 * Синхронизация WB → офис: тот же сбор, что у /audit (collectAudit), затем
 * снимок в базу и событие в ленту. С настоящим ключом — 1–3 минуты из-за
 * лимитов WB, поэтому по расписанию, а не на каждый клик.
 */
import { collectAudit } from "../../audit/collect.js";
import { createDemoClient } from "../../audit/demo.js";
import { buildReport } from "../../audit/analyze.js";
import { WBClient } from "../../mcp/wb/src/client.js";
import type { OfficeStore, SecretStore } from "../core/ports.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";

export interface SyncOptions {
  demo?: boolean;
  days?: number;
  now?: Date;
  log?: (m: string) => void;
}

export type SyncResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: string };

let running: Promise<SyncResult> | null = null;

/** Одна синхронизация за раз: второй вызов, пока идёт первый, получает тот же результат. */
export function syncWb(store: OfficeStore, secrets: SecretStore, opts: SyncOptions = {}): Promise<SyncResult> {
  running ??= doSync(store, secrets, opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(store: OfficeStore, secrets: SecretStore, opts: SyncOptions): Promise<SyncResult> {
  const demo = Boolean(opts.demo);
  let client: WBClient;
  if (demo) client = createDemoClient(opts.now);
  else {
    const token = secrets.get("WB_API_TOKEN");
    if (!token) return { ok: false, reason: "Ключ WB не настроен — /setup в Claude Code или демо-режим" };
    client = new WBClient({ token });
  }

  store.setAgentStatus("analyst", "working", "собираю свежие данные WB");
  store.addEvent({ kind: "agent_started", agentId: "analyst", message: demo ? "Обновляю данные демо-магазина" : "Обновляю данные WB (1–3 минуты: лимиты WB)" });
  try {
    const data = await collectAudit(client, { days: opts.days ?? 30, now: opts.now, demo, log: opts.log });
    const snapshot = buildSnapshot(buildReport(data));
    store.addSnapshot(snapshot);
    const high = snapshot.issues.filter((i) => i.priority === "high").length;
    store.setAgentStatus("analyst", "idle");
    store.addEvent({
      kind: "sync_finished",
      agentId: "analyst",
      message: `Данные обновлены: проблем ${snapshot.issues.length}, срочных ${high}${snapshot.unavailable.length ? `; нет разделов: ${snapshot.unavailable.map((u) => u.section).join(", ")}` : ""}`,
    });
    return { ok: true, snapshot };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    store.setAgentStatus("analyst", "error", "не получилось обновить данные WB");
    store.addEvent({ kind: "agent_error", agentId: "analyst", message: `Не получилось обновить данные WB: ${reason}` });
    return { ok: false, reason };
  }
}

/** Пора ли обновлять: снимка нет или он старше `maxAgeHours`. */
export function isStale(createdAt: string | undefined, maxAgeHours: number, now = new Date()): boolean {
  if (!createdAt) return true;
  return now.getTime() - new Date(createdAt).getTime() > maxAgeHours * 3600_000;
}
