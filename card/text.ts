/**
 * Слова в поисковых запросах и тексте карточки. Без словарей и внешних библиотек:
 * нормализация, грубое отсечение окончаний и сравнение по основам. Этого хватает,
 * чтобы «пледы флисовые» и «плед флисовый» считались одним и тем же.
 */

const STOP = new Set(
  "и в во на для с со по из от до к ко а о об у за под над при без или не ни но же ли бы как что это то так все всё его ее её их мы вы он она они шт штук".split(" "),
);

/** Окончания от длинных к коротким. Отрезаем одно — самое длинное подходящее. */
const ENDINGS = [
  "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ешь", "ется", "ются", "ость", "ости",
  "ая", "яя", "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ом", "ем", "ах", "ях", "ов", "ев", "ей", "ую", "юю", "ам", "ям", "ия", "ию", "ье", "ья",
  "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й",
].sort((a, b) => b.length - a.length);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    // 200x220, 200*220, 200 х 220 → 200х220: размер — одно слово.
    .replace(/(\d)\s*[xх×*]\s*(\d)/g, "$1х$2");
}

export function words(s: string): string[] {
  return normalize(s)
    .split(/[^a-zа-я0-9х]+/)
    .filter((w) => w && !STOP.has(w) && (w.length >= 2 || /\d/.test(w)));
}

export function stem(w: string): string {
  if (/\d/.test(w) || w.length <= 2) return w;
  // Короткие слова режем осторожнее: «чай» и «чая» — одно, но основа не короче двух букв.
  for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= (w.length <= 4 ? 2 : 3)) return w.slice(0, -e.length);
  return w;
}

export const stems = (s: string): string[] => [...new Set(words(s).map(stem))];

/** Набор основ текста и самое частое написание каждой основы (для показа человеку). */
export class StemIndex {
  readonly set = new Set<string>();
  private readonly forms = new Map<string, Map<string, number>>();

  constructor(...texts: string[]) {
    for (const t of texts) this.add(t);
  }

  add(text: string) {
    for (const w of words(text)) {
      const s = stem(w);
      this.set.add(s);
      const m = this.forms.get(s) ?? new Map<string, number>();
      m.set(w, (m.get(w) ?? 0) + 1);
      this.forms.set(s, m);
    }
    return this;
  }

  has(s: string) {
    return this.set.has(s);
  }

  form(s: string): string {
    const m = this.forms.get(s);
    if (!m) return s;
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]![0];
  }
}
