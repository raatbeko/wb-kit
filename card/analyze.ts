/**
 * Разбор текста карточки против поисковых запросов и карточек конкурентов.
 * Здесь только счёт: какие слова ищут, какие из них есть в карточке, что пишут лидеры.
 * Сам текст предлагает Claude (proposal.md), а здесь же проверяется, что предложение
 * укладывается в лимиты WB и покрывает больше спроса, чем было.
 */
import { StemIndex, stem, stems, words } from "./text.js";

/** Ограничения WB на текст карточки. */
export const LIMITS = { title: 60, description: 5000 } as const;

export interface Characteristic {
  name: string;
  value: string;
}

export interface CardText {
  nmId: number;
  vendorCode?: string;
  brand?: string;
  subject: string;
  title: string;
  description: string;
  characteristics: Characteristic[];
  photos: number;
  hasVideo: boolean;
}

export interface SearchText {
  text: string;
  /** Обращений за период отчёта. */
  frequency: number;
  weekFrequency: number | null;
  avgPosition: number | null;
  openCard: number | null;
  orders: number | null;
}

export interface CardInput {
  generatedAt: string;
  demo?: boolean;
  period: { from: string; to: string };
  own: CardText;
  searchTexts: SearchText[];
  /** Почему запросов нет (нет категории «Аналитика», нет данных у нового товара…). */
  searchTextsError?: string;
  competitors: CardText[];
  /** Откуда взяты конкуренты: «выдача «плед флисовый» от 18.11.2026», «указаны вручную». */
  competitorsFrom?: string;
}

export interface QueryCoverage extends SearchText {
  inTitle: boolean;
  inCard: boolean;
  /** Слова запроса, которых нет нигде в карточке. */
  missing: string[];
  /** Слова, которые есть в описании или характеристиках, но не в названии. */
  notInTitle: string[];
}

export interface WordStat {
  stem: string;
  word: string;
  /** Сколько обращений приходится на запросы с этим словом. */
  demand: number;
  queries: number;
  inTitle: boolean;
  inCard: boolean;
}

export interface CompetitorWord {
  stem: string;
  word: string;
  /** У скольких конкурентов слово есть в названии или характеристиках. */
  competitors: number;
}

export interface Coverage {
  /** Доля спроса (обращений), у которой все слова запроса есть в названии. */
  title: number;
  /** То же для всей карточки: название, описание, характеристики. */
  card: number;
}

export interface Proposal {
  /** Текст до первого раздела — короткое объяснение, что и почему меняем. */
  intro: string;
  title?: string;
  description?: string;
  characteristics: Characteristic[];
  /** Остальные разделы proposal.md (фото, инфографика, «коротко») — показываются как есть. */
  rest: string;
  warnings: string[];
  coverage: Coverage;
}

export interface CardReport {
  input: CardInput;
  queries: QueryCoverage[];
  words: WordStat[];
  competitorWords: CompetitorWord[];
  coverage: Coverage;
  metrics: {
    titleLength: number;
    descriptionLength: number;
    characteristics: number;
    photos: number;
    hasVideo: boolean;
    competitors: { descriptionMedian: number | null; characteristicsMedian: number | null; photosMedian: number | null; withVideo: number; count: number };
  };
  findings: string[];
  proposal?: Proposal;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};

/** Для поиска важны значения характеристик; названия полей («Цвет», «Материал») — шум. */
const charValues = (c: Characteristic[]) => c.map((x) => x.value).join(" \n ");

function indexes(card: Pick<CardText, "title" | "description" | "characteristics" | "subject">) {
  const title = new StemIndex(card.title);
  const all = new StemIndex(card.title, card.description, charValues(card.characteristics), card.subject);
  return { title, all };
}

function coverageOf(queries: SearchText[], title: StemIndex, all: StemIndex): Coverage {
  const total = queries.reduce((s, q) => s + q.frequency, 0);
  if (!total) return { title: 0, card: 0 };
  let t = 0;
  let c = 0;
  for (const q of queries) {
    const st = stems(q.text);
    if (!st.length) continue;
    if (st.every((s) => title.has(s))) t += q.frequency;
    if (st.every((s) => all.has(s))) c += q.frequency;
  }
  return { title: t / total, card: c / total };
}

