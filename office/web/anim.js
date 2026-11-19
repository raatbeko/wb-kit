/**
 * Анимация сотрудников без three.js: только числа позы (углы суставов).
 * office3d.js каждый кадр спрашивает «какую позу хотим» и плавно подводит
 * к ней скелет — поэтому переходы между состояниями не дёргаются.
 *
 * Оси (как в сцене): лицо смотрит в +z.
 *   плечо x < 0 — рука вперёд/вверх (−1.6 — вперёд, −3 — вверх), z — в сторону;
 *   локоть x < 0 — предплечье сгибается вперёд;
 *   бедро x = −π/2 и колено x = +π/2 — сидит; 0 и 0 — стоит;
 *   голова x > 0 — смотрит вниз, y > 0 — поворот к +x;
 *   корпус x > 0 — наклон вперёд.
 * Левая рука — [0] (со стороны −x), её «внутрь» — z > 0; у правой наоборот.
 */

export const POSE_KEYS = [
  "torsoX", "torsoY", "torsoZ", "lift",
  "headX", "headY", "headZ",
  "shLx", "shLz", "elL", "shRx", "shRz", "elR",
  "hipL", "kneeL", "hipR", "kneeR",
  "mouth", "smile", "pupX", "pupY",
];

const HALF_PI = Math.PI / 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Плавный вход и выход действия: 0 → 1 → 0 за время действия. */
export const envelope = (u, edge = 0.2) => (u <= 0 || u >= 1 ? 0 : u < edge ? smooth(u / edge) : u > 1 - edge ? smooth((1 - u) / edge) : 1);
function smooth(x) {
  return x * x * (3 - 2 * x);
}
const mix = (a, b, k) => a + (b - a) * k;

/** Сидит спокойно: руки на столе, спина прямая. */
export function seated() {
  return {
    torsoX: 0.04, torsoY: 0, torsoZ: 0, lift: 0,
    headX: 0, headY: 0, headZ: 0,
    shLx: -0.55, shLz: 0.12, elL: -0.75, shRx: -0.55, shRz: -0.12, elR: -0.75,
    hipL: -HALF_PI, kneeL: HALF_PI, hipR: -HALF_PI, kneeR: HALF_PI,
    mouth: 0, smile: 0, pupX: 0, pupY: 0,
  };
}

/** Наложить часть позы с весом w (0 — не трогать, 1 — заменить). */
function blend(P, part, w) {
  if (w <= 0) return P;
  for (const k in part) P[k] = mix(P[k], part[k], w);
  return P;
}

/* ---------- Набор движений ---------- */

/** Печатает: пальцы бегают, голова чуть кивает в такт мыслям. */
function typing(P, ph, m) {
  P.torsoX = 0.14;
  P.headX = 0.14 + Math.sin(ph * 2.7) * 0.03 * m;
  P.shLx = -0.5 + Math.sin(ph * 15) * 0.07 * m;
  P.shRx = -0.5 + Math.sin(ph * 15 + 2.1) * 0.07 * m;
  P.elL = -1.05 + Math.sin(ph * 17 + 1) * 0.16 * m;
  P.elR = -1.05 + Math.sin(ph * 17 + 3.3) * 0.16 * m;
  P.shLz = 0.16;
  P.shRz = -0.16;
}

