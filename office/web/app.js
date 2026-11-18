/**
 * Фронт офиса: верхняя панель с цифрами, 3D-сцена или 2D-карточки, лента
 * событий, «рабочий стол» сотрудника (ui/workspace.js), окно просмотра
 * (карточка товара, отчёт). Всё текстовое — через esc / textContent: данные
 * из базы и WB не исполняются как HTML.
 */
import { Office3D, formatKpi, hasWebGL, LAYOUT } from "./office3d.js";
import { esc } from "./ui/table.js";
import { STAFF_NAME, createWorkspace, headlineFor, productCardHtml } from "./ui/workspace.js";

const $ = (id) => document.getElementById(id);
const STATUS = { idle: "отдыхает", working: "работает", waiting: "ждёт вашего решения", error: "ошибка" };
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
const KEY_NAMES = { WB_API_TOKEN: "Wildberries", MPSTATS_TOKEN: "MPSTATS", ANTHROPIC_API_KEY: "Claude API" };

const state = {
  agents: new Map(),
  snapshot: null,
  approvals: [],
  reports: [],
  tasks: [],
  events: [],
  mode: { mode: "claude_code", demo: false, canApprove: false, canAsk: false },
  keys: [],
  selected: null,
  panel: null, // "agent" | "approvals" | "reports"
  view: "3d",
  office: null,
  noWebGL: false,
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
const time = (iso) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const date = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const color = (id) => `#${(LAYOUT[id]?.shirt ?? 0x777777).toString(16).padStart(6, "0")}`;
const snap = () => state.snapshot?.snapshot ?? null;
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 60 * 24 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
}

/* ---------- Решения (общая карточка для панели и рабочего стола) ---------- */

const ARG_LABELS = { nmID: "Артикул", price: "Цена до скидки, ₽", discount: "Скидка, %", text: "Текст", id: "ID", stocks: "Остатки", sku: "Баркод", amount: "Количество", warehouseId: "Склад", supplyId: "Поставка", orders: "Заказы", name: "Название" };

/** Что именно уйдёт в WB — из настоящих аргументов, а не из пояснения сотрудника. */
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
  const buttons =
    a.status !== "pending"
      ? ""
      : state.mode.canApprove && !a.sessionId
        ? `<div class="row"><button class="btn primary" data-approve="${esc(a.id)}" type="button">Одобрить</button><button class="btn danger" data-reject="${esc(a.id)}" type="button">Отклонить</button></div>`
        : `<p class="hint">Ответьте «да» или «нет» в окне Claude Code — офис обновится сам.</p>`;
  return `<div class="appr s-${esc(a.status)}"><div><b>${esc(a.title)}</b></div>
    <div class="muted">${esc(who)} · ${esc(APPROVAL[a.status] ?? a.status)} · ${esc(date(a.createdAt))}</div>${explain}${sent}${buttons}</div>`;
}

async function decide(id, what) {
  try {
    await post(`/api/approvals/${id}/${what}`);
    await refreshApprovals();
  } catch (err) {
    notice(err.message);
  }
}

/* ---------- Верхняя панель ---------- */

function renderTop() {
  const s = snap();
  $("shop").textContent = s?.shop ? `· ${s.shop}` : "";
  $("demo-badge").hidden = !state.mode.demo;
  const kpis = (s?.kpis ?? []).slice(0, 7);
  $("kpis").innerHTML = kpis.length
    ? kpis
        .map((k) => {
          const d = typeof k.delta === "number" ? `<span class="d ${k.delta >= 0 ? "up" : "down"}">${k.delta > 0 ? "+" : ""}${esc(k.delta)}%</span>` : "";
          return `<div class="kpi" title="${esc(k.hint ?? "")}"><span class="l">${esc(k.label)}</span><span class="v">${esc(formatKpi(k))}</span>${d}</div>`;
        })
        .join("") + `<div class="kpi fresh" title="Когда офис последний раз забирал данные WB"><span class="l">Данные</span><span class="v muted">${esc(ago(state.snapshot.createdAt))}</span></div>`
    : `<div class="kpi"><span class="l">Данные WB</span><span class="v muted">${state.keys.find((k) => k.name === "WB_API_TOKEN")?.present ? "обновляются…" : "нет ключа — /setup или демо"}</span></div>`;
  const pending = state.approvals.filter((a) => a.status === "pending").length;
  $("approvals-count").textContent = pending;
  $("approvals-count").classList.toggle("hot", pending > 0);
  $("mode").textContent = state.mode.demo ? "демо-магазин" : state.mode.canAsk ? "вопросы — прямо здесь" : "вопросы — в Claude Code";
}