/** Разбор proposal.md: разделы «## Название», «## Описание», «## Характеристики», остальное — как есть. */
export function parseProposal(md: string): Omit<Proposal, "warnings" | "coverage"> {
  const parts = md.split(/^##\s+/m);
  const out: Omit<Proposal, "warnings" | "coverage"> = { intro: parts[0]!.trim(), characteristics: [], rest: "" };
  const rest: string[] = [];
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const head = (nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase();
    const body = (nl < 0 ? "" : part.slice(nl + 1)).trim();
    if (head.startsWith("название")) out.title = body.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^[«"]|[»"]$/g, "");
    else if (head.startsWith("описание")) out.description = body;
    else if (head.startsWith("характеристик")) {
      for (const line of body.split("\n")) {
        const m = line.match(/^\s*[-*]\s*([^:]+):\s*(.+)$/);
        if (m) out.characteristics.push({ name: m[1]!.trim().replace(/\*\*/g, ""), value: m[2]!.trim() });
      }
    } else rest.push(`## ${part.trim()}`);
  }
  out.rest = rest.join("\n\n");
  return out;
}

export function buildCardReport(input: CardInput, proposalMd?: string): CardReport {
  const own = input.own;
  const { title, all } = indexes(own);
  const searchTexts = [...input.searchTexts].sort((a, b) => b.frequency - a.frequency);

  const queries: QueryCoverage[] = searchTexts.map((q) => {
    const st = stems(q.text);
    return {
      ...q,
      inTitle: st.length > 0 && st.every((s) => title.has(s)),
      inCard: st.length > 0 && st.every((s) => all.has(s)),
      // Показываем слова так, как их пишут в запросе, а не основы («крышкой», а не «крыш»).
      missing: [...new Set(words(q.text).filter((w) => !all.has(stem(w))))],
      notInTitle: [...new Set(words(q.text).filter((w) => all.has(stem(w)) && !title.has(stem(w))))],
    };
  });

  // Слова запросов, взвешенные спросом: какие слова приносят больше всего обращений.
  const qIndex = new StemIndex(...searchTexts.map((q) => q.text));
  const wordMap = new Map<string, WordStat>();
  for (const q of searchTexts) {
    for (const s of stems(q.text)) {
      const w = wordMap.get(s) ?? { stem: s, word: qIndex.form(s), demand: 0, queries: 0, inTitle: title.has(s), inCard: all.has(s) };
      w.demand += q.frequency;
      w.queries += 1;
      wordMap.set(s, w);
    }
  }
  const wordsList = [...wordMap.values()].sort((a, b) => b.demand - a.demand);

  // Что пишут конкуренты в названии и характеристиках, а у продавца нет нигде.
  const compIndex = new StemIndex();
  const compCount = new Map<string, number>();
  for (const c of input.competitors) {
    const own = new Set(stems(`${c.title} ${charValues(c.characteristics)}`));
    compIndex.add(`${c.title} ${charValues(c.characteristics)}`);
    for (const s of own) compCount.set(s, (compCount.get(s) ?? 0) + 1);
  }
  const minShare = Math.max(2, Math.ceil(input.competitors.length * 0.3));
  const competitorWords: CompetitorWord[] = [...compCount.entries()]
    .filter(([s, n]) => n >= minShare && !all.has(s) && !/^\d+$/.test(s))
    .map(([s, n]) => ({ stem: s, word: compIndex.form(s), competitors: n }))
    .sort((a, b) => b.competitors - a.competitors || a.word.localeCompare(b.word))
    .slice(0, 30);

  const comps = input.competitors;
  const metrics: CardReport["metrics"] = {
    titleLength: own.title.length,
    descriptionLength: own.description.length,
    characteristics: own.characteristics.length,
    photos: own.photos,
    hasVideo: own.hasVideo,
    competitors: {
      descriptionMedian: median(comps.map((c) => c.description.length)),
      characteristicsMedian: median(comps.map((c) => c.characteristics.length)),
      photosMedian: median(comps.map((c) => c.photos)),
      withVideo: comps.filter((c) => c.hasVideo).length,
      count: comps.length,
    },
  };

  const coverage = coverageOf(searchTexts, title, all);
  const findings: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (searchTexts.length) {
    findings.push(`Название целиком содержит запросы, на которые приходится ${pct(coverage.title)} обращений; вся карточка — ${pct(coverage.card)}.`);
    const missingTop = wordsList.filter((w) => !w.inCard).slice(0, 5);
    if (missingTop.length) findings.push(`Нет в карточке слов из частых запросов: ${missingTop.map((w) => `«${w.word}»`).join(", ")}.`);
    const notTitle = wordsList.filter((w) => w.inCard && !w.inTitle).slice(0, 5);
    if (notTitle.length) findings.push(`Есть в описании или характеристиках, но не в названии: ${notTitle.map((w) => `«${w.word}»`).join(", ")}.`);
  } else if (input.searchTextsError) {
    findings.push(`Поисковые запросы WB недоступны: ${input.searchTextsError}`);
  }
  const cm = metrics.competitors;
  if (cm.descriptionMedian && metrics.descriptionLength < cm.descriptionMedian * 0.5) findings.push(`Описание ${metrics.descriptionLength} символов — у конкурентов обычно около ${cm.descriptionMedian}.`);
  if (cm.characteristicsMedian && metrics.characteristics < cm.characteristicsMedian * 0.7) findings.push(`Заполнено характеристик ${metrics.characteristics} — у конкурентов около ${cm.characteristicsMedian}.`);
  if (cm.photosMedian && metrics.photos < cm.photosMedian * 0.7) findings.push(`Фото ${metrics.photos} — у конкурентов около ${cm.photosMedian}.`);
  if (!metrics.hasVideo && cm.count && cm.withVideo >= cm.count / 2) findings.push(`Нет видео, а у ${cm.withVideo} из ${cm.count} конкурентов есть.`);
  if (metrics.titleLength > LIMITS.title) findings.push(`Название длиннее ${LIMITS.title} символов (${metrics.titleLength}) — WB может его обрезать или не принять.`);

  let proposal: Proposal | undefined;
  if (proposalMd?.trim()) {
    const p = parseProposal(proposalMd);
    const warnings: string[] = [];
    if (p.title && p.title.length > LIMITS.title) warnings.push(`Название ${p.title.length} символов — больше лимита WB в ${LIMITS.title}. Сократите.`);
    if (p.description && p.description.length > LIMITS.description) warnings.push(`Описание ${p.description.length} символов — больше лимита WB в ${LIMITS.description}.`);
    if (!p.title) warnings.push("В proposal.md нет раздела «## Название».");
    if (!p.description) warnings.push("В proposal.md нет раздела «## Описание».");
    const merged = new Map(own.characteristics.map((c) => [c.name.toLowerCase(), c]));
    for (const c of p.characteristics) merged.set(c.name.toLowerCase(), c);
    const after = indexes({
      title: p.title ?? own.title,
      description: p.description ?? own.description,
      characteristics: [...merged.values()],
      subject: own.subject,
    });
    proposal = { ...p, warnings, coverage: coverageOf(searchTexts, after.title, after.all) };
  }

  return { input, queries, words: wordsList, competitorWords, coverage, metrics, findings, proposal };
}