/** Действия рабочего режима — сменяют друг друга каждые несколько секунд. */
const WORK = {
  type: () => {},
  // Сверяется с бумагами слева — одной рукой продолжает печатать.
  papers: (P, u, ph, m) => blend(P, { headY: -0.55, headX: 0.38, torsoY: -0.12, shLx: -0.9, shLz: 0.3, elL: -0.5 }, envelope(u)),
  // Водит мышкой справа.
  mouse: (P, u, ph, m) => blend(P, { shRx: -0.62 + Math.sin(ph * 4) * 0.05 * m, shRz: 0.22 + Math.sin(ph * 3) * 0.06 * m, elR: -0.95, headY: 0.08, pupX: 0.6 }, envelope(u)),
  // Задумался: рука у подбородка, взгляд вверх.
  think: (P, u, ph, m) => blend(P, { torsoX: -0.05, shRx: -1.15, shRz: -0.35, elR: -2.15, headX: -0.18, headZ: 0.08, pupY: 0.8 }, envelope(u)),
  // Придвинулся к экрану — что-то нашёл.
  lean: (P, u, ph, m) => blend(P, { torsoX: 0.32, headX: -0.05, elL: -1.25, elR: -1.25 }, envelope(u)),
  // Кивает сам себе: «так, понятно».
  nod: (P, u, ph, m) => blend(P, { headX: 0.12 + Math.sin(u * Math.PI * 6) * 0.14 * m, smile: 0.5 }, envelope(u)),
  // У аналитика второй монитор слева.
  screen2: (P, u, ph, m) => blend(P, { headY: -0.5, headX: -0.08, torsoY: -0.18, pupX: -0.6 }, envelope(u)),
};

/** Действия, пока сотрудник свободен. */
const IDLE = {
  // Оглядывается по офису.
  look: (P, u, ph, m) => blend(P, { headY: Math.sin(u * Math.PI * 2) * 0.8, headX: -0.05, pupX: Math.sin(u * Math.PI * 2) }, envelope(u, 0.15)),
  // Потягивается: руки вверх, зевает.
  stretch: (P, u, ph, m) =>
    blend(P, { torsoX: -0.16, headX: -0.32, shLx: -3.0, shLz: -0.25, elL: -0.25, shRx: -3.0, shRz: 0.25, elR: -0.25, mouth: u > 0.3 && u < 0.7 ? 1 : 0.2 }, envelope(u, 0.25)),
  // Пьёт кофе из кружки (кружка со стола оказывается в руке).
  sip: (P, u, ph, m) => blend(P, { shLx: -1.3, shLz: 0.42, elL: -2.05, headX: u > 0.35 && u < 0.7 ? -0.22 : 0, torsoX: -0.03 }, envelope(u, 0.25)),
  // Откинулся на спинку, руки за головой.
  relax: (P, u, ph, m) => blend(P, { torsoX: -0.22, headX: -0.12, shLx: -2.55, shLz: -0.55, elL: -2.2, shRx: -2.55, shRz: 0.55, elR: -2.2, smile: 0.6 }, envelope(u, 0.2)),
  // Листает телефон.
  phone: (P, u, ph, m) => blend(P, { headX: 0.42, shRx: -0.8, shRz: -0.32, elR: -1.45, shLx: -0.8, shLz: 0.3, elL: -1.3, pupY: -0.6 }, envelope(u, 0.15)),
  // Чешет затылок.
  scratch: (P, u, ph, m) => blend(P, { shRx: -2.6, shRz: 0.15, elR: -1.7 + Math.sin(ph * 16) * 0.15 * m, headZ: -0.12, headX: 0.08 }, envelope(u, 0.25)),
  // Крутится на кресле — это делает swivel в office3d.js, здесь только взгляд.
  swivel: (P, u, ph, m) => blend(P, { headX: -0.05, smile: 0.3 }, envelope(u)),
  // Разговор по гарнитуре: рука у уха, рот двигается.
  call: (P, u, ph, m) => blend(P, { shRx: -1.0, shRz: 0.55, elR: -2.4, headZ: 0.12, mouth: Math.max(0, Math.sin(ph * 11)) * 0.7 * m, smile: 0.3 }, envelope(u, 0.15)),
};

export const IDLE_KINDS = Object.keys(IDLE);
export const WORK_KINDS = Object.keys(WORK);

/**
 * Следующее действие. rand — функция 0..1 (в тестах подставляется своя).
 * Длительности — секунды.
 */
export function pickIdle(rand, { headset = false, canWalk = false } = {}) {
  const pool = [
    ["look", 3, 3.5], ["stretch", 1.2, 2.6], ["sip", 2, 2.8], ["relax", 1.2, 4.5], ["phone", 1.5, 4], ["scratch", 1, 1.6], ["swivel", 1, 3.2],
    ...(headset ? [["call", 2.2, 5]] : []),
    ...(canWalk ? [["walk", 1.4, 0]] : []),
  ];
  const total = pool.reduce((s, x) => s + x[1], 0);
  let r = rand() * total;
  for (const [kind, w, dur] of pool) {
    r -= w;
    if (r <= 0) return { kind, dur };
  }
  return { kind: "look", dur: 3.5 };
}

