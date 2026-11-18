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

/** 1 строка, 2 строки, 5 строк. */
export function rowsWord(n) {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? "строка" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "строки" : "строк";
}

/**
 * Ячейка CSV для русского Excel. Числовые колонки — числом с запятой (Excel посчитает),
 * остальные — как в таблице. Текст, начинающийся с = + - @ (например, отзыв покупателя),
 * Excel выполнил бы как формулу — ставим перед ним апостроф.
 */
export function csvCell(v, col, row) {
  let s;
  if (typeof v === "number" && (!col || (col.num && !col.csvText))) s = String(v).replace(".", ",");
  else {
    s = String((col?.fmt ? col.fmt(v, row) : v) ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

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
        const xe = x === null || x === undefined;
        const ye = y === null || y === undefined;
        if (xe || ye) return xe === ye ? 0 : xe ? 1 : -1;
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
    count.textContent = r.length === st.rows.length ? `${r.length} ${rowsWord(r.length)}` : `${r.length} из ${st.rows.length}`;
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
    // Текст, начинающийся с = + - @, Excel выполнит как формулу (а это может быть отзыв покупателя) —
    // ставим перед ним апостроф. Числа идут как есть, с запятой.
    const lines = [columns.map((c) => csvCell(c.label)).join(";"), ...visible().map((row) => columns.map((c) => csvCell(row[c.key], c, row)).join(";"))];
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
