/**
 * Фронт офиса: верхняя панель с цифрами, 3D-сцена или 2D-карточки, лента
 * событий, панель сотрудника (задачи, проблемы, решения, отчёты).
 * Всё текстовое выводится через textContent / esc — данные из базы не
 * исполняются как HTML.
 */
import { Office3D, drawWallScreen, formatKpi, hasWebGL, LAYOUT } from "./office3d.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const STATUS = { idle: "отдыхает", working: "работает", waiting: "ждёт вашего решения", error: "ошибка" };
const PRIORITY = { high: "срочно", medium: "важно", low: "можно позже" };
const APPROVAL = { pending: "ждёт решения", approved: "одобрено", rejected: "отклонено", done: "сделано", failed: "ошибка" };
/** Пример вопроса каждому сотруднику — подсказка, что у него можно спросить. */
const QUESTION = {
  director: "что срочно на этой неделе?",
  finance: "какие товары в минусе после удержаний WB?",
  analyst: "что с продажами за 30 дней?",
  scout: "что делают конкуренты?",
  reviews: "ответь на новые отзывы",
  logist: "что везти на склад?",
  marketer: "окупается ли реклама?",
  content: "улучши карточку пледа",
  reports: "продажи по категориям за месяц",
};
const KEY_NAMES ={ WB_API_TOKEN: "Wildberries", MPSTATS_TOKEN: "MPSTATS", ANTHROPIC_API_KEY: "Claude API" };

const state = {
  agents: new Map(),
  snapshot: null,
  approvals: [],
  reports: [],
  events: [],
  mode: { mode: "claude_code", demo: false, canApprove: false, canAsk: false },
  keys: [],
  selected: null,
  panel: null, // "agent" | "approvals" | "reports"
  view: "3d",
  office: null,
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим — не страшно */ } },
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Ошибка ${r.status}`);
  return body;
}
const post = (path, body = {}) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function notice(text) {
  const n = $("notice");
  n.textContent = text;
  n.hidden = false;
  clearTimeout(notice.t);
  notice.t = setTimeout(() => (n.hidden = true), 4500);
}

function time(iso) {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function date(iso) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function color(id) {
  const c = LAYOUT[id]?.shirt ?? 0x777777;
  return `#${c.toString(16).padStart(6, "0")}`;
}

/* ---------- Верхняя панель ---------- */

function renderTop() {
  const s = state.snapshot?.snapshot;
  $("shop").textContent = s?.shop ? `· ${s.shop}` : "";
  $("demo-badge").hidden = !state.mode.demo;
  const kpis = (s?.kpis ?? []).slice(0, 7);
  $("kpis").innerHTML = kpis.length
    ? kpis
        .map((k) => {
          const d = typeof k.delta === "number" ? `<span class="d ${k.delta >= 0 ? "up" : "down"}">${k.delta > 0 ? "+" : ""}${esc(k.delta)}%</span>` : "";
          return `<div class="kpi" title="${esc(k.hint ?? "")}"><span class="l">${esc(k.label)}</span><span class="v">${esc(formatKpi(k))}</span>${d}</div>`;
        })
        .join("")
    : `<div class="kpi"><span class="l">Данные WB</span><span class="v muted">${state.keys.find((k) => k.name === "WB_API_TOKEN")?.present ? "обновляются…" : "нет ключа — /setup или демо"}</span></div>`;
  const pending = state.approvals.filter((a) => a.status === "pending").length;
  $("approvals-count").textContent = pending;
  $("approvals-count").classList.toggle("hot", pending > 0);
  if (state.office) drawWallScreen(state.office.wall, s?.kpis ?? [], s?.shop ? `Магазин «${s.shop}»` : "Магазин");
  $("mode").textContent = state.mode.demo ? "демо-магазин" : state.mode.canAsk ? "вопросы — прямо здесь" : "вопросы — в Claude Code";
}

/* ---------- Лента ---------- */

function addEvent(e, fresh) {
  state.events.push(e);
  if (state.events.length > 200) state.events.shift();
  const feed = $("feed");
  feed.querySelector(".empty")?.remove();
  const who = e.agentId && state.agents.get(e.agentId)?.name;
  const li = document.createElement("li");
  li.className = `k-${e.kind}${fresh ? " new" : ""}`;
  li.innerHTML = `<time>${esc(time(e.createdAt))}</time><span>${who ? `<b>${esc(who)}:</b> ` : ""}${esc(e.message)}</span>`;
  if (e.agentId) {
    li.style.cursor = "pointer";
    li.addEventListener("click", () => openAgent(e.agentId));
  }
  feed.prepend(li);
  while (feed.children.length > 80) feed.lastChild.remove();
}