/** Мониторы и стена в 3D: главный вывод каждого сотрудника и его цифры. */
function renderScreens() {
  if (!state.office) return;
  const s = snap();
  const ctx = { reports: state.reports };
  for (const a of state.agents.values()) {
    state.office.setMonitor(a.id, { headline: headlineFor(a.id, s, ctx), stats: s?.desks?.[a.id] ?? [], status: a.status });
  }
  state.office.setWall({
    title: s?.shop ? `Магазин «${s.shop}»` : "Магазин",
    kpis: s?.kpis ?? [],
    weekly: s?.weekly ?? [],
    urgent: (s?.issues ?? []).filter((i) => i.priority === "high").slice(0, 3).map((i) => i.title),
    fresh: state.snapshot ? `данные ${ago(state.snapshot.createdAt)}` : "данных WB нет",
    waiting: state.approvals.filter((a) => a.status === "pending").length,
  });
}

/* ---------- Лента ---------- */

function addEvent(e, fresh) {
  state.events.push(e);
  if (state.events.length > 300) state.events.shift();
  const feed = $("feed");
  feed.querySelector(".empty")?.remove();
  const who = e.agentId && state.agents.get(e.agentId)?.name;
  const li = document.createElement("li");
  li.className = `k-${e.kind}${fresh ? " new" : ""}${e.agentId ? " link" : ""}`;
  li.innerHTML = `<time>${esc(time(e.createdAt))}</time><span>${who ? `<b>${esc(who)}:</b> ` : ""}${esc(e.message)}</span>`;
  if (e.agentId) li.dataset.agent = e.agentId;
  feed.prepend(li);
  while (feed.children.length > 80) feed.lastChild.remove();
}
$("feed").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-agent]");
  if (li) openAgent(li.dataset.agent, "dialog");
});

/* ---------- Сотрудники: 2D-карточки ---------- */

let lastCardsHtml = "";
function renderCards() {
  // Перерисовка только при изменениях — иначе клик и фокус клавиатуры терялись бы.
  const s = snap();
  const html = [...state.agents.values()]
    .map((a) => {
      const h = headlineFor(a.id, s, { reports: state.reports });
      const desk = (s?.desks?.[a.id] ?? []).map((d) => `<span class="stat ${esc(d.tone)}">${esc(d.label)}: <b>${esc(d.value)}</b></span>`).join("");
      return `<button class="card" type="button" data-id="${esc(a.id)}">
        <div class="who"><span class="avatar" style="background:${color(a.id)}">${esc(a.name[0])}</span>
          <div><div class="name">${esc(a.name)}</div><div class="title">${esc(a.title)}</div></div></div>
        <div class="st"><span class="dot ${esc(a.status)}"></span>${esc(a.status === "idle" ? STATUS.idle : a.activity || STATUS[a.status])}</div>
        ${h ? `<div class="card-h">${esc(h)}</div>` : `<div class="muted">${esc(a.duty)}</div>`}
        <div class="stats">${desk}</div>
        <span class="card-more">Открыть рабочий стол →</span>
      </button>`;
    })
    .join("");
  if (html === lastCardsHtml) return;
  lastCardsHtml = html;
  $("cards").innerHTML = html;
}
$("cards").addEventListener("click", (ev) => {
  const card = ev.target.closest(".card");
  if (card) openAgent(card.dataset.id);
});

/* ---------- Панель: рабочий стол сотрудника, решения, отчёты ---------- */

const workspace = createWorkspace($("ws"), {
  onOpenProduct: openProduct,
  onOpenReport: openReport,
  onDecide: decide,
  async onAsk(agentId, question) {
    try {
      await post("/api/tasks", { agentId, question });
      notice(`${state.agents.get(agentId)?.name ?? ""}: взялся за задачу`);
      refreshTasks().catch(() => {});
      return true;
    } catch (err) {
      notice(err.message);
      return false;
    }
  },
});

