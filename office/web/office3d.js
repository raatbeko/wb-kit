/**
 * 3D-офис на three.js. Всё нарисовано кодом из простых фигур — без скачанных
 * моделей (нет вопросов с лицензиями, ничего не грузится из интернета).
 *
 * Что знает остальной код (app.js):
 *   setAgent(id, status, activity) — статус сотрудника (печатает / «!» / красная лампа);
 *   setMonitor(id, { headline, stats, status }) — что на его мониторе;
 *   setWall({ title, kpis, weekly, urgent, fresh, waiting }) — большой экран на стене;
 *   select(id), addPaper(id), handoff(from, to), celebrate(id), setActive(on).
 * Персонажа потом можно заменить на GLB-модель — интерфейс не изменится.
 * Позы и действия сотрудников (печатает, пьёт кофе, машет, идёт к кулеру) — в anim.js.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { damp, kitchenRoute, pickIdle, pickWork, seated, targetPose, turnTo } from "./anim.js";

/** Где сидит каждый сотрудник, как выглядит и какие вещи у него на столе. */
export const LAYOUT = {
  director: { x: 0, z: -5.6, shirt: 0x3b2f63, hair: 0x2b1d14, acc: "tie", big: true, props: "director" },
  finance: { x: -6, z: -0.6, shirt: 0x1f7a5a, hair: 0x5a3a22, acc: "glasses", props: "finance" },
  analyst: { x: -2, z: -0.6, shirt: 0x2f6fb5, hair: 0x1d1d1d, acc: "glasses", props: "analyst" },
  scout: { x: 2, z: -0.6, shirt: 0x8a5a2b, hair: 0xb8862f, acc: "cap", props: "scout" },
  reports: { x: 6, z: -0.6, shirt: 0x6d6d78, hair: 0x3a2a1e, acc: "none", props: "reports" },
  reviews: { x: -6, z: 3.6, shirt: 0xc2477a, hair: 0x7a3b1d, acc: "headset", props: "reviews" },
  logist: { x: -2, z: 3.6, shirt: 0xd17a22, hair: 0x2b2b2b, acc: "cap", props: "logist" },
  marketer: { x: 2, z: 3.6, shirt: 0x7b2fbe, hair: 0xe0b060, acc: "headset", props: "marketer" },
  content: { x: 6, z: 3.6, shirt: 0x2aa3a3, hair: 0x402018, acc: "beret", props: "content" },
};

const SKIN = [0xf1c9a5, 0xe0ac84, 0xc68e63, 0xf3d2b8];
const ACCENT = 0x7b2fbe;

/* ---------- Кирпичики ---------- */

const matCache = new Map();
function mat(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.04, ...opts }));
  return matCache.get(key);
}
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
function box(w, h, d, color, opts, { cast = true } = {}) {
  const m = new THREE.Mesh(boxGeo, mat(color, opts));
  m.scale.set(w, h, d);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, color, seg = 16, opts) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(color, opts));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function at(obj, x, y, z, ry = 0) {
  obj.position.set(x, y, z);
  obj.rotation.y = ry;
  return obj;
}

function canvasTex(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { canvas: c, tex: t };
}

/** Перенос текста по словам на canvas; возвращает высоту. */
function wrap(c, text, x, y, maxW, lineH, maxLines) {
  const words = String(text ?? "").split(/\s+/);
  let line = "";
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (c.measureText(test).width > maxW && line) {
      n++;
      if (n >= maxLines) {
        c.fillText(line.replace(/.$/, "…"), x, y);
        return n * lineH;
      }
      c.fillText(line, x, y);
      y += lineH;
      line = words[i];
    } else line = test;
  }
  if (line) {
    c.fillText(line, x, y);
    n++;
  }
  return n * lineH;
}

export function formatKpi(k) {
  if (k.value === null || k.value === undefined) return "—";
  const n = k.unit === "%" || k.unit === "★" ? k.value : Math.round(k.value);
  const s = typeof n === "number" ? n.toLocaleString("ru-RU") : String(n);
  return k.unit === "₽" ? `${s} ₽` : k.unit === "%" ? `${s}%` : k.unit === "★" ? `${s}★` : k.unit === "шт" ? `${s} шт` : s;
}

export function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/* ---------- Мебель и вещи ---------- */

function makeChair() {
  const g = new THREE.Group();
  const seat = box(0.6, 0.08, 0.58, 0x2f2f37);
  seat.position.y = 0.5;
  const back = box(0.58, 0.62, 0.07, 0x2f2f37);
  back.position.set(0, 0.86, -0.3);
  const post = cyl(0.03, 0.03, 0.38, 0x1f1f24, 8);
  post.position.y = 0.27;
  g.add(seat, back, post);
  // Крестовина на колёсиках.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = box(0.32, 0.03, 0.05, 0x1f1f24);
    leg.position.set(Math.cos(a) * 0.16, 0.07, Math.sin(a) * 0.16);
    leg.rotation.y = -a;
    const wheel = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), mat(0x111114));
    wheel.position.set(Math.cos(a) * 0.3, 0.04, Math.sin(a) * 0.3);
    g.add(leg, wheel);
  }
  for (const sx of [-1, 1]) {
    const arm = box(0.05, 0.05, 0.38, 0x1f1f24);
    arm.position.set(sx * 0.32, 0.7, -0.02);
    g.add(arm);
  }
  return g;
}

/** Стол с монитором (экран — canvas с данными сотрудника), клавиатурой, лампой статуса. */
function makeDesk(big) {
  const g = new THREE.Group();
  const w = big ? 3 : 2.2;
  const top = box(w, 0.07, 1.1, 0xc9a477);
  top.position.y = 0.78;
  g.add(top);
  const panel = box(w - 0.1, 0.5, 0.04, 0xb08d60);
  panel.position.set(0, 0.5, 0.5);
  g.add(panel);
  for (const sx of [-1, 1]) {
    const side = box(0.06, 0.75, 1.0, 0xb08d60);
    side.position.set(sx * (w / 2 - 0.05), 0.375, 0);
    g.add(side);
  }
  // Монитор: экран смотрит на сотрудника (−z).
  const { canvas, tex } = canvasTex(320, 200, (c, W, H) => {
    c.fillStyle = "#1b2330";
    c.fillRect(0, 0, W, H);
  });
  const monitor = new THREE.Group();
  const frame = box(1.02, 0.66, 0.05, 0x1d1d22);
  frame.position.y = 0.33;
  const screenMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.58), screenMat);
  screen.position.set(0, 0.33, -0.03);
  screen.rotation.y = Math.PI;
  const stand = box(0.08, 0.18, 0.08, 0x1d1d22);
  stand.position.y = -0.06;
  const foot = box(0.32, 0.02, 0.2, 0x1d1d22);
  foot.position.y = -0.14;
  monitor.add(frame, screen, stand, foot);
  monitor.position.set(0, 0.95, 0.18);
  g.add(monitor);
  const kb = box(0.62, 0.025, 0.2, 0x34343c);
  kb.position.set(0, 0.825, -0.22);
  const mouse = box(0.07, 0.03, 0.11, 0x34343c);
  mouse.position.set(0.48, 0.825, -0.22);
  const mug = cyl(0.05, 0.045, 0.11, ACCENT, 12);
  mug.position.set(-(w / 2 - 0.3), 0.87, -0.25);
  g.add(kb, mouse, mug);
  // Лампа статуса (зелёная — работает, красная — ошибка).
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0x000000 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), lampMat);
  lamp.position.set(w / 2 - 0.22, 0.88, 0.32);
  g.add(lamp);
  // Стопка готовых отчётов — растёт, когда приходят отчёты.
  const papers = box(0.34, 0.02, 0.44, 0xf7f3ea);
  papers.position.set(-(w / 2 - 0.32), 0.83, 0.18);
  papers.visible = false;
  g.add(papers);
  const chair = makeChair();
  chair.position.z = -0.95;
  g.add(chair);
  return { group: g, screenMat, canvas, tex, lampMat, papers, mug, width: w };
}

