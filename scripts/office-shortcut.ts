/**
 * Ярлык запуска 3D-офиса на Рабочем столе: `npm run office:shortcut`.
 * Одна команда для всех: на Windows — scripts/office-shortcut.ps1 (ярлык .lnk),
 * на Mac — scripts/office-shortcut.sh (файл «WB Офис.command»).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../mcp/wb/src/env.js";

const win = process.platform === "win32";
const script = join(ROOT, "scripts", win ? "office-shortcut.ps1" : "office-shortcut.sh");
const r = win
  ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: "inherit" })
  : spawnSync("bash", [script], { stdio: "inherit" });

if (r.error) {
  console.error(`Не удалось запустить ${win ? "PowerShell" : "bash"}: ${r.error.message}`);
  console.error("Офис можно запускать и без ярлыка: npm run office:web");
}
process.exitCode = r.status ?? 1;