function wsContext() {
  const a = state.agents.get(state.selected);
  return {
    agent: a,
    snapshot: snap(),
    snapshotId: state.snapshot?.id ?? null,
    approvals: state.approvals,
    reports: state.reports,
    tasks: state.tasks,
    events: state.events,
    mode: state.mode,
    color: color(a.id),
    example: QUESTION[a.id] ?? "что срочно?",
    approvalHtml,
  };
}

function openAgent(id, tab) {
  if (!state.agents.has(id)) return;
  state.office?.stopTour();
  state.selected = id;
  state.panel = "agent";
  workspace.open(id, tab);
  state.office?.select(id);
  renderPanel();
}
function openPanel(kind) {
  $("panel").classList.remove("full");
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
  $("panel").classList.remove("wide", "full");
  lastPanelHtml = "";
}

let lastPanelHtml = "";
function renderPanel() {
  const panel = $("panel");
  if (!state.panel) return;
  panel.hidden = false;
  const isAgent = state.panel === "agent";
  panel.classList.toggle("wide", isAgent);
  $("ws").hidden = !isAgent;
  $("panel-body").hidden = isAgent;
  $("panel-full").hidden = !isAgent;
  if (isAgent) {
    if (!state.agents.get(state.selected)) return closePanel();
    workspace.update(wsContext());
    return;
  }
  let html = "";
  if (state.panel === "approvals") {
    const list = state.approvals.slice(0, 40);
    html = `<h2>Решения</h2><p class="sub">Изменения в кабинете WB выполняются только после вашего «да».</p>
      ${list.length ? list.map(approvalHtml).join("") : `<p class="muted">Пока сотрудники ничего не предлагали менять.</p>`}`;
  } else {
    const keys = state.keys.map((k) => `<li>${esc(KEY_NAMES[k.name] ?? k.name)}: ${k.present ? "подключён" : "нет"}</li>`).join("");
    html = `<h2>Отчёты</h2><p class="sub">Отчёты Claude Code из папки reports и ответы сотрудников — открываются прямо здесь.</p>
      <ul class="rep-list">${state.reports.length ? state.reports.map((r) => `<li><button type="button" class="rep" data-report="${esc(r.id)}"><span class="rep-t">${esc(r.title)}</span><span class="muted">${esc(date(r.createdAt))} · ${esc(STAFF_NAME[r.agentId] ?? "")}</span></button></li>`).join("") : `<li class="muted">Отчётов пока нет. В Claude Code: /audit, /office, /competitors.</li>`}</ul>
      <h3>Ключи</h3><ul class="list">${keys}</ul>
      <h3>Данные WB</h3><p class="muted">${state.snapshot ? `Обновлены ${esc(date(state.snapshot.createdAt))} (${esc(ago(state.snapshot.createdAt))})${snap().demo ? " — демо-магазин" : ""}` : "Ещё не загружались"}</p>`;
  }
  if (html === lastPanelHtml) return;
  lastPanelHtml = html;
  $("panel-body").innerHTML = html;
}

$("panel-body").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-approve],[data-reject]");
  if (b && !b.disabled) {
    b.disabled = true;
    decide(b.dataset.approve || b.dataset.reject, b.dataset.approve ? "approve" : "reject").finally(() => (b.disabled = false));
    return;
  }
  const r = ev.target.closest("[data-report]");
  if (r) openReport(r.dataset.report);
});

/* ---------- Окно просмотра: карточка товара, отчёт ---------- */

function openModal(html, { wide = false } = {}) {
  const m = $("modal");
  $("modal-body").innerHTML = html;
  m.classList.toggle("wide", wide);
  if (!m.open) m.showModal();
}
$("modal-close").addEventListener("click", () => $("modal").close());
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) $("modal").close(); // клик по фону
});

function openProduct(nmId) {
  const p = snap()?.products.find((x) => x.nmId === nmId);
  if (!p) return notice("Нет данных по этому товару");
  openModal(productCardHtml(p, snap()));
}

