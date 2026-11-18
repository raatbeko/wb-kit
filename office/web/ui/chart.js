/**
 * Простые графики на SVG без библиотек.
 * - barChart: одна серия по времени (заказы по неделям) — без легенды, название
 *   говорит само; тонкие столбики со скруглённым верхом, подсказка при наведении.
 * - hbars: горизонтальные полосы «доля от целого» (склады, расходы рекламы, удержания WB).
 * Цвет — один акцентный тон для величины; статусные цвета не используются как «серии».
 */
import { esc } from "./table.js";

const nf = new Intl.NumberFormat("ru-RU");

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

/** points: [{ label, value, hint? }]. Возвращает HTML-строку; подсказки вешает attachChartTips. */
export function barChart(points, { title, unit = "₽", height = 160 } = {}) {
  if (!points.length) return `<p class="muted">Нет данных для графика</p>`;
  const w = 560;
  const pad = { l: 8, r: 8, t: 12, b: 26 };
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const bw = (w - pad.l - pad.r) / points.length;
  const ih = height - pad.t - pad.b;
  const bars = points
    .map((p, i) => {
      const h = Math.max(2, (p.value / max) * ih);
      const x = pad.l + i * bw + bw * 0.18;
      const y = pad.t + ih - h;
      const bwi = bw * 0.64;
      const r = Math.min(4, bwi / 2, h);
      // Скругление только сверху, к оси — прямо.
      const path = `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bwi - r} Q${x + bwi},${y} ${x + bwi},${y + r} V${y + h} Z`;
      const tip = `${p.label}: ${nf.format(Math.round(p.value))}${unit ? " " + unit : ""}${p.hint ? " · " + p.hint : ""}`;
      return `<g class="bar${p.partial ? " partial" : ""}" data-tip="${esc(tip)}"><rect x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/><path d="${path}"/></g>`;
    })
    .join("");
  const labels = points
    .map((p, i) => (points.length <= 8 || i % 2 === 0 ? `<text x="${pad.l + i * bw + bw / 2}" y="${height - 8}" text-anchor="middle">${esc(p.label)}</text>` : ""))
    .join("");
  return `<figure class="chart">
    ${title ? `<figcaption>${esc(title)}</figcaption>` : ""}
    <svg viewBox="0 0 ${w} ${height}" role="img" aria-label="${esc(title ?? "график")}" preserveAspectRatio="none">
      <line class="base" x1="${pad.l}" x2="${w - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>
      <text class="max" x="${pad.l + 2}" y="${pad.t + 10}">${esc(nf.format(max))}${unit ? " " + unit : ""}</text>
      ${bars}${labels}
    </svg>
    <div class="tip" hidden></div>
  </figure>`;
}

/** Горизонтальные полосы: [{ label, value, sub? }], от большего к меньшему. */
export function hbars(items, { unit = "", max: maxIn, limit = 8 } = {}) {
  if (!items.length) return `<p class="muted">Нет данных</p>`;
  const list = items.slice(0, limit);
  const max = maxIn ?? Math.max(...list.map((i) => i.value), 1);
  return `<div class="hbars">${list
    .map(
      (i) => `<div class="hbar" title="${esc(i.label)}: ${esc(nf.format(Math.round(i.value)))}${unit ? " " + esc(unit) : ""}">
        <div class="hbar-l"><span>${esc(i.label)}</span><b>${esc(nf.format(Math.round(i.value)))}${unit ? " " + esc(unit) : ""}</b></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(1, (i.value / max) * 100).toFixed(1)}%"></div></div>
        ${i.sub ? `<div class="hbar-sub muted">${esc(i.sub)}</div>` : ""}
      </div>`,
    )
    .join("")}${items.length > limit ? `<p class="muted">и ещё ${items.length - limit}</p>` : ""}</div>`;
}

/** Подсказки графиков: один обработчик на контейнер, позиция — у курсора. */
export function attachChartTips(root) {
  root.addEventListener("pointermove", (e) => {
    const g = e.target.closest?.(".chart .bar");
    for (const fig of root.querySelectorAll(".chart")) {
      const tip = fig.querySelector(".tip");
      if (!g || !fig.contains(g)) {
        tip.hidden = true;
        fig.querySelectorAll(".bar.on").forEach((b) => b.classList.remove("on"));
        continue;
      }
      fig.querySelectorAll(".bar.on").forEach((b) => b !== g && b.classList.remove("on"));
      g.classList.add("on");
      const r = fig.getBoundingClientRect();
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 180)}px`;
      tip.style.top = `${e.clientY - r.top - 34}px`;
    }
  });
  root.addEventListener("pointerleave", () => {
    for (const fig of root.querySelectorAll(".chart")) {
      fig.querySelector(".tip").hidden = true;
      fig.querySelectorAll(".bar.on").forEach((b) => b.classList.remove("on"));
    }
  });
}
