/**
 * Запуск офиса на ноутбуке:  npm run office:web  →  http://localhost:3000
 *
 * Слушаем только 127.0.0.1: офис видит данные магазина, другим компьютерам
 * в сети (кафе, коворкинг) он не должен быть доступен.
 */
import { LocalEventBus } from "../bus/local-bus.js";
import { STAFF } from "../core/staff.js";
import { DB_PATH } from "../db/sqlite.js";
import { EnvSecretStore } from "../secrets/env-secrets.js";
import { SqliteOfficeStore } from "../store/sqlite-store.js";
import { createApp } from "./app.js";

const HOST = "127.0.0.1";
// `--port 3100` удобнее, чем переменная окружения: одинаково работает в PowerShell и в терминале Mac.
const argPort = process.argv.indexOf("--port");
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.OFFICE_PORT) || 3000;

const store = new SqliteOfficeStore(DB_PATH);
store.ensureAgents(STAFF);
const bus = new LocalEventBus(store);
const server = createApp({ store, bus, secrets: new EnvSecretStore() });

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Порт ${PORT} занят: офис уже открыт или порт занят другой программой.`);
    console.error(`Откройте http://localhost:${PORT} или запустите на другом порту: npm run office:web -- --port 3100`);
  } else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Офис открыт: http://localhost:${PORT}`);
  console.log("Остановить — Ctrl+C.");
});

const stop = () => {
  server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