function openReport(id) {
  const r = state.reports.find((x) => x.id === id);
  if (!r) return;
  if (!r.path) {
    // Ответ сотрудника (режим Claude API) — текстом.
    return openModal(`<h2>${esc(r.title)}</h2><p class="sub">${esc(STAFF_NAME[r.agentId] ?? "")} · ${esc(date(r.createdAt))}</p><div class="answer">${esc(r.summary?.text ?? "")}</div>`);
  }
  const href = "/" + r.path.split("/").map(encodeURIComponent).join("/");
  // Отчёт — в песочнице: его скрипты не получат доступ к офису (сервер тоже отдаёт его с CSP sandbox).
  openModal(
    `<div class="rep-head"><div><h2>${esc(r.title)}</h2><p class="sub">${esc(STAFF_NAME[r.agentId] ?? "")} · ${esc(date(r.createdAt))}</p></div>
      <a class="btn" href="${esc(href)}" target="_blank" rel="noopener">Открыть в новой вкладке</a></div>
     <iframe class="rep-frame" src="${esc(href)}" sandbox="allow-popups allow-popups-to-escape-sandbox" title="${esc(r.title)}"></iframe>`,
    { wide: true },
  );
}

/* ---------- Данные ---------- */

let agentsReq = 0;
async function refreshAgents() {
  // Ответы могут прийти не по порядку — берём только самый свежий запрос.
  const n = ++agentsReq;
  const list = await api("/api/agents");
  if (n !== agentsReq) return;
  for (const a of list) {
    const prev = state.agents.get(a.id);
    state.agents.set(a.id, a);
    state.office?.setAgent(a.id, a.status, a.activity);
    if (prev && prev.status !== a.status) state.office?.setMonitor(a.id, { status: a.status });
  }
  if (state.view === "2d") renderCards();
  if (state.panel === "agent") renderPanel();
}
let approvalsReq = 0;
async function refreshApprovals() {
  const n = ++approvalsReq;
  const list = await api("/api/approvals");
  if (n !== approvalsReq) return;
  state.approvals = list;
  renderTop();
  renderScreens();
  if (state.panel) renderPanel();
}
async function refreshReports() {
  state.reports = await api("/api/reports?limit=100");
  if (state.panel) renderPanel();
  if (state.view === "2d") renderCards();
}
async function refreshTasks() {
  state.tasks = await api("/api/tasks");
  if (state.panel === "agent") renderPanel();
}
async function refreshSnapshot() {
  state.snapshot = await api("/api/snapshot");
  renderTop();
  renderScreens();
  if (state.view === "2d") renderCards();
  if (state.panel) renderPanel();
}

let pending = null;
let needApprovals = false;
let needTasks = false;
function onEvent(e) {
  addEvent(e, true);
  // 3D реагирует на события сразу: лист летит от директора к сотруднику, готовый — радуется.
  if (e.kind === "agent_step" && e.agentId === "director" && e.data?.to) state.office?.handoff("director", e.data.to);
  if (e.kind === "agent_finished" && e.agentId && e.agentId !== "director") state.office?.celebrate(e.agentId);
  if (e.kind === "report_added" && e.agentId) state.office?.addPaper(e.agentId);
  // Флаги копятся по всей пачке: нужное событие могло прийти не первым.
  if (["approval_requested", "approval_resolved"].includes(e.kind)) needApprovals = true;
  if (e.taskId) needTasks = true;
  pending ??= setTimeout(async () => {
    pending = null;
    const approvalsToo = needApprovals || state.approvals.some((a) => a.status === "pending");
    const tasksToo = needTasks;
    needApprovals = needTasks = false;
    try {
      await refreshAgents();
      if (approvalsToo) await refreshApprovals();
      if (tasksToo) await refreshTasks();
      if (state.panel === "agent") renderPanel(); // «последние шаги» в диалоге
    } catch { /* следующий раз */ }
  }, 300);
  if (e.kind === "sync_finished") refreshSnapshot().catch(() => {});
  if (e.kind === "report_added" || e.kind === "agent_finished") refreshReports().catch(() => {});
}

/* ---------- 2D / 3D ---------- */