/* ---------- Сотрудники ---------- */

function applyAgents(list) {
  for (const a of list) {
    state.agents.set(a.id, a);
    state.office?.setAgent(a.id, a.status, a.activity);
  }
  if (state.view === "2d") renderCards();
  if (state.panel === "agent") renderPanel();
}

let agentsReq = 0;
async function refreshAgents() {
  // Ответы могут прийти не по порядку — берём только самый свежий запрос.
  const n = ++agentsReq;
  const list = await api("/api/agents");
  if (n === agentsReq) applyAgents(list);
}

function statsHtml(id) {
  const desk = state.snapshot?.snapshot?.desks?.[id] ?? [];
  return desk.map((d) => `<span class="stat ${esc(d.tone)}">${esc(d.label)}: <b>${esc(d.value)}</b></span>`).join("");
}

let lastCardsHtml = "";
function renderCards() {
  // Перерисовка только при изменениях — иначе клик и фокус клавиатуры терялись бы каждые 4 секунды.
  const html = [...state.agents.values()]
    .map(
      (a) => `<button class="card" type="button" data-id="${esc(a.id)}">
        <div class="who"><span class="avatar" style="background:${color(a.id)}">${esc(a.name[0])}</span>
          <div><div class="name">${esc(a.name)}</div><div class="title">${esc(a.title)}</div></div></div>
        <div class="st"><span class="dot ${esc(a.status)}"></span>${esc(a.status === "idle" ? STATUS.idle : a.activity || STATUS[a.status])}</div>
        <div class="muted">${esc(a.duty)}</div>
        <div class="stats">${statsHtml(a.id)}</div>
      </button>`,
    )
    .join("");
  if (html === lastCardsHtml) return;
  lastCardsHtml = html;
  $("cards").innerHTML = html;
}
$("cards").addEventListener("click", (ev) => {
  const card = ev.target.closest(".card");
  if (card) openAgent(card.dataset.id);
});

/* ---------- Панель ---------- */

function openAgent(id) {
  state.selected = id;
  state.panel = "agent";
  state.office?.select(id);
  renderPanel();
}
function openPanel(kind) {
  state.selected = null;
  state.panel = kind;
  state.office?.select(null);
  renderPanel();
}
function closePanel() {
  state.panel = null;
  state.selected = null;
  state.office?.select(null);
  $("panel").hidden = true;
  lastPanelHtml = "";
}

/** Подписи полей аргументов инструментов записи WB. */
const ARG_LABELS = { nmID: "Артикул", price: "Цена до скидки, ₽", discount: "Скидка, %", text: "Текст", id: "ID", stocks: "Остатки", sku: "Баркод", amount: "Количество", warehouseId: "Склад", supplyId: "Поставка", orders: "Заказы", name: "Название" };

/**
 * Что именно уйдёт в WB — из настоящих аргументов, а не из пояснения сотрудника.
 * Человек одобряет ровно то, что будет выполнено.
 */
function argsHtml(args) {
  const val = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));
  const parts = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const cols = [...new Set(v.flatMap((x) => Object.keys(x)))];
      parts.push(`<table><thead><tr>${cols.map((c) => `<th>${esc(ARG_LABELS[c] ?? c)}</th>`).join("")}</tr></thead><tbody>${v
        .slice(0, 50)
        .map((x) => `<tr>${cols.map((c) => `<td>${esc(x[c] === undefined ? "" : val(x[c]))}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>${v.length > 50 ? `<p class="hint">и ещё ${v.length - 50}</p>` : ""}`);
    } else parts.push(`<p><span class="muted">${esc(ARG_LABELS[k] ?? k)}:</span> ${esc(val(v))}</p>`);
  }
  return parts.join("");
}