export function pickWork(rand, role) {
  const pool = [["type", 4, 3], ["papers", 1.4, 2.2], ["mouse", 1.6, 2.4], ["think", 1, 2.4], ["lean", 1, 2], ["nod", 0.8, 1.4], ...(role === "analyst" ? [["screen2", 1.8, 2.6]] : [])];
  const total = pool.reduce((s, x) => s + x[1], 0);
  let r = rand() * total;
  for (const [kind, w, dur] of pool) {
    r -= w;
    if (r <= 0) return { kind, dur };
  }
  return { kind: "type", dur: 3 };
}

/**
 * Целевая поза на этот кадр.
 * s: { status, t, ph, m, action?: {kind, start, dur}, work?: {...}, walk?: { phase, carry, stand },
 *      cheer, saying, wave, throwing, look?: { yaw, pitch } }
 */
export function targetPose(s) {
  const { t, ph } = s;
  const m = s.m ?? 1;
  const P = seated();
  const prog = (a) => (a ? clamp((t - a.start) / a.dur, 0, 1) : 0);

  if (s.walk) {
    // Встаёт / идёт / садится: stand 0..1 — насколько выпрямились ноги.
    const st = s.walk.stand;
    const moving = s.walk.moving ? 1 : 0;
    const w = s.walk.phase;
    const sw = Math.sin(w) * moving;
    P.hipL = mix(-HALF_PI, sw * 0.55, st);
    P.hipR = mix(-HALF_PI, -sw * 0.55, st);
    P.kneeL = mix(HALF_PI, 0.08 + Math.max(0, Math.cos(w)) * 0.75 * moving, st);
    P.kneeR = mix(HALF_PI, 0.08 + Math.max(0, -Math.cos(w)) * 0.75 * moving, st);
    P.torsoX = mix(0.04, 0.07 * moving, st);
    P.torsoY = Math.sin(w) * 0.06 * moving;
    P.lift = Math.abs(Math.cos(w)) * 0.035 * moving;
    P.shLx = mix(-0.55, -sw * 0.45 - 0.05, st);
    P.shRx = mix(-0.55, sw * 0.45 - 0.05, st);
    P.shLz = mix(0.12, -0.08, st);
    P.shRz = mix(-0.12, 0.08, st);
    P.elL = mix(-0.75, -0.25 - Math.max(0, -sw) * 0.3, st);
    P.elR = mix(-0.75, -0.25 - Math.max(0, sw) * 0.3, st);
    if (s.walk.carry) Object.assign(P, { shLx: -0.45, shLz: 0.2, elL: -1.3 });
    if (s.walk.drinking) blend(P, { shLx: -1.3, shLz: 0.42, elL: -2.05, headX: -0.2 }, envelope(s.walk.drinking, 0.3));
    P.headX = 0.05;
    return P;
  }

  if (s.status === "working") {
    typing(P, ph, m);
    const a = s.work;
    if (a && WORK[a.kind]) WORK[a.kind](P, prog(a), ph, m);
  } else if (s.status === "waiting") {
    // Ждёт решения: смотрит на вас, постукивает пальцами, время от времени машет.
    P.torsoX = 0.02;
    P.elR = -0.8 + Math.abs(Math.sin(ph * 9)) * 0.22 * m;
    P.shRx = -0.6;
    const cyc = (t + s.ph) % 4.5;
    if (cyc < 1.4) wave(P, cyc / 1.4, ph, m);
  } else if (s.status === "error") {
    // Ошибка: схватился за голову, качает головой.
    const cyc = (t + s.ph) % 5;
    P.torsoX = 0.2;
    P.headX = 0.35;
    if (cyc < 2.2) {
      blend(P, { shLx: -2.45, shLz: 0.35, elL: -1.55, shRx: -2.45, shRz: -0.35, elR: -1.55, headY: Math.sin(ph * 7) * 0.25 * m, headX: 0.15, mouth: 0.4 }, envelope(cyc / 2.2, 0.2));
    }
  } else {
    // Свободен: дышит, иногда что-то делает.
    P.headY = Math.sin(ph * 0.45) * 0.18 * m;
    const a = s.action;
    if (a && IDLE[a.kind]) IDLE[a.kind](P, prog(a), ph, m);
  }

  if (s.saying) {
    // Говорит на планёрке: рот, жест рукой, кивки.
    P.mouth = Math.max(0, Math.sin(ph * 13)) * 0.8 * m;
    P.smile = 0.4;
    P.headX = Math.sin(ph * 3) * 0.06;
    blend(P, { shRx: -1.3 + Math.sin(ph * 2.3) * 0.25 * m, shRz: 0.35, elR: -1.1 + Math.sin(ph * 3.1) * 0.3 * m }, 1);
  }
  if (s.wave) wave(P, s.wave, ph, m);
  if (s.throwing) {
    // Бросает лист: замах назад и бросок вперёд.
    const u = s.throwing;
    const swing = u < 0.45 ? mix(-0.6, -2.7, u / 0.45) : mix(-2.7, -1.2, (u - 0.45) / 0.55);
    blend(P, { shRx: swing, shRz: 0.25, elR: u < 0.45 ? -1.4 : -0.2, torsoY: u < 0.45 ? -0.2 : 0.15, smile: 0.5 }, envelope(u, 0.15));
  }
  if (s.cheer) {
    // Готово: подпрыгивает на кресле, руки вверх, улыбка.
    const u = s.cheer;
    blend(P, {
      shLx: -2.95 + Math.sin(ph * 12) * 0.12 * m, shLz: -0.35, elL: -0.2,
      shRx: -2.95 + Math.sin(ph * 12 + 1) * 0.12 * m, shRz: 0.35, elR: -0.2,
      headX: -0.2, torsoX: -0.08, lift: Math.abs(Math.sin(ph * 9)) * 0.09 * m, smile: 1, mouth: 0.5,
    }, envelope(u, 0.15));
  }
  // Смотрит на камеру (на вас), когда на него навели или он ждёт решения.
  if (s.look) {
    const k = s.look.weight ?? 1;
    P.headY = mix(P.headY, clamp(s.look.yaw, -1.05, 1.05), k);
    P.headX = mix(P.headX, clamp(s.look.pitch, -0.45, 0.25), k);
    P.pupX = mix(P.pupX, clamp((s.look.yaw - P.headY) * 1.5, -1, 1), k);
    P.pupY = mix(P.pupY, 0.5, k);
  }
  return P;
}

