/**
 * Запуск офиса на ноутбуке:
 *   npm run office:web              →  http://localhost:3000
 *   npm run office:web -- --demo    →  демо-магазин, офис «живёт» сам (для показа)
 *   npm run office:web -- --port 3100
 *
 * Слушаем только 127.0.0.1: офис видит данные магазина, другим компьютерам
 * в сети (кафе, коворкинг) он не должен быть доступен.
 */
import { join } from "node:path";
import { ROOT } from "../../mcp/wb/src/env.js";
import { createExecutor } from "../agents/execute.js";
import { loadSdk, SdkAgentRunner } from "../agents/sdk-runner.js";
import { LocalEventBus } from "../bus/local-bus.js";
import type { AgentRunner } from "../core/ports.js";
import { STAFF } from "../core/staff.js";
import { DB_PATH } from "../db/sqlite.js";
import { startDemo } from "../demo/simulator.js";
import { EnvSecretStore } from "../secrets/env-secrets.js";
import { SqliteOfficeStore } from "../store/sqlite-store.js";
import { scanReports } from "../sync/reports-scan.js";
import { isStale, syncWb } from "../sync/sync.js";
import { REPORTS_DIR, createApp } from "./app.js";

const HOST = "127.0.0.1";
// `--port 3100` удобнее, чем переменная окружения: одинаково работает в PowerShell и в терминале Mac.
const argPort = process.argv.indexOf("--port");
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.OFFICE_PORT) || 3000;
const DEMO = process.argv.includes("--demo");
/** Как часто обновлять данные WB с настоящим ключом. */
const SYNC_EVERY_HOURS = 6;

async function main() {
  // Демо — в отдельной базе: выдуманный магазин не смешивается с настоящим.
  const store = new SqliteOfficeStore(DEMO ? join(ROOT, "data", "office-demo.db") : DB_PATH);
  store.ensureAgents(STAFF);
  const secrets = new EnvSecretStore();
  const bus = new LocalEventBus(store);

  // Режим Agent SDK — если есть ключ Claude API и установлен пакет SDK.
  let runner: AgentRunner | undefined;
  if (!DEMO && secrets.get("ANTHROPIC_API_KEY")) {
    const sdk = await loadSdk();
    if (sdk) runner = new SdkAgentRunner({ store, secrets, sdk });
    else console.log("Есть ключ Claude API, но не установлен Agent SDK — вопросы из офиса выключены. Включить: npm run office:api");
  }

  const startSync = () =>
    void syncWb(store, secrets, { demo: DEMO }).then((r) => {
      if (!r.ok) console.log(`Данные WB не обновлены: ${r.reason}`);
    });

  const server = createApp({
    store,
    bus,
    secrets,
    demo: DEMO,
    mode: runner ? "agent_sdk" : "claude_code",
    runner,
    // Одобрять в офисе можно в демо (ничего не уходит в WB) и в режиме Agent SDK.
    // В режиме «окна» решение принимает человек в Claude Code.
    executeApproval: DEMO || runner ? createExecutor(secrets, { demo: DEMO }) : undefined,
    startSync,
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Порт ${PORT} занят: офис уже открыт или порт занят другой программой.`);
      console.error(`Откройте http://localhost:${PORT} или запустите на другом порту: npm run office:web -- --port 3100`);
    } else console.error(err);
    process.exit(1);
  });

  const timers: NodeJS.Timeout[] = [];
  let stopDemo: (() => void) | undefined;

  server.listen(PORT, HOST, () => {
    console.log(`Офис открыт: http://localhost:${PORT}${DEMO ? "  (демо-магазин)" : ""}`);
    console.log(runner ? "Режим: вопросы и одобрения прямо в офисе (Claude API)." : DEMO ? "Режим: демо." : "Режим: окно в Claude Code — задавайте вопросы там, офис покажет работу.");
    console.log("Остановить — Ctrl+C.");

    // Отчёты из reports/ — при старте и раз в 10 секунд (Claude Code может сделать новый в любой момент).
    const scan = () => {
      try {
        scanReports(store, REPORTS_DIR);
      } catch (err) {
        console.error("Не удалось просмотреть reports/:", err);
      }
    };
    scan();
    timers.push(setInterval(scan, 10_000));

    if (DEMO) {
      if (isStale(store.latestSnapshot()?.createdAt, 12)) startSync();
      stopDemo = startDemo(store, () => store.latestSnapshot()?.snapshot);
    } else if (secrets.get("WB_API_TOKEN")) {
      // Данные WB — при старте, если старше 6 часов, и дальше по расписанию.
      const maybeSync = () => {
        if (isStale(store.latestSnapshot()?.createdAt, SYNC_EVERY_HOURS)) startSync();
      };
      maybeSync();
      timers.push(setInterval(maybeSync, 15 * 60_000));
    } else console.log("Ключа WB нет — экраны офиса будут пустыми. Посмотреть с данными: npm run office:web -- --demo");
    for (const t of timers) t.unref();
  });

  const stop = () => {
    stopDemo?.();
    for (const t of timers) clearInterval(t);
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