/** Личные вещи по роли — сразу видно, кто чем занят. */
function addProps(desk, kind, w) {
  const g = desk.group;
  const right = w / 2 - 0.35;
  if (kind === "logist") {
    // Коробки WB у стола.
    for (const [x, y, z, s] of [[w / 2 + 0.35, 0.22, 0.1, 0.44], [w / 2 + 0.35, 0.62, 0.1, 0.36], [w / 2 + 0.8, 0.2, -0.2, 0.4]]) {
      const b = box(s, s, s, 0xc9a06a);
      b.position.set(x, y, z);
      const tape = box(s + 0.005, 0.06, s + 0.005, ACCENT);
      tape.position.set(x, y, z);
      g.add(b, tape);
    }
  } else if (kind === "finance") {
    const calc = box(0.2, 0.03, 0.28, 0x2c3e50);
    calc.position.set(right, 0.83, -0.2);
    const keys = box(0.16, 0.005, 0.16, 0x95a5a6);
    keys.position.set(right, 0.85, -0.24);
    const coins = cyl(0.06, 0.06, 0.08, 0xd4ac0d, 14, { metalness: 0.6, roughness: 0.35 });
    coins.position.set(right - 0.05, 0.86, 0.05);
    g.add(calc, keys, coins);
  } else if (kind === "analyst") {
    // Второй монитор с графиком.
    const { tex } = canvasTex(160, 100, (c, W, H) => {
      c.fillStyle = "#14202c";
      c.fillRect(0, 0, W, H);
      c.strokeStyle = "#57c486";
      c.lineWidth = 4;
      c.beginPath();
      [70, 62, 66, 48, 52, 36, 30, 22].forEach((y, i) => (i ? c.lineTo(10 + i * 20, y) : c.moveTo(10, y)));
      c.stroke();
    });
    const m2 = new THREE.Group();
    const fr = box(0.62, 0.42, 0.04, 0x1d1d22);
    const sc = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.36), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    sc.position.z = -0.025;
    sc.rotation.y = Math.PI;
    m2.add(fr, sc);
    m2.position.set(-0.75, 1.2, 0.12);
    m2.rotation.y = 0.35;
    g.add(m2);
  } else if (kind === "reviews") {
    // Звёзды отзывов на подставке.
    for (let i = 0; i < 3; i++) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), mat(0xf1c40f, { emissive: 0x6a5200, emissiveIntensity: 0.4 }));
      star.position.set(right - i * 0.13, 0.9, 0.05);
      g.add(star);
    }
  } else if (kind === "marketer") {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 14, 1, true), mat(0xe74c3c, { side: THREE.DoubleSide }));
    horn.rotation.z = Math.PI / 2;
    horn.position.set(right, 0.92, 0.05);
    g.add(horn);
  } else if (kind === "content") {
    // Софтбокс и фотофон.
    const pole = cyl(0.015, 0.015, 1.6, 0x222222, 8);
    pole.position.set(w / 2 + 0.45, 0.8, 0.3);
    const soft = box(0.5, 0.5, 0.06, 0xffffff, { emissive: 0xfff3d6, emissiveIntensity: 0.9 });
    soft.position.set(w / 2 + 0.45, 1.65, 0.3);
    soft.rotation.y = -0.6;
    const cam = box(0.16, 0.11, 0.1, 0x111111);
    cam.position.set(right, 0.88, 0.0);
    g.add(pole, soft, cam);
  } else if (kind === "scout") {
    for (const sx of [-0.045, 0.045]) {
      const tube = cyl(0.035, 0.035, 0.16, 0x2d3436, 10);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(right + sx, 0.87, -0.05);
      g.add(tube);
    }
    const map = box(0.4, 0.01, 0.3, 0xa3d9a5);
    map.position.set(right - 0.15, 0.82, 0.25);
    g.add(map);
  } else if (kind === "reports") {
    ["#c0392b", "#2980b9", "#27ae60", "#f39c12"].forEach((col, i) => {
      const b = box(0.07, 0.3, 0.24, new THREE.Color(col).getHex());
      b.position.set(right - i * 0.08, 0.96, 0.25);
      g.add(b);
    });
  } else if (kind === "director") {
    const plate = box(0.5, 0.1, 0.06, 0x2c2c34);
    plate.position.set(0.9, 0.86, -0.4);
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 14), mat(0x3d8bd4, { roughness: 0.4 }));
    globe.position.set(-1.1, 1.0, 0.2);
    const gstand = cyl(0.02, 0.06, 0.12, 0x8c6d4a, 10);
    gstand.position.set(-1.1, 0.86, 0.2);
    g.add(plate, globe, gstand);
  }
}

/**
 * Сотрудник со скелетом: корпус (наклон), голова (глаза моргают, зрачки смотрят,
 * рот говорит и улыбается), руки с локтями, ноги с коленями — может встать и пройтись.
 * Углы суставов задаёт anim.js, здесь только «кости» и меши.
 */