/** 3D создаётся, только когда его впервые выбрали: на телефоне и в 2D видеокарта не греется. */
function ensureOffice() {
  if (state.office || state.noWebGL) return state.office;
  if (!hasWebGL()) state.noWebGL = true;
  else {
    try {
      state.office = new Office3D($("scene"), [...state.agents.values()], {
        onSelect: (id) => openAgent(id),
        onHover: (id) => {
          const a = state.agents.get(id);
          return a ? { name: a.name, title: a.title, headline: headlineFor(id, snap(), { reports: state.reports }) } : null;
        },
        onWall: () => openAgent("director"),
      });
      window.__office = state.office; // для скриншотов и отладки
      renderScreens();
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
  const [agents, mode, keys, events] = await Promise.all([api("/api/agents"), api("/api/mode"), api("/api/keys"), api("/api/events?limit=60")]);
  state.mode = mode;
  state.keys = keys;
  for (const a of agents) state.agents.set(a.id, a);
  for (const e of events) addEvent(e, false);
  if (!events.length) $("feed").innerHTML = `<li class="empty">Пока тихо. Задайте вопрос в Claude Code — здесь появятся шаги сотрудников.</li>`;

  setView(store.get("office-view") === "2d" || matchMedia("(max-width: 520px)").matches ? "2d" : "3d");
  await Promise.all([refreshSnapshot(), refreshApprovals(), refreshReports(), refreshTasks()]);

  // Утренняя планёрка — сама, один раз в день, если открыт 3D и есть данные.
  if (state.view === "3d" && state.office && snap() && store.get("office-meeting") !== new Date().toDateString()) setTimeout(runMeeting, 1200);

  const last = events.length ? events[events.length - 1].seq : 0;
  const es = new EventSource(`/api/stream?after=${last}`);
  es.onopen = () => ($("conn").innerHTML = "<b>●</b> на связи");
  es.onerror = () => ($("conn").textContent = "Нет связи с офисом — переподключаюсь…");
  es.addEventListener("office", (msg) => onEvent(JSON.parse(msg.data)));

  // Статусы меняются и без событий (например, «читаю отчёты») — подтягиваем раз в 4 секунды.
  setInterval(() => refreshAgents().catch(() => {}), 4000);
  // «Данные N мин назад» и часы на стене.
  setInterval(() => {
    renderTop();
    renderScreens();
  }, 60_000);
}

/* ---------- Планёрка ---------- */

const MEETING_ORDER = ["director", "analyst", "finance", "logist", "marketer", "reviews", "content", "scout", "reports"];

/** Камера обходит столы, каждый говорит главное с цифрой; в конце — сколько решений ждут человека. */
function runMeeting() {
  if (state.view !== "3d" || !state.office) {
    setView("3d");
    if (!state.office) return notice("Планёрка показывается в 3D, а этот компьютер не умеет 3D");
  }
  closePanel();
  const s = snap();
  const lines = MEETING_ORDER.filter((id) => state.agents.has(id)).map((id) => ({ id, text: headlineFor(id, s, { reports: state.reports }) }));
  if (!lines.some((l) => l.text)) return notice("Данных WB пока нет — планёрке нечего обсудить");
  store.set("office-meeting", new Date().toDateString());
  state.office.tour(lines, {
    onEnd() {
      const n = state.approvals.filter((a) => a.status === "pending").length;
      notice(n ? `Планёрка окончена. Ждут вашего решения: ${n} — кнопка «Решения»` : "Планёрка окончена. Решений от вас сейчас не ждут.");
    },
  });
}
$("meeting-btn").addEventListener("click", runMeeting);

$("panel-close").addEventListener("click", closePanel);
$("panel-full").addEventListener("click", () => $("panel").classList.toggle("full"));
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
  if (e.key === "Escape" && !$("modal").open) {
    state.office?.stopTour();
    closePanel();
  }
  // Enter на строке таблицы — как щелчок (карточка товара).
  if (e.key === "Enter" && e.target.matches?.("tr[data-nm]")) openProduct(Number(e.target.dataset.nm));
});

main().catch((err) => {
  console.error(err);
  $("conn").textContent = "Офис не отвечает. Запустите: npm run office:web";
});
