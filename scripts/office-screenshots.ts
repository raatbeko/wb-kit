/**
 * Скриншоты офиса для README (для разработчика набора, клиенту не нужно):
 *   1) npm run office:web -- --demo --port 3210
 *   2) npm run office:screenshots
 * Запускает Chrome без окна, открывает демо-офис и снимает 3D-вид и 2D-кабинет
 * через протокол отладки Chrome. Зависимостей нет: WebSocket встроен в Node 22.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../mcp/wb/src/env.js";

const URL_ = process.env.OFFICE_URL ?? "http://localhost:3210/";
const PORT = 9333;
const CHROME = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) throw new Error("Не найден Chrome/Edge — укажите путь в CHROME_PATH");
  const profile = mkdtempSync(join(tmpdir(), "office-shot-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1440,900",
    "--hide-scrollbars",
    "about:blank",
  ]);
  try {
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        target = list.find((t) => t.type === "page");
      } catch {
        /* Chrome ещё стартует */
      }
    }
    if (!target) throw new Error("Chrome не ответил");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let id = 0;
    const waiting = new Map<number, (v: unknown) => void>();
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown };
      if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)!(msg.result);
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const shot = async (file: string) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(ROOT, "docs", "office-3d", file), Buffer.from(r.data, "base64"));
      console.log(`docs/office-3d/${file}`);
    };
    const js = (expression: string) => send("Runtime.evaluate", { expression, awaitPromise: true });

    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable");
    await send("Page.navigate", { url: URL_ });
    await sleep(1500);
    // Планёрку на скриншотах не запускаем: помечаем, что сегодня она уже была.
    await js(`localStorage.setItem("office-meeting", new Date().toDateString()); localStorage.setItem("office-view","3d"); location.reload()`);
    await sleep(9000); // данные, сцена, несколько шагов демо-сценария
    await shot("screenshot-office.png");

    // Рабочий стол аналитика: главный вывод, график, воронка.
    await js(`window.__office.onSelect("analyst")`);
    await sleep(2500);
    await shot("screenshot-agent.png");

    // Таблица логиста: остатки и дни запаса с подсветкой.
    await js(`window.__office.onSelect("logist"); setTimeout(() => document.querySelector('.ws-tabs [data-tab="table"]').click(), 300)`);
    await sleep(2500);
    await shot("screenshot-table.png");

    // Планёрка: сотрудник рассказывает главное.
    await js(`document.getElementById("panel-close").click(); document.getElementById("meeting-btn").click()`);
    await sleep(6800);
    await shot("screenshot-meeting.png");

    await js(`window.__office.stopTour(); document.getElementById("view-2d").click()`);
    await sleep(1500);
    await shot("screenshot-cabinet.png");
    await js(`localStorage.setItem("office-view","3d")`);
    ws.close();
  } finally {
    chrome.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome ещё держит файлы — не страшно, это временная папка */
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