function makePerson(look, seed) {
  const p = new THREE.Group();
  const skin = SKIN[seed % SKIN.length];
  const pants = 0x34495e;
  // Ноги: бедро от тазобедренного сустава, голень от колена.
  const legs = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.13, 0.62, 0.02);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.3, 4, 8), mat(pants));
    thigh.position.y = -0.2;
    thigh.castShadow = true;
    const knee = new THREE.Group();
    knee.position.y = -0.42;
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.34, 4, 8), mat(pants));
    shin.position.y = -0.26;
    shin.castShadow = true;
    const shoe = box(0.14, 0.08, 0.24, 0x1c1c1c);
    shoe.position.set(0, -0.52, 0.05);
    knee.add(shin, shoe);
    hip.add(thigh, knee);
    p.add(hip);
    legs.push({ hip, knee });
  }
  // Всё выше пояса — в корпусе: наклоняется и поворачивается целиком.
  const torso = new THREE.Group();
  torso.position.y = 0.62;
  p.add(torso);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.45, 6, 16), mat(look.shirt));
  body.position.y = 0.4;
  body.castShadow = true;
  torso.add(body);
  const headPivot = new THREE.Group();
  headPivot.position.y = 0.93;
  torso.add(headPivot);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 18), mat(skin));
  head.position.y = 0.12;
  head.castShadow = true;
  headPivot.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.275, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(look.hair));
  hair.position.y = 0.14;
  hair.rotation.x = -0.25;
  headPivot.add(hair);
  const eyes = [];
  const pupils = [];
  for (const sx of [-1, 1]) {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), mat(0xffffff));
    white.position.set(sx * 0.09, 0.16, 0.225);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.027, 10, 8), mat(0x1a1a1a));
    pupil.position.set(sx * 0.09, 0.16, 0.266);
    pupil.userData.x0 = sx * 0.09;
    headPivot.add(white, pupil);
    eyes.push(white, pupil);
    pupils.push(pupil);
  }
  // Брови — поднимаются, когда сотрудник радуется или ждёт.
  const brows = [];
  for (const sx of [-1, 1]) {
    const brow = box(0.08, 0.018, 0.02, look.hair);
    brow.position.set(sx * 0.09, 0.235, 0.24);
    brow.rotation.z = sx * -0.12;
    headPivot.add(brow);
    brows.push(brow);
  }
  const mouth = box(0.09, 0.015, 0.02, 0x8e4a3a);
  mouth.position.set(0, 0.04, 0.25);
  headPivot.add(mouth);
  // Руки: плечо → локоть → кисть.
  const arms = [];
  const elbows = [];
  const hands = [];
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * 0.33, 0.66, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.078, 0.2, 4, 8), mat(look.shirt));
    upper.position.y = -0.14;
    upper.castShadow = true;
    const elbow = new THREE.Group();
    elbow.position.y = -0.28;
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.18, 4, 8), mat(look.shirt));
    fore.position.y = -0.13;
    fore.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), mat(skin));
    hand.position.y = -0.3;
    elbow.add(fore, hand);
    shoulder.add(upper, elbow);
    torso.add(shoulder);
    arms.push(shoulder);
    elbows.push(elbow);
    hands.push(hand);
  }
  // Кружка в левой руке (кофе за столом и у кулера) и телефон в правой.
  const cup = cyl(0.05, 0.045, 0.11, ACCENT, 12);
  cup.position.set(0.04, -0.33, 0.06);
  cup.visible = false;
  elbows[0].add(cup);
  const phone = box(0.09, 0.015, 0.16, 0x15151a);
  phone.position.set(-0.03, -0.36, 0.05);
  phone.rotation.x = 0.4;
  phone.visible = false;
  elbows[1].add(phone);

  const acc = look.acc;
  if (acc === "tie") {
    const tie = box(0.09, 0.35, 0.02, 0xc0392b);
    tie.position.set(0, 0.56, 0.29);
    torso.add(tie);
  } else if (acc === "glasses") {
    for (const sx of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.012, 6, 16), mat(0x111111));
      lens.position.set(sx * 0.09, 0.16, 0.27);
      headPivot.add(lens);
    }
  } else if (acc === "cap") {
    const cap = cyl(0.27, 0.28, 0.12, look.shirt, 20);
    cap.position.y = 0.32;
    const visor = box(0.3, 0.03, 0.2, look.shirt);
    visor.position.set(0, 0.28, 0.26);
    headPivot.add(cap, visor);
  } else if (acc === "headset") {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 6, 24, Math.PI), mat(0x222222));
    band.position.y = 0.14;
    headPivot.add(band);
    const mic = box(0.03, 0.03, 0.2, 0x222222);
    mic.position.set(0.22, 0.02, 0.15);
    headPivot.add(mic);
  } else if (acc === "beret") {
    const beret = cyl(0.3, 0.3, 0.07, 0xb03050, 20);
    beret.position.set(0.04, 0.36, 0);
    beret.rotation.z = 0.2;
    headPivot.add(beret);
  }
  return { group: p, torso, body, headPivot, arms, elbows, hands, legs, eyes, pupils, brows, mouth, cup, phone, headset: acc === "headset" };
}

/* ---------- Сцена ---------- */

export class Office3D {
  constructor(container, agents, { onSelect, onHover, onWall } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onWall = onWall;
    this.people = new Map();
    this.flights = [];
    this.timer = new THREE.Timer();
    this.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.wallData = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    // На слабом ноутбуке 2× пикселей — лишняя нагрузка; 1.5 выглядит так же.
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    container.appendChild(labels.domElement);
    this.labels = labels;

    this.tip = document.createElement("div");
    this.tip.className = "hover-tip";
    this.tip.hidden = true;
    container.appendChild(this.tip);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe8dfd2);
    scene.fog = new THREE.Fog(0xe8dfd2, 34, 70);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    camera.position.set(12, 13.5, 17.5);
    this.camera = camera;
    this.home = { pos: camera.position.clone(), target: new THREE.Vector3(0, 0.6, -0.6) };

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(this.home.target);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.44;
    controls.minDistance = 5;
    controls.maxDistance = 40;
    this.controls = controls;
    controls.addEventListener("start", () => {
      this.fly = null;
      this.stopTour();
    });
    controls.addEventListener("change", () => (this.movedAt = performance.now()));