/** Выжимка для Claude: по ней он пишет proposal.md. */
export function cardSummary(r: CardReport) {
  const o = r.input.own;
  return {
    product: { nmId: o.nmId, vendorCode: o.vendorCode, brand: o.brand, subject: o.subject },
    current: { title: o.title, description: o.description, characteristics: o.characteristics, photos: o.photos, hasVideo: o.hasVideo },
    limits: LIMITS,
    period: r.input.period,
    searchTextsError: r.input.searchTextsError ?? null,
    coverage: r.coverage,
    findings: r.findings,
    topQueries: r.queries.slice(0, 30).map((q) => ({ text: q.text, frequency: q.frequency, avgPosition: q.avgPosition, orders: q.orders, inTitle: q.inTitle, missing: q.missing })),
    missingWords: r.words.filter((w) => !w.inCard).slice(0, 20).map((w) => ({ word: w.word, demand: w.demand })),
    notInTitle: r.words.filter((w) => w.inCard && !w.inTitle).slice(0, 15).map((w) => ({ word: w.word, demand: w.demand })),
    competitorWords: r.competitorWords.map((w) => ({ word: w.word, competitors: w.competitors })),
    competitors: {
      from: r.input.competitorsFrom ?? null,
      ...r.metrics.competitors,
      titles: r.input.competitors.map((c) => c.title),
    },
    proposal: r.proposal ? { title: r.proposal.title, titleLength: r.proposal.title?.length, descriptionLength: r.proposal.description?.length, coverage: r.proposal.coverage, warnings: r.proposal.warnings } : null,
  };
}

