/**
 * Обновить данные WB в офисе вручную:
 *   npm run office:sync            — по ключу из .env (1–3 минуты, лимиты WB)
 *   npm run office:sync -- --demo  — демо-магазин (в базу демо-офиса)
 * Обычно не нужно: офис сам обновляет данные раз в 6 часов, пока открыт.
 */
import { join } from "node:path";
import { ROOT } from "../../mcp/wb/src/env.js";
import { STAFF } from "../core/staff.js";
import { DB_PATH } from "../db/sqlite.js";
import { EnvSecretStore } from "../secrets/env-secrets.js";
import { SqliteOfficeStore } from "../store/sqlite-store.js";
import { syncWb } from "./sync.js";

const demo = process.argv.includes("--demo");
const store = new SqliteOfficeStore(demo ? join(ROOT, "data", "office-demo.db") : DB_PATH);
store.ensureAgents(STAFF);
console.error(demo ? "Обновляю данные демо-магазина…" : "Обновляю данные WB. С настоящим ключом это 1–3 минуты: WB отдаёт отчёты не чаще раза в минуту.");
const r = await syncWb(store, new EnvSecretStore(), { demo, log: (m) => console.error(m) });
store.close();
if (r.ok) {
  const high = r.snapshot.issues.filter((i) => i.priority === "high").length;
  console.log(`Готово: проблем ${r.snapshot.issues.length}, срочных ${high}. Откройте офис: npm run office:web${demo ? " -- --demo" : ""}`);
} else {
  console.error(`Не получилось: ${r.reason}`);
  process.exitCode = 1;
}