function approvalHtml(a) {
  const rows = (a.changes ?? []).map((c) => `<tr><td>${esc(c.item)}</td><td>${esc(c.before)}</td><td>${esc(c.after)}</td></tr>`).join("");
  const explain = rows ? `<table><thead><tr><th>Что</th><th>Было</th><th>Станет</th></tr></thead><tbody>${rows}</tbody></table>` : "";
  const sent = Object.keys(a.args ?? {}).length ? `<div class="hint" style="margin-top:6px">Что уйдёт в WB:</div>${argsHtml(a.args)}` : "";
  const who = state.agents.get(a.agentId)?.name ?? a.agentId;
  // Запрос из Claude Code (есть сеанс) решается там — двойное «да» выполнило бы изменение дважды.
  const fromClaudeCode = Boolean(a.sessionId);
  const buttons =
    a.status !== "pending"
      ? ""
      : state.mode.canApprove && !fromClaudeCode
        ? `<div class="row"><button class="btn primary" data-approve="${esc(a.id)}" type="button">Одобрить</button><button class="btn danger" data-reject="${esc(a.id)}" type="button">Отклонить</button></div>`
        : `<p class="hint">Ответьте «да» или «нет» в окне Claude Code — офис обновится сам.</p>`;
  return `<div class="appr s-${esc(a.status)}"><div><b>${esc(a.title)}</b></div>
    <div class="muted">${esc(who)} · ${esc(APPROVAL[a.status] ?? a.status)} · ${esc(date(a.createdAt))}</div>${explain}${sent}${buttons}</div>`;
}