/** Машет правой рукой: u 0..1 — ход жеста. */
function wave(P, u, ph, m) {
  blend(P, { shRx: -2.65, shRz: 0.45 + Math.sin(ph * 13) * 0.32 * m, elR: -0.45, smile: 0.8, headZ: -0.06 }, envelope(u, 0.2));
}

/** Подвести текущую позу к целевой. a = 1 − e^(−k·dt). */
export function damp(cur, tgt, a) {
  for (const k of POSE_KEYS) cur[k] += (tgt[k] - cur[k]) * a;
  return cur;
}

/** Повернуть угол a к b по кратчайшей дуге на долю k. */
export function turnTo(a, b, k) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Маршрут к кухне и обратно (координаты относительно стола; лицо сидящего — +z).
 * Первый ряд выходит в проход перед стеклом директора, второй — в проход между рядами,
 * дальше вдоль правой стены к кулеру или кофемашине.
 */
export function kitchenRoute(root, rand) {
  const aisle = root.z < 1.5 ? -2.7 : 1.25;
  const dest = rand() < 0.5 ? [7.9, -9.95] : [9.3, -10.1];
  const pts = [
    [root.x, root.z - 1.65],
    [root.x, aisle],
    [8.6, aisle],
    [8.6, -9.3],
    dest,
  ];
  return pts.map(([x, z]) => ({ x: x - root.x, z: z - root.z }));
}