    // Свет: мягкое небо + тёплое низкое солнце из окна (слева) + немного заполняющего.
    scene.add(new THREE.HemisphereLight(0xfff4e6, 0x8a7560, 1.05));
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.3);
    sun.position.set(-16, 13, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 13, bottom: -13, near: 1, far: 55 });
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.45);
    fill.position.set(12, 8, 14);
    scene.add(fill);
    // Свет над выбранным столом.
    this.spot = new THREE.PointLight(0xfff0d0, 0, 6, 1.6);
    scene.add(this.spot);

    this.buildRoom();
    agents.forEach((a, i) => this.addPerson(a, i));

    // Кольцо под сотрудником при наведении/выборе.
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 40), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);

    this.bindPointer();
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(container);
    this.resize();
    this.active = false;
    this.setActive(true);
  }

  buildRoom() {
    const s = this.scene;
    const statics = [];
    const add = (...objs) => {
      for (const o of objs) {
        s.add(o);
        statics.push(o);
      }
    };

    // Пол — доски (canvas-текстура), ковёр под рабочей зоной.
    const { tex: floorTex } = canvasTex(512, 512, (c, W, H) => {
      c.fillStyle = "#cdb593";
      c.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 32) {
        for (let x = (y / 32) % 2 ? -64 : 0; x < W; x += 128) {
          const v = 190 + ((x * 7 + y * 13) % 23) - 11;
          c.fillStyle = `rgb(${v + 15},${v - 5},${v - 40})`;
          c.fillRect(x + 1, y + 1, 126, 30);
        }
      }
    });
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(6, 5);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(28, 22), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -0.5;
    floor.receiveShadow = true;
    add(floor);
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(17.5, 9.2), mat(0x9c8a72, { roughness: 1 }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.006, 1.5);
    rug.receiveShadow = true;
    const rugEdge = new THREE.Mesh(new THREE.PlaneGeometry(18, 9.7), mat(0x7b6a55, { roughness: 1 }));
    rugEdge.rotation.x = -Math.PI / 2;
    rugEdge.position.set(0, 0.004, 1.5);
    rugEdge.receiveShadow = true;
    add(rugEdge, rug);

    // Стены, плинтусы.
    const back = box(28, 4.4, 0.2, 0xf1ebe1, {}, { cast: false });
    back.position.set(0, 2.2, -11.5);
    const left = box(0.2, 4.4, 22, 0xebe3d6, {}, { cast: false });
    left.position.set(-14, 2.2, -0.5);
    const bb1 = box(28, 0.14, 0.05, 0x8c6d4a);
    bb1.position.set(0, 0.07, -11.38);
    const bb2 = box(0.05, 0.14, 22, 0x8c6d4a);
    bb2.position.set(-13.88, 0.07, -0.5);
    add(back, left, bb1, bb2);

    // Акцентная стена за директором: фиолетовая панель, вывеска и большой экран.
    const accent = box(10, 3.6, 0.06, ACCENT, { roughness: 0.9 }, { cast: false });
    accent.position.set(0, 2.2, -11.36);
    add(accent);
    const { tex: signTex } = canvasTex(512, 96, (c, W, H) => {
      c.clearRect(0, 0, W, H);
      c.fillStyle = "#ffffff";
      c.font = "700 64px system-ui, sans-serif";
      c.textAlign = "center";
      c.fillText("WB ОФИС", W / 2, 70);
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.48), new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false }));
    sign.position.set(0, 3.68, -11.32);
    add(sign);
    const wall = canvasTex(1024, 512, () => {});
    this.wall = wall;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 2.8), new THREE.MeshBasicMaterial({ map: wall.tex, toneMapped: false }));
    screen.position.set(0, 1.95, -11.3);
    screen.userData.wall = true;
    const screenFrame = box(5.8, 3.0, 0.06, 0x16161b);
    screenFrame.position.set(0, 1.95, -11.33);
    add(screenFrame, screen);
    this.wallScreen = screen;
    this.drawWall();

    // Окно на левой стене: небо, рама, переплёт, подоконник, солнечное пятно на полу.
    const { tex: skyTex } = canvasTex(256, 128, (c, W, H) => {
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#8fc3ea");
      g.addColorStop(1, "#f6e3c4");
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      c.fillStyle = "rgba(90,110,130,.55)";
      [[10, 80, 30, 48], [44, 64, 26, 64], [74, 90, 40, 38], [118, 70, 22, 58], [144, 86, 36, 42], [184, 60, 30, 68], [218, 84, 34, 44]].forEach(([x, y, w, h]) => c.fillRect(x, y, w, h));
    });
    for (const z of [-5.5, 2.5]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.2), new THREE.MeshBasicMaterial({ map: skyTex, toneMapped: false }));
      win.position.set(-13.88, 2.3, z);
      win.rotation.y = Math.PI / 2;
      add(win);
      const fr = [box(0.12, 2.4, 0.12, 0xffffff), box(0.12, 2.4, 0.12, 0xffffff), box(0.12, 0.12, 5.2, 0xffffff), box(0.12, 0.12, 5.2, 0xffffff), box(0.08, 2.2, 0.06, 0xffffff), box(0.08, 0.06, 5, 0xffffff)];
      fr[0].position.set(-13.84, 2.3, z - 2.55);
      fr[1].position.set(-13.84, 2.3, z + 2.55);
      fr[2].position.set(-13.84, 3.45, z);
      fr[3].position.set(-13.84, 1.15, z);
      fr[4].position.set(-13.84, 2.3, z);
      fr[5].position.set(-13.84, 2.3, z);
      const sill = box(0.35, 0.06, 5.4, 0xf5f0e8);
      sill.position.set(-13.7, 1.1, z);
      add(...fr, sill);
      const patch = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 3.2), new THREE.MeshBasicMaterial({ color: 0xffe9c2, transparent: true, opacity: 0.18, depthWrite: false }));
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(-11.3, 0.012, z + 0.4);
      add(patch);
    }

    // Кабинет директора — стеклянная перегородка с тонкой рамой.
    const glass = new THREE.Mesh(new THREE.BoxGeometry(9, 2.3, 0.04), new THREE.MeshStandardMaterial({ color: 0xcfe3ef, transparent: true, opacity: 0.22, roughness: 0.05 }));
    glass.position.set(0, 1.15, -3.5);
    const gtop = box(9.1, 0.06, 0.08, 0x2c2c34);
    gtop.position.set(0, 2.32, -3.5);
    add(glass, gtop);

    // Левый дальний угол: стеллаж с папками и пробковая доска со стикерами.
    const shelf = new THREE.Group();
    const frame = box(2.4, 2.6, 0.5, 0x8c6d4a);
    frame.position.y = 1.3;
    shelf.add(frame);
    const binderColors = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, ACCENT, 0x16a085, 0xd35400];
    for (let r = 0; r < 4; r++) {
      const plank = box(2.3, 0.04, 0.46, 0xa58560);
      plank.position.set(0, 0.25 + r * 0.6, 0.03);
      shelf.add(plank);
      for (let i = 0; i < 9; i++) {
        if ((i * 7 + r * 3) % 5 === 0) continue;
        const b = box(0.16, 0.42 + ((i + r) % 3) * 0.04, 0.34, binderColors[(i + r * 2) % binderColors.length]);
        b.position.set(-1.0 + i * 0.24, 0.5 + r * 0.6, 0.06);
        shelf.add(b);
      }
    }
    shelf.position.set(-11.2, 0, -10.9);
    add(shelf);
    const cork = box(2.4, 1.5, 0.05, 0xc49a6c, {}, { cast: false });
    cork.position.set(-7.6, 2.3, -11.37);
    add(cork);
    [0xfff176, 0x81d4fa, 0xa5d6a7, 0xf48fb1, 0xffcc80, 0xfff176, 0xce93d8].forEach((col, i) => {
      const note = box(0.32, 0.32, 0.01, col, {}, { cast: false });
      note.position.set(-8.5 + (i % 4) * 0.6, 2.65 - Math.floor(i / 4) * 0.55, -11.33);
      note.rotation.z = ((i * 37) % 11) / 60 - 0.08;
      add(note);
    });

    // Правый дальний угол: кухня — стойка, кофемашина, кулер, холодильник.
    const counter = box(3.4, 0.95, 0.75, 0xe9e3d8);
    counter.position.set(10.2, 0.475, -10.9);
    const ctop = box(3.5, 0.05, 0.8, 0x4a4a52);
    ctop.position.set(10.2, 0.97, -10.9);
    const coffee = box(0.42, 0.55, 0.38, 0x2d2d33);
    coffee.position.set(9.3, 1.27, -10.95);
    const cup = cyl(0.05, 0.045, 0.1, 0xffffff, 12);
    cup.position.set(9.3, 1.05, -10.72);
    const fridge = box(0.9, 2.1, 0.8, 0xdfe4ea);
    fridge.position.set(12.4, 1.05, -10.9);
    const cooler = new THREE.Group();
    const cbase = box(0.45, 1.0, 0.45, 0xf0f0f0);
    cbase.position.y = 0.5;
    const bottle = cyl(0.17, 0.2, 0.5, 0x7fc8f8, 16, { transparent: true, opacity: 0.75, roughness: 0.1 });
    bottle.position.y = 1.25;
    cooler.add(cbase, bottle);
    cooler.position.set(7.9, 0, -10.8);
    add(counter, ctop, coffee, cup, fridge, cooler);

    // Ближний правый угол: диванная зона.
    const lounge = new THREE.Group();
    const seat = box(2.6, 0.42, 0.95, 0x5d6d7e);
    seat.position.y = 0.33;
    const sback = box(2.6, 0.7, 0.25, 0x5d6d7e);
    sback.position.set(0, 0.75, -0.38);
    const arm1 = box(0.25, 0.6, 0.95, 0x4f5d6b);
    arm1.position.set(-1.3, 0.45, 0);
    const arm2 = arm1.clone();
    arm2.position.x = 1.3;
    const pillow = box(0.5, 0.4, 0.15, 0xf5b041);
    pillow.position.set(-0.8, 0.72, -0.2);
    pillow.rotation.z = 0.15;
    lounge.add(seat, sback, arm1, arm2, pillow);
    lounge.position.set(10.2, 0, 7.4);
    lounge.rotation.y = -Math.PI / 2 + 0.3;
    const table = cyl(0.55, 0.55, 0.06, 0xc9a477, 24);
    table.position.set(8.6, 0.42, 6.9);
    const tleg = cyl(0.05, 0.05, 0.4, 0x8c6d4a, 8);
    tleg.position.set(8.6, 0.2, 6.9);
    const mag = box(0.4, 0.02, 0.3, 0xe74c3c);
    mag.position.set(8.5, 0.46, 6.85);
    mag.rotation.y = 0.4;
    const rugRound = new THREE.Mesh(new THREE.CircleGeometry(2.2, 40), mat(0xd7c4a3, { roughness: 1 }));
    rugRound.rotation.x = -Math.PI / 2;
    rugRound.position.set(9.3, 0.008, 7.1);
    rugRound.receiveShadow = true;
    add(lounge, table, tleg, mag, rugRound);

    // Растения.
    for (const [x, z, sc] of [[-12.6, -9.4, 1.2], [6.6, -10.9, 0.9], [-12.6, 8.2, 1.1], [12.4, 4.2, 1.0], [-4.6, -10.9, 0.8]]) {
      const pot = cyl(0.32 * sc, 0.25 * sc, 0.55 * sc, 0xb5651d, 16);
      pot.position.set(x, 0.275 * sc, z);
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.65 * sc, 1), mat(0x4f8a4b, { flatShading: true }));
      leaves.position.set(x, 0.55 * sc + 0.55 * sc, z);
      leaves.castShadow = true;
      add(pot, leaves);
    }

    // Подвесных ламп нет намеренно: при виде сверху они закрывали сотрудников.
    // Настенные бра у окон дают тот же уют и ничего не загораживают.
    for (const z of [-8.6, -1.5, 5.4]) {
      const sconce = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xfff1cf }));
      sconce.rotation.z = Math.PI / 2;
      sconce.position.set(-13.86, 3.2, z);
      add(sconce);
    }

    // Часы на стене — настоящее время.
    const clock = new THREE.Group();
    const face = cyl(0.42, 0.42, 0.05, 0xffffff, 32);
    face.rotation.x = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 8, 32), mat(0x2c2c34));
    clock.add(face, rim);
    const hand = (len, w, col) => {
      const pivot = new THREE.Group();
      const m = box(w, len, 0.02, col, {}, { cast: false });
      m.position.y = len / 2;
      pivot.add(m);
      pivot.position.z = 0.04;
      clock.add(pivot);
      return pivot;
    };
    this.clockH = hand(0.22, 0.05, 0x1d1d22);
    this.clockM = hand(0.33, 0.035, 0x1d1d22);
    clock.position.set(-3.9, 3.2, -11.32);
    s.add(clock);

    // Статике не нужно пересчитывать матрицы каждый кадр.
    for (const o of statics) {
      o.updateMatrixWorld(true);
      o.traverse((c) => (c.matrixAutoUpdate = false));
    }
  }

  addPerson(agent, i) {
    const look = LAYOUT[agent.id] ?? { x: (i % 4) * 4 - 6, z: 7.5, shirt: 0x777777, hair: 0x333333, acc: "none" };
    const root = new THREE.Group();
    root.position.set(look.x, 0, look.z);
    root.userData.agentId = agent.id;
    const desk = makeDesk(look.big);
    addProps(desk, look.props, desk.width);
    root.add(desk.group);
    const person = makePerson(look, i);
    person.group.position.set(0, -0.05, -0.95);
    root.add(person.group);
    this.scene.add(root);

    const nameEl = document.createElement("div");
    nameEl.className = "label";
    nameEl.textContent = agent.name;
    const name = new CSS2DObject(nameEl);
    name.position.set(0, 0.05, -1.65);
    root.add(name);

    const bubbleEl = document.createElement("div");
    bubbleEl.className = "bubble";
    bubbleEl.hidden = true;
    const bubble = new CSS2DObject(bubbleEl);
    bubble.position.set(0, 2.45, -0.95);
    root.add(bubble);

    const bang = new THREE.Group();
    const bar = box(0.12, 0.42, 0.12, 0xf0a72a, { emissive: 0xf0a72a, emissiveIntensity: 0.6 });
    bar.position.y = 0.3;
    const dot = box(0.12, 0.12, 0.12, 0xf0a72a, { emissive: 0xf0a72a, emissiveIntensity: 0.6 });
    bang.add(bar, dot);
    bang.position.set(0, 2.15, -0.95);
    bang.visible = false;
    root.add(bang);

    const p = {
      id: agent.id, root, desk, person, nameEl, bubbleEl, bang, status: "idle", phase: i * 1.7, papers: 0,
      monitor: { name: agent.name, headline: null, stats: [], status: "idle" },
      blinkAt: 2 + i, cheerUntil: 0,
      // Анимация: текущая поза, где стоит (относительно стола), куда смотрит, что делает.
      pose: seated(), pos: { x: 0, z: -0.95 }, yaw: 0, stand: 0, swivel: 0,
      action: null, nextAction: 3 + i * 1.3, work: null, walk: null, waveUntil: 0, throwUntil: 0,
    };
    this.people.set(agent.id, p);
    this.setAgent(agent.id, agent.status, agent.activity);
    this.drawMonitor(p);
  }

  /* ---------- Экраны ---------- */

  /** Монитор сотрудника: шапка с именем и статусом, главный вывод, цифры; при работе — бегущие строки. */
  drawMonitor(p, t = 0) {
    const c = p.desk.canvas.getContext("2d");
    const W = 320;
    const H = 200;
    const m = p.monitor;
    const statusCol = { working: "#57c486", waiting: "#f0a72a", error: "#ef6b5b" }[m.status] ?? "#6f7a88";
    c.fillStyle = "#141b24";
    c.fillRect(0, 0, W, H);
    c.fillStyle = statusCol;
    c.fillRect(0, 0, W, 6);
    c.fillStyle = "#ffffff";
    c.font = "600 20px system-ui, sans-serif";
    c.fillText(m.name, 14, 34);
    c.fillStyle = "#9aa6b5";
    c.font = "14px system-ui, sans-serif";
    c.fillText({ working: "работает", waiting: "ждёт решения", error: "ошибка" }[m.status] ?? "на месте", W - 110, 32);
    if (m.status === "working") {
      // «Печатает»: строки кода/цифр бегут по экрану.
      c.fillStyle = "#3a5a7a";
      for (let i = 0; i < 6; i++) {
        const w = 60 + ((i * 53 + Math.floor(t * 6) * 31) % 200);
        c.fillRect(14, 56 + i * 22, w, 10);
      }
      c.fillStyle = "#57c486";
      c.fillRect(14 + ((Math.floor(t * 6) * 37) % 220), 56 + (Math.floor(t * 3) % 6) * 22, 12, 10);
    } else {
      c.fillStyle = "#e8edf3";
      c.font = "600 17px system-ui, sans-serif";
      const used = wrap(c, m.headline || "Данных пока нет", 14, 66, W - 28, 21, 3);
      c.font = "14px system-ui, sans-serif";
      let y = 66 + used + 12;
      for (const s of (m.stats ?? []).slice(0, 3)) {
        c.fillStyle = "#9aa6b5";
        c.fillText(s.label, 14, y);
        c.fillStyle = { bad: "#ef6b5b", warn: "#f0a72a", ok: "#57c486" }[s.tone] ?? "#e8edf3";
        c.font = "600 14px system-ui, sans-serif";
        c.fillText(String(s.value), 170, y);
        c.font = "14px system-ui, sans-serif";
        y += 20;
        if (y > H - 6) break;
      }
    }
    p.desk.tex.needsUpdate = true;
  }

  setMonitor(id, data) {
    const p = this.people.get(id);
    if (!p) return;
    Object.assign(p.monitor, data);
    this.drawMonitor(p, this.timer.getElapsed());
  }

  setWall(data) {
    this.wallData = data;
    this.drawWall();
  }

  /** Большой экран: заголовок, KPI, заказы по неделям, срочное, свежесть данных, сколько ждёт решений. */
  drawWall() {
    const d = this.wallData ?? { title: "Магазин", kpis: [], weekly: [], urgent: [], fresh: "", waiting: 0 };
    const c = this.wall.canvas.getContext("2d");
    const W = 1024;
    const H = 512;
    c.fillStyle = "#11141a";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "#c79cf2";
    c.font = "600 34px system-ui, sans-serif";
    c.fillText(d.title, 32, 54);
    c.fillStyle = "#8b93a1";
    c.font = "22px system-ui, sans-serif";
    c.textAlign = "right";
    c.fillText(`${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · ${d.fresh ?? ""}`, W - 32, 54);
    c.textAlign = "left";
    // KPI — четыре главных.
    (d.kpis ?? []).slice(0, 4).forEach((k, i) => {
      const x = 32 + i * 245;
      c.fillStyle = "#8b93a1";
      c.font = "20px system-ui, sans-serif";
      c.fillText(k.label, x, 104);
      c.fillStyle = "#ffffff";
      c.font = "600 34px system-ui, sans-serif";
      c.fillText(formatKpi(k), x, 144);
      if (typeof k.delta === "number") {
        c.fillStyle = k.delta >= 0 ? "#57c486" : "#ef6b5b";
        c.font = "20px system-ui, sans-serif";
        c.fillText(`${k.delta > 0 ? "+" : ""}${k.delta}%`, x, 172);
      }
    });
    // Заказы по неделям — столбики.
    const wk = (d.weekly ?? []).slice(-12);
    const cx = 32;
    const cy = 210;
    const cw = 560;
    const ch = 250;
    c.fillStyle = "#8b93a1";
    c.font = "20px system-ui, sans-serif";
    c.fillText("Заказы по неделям", cx, cy);
    if (wk.length) {
      const max = Math.max(...wk.map((w) => w.ordersSum), 1);
      const bw = cw / wk.length;
      wk.forEach((w, i) => {
        const h = Math.max(3, (w.ordersSum / max) * (ch - 40));
        c.fillStyle = i === wk.length - 1 ? "#c79cf2" : "#7b5aa6";
        c.fillRect(cx + i * bw + bw * 0.15, cy + ch - h, bw * 0.7, h);
      });
    } else {
      c.fillStyle = "#5c6470";
      c.fillText("нет данных WB", cx, cy + 60);
    }
    // Справа — срочное и решения.
    const rx = 640;
    c.fillStyle = "#ef6b5b";
    c.font = "600 22px system-ui, sans-serif";
    c.fillText(d.urgent?.length ? "Срочно" : "Срочного нет", rx, cy);
    c.fillStyle = "#e8edf3";
    c.font = "20px system-ui, sans-serif";
    let y = cy + 36;
    for (const u of (d.urgent ?? []).slice(0, 3)) {
      y += wrap(c, `• ${u}`, rx, y, W - rx - 32, 26, 2) + 8;
    }
    if (d.waiting) {
      c.fillStyle = "#f0a72a";
      c.font = "600 24px system-ui, sans-serif";
      c.fillText(`Ждут вашего решения: ${d.waiting}`, rx, H - 40);
    }
    this.wall.tex.needsUpdate = true;
  }

  /* ---------- Статусы и события ---------- */

  setAgent(id, status, activity) {
    const p = this.people.get(id);
    if (!p) return;
    p.status = status;
    p.activityText = activity;
    // Пока сотрудник «говорит» на планёрке, его облачко не перебиваем — статус применится после.
    if (p.saying) return;
    const text = status === "waiting" ? "! ждёт вашего решения" : activity;
    p.bubbleEl.textContent = text || "";
    p.bubbleEl.className = `bubble ${status}`;
    p.bubbleEl.hidden = !(status !== "idle" && text);
    p.bang.visible = status === "waiting";
    p.desk.lampMat.color.set(status === "error" ? 0xc0392b : status === "working" ? 0x2f7d4f : 0x555555);
    p.desk.lampMat.emissive.set(status === "error" ? 0x8a1a10 : status === "working" ? 0x1a5a33 : 0x000000);
    if (p.monitor.status !== status) {
      p.monitor.status = status;
      this.drawMonitor(p, this.timer.getElapsed());
    }
  }

  /** Отчёт пришёл — на столе прибавилось бумаг. */
  addPaper(id) {
    const p = this.people.get(id);
    if (!p) return;
    p.papers = Math.min(p.papers + 1, 8);
    p.desk.papers.visible = true;
    p.desk.papers.scale.y = 0.02 * p.papers * 2;
    p.desk.papers.position.y = 0.82 + p.papers * 0.02;
  }

  /** Лист с задачей летит по дуге от одного стола к другому. */
  handoff(fromId, toId) {
    const a = this.people.get(fromId);
    const b = this.people.get(toId);
    if (!a || !b || this.reduceMotion) return;
    const sheet = box(0.34, 0.01, 0.46, 0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.25 });
    const from = a.root.position.clone().add(new THREE.Vector3(0, 1.4, -0.4));
    const to = b.root.position.clone().add(new THREE.Vector3(0, 1.0, 0));
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 2.6, 0));
    this.scene.add(sheet);
    a.throwUntil = this.timer.getElapsed() + 0.7;
    this.flights.push({ obj: sheet, curve: new THREE.QuadraticBezierCurve3(from, mid, to), t: 0, dur: 1.1, done: () => this.celebrate(toId, 0.4) });
  }

  /** «Готово»: руки вверх, монитор вспыхивает зелёным. */
  celebrate(id, seconds = 1.1) {
    const p = this.people.get(id);
    if (!p) return;
    p.cheerUntil = this.timer.getElapsed() + seconds;
    p.cheerDur = seconds;
  }

  /* ---------- Анимация сотрудника ---------- */

  /** Один кадр одного сотрудника: выбрать действие, посчитать позу, подвести к ней скелет. */
  animatePerson(p, t, dt, m, slot) {
    const { person } = p;
    const ph = t + p.phase;
    const idle = p.status === "idle" && !p.saying;

    // Свободен — время от времени что-то делает: потягивается, пьёт кофе, идёт к кулеру.
    if (!idle) p.action = null;
    else if (!p.walk && !this.reduceMotion && t > p.nextAction) {
      const canWalk = slot.free && p.id !== "director" && p.id !== this.selected;
      const a = pickIdle(Math.random, { headset: person.headset, canWalk });
      if (a.kind === "walk") {
        this.startWalk(p, t);
        slot.free = false;
      } else p.action = { ...a, start: t, dir: Math.random() < 0.5 ? -1 : 1 };
      p.nextAction = t + a.dur + 2.5 + Math.random() * 5;
    }
    if (p.action && t > p.action.start + p.action.dur) p.action = null;
    // Работает — печатает, сверяется с бумагами, водит мышкой, думает.
    if (p.status === "working" && !p.walk) {
      if (!p.work || t > p.work.start + p.work.dur) p.work = { ...pickWork(Math.random, p.id), start: t };
    } else p.work = null;

    const walk = p.walk ? this.stepWalk(p, t, dt) : null;

    // Смотрит на вас, когда на него навели, позвали, он ждёт решения или говорит на планёрке.
    let look = null;
    if (!walk && (p.id === this.hovered || p.id === this.selected || p.status === "waiting" || p.saying || p.waveUntil > t)) {
      const c = this.camera.position;
      const dx = c.x - (p.root.position.x + p.pos.x);
      const dz = c.z - (p.root.position.z + p.pos.z);
      const dy = c.y - 1.6;
      const strong = p.id === this.hovered || p.saying || p.waveUntil > t;
      look = { yaw: Math.atan2(dx, dz) - p.yaw - p.swivel, pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 0.7, weight: strong ? 1 : 0.6 };
    }
    const left = (until, dur) => (until > t ? 1 - (until - t) / dur : 0);
    const tgt = targetPose({
      status: p.status, t, ph, m, action: p.action, work: p.work, walk, saying: p.saying, look,
      cheer: left(p.cheerUntil, p.cheerDur ?? 1.1),
      wave: left(p.waveUntil, p.waveDur ?? 1.4),
      throwing: left(p.throwUntil, 0.7),
    });
    const P = damp(p.pose, tgt, 1 - Math.exp(-dt * (walk ? 24 : 12)));

    // Крутится на кресле — только в действии swivel.
    const sw = p.action?.kind === "swivel" ? Math.sin(((t - p.action.start) / p.action.dur) * Math.PI * 2) * 0.55 * p.action.dir : 0;
    p.swivel += (sw - p.swivel) * (1 - Math.exp(-dt * 5));

    person.group.position.set(p.pos.x, -0.05 + 0.42 * p.stand, p.pos.z);
    person.group.rotation.y = p.yaw + p.swivel;
    person.torso.rotation.set(P.torsoX, P.torsoY, P.torsoZ);
    person.torso.position.y = 0.62 + P.lift;
    person.headPivot.rotation.set(P.headX, P.headY, P.headZ);
    person.arms[0].rotation.set(P.shLx, 0, P.shLz);
    person.arms[1].rotation.set(P.shRx, 0, P.shRz);
    person.elbows[0].rotation.x = P.elL;
    person.elbows[1].rotation.x = P.elR;
    person.legs[0].hip.rotation.x = P.hipL;
    person.legs[0].knee.rotation.x = P.kneeL;
    person.legs[1].hip.rotation.x = P.hipR;
    person.legs[1].knee.rotation.x = P.kneeR;
    person.mouth.scale.set(0.09 * (1 + P.smile * 0.5), 0.015 * (1 + P.mouth * 3.5), 0.02);
    for (const pu of person.pupils) pu.position.set(pu.userData.x0 + P.pupX * 0.018, 0.16 + P.pupY * 0.014, 0.266);
    for (const br of person.brows) br.position.y = 0.235 + P.smile * 0.018;
    person.body.scale.y = 1 + Math.sin(ph * 2) * 0.015 * m;

    // Кружка: за столом берёт со стола, у кулера наливает себе и несёт обратно.
    const u = p.action ? (t - p.action.start) / p.action.dur : 0;
    const sipping = p.action?.kind === "sip" && u > 0.15 && u < 0.85;
    person.cup.visible = sipping || Boolean(walk?.cup);
    p.desk.mug.visible = !sipping;
    person.phone.visible = p.action?.kind === "phone" && u > 0.1 && u < 0.9;

    // Моргание раз в несколько секунд.
    const blink = t > p.blinkAt && t < p.blinkAt + 0.12;
    if (t > p.blinkAt + 0.12) p.blinkAt = t + 2.5 + ((p.phase * 13) % 3);
    for (const e of person.eyes) e.scale.y = blink ? 0.15 : 1;

    if (p.status === "working" && Math.floor(t / 0.3) !== p.lastTick) {
      // Бегущие строки на мониторе — раз в 0,3 с.
      p.lastTick = Math.floor(t / 0.3);
      this.drawMonitor(p, t);
    }
    if (p.bang.visible) p.bang.position.y = 2.15 + Math.abs(Math.sin(ph * 4)) * 0.2 * m;
  }

  /** Встать и сходить к кулеру или кофемашине. */
  startWalk(p, t) {
    p.action = null;
    p.walk = { stage: "rise", route: kitchenRoute(p.root.position, Math.random), i: 0, phase: 0, t0: t, hurry: false };
    this.walkCooldown = t + 35;
  }

  /**
   * Шаг прогулки: встаёт → идёт → пьёт → идёт обратно → садится.
   * Позвали (клик, планёрка, новая задача) — разворачивается и быстро идёт к столу.
   */
  stepWalk(p, t, dt) {
    const w = p.walk;
    if (!w.hurry && (p.status !== "idle" || this.tourState || p.id === this.selected)) w.hurry = true;
    const seat = { x: 0, z: -0.95 };
    const speed = w.hurry ? 4.2 : 1.9;
    const k = (r) => 1 - Math.exp(-dt * r);
    let moving = false;
    const go = (path, onEnd) => {
      const target = path[w.i];
      const dx = target.x - p.pos.x;
      const dz = target.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      const step = speed * dt;
      if (d > 1e-4) p.yaw = turnTo(p.yaw, Math.atan2(dx, dz), k(10));
      if (d <= step) {
        p.pos.x = target.x;
        p.pos.z = target.z;
        w.i++;
        if (w.i >= path.length) onEnd();
      } else {
        p.pos.x += (dx / d) * step;
        p.pos.z += (dz / d) * step;
      }
      moving = true;
      w.phase += dt * speed * 4.2;
    };
    const turnBack = (path) => {
      w.stage = "back";
      w.back = [...path, seat];
      w.i = 0;
    };

    if (w.stage === "rise") {
      p.stand += (1 - p.stand) * k(w.hurry ? 12 : 6);
      if (w.hurry) w.stage = "sit";
      else if (p.stand > 0.96) {
        p.stand = 1;
        w.stage = "go";
        w.i = 0;
      }
    } else if (w.stage === "go") {
      if (w.hurry) turnBack(w.route.slice(0, w.i).reverse());
      else
        go(w.route, () => {
          w.stage = "drink";
          w.t0 = t;
        });
    } else if (w.stage === "drink") {
      p.yaw = turnTo(p.yaw, Math.PI, k(6));
      if (w.hurry || t - w.t0 > 3.4) turnBack(w.route.slice(0, -1).reverse());
    } else if (w.stage === "back") {
      go(w.back, () => (w.stage = "sit"));
    } else if (w.stage === "sit") {
      p.pos.x += (seat.x - p.pos.x) * k(10);
      p.pos.z += (seat.z - p.pos.z) * k(10);
      p.yaw = turnTo(p.yaw, 0, k(8));
      p.stand += (0 - p.stand) * k(w.hurry ? 12 : 6);
      if (p.stand < 0.02 && Math.abs(p.yaw) < 0.02) {
        p.stand = 0;
        p.yaw = 0;
        p.pos.x = seat.x;
        p.pos.z = seat.z;
        p.walk = null;
        p.nextAction = t + 4 + Math.random() * 4;
      }
    }
    const drinking = w.stage === "drink" ? Math.min(1, (t - w.t0) / 3.4) : 0;
    return { stand: p.stand, moving: moving && w.stage !== "sit", phase: w.phase, carry: w.stage === "back", drinking, cup: w.stage === "drink" || w.stage === "back" };
  }


  select(id) {
    this.selected = id ?? null;
    for (const [pid, p] of this.people) p.nameEl.classList.toggle("sel", pid === id);
    const p = this.people.get(id);
    if (!p) {
      this.spot.intensity = 0;
      this.ring.visible = Boolean(this.hovered);
      this.flyTo(this.home.pos, this.home.target);
      return;
    }
    // Сотрудник замечает, что его позвали: возвращается к столу и машет.
    if (p.walk) p.walk.hurry = true;
    p.waveUntil = this.timer.getElapsed() + 1.4;
    p.waveDur = 1.4;
    this.spot.position.copy(p.root.position).add(new THREE.Vector3(0, 2.6, -0.4));
    this.spot.intensity = 9;
    this.placeRing(p);
    // Справа откроется рабочий стол — сотрудник должен оказаться в левой свободной части экрана.
    const shift = this.container.clientWidth > 900 ? 2.6 : 0;
    const t = p.root.position.clone().add(new THREE.Vector3(shift * 0.8, 1, -0.6 - shift * 0.6));
    this.flyTo(t.clone().add(new THREE.Vector3(3.6, 4.4, 6.2)), t);
  }

  /**
   * Планёрка: камера по очереди подлетает к сотрудникам, каждый «говорит» свою
   * главную фразу. lines: [{ id, text }]. Любой клик или вращение — конец.
   */
  tour(lines, { onEnd, stepMs = 2600 } = {}) {
    this.stopTour();
    const list = lines.filter((l) => this.people.has(l.id) && l.text);
    if (!list.length) return;
    let i = 0;
    const say = (p, text) => {
      p.saying = true;
      p.bubbleEl.textContent = text;
      p.bubbleEl.className = "bubble say";
      p.bubbleEl.hidden = false;
    };
    const unsay = (p) => {
      if (!p?.saying) return;
      p.saying = false;
      this.setAgent(p.id, p.status, p.activityText);
    };
    const next = () => {
      unsay(this.people.get(list[i - 1]?.id));
      if (i >= list.length) return this.stopTour(true);
      const p = this.people.get(list[i].id);
      const t = p.root.position.clone().add(new THREE.Vector3(0, 1, -0.6));
      this.flyTo(t.clone().add(new THREE.Vector3(4.2, 5.2, 7.4)), t);
      this.placeRing(p);
      say(p, list[i].text);
      i++;
      this.tourState.timer = setTimeout(next, this.reduceMotion ? stepMs * 1.5 : stepMs);
    };
    this.tourState = { onEnd, timer: null, cleanup: () => list.forEach((l) => unsay(this.people.get(l.id))) };
    next();
  }

  stopTour(finished = false) {
    const st = this.tourState;
    if (!st) return;
    this.tourState = null;
    clearTimeout(st.timer);
    st.cleanup();
    this.ring.visible = false;
    this.flyTo(this.home.pos, this.home.target);
    st.onEnd?.(finished);
  }

  placeRing(p) {
    this.ring.position.set(p.root.position.x, 0.02, p.root.position.z - 0.95);
    this.ring.material.color.setHex(LAYOUT[p.id]?.shirt ?? ACCENT);
    this.ring.visible = true;
  }

  flyTo(pos, target) {
    this.fly = { from: this.camera.position.clone(), to: pos.clone(), tFrom: this.controls.target.clone(), tTo: target.clone(), t: 0 };
  }

  /* ---------- Мышь ---------- */

  bindPointer() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const pick = (e) => {
      const r = el.getBoundingClientRect();
      ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, this.camera);
      const hit = ray.intersectObjects([...[...this.people.values()].map((p) => p.root), this.wallScreen], true)[0];
      let o = hit?.object;
      if (o?.userData.wall) return { wall: true };
      while (o && !o.userData.agentId) o = o.parent;
      return o ? { agentId: o.userData.agentId } : null;
    };
    let down = null;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // это было вращение камеры
      const h = pick(e);
      if (h?.agentId) this.onSelect?.(h.agentId);
      else if (h?.wall) this.onWall?.();
    });
    let last = 0;
    el.addEventListener("pointermove", (e) => {
      const now = performance.now();
      if (now - last < 40) return; // не чаще 25 раз в секунду
      last = now;
      const h = pick(e);
      el.style.cursor = h ? "pointer" : "";
      const id = h?.agentId ?? null;
      if (id !== this.hovered) {
        this.hovered = id;
        // Навели на свободного сотрудника — он оборачивается и машет (не чаще раза в 6 секунд).
        const hp = this.people.get(id);
        const now = this.timer.getElapsed();
        if (hp && hp.status === "idle" && !hp.walk && now - (hp.hoverWaveAt ?? -99) > 6) {
          hp.hoverWaveAt = now;
          hp.waveUntil = now + 1.1;
          hp.waveDur = 1.1;
        }
        const p = this.people.get(id ?? this.selected);
        if (p) this.placeRing(p);
        else this.ring.visible = false;
      }
      if (id) {
        const info = this.onHover?.(id);
        if (info) {
          this.tip.innerHTML = "";
          const b = document.createElement("b");
          b.textContent = `${info.name} · ${info.title}`;
          this.tip.append(b);
          if (info.headline) {
            const hd = document.createElement("div");
            hd.className = "h";
            hd.textContent = info.headline;
            this.tip.append(hd);
          }
          const go = document.createElement("div");
          go.className = "go";
          go.textContent = "Нажмите — откроется рабочий стол";
          this.tip.append(go);
          const r = this.container.getBoundingClientRect();
          this.tip.style.left = `${Math.min(e.clientX - r.left + 16, r.width - 310)}px`;
          this.tip.style.top = `${e.clientY - r.top + 16}px`;
          this.tip.hidden = false;
        }
      } else if (h?.wall) {
        this.tip.innerHTML = "<b>Экран магазина</b><div class='go'>Нажмите — откроется рабочий стол директора</div>";
        const r = this.container.getBoundingClientRect();
        this.tip.style.left = `${Math.min(e.clientX - r.left + 16, r.width - 310)}px`;
        this.tip.style.top = `${e.clientY - r.top + 16}px`;
        this.tip.hidden = false;
      } else this.tip.hidden = true;
    });
    el.addEventListener("pointerleave", () => {
      this.tip.hidden = true;
      this.hovered = null;
      const p = this.people.get(this.selected);
      if (p) this.placeRing(p);
      else this.ring.visible = false;
    });
  }

  /* ---------- Цикл ---------- */

  /** Включить/выключить отрисовку: в 2D-режиме сцена не рисуется и не грузит видеокарту. */
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.renderer.setAnimationLoop(on ? () => this.frame() : null);
    if (on) {
      this.timer.update();
      this.resize();
    }
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.fov = w < 700 ? 55 : 38;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    const m = this.reduceMotion ? 0.2 : 1;

    // Когда никто не работает, ничего не летит и камера стоит — рисуем реже (батарея ноутбука).
    // «Ждёт решения» и «ошибка» могут висеть часами — для прыгающего «!» хватает редких кадров.
    // Человек крутит камеру — рисуем каждый кадр, иначе вращение дёргается.
    const moving = performance.now() - (this.movedAt ?? 0) < 400;
    const busy = moving || this.fly || this.flights.length || this.tourState || [...this.people.values()].some((p) => p.status === "working" || p.walk || p.cheerUntil > t || p.waveUntil > t || p.throwUntil > t);
    this.skip = (this.skip ?? 0) + 1;
    if (!busy && this.skip % 3 !== 0) {
      this.controls.update();
      return;
    }

    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt * 2.2); // ≈ 0,45 с — без долгих пролётов
      const k = 1 - Math.pow(1 - this.fly.t, 3);
      this.camera.position.lerpVectors(this.fly.from, this.fly.to, k);
      this.controls.target.lerpVectors(this.fly.tFrom, this.fly.tTo, k);
      if (this.fly.t >= 1) this.fly = null;
    }
    for (const f of [...this.flights]) {
      f.t += dt / f.dur;
      const k = Math.min(1, f.t);
      f.obj.position.copy(f.curve.getPoint(k));
      f.obj.rotation.y = k * Math.PI * 2;
      f.obj.rotation.z = Math.sin(k * Math.PI) * 0.5;
      if (k >= 1) {
        this.scene.remove(f.obj);
        this.flights.splice(this.flights.indexOf(f), 1);
        f.done?.();
      }
    }

    // Своё dt: в спокойные минуты кадры пропускаются, а движения должны идти с той же скоростью.
    const adt = Math.min(t - (this.animT ?? t), 0.1);
    this.animT = t;
    const slot = { free: !this.reduceMotion && !this.tourState && t > (this.walkCooldown ?? 25) && ![...this.people.values()].some((q) => q.walk) };
    for (const p of this.people.values()) this.animatePerson(p, t, adt, m, slot);
    if (this.ring.visible) this.ring.material.opacity = 0.6 + Math.sin(t * 4) * 0.25;

    // Часы — настоящее время.
    const now = new Date();
    this.clockM.rotation.z = -(now.getMinutes() / 60) * Math.PI * 2;
    this.clockH.rotation.z = -(((now.getHours() % 12) + now.getMinutes() / 60) / 12) * Math.PI * 2;

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