function reportLink(r) {
  if (r.path) {
    const href = "/" + r.path.split("/").map(encodeURIComponent).join("/");
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(r.title)}</a>`;
  }
  return `<b>${esc(r.title)}</b>${r.summary?.text ? `<div class="answer">${esc(r.summary.text)}</div>` : ""}`;
}

function renderPanel() {
  const body = $("panel-body");
  const panel = $("panel");
  if (!state.panel) return;
  panel.hidden = false;
  let html = "";

  if (state.panel === "approvals") {
    const list = state.approvals.slice(0, 40);
    html = `<h2>Решения</h2><p class="sub">Изменения в кабинете WB выполняются только после вашего «да».</p>
      ${list.length ? list.map(approvalHtml).join("") : `<p class="muted">Пока сотрудники ничего не предлагали менять.</p>`}`;
  } else if (state.panel === "reports") {
    const keys = state.keys.map((k) => `<li>${esc(KEY_NAMES[k.name] ?? k.name)}: ${k.present ? "подключён" : "нет"}</li>`).join("");
    html = `<h2>Отчёты</h2><p class="sub">Отчёты Claude Code из папки reports и ответы сотрудников.</p>
      <ul class="list">${state.reports.length ? state.reports.map((r) => `<li>${reportLink(r)} <span class="muted">· ${esc(date(r.createdAt))}</span></li>`).join("") : `<li class="muted">Отчётов пока нет. В Claude Code: /audit, /office, /competitors.</li>`}</ul>
      <h3>Ключи</h3><ul class="list">${keys}</ul>
      <h3>Данные WB</h3><p class="muted">${state.snapshot ? `Обновлены ${esc(date(state.snapshot.createdAt))}${state.snapshot.snapshot.demo ? " (демо-магазин)" : ""}` : "Ещё не загружались"}</p>`;
  } else {
    const a = state.agents.get(state.selected);
    if (!a) return closePanel();
    const s = state.snapshot?.snapshot;
    const issues = (s?.issues ?? []).filter((i) => i.owner === a.id);
    const appr = state.approvals.filter((x) => x.agentId === a.id).slice(0, 5);
    const events = state.events.filter((e) => e.agentId === a.id).slice(-8).reverse();
    const reports = state.reports.filter((r) => r.agentId === a.id).slice(0, 6);
    const ask = state.mode.canAsk
      ? `<form class="ask" id="ask"><textarea name="q" maxlength="2000" placeholder="Спросите ${esc(a.name.toLowerCase())}…" required></textarea>
         <div class="row"><span class="muted">Ответ появится в ленте и здесь</span><button class="btn primary" type="submit">Спросить</button></div></form>`
      : `<p class="muted">Спросите в Claude Code, например: «${esc(a.title)}, ${esc(QUESTION[a.id] ?? "что срочно?")}» или командой /office — здесь будет видно, как сотрудник работает.</p>`;
    html = `
      <div class="who" style="display:flex;gap:12px;align-items:center"><span class="avatar" style="background:${color(a.id)};width:44px;height:44px;font-size:18px">${esc(a.name[0])}</span>
        <div><h2>${esc(a.name)}</h2><div class="sub">${esc(a.title)} · ${esc(a.duty)}</div></div></div>
      <p class="st" style="margin-top:12px"><span class="dot ${esc(a.status)}"></span>${esc(a.status === "idle" ? STATUS.idle : a.activity || STATUS[a.status])}</p>
      <div class="stats">${statsHtml(a.id)}</div>
      ${appr.length ? `<h3>Решения</h3>${appr.map(approvalHtml).join("")}` : ""}
      <h3>Что нашёл в магазине</h3>
      ${issues.length ? issues.map((i) => `<div class="issue"><div><span class="p p-${esc(i.priority)}">${esc(PRIORITY[i.priority])}</span><span class="t">${esc(i.title)}</span></div>
          <div class="a">${esc(i.action)}</div>${i.products?.length ? `<div class="prods">${i.products.slice(0, 4).map((p) => esc(p.title)).join(" · ")}${i.products.length > 4 ? ` и ещё ${i.products.length - 4}` : ""}</div>` : ""}</div>`).join("") : `<p class="muted">${s ? "По его участку проблем нет." : "Данных WB пока нет."}</p>`}
      <h3>Спросить</h3>${ask}
      <h3>Последние шаги</h3>
      <ul class="list">${events.length ? events.map((e) => `<li><span class="muted">${esc(time(e.createdAt))}</span> ${esc(e.message)}</li>`).join("") : `<li class="muted">Пока ничего</li>`}</ul>
      ${reports.length ? `<h3>Отчёты</h3><ul class="list">${reports.map((r) => `<li>${reportLink(r)}</li>`).join("")}</ul>` : ""}`;
  }
  setPanelHtml(body, html);
}

/**
 * Панель обновляется часто (статусы, события). Перерисовываем только если
 * содержимое изменилось, а набранный вопрос и фокус сохраняем — иначе текст
 * стирался бы под пальцами, а кнопки исчезали бы под курсором.
 */
let lastPanelHtml = "";
function setPanelHtml(body, html) {
  if (html === lastPanelHtml) return;
  lastPanelHtml = html;
  const ta = body.querySelector("textarea");
  const keep = ta && { value: ta.value, focused: document.activeElement === ta, start: ta.selectionStart, end: ta.selectionEnd };
  body.innerHTML = html;
  const next = body.querySelector("textarea");
  if (keep && next) {
    next.value = keep.value;
    if (keep.focused) {
      next.focus();
      next.setSelectionRange(keep.start, keep.end);
    }
  }
}

// Обработчики — один раз, на весь контейнер панели (делегирование).
$("panel-body").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-approve],[data-reject]");
  if (!b || b.disabled) return;
  const id = b.dataset.approve || b.dataset.reject;
  b.disabled = true;
  try {
    await post(`/api/approvals/${id}/${b.dataset.approve ? "approve" : "reject"}`);
    await refreshApprovals();
  } catch (err) {
    notice(err.message);
    b.disabled = false;
  }
});
$("panel-body").addEventListener("submit", async (ev) => {
  if (ev.target.id !== "ask") return;
  ev.preventDefault();
  const a = state.agents.get(state.selected);
  const q = new FormData(ev.target).get("q");
  if (!a || !q) return;
  try {
    await post("/api/tasks", { agentId: a.id, question: q });
    notice(`${a.name}: взялся за задачу`);
    ev.target.reset();
  } catch (err) {
    notice(err.message);
  }
});

/* ---------- Данные ---------- */

let approvalsReq = 0;
async function refreshApprovals() {
  // Как у сотрудников: старый ответ, пришедший позже нового, не перезаписывает его.
  const n = ++approvalsReq;
  const list = await api("/api/approvals");
  if (n !== approvalsReq) return;
  state.approvals = list;
  renderTop();
  if (state.panel) renderPanel();
}
async function refreshReports() {
  state.reports = await api("/api/reports");
  if (state.panel) renderPanel();
}
async function refreshSnapshot() {
  state.snapshot = await api("/api/snapshot");
  renderTop();
  if (state.view === "2d") renderCards();
  if (state.panel) renderPanel();
}

let pending = null;
let needApprovals = false;
function onEvent(e) {
  addEvent(e, true);
  // Флаг копится по всей пачке: предложение могло прийти не первым событием.
  if (["approval_requested", "approval_resolved"].includes(e.kind)) needApprovals = true;
  // Пачка событий за полсекунды — одно обновление.
  pending ??= setTimeout(async () => {
    pending = null;
    const approvalsToo = needApprovals || state.approvals.some((a) => a.status === "pending");
    needApprovals = false;
    try {
      await refreshAgents();
      if (approvalsToo) await refreshApprovals();
    } catch { /* следующий раз */ }
  }, 300);
  if (e.kind === "sync_finished") refreshSnapshot().catch(() => {});
  if (e.kind === "report_added" || e.kind === "agent_finished") {
    refreshReports().catch(() => {});
    if (e.kind === "report_added" && e.agentId) state.office?.addPaper(e.agentId);
  }
}

/** 3D создаётся, только когда его впервые выбрали: на телефоне и в 2D видеокарта не греется. */
function ensureOffice() {
  if (state.office || state.noWebGL) return state.office;
  if (!hasWebGL()) {
    state.noWebGL = true;
  } else {
    try {
      state.office = new Office3D($("scene"), [...state.agents.values()], { onSelect: openAgent });
      window.__office = state.office; // для скриншотов и отладки
      renderTop();
      for (const e of state.events) if (e.kind === "report_added" && e.agentId) state.office.addPaper(e.agentId);
    } catch (err) {
      console.error(err);
      state.noWebGL = true;
    }
  }
  if (state.noWebGL) {
    $("view-3d").disabled = true;
    $("view-3d").title = "Этот компьютер не умеет 3D — показываем карточки";
  }
  return state.office;
}

function setView(v) {
  if (v === "3d" && !ensureOffice()) v = "2d";
  state.office?.setActive(v === "3d");
  state.view = v;
  store.set("office-view", v);
  $("scene").hidden = v !== "3d";
  $("cards").hidden = v !== "2d";
  $("view-3d").setAttribute("aria-pressed", String(v === "3d"));
  $("view-2d").setAttribute("aria-pressed", String(v === "2d"));
  if (v === "2d") renderCards();
}

async function main() {
  const [agents, mode, keys, events] = await Promise.all([api("/api/agents"), api("/api/mode"), api("/api/keys"), api("/api/events?limit=40")]);
  state.mode = mode;
  state.keys = keys;
  for (const a of agents) state.agents.set(a.id, a);

  setView(store.get("office-view") === "2d" || matchMedia("(max-width: 520px)").matches ? "2d" : "3d");

  await Promise.all([refreshSnapshot(), refreshApprovals(), refreshReports()]);
  if (!events.length) $("feed").innerHTML = `<li class="empty">Пока тихо. Задайте вопрос в Claude Code — здесь появятся шаги сотрудников.</li>`;
  for (const e of events) addEvent(e, false);
  for (const e of events) if (e.kind === "report_added" && e.agentId) state.office?.addPaper(e.agentId);

  const last = events.length ? events[events.length - 1].seq : 0;
  const es = new EventSource(`/api/stream?after=${last}`);
  es.onopen = () => ($("conn").innerHTML = "<b>●</b> на связи");
  es.onerror = () => ($("conn").textContent = "Нет связи с офисом — переподключаюсь…");
  es.addEventListener("office", (msg) => onEvent(JSON.parse(msg.data)));

  // Статусы меняются и без событий (например, «читаю отчёты») — подтягиваем раз в 4 секунды.
  setInterval(() => refreshAgents().catch(() => {}), 4000);
}

$("panel-close").addEventListener("click", closePanel);
$("approvals-btn").addEventListener("click", () => (state.panel === "approvals" ? closePanel() : openPanel("approvals")));
$("reports-btn").addEventListener("click", () => (state.panel === "reports" ? closePanel() : openPanel("reports")));
$("view-3d").addEventListener("click", () => setView("3d"));
$("view-2d").addEventListener("click", () => setView("2d"));
$("sync-btn").addEventListener("click", async () => {
  try {
    await post("/api/sync");
    notice(state.mode.demo ? "Обновляю демо-магазин…" : "Обновляю данные WB — 1–3 минуты (лимиты WB)");
  } catch (err) {
    notice(err.message);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePanel();
});

main().catch((err) => {
  console.error(err);
  $("conn").textContent = "Офис не отвечает. Запустите: npm run office:web";
});
