/**
 * Таблица сотрудника: сортировка по клику на заголовок, поиск, выгрузка CSV.
 * Колонки описываются данными: { key, label, fmt?, num?, tone?(row) }.
 * Всё текстовое — через esc (данные из WB не исполняются как HTML).
 */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const nf = new Intl.NumberFormat("ru-RU");
export const fmt = {
  rub: (v) => (v === null || v === undefined ? "—" : `${nf.format(Math.round(v))} ₽`),
  int: (v) => (v === null || v === undefined ? "—" : nf.format(Math.round(v))),
  pct: (v) => (v === null || v === undefined ? "—" : `${nf.format(Math.round(v * 10) / 10)}%`),
  delta: (v) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${nf.format(Math.round(v * 10) / 10)}%`),
  days: (v) => (v === null || v === undefined ? "—" : `${nf.format(Math.round(v))} дн`),
  star: (v) => (v === null || v === undefined ? "—" : `${v}★`),
  bool: (v) => (v ? "да" : "нет"),
  text: (v) => (v === null || v === undefined || v === "" ? "—" : String(v)),
  date: (v) => (v ? new Date(v).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) : "—"),
};

/**
 * Нарисовать таблицу в `host`. Состояние сортировки и поиска живёт в замыкании,
 * поэтому повторный вызов render с новыми строками не сбрасывает выбор человека.
 */
export function createTable(host, { columns, rows, sort, title, empty = "Нет данных", search = true, limit = 200, filename = "таблица", rowNm }) {
  const st = { key: sort?.key ?? null, dir: sort?.dir ?? -1, q: "", rows };

  host.innerHTML = `
    <div class="tbl-tools">
      ${search ? `<input class="tbl-search" type="search" placeholder="Поиск по таблице" aria-label="Поиск по таблице">` : "<span></span>"}
      <span class="tbl-count muted"></span>
      <button class="btn ghost small tbl-csv" type="button" title="Скачать как CSV для Excel">CSV</button>
    </div>
    <div class="tbl-wrap"><table class="tbl"><caption class="sr">${esc(title ?? "")}</caption><thead></thead><tbody></tbody></table></div>`;
  const thead = host.querySelector("thead");
  const tbody = host.querySelector("tbody");
  const count = host.querySelector(".tbl-count");

  const visible = () => {
    let r = st.rows;
    if (st.q) {
      const q = st.q.toLowerCase();
      r = r.filter((row) => columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q)));
    }
    if (st.key) {
      const k = st.key;
      r = [...r].sort((a, b) => {
        const x = a[k];
        const y = b[k];
        // Пустые значения — всегда в конце, в какую сторону ни сортируй.
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru")) * st.dir;
      });
    }
    return r;
  };

  const draw = () => {
    thead.innerHTML = `<tr>${columns
      .map((c) => {
        const on = st.key === c.key;
        const aria = on ? (st.dir > 0 ? "ascending" : "descending") : "none";
        return `<th class="${c.num ? "num" : ""}" aria-sort="${aria}"><button type="button" data-key="${esc(c.key)}">${esc(c.label)}<span class="arr">${on ? (st.dir > 0 ? "▲" : "▼") : ""}</span></button></th>`;
      })
      .join("")}</tr>`;
    const r = visible();
    count.textContent = r.length === st.rows.length ? `${r.length} строк` : `${r.length} из ${st.rows.length}`;
    tbody.innerHTML = r.length
      ? r
          .slice(0, limit)
          .map(
            (row) =>
              `<tr${rowNm && rowNm(row) ? ` data-nm="${esc(rowNm(row))}" class="clickable" tabindex="0"` : ""}>${columns
                .map((c) => {
                  const tone = c.tone?.(row) ?? "";
                  return `<td class="${c.num ? "num" : ""} ${tone ? `t-${tone}` : ""}" ${c.wide ? 'style="white-space:normal;min-width:220px"' : ""}>${esc((c.fmt ?? fmt.text)(row[c.key], row))}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("") + (r.length > limit ? `<tr><td colspan="${columns.length}" class="muted">и ещё ${r.length - limit} — уточните поиск</td></tr>` : "")
      : `<tr><td colspan="${columns.length}" class="muted">${esc(empty)}</td></tr>`;
  };

  thead.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b) return;
    const k = b.dataset.key;
    st.dir = st.key === k ? -st.dir : columns.find((c) => c.key === k)?.num ? -1 : 1;
    st.key = k;
    draw();
  });
  host.querySelector(".tbl-search")?.addEventListener("input", (e) => {
    st.q = e.target.value.trim();
    draw();
  });
  host.querySelector(".tbl-csv").addEventListener("click", () => {
    // «;» и BOM — чтобы русский Excel открыл файл двойным щелчком без мастера импорта.
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [columns.map((c) => cell(c.label)).join(";"), ...visible().map((row) => columns.map((c) => cell(typeof row[c.key] === "number" ? String(row[c.key]).replace(".", ",") : row[c.key])).join(";"))];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  draw();
  return {
    update(rows) {
      st.rows = rows;
      draw();
    },
  };
}
