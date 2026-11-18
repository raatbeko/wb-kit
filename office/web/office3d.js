/**
 * 3D-офис на three.js: пол, стены, столы, стилизованные сотрудники из простых
 * фигур (без скачанных моделей — нет вопросов с лицензиями, всё рисуется кодом).
 * Персонажа потом можно заменить на GLB-модель: всё, что знает остальной код, —
 * setAgent(id, status, activity) и onSelect.
 *
 * Состояния: idle — дышит и иногда оглядывается; working — печатает, экран
 * мигает; waiting — «!» прыгает над головой; error — красная лампа на столе.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

/** Где сидит каждый сотрудник и как он выглядит. */
export const LAYOUT = {
  director: { x: 0, z: -5.2, shirt: 0x3b2f63, hair: 0x2b1d14, acc: "tie", big: true },
  finance: { x: -6, z: -0.6, shirt: 0x1f7a5a, hair: 0x5a3a22, acc: "glasses" },
  analyst: { x: -2, z: -0.6, shirt: 0x2f6fb5, hair: 0x1d1d1d, acc: "glasses" },
  scout: { x: 2, z: -0.6, shirt: 0x8a5a2b, hair: 0xb8862f, acc: "cap" },
  reports: { x: 6, z: -0.6, shirt: 0x6d6d78, hair: 0x3a2a1e, acc: "none" },
  reviews: { x: -6, z: 3.6, shirt: 0xc2477a, hair: 0x7a3b1d, acc: "headset" },
  logist: { x: -2, z: 3.6, shirt: 0xd17a22, hair: 0x2b2b2b, acc: "cap" },
  marketer: { x: 2, z: 3.6, shirt: 0x7b2fbe, hair: 0xe0b060, acc: "headset" },
  content: { x: 6, z: 3.6, shirt: 0x2aa3a3, hair: 0x402018, acc: "beret" },
};

const SKIN = [0xf1c9a5, 0xe0ac84, 0xc68e63, 0xf3d2b8];

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts });
}

function box(w, h, d, color, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Стол с монитором, клавиатурой и стулом. Возвращает группу и материал экрана. */
function makeDesk(big) {
  const g = new THREE.Group();
  const w = big ? 3 : 2.2;
  const top = box(w, 0.08, 1.1, 0xc9a477);
  top.position.y = 0.78;
  g.add(top);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = box(0.07, 0.78, 0.07, 0x8c6d4a);
      leg.position.set(sx * (w / 2 - 0.1), 0.39, sz * 0.45);
      g.add(leg);
    }
  // Монитор смотрит на сотрудника (он сидит со стороны −z), экран — на −z.
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x1b2330, emissive: 0x24384f, emissiveIntensity: 0.6, roughness: 0.4 });
  const monitor = new THREE.Group();
  const frame = box(0.95, 0.6, 0.05, 0x222228);
  frame.position.y = 0.3;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.5), screenMat);
  screen.position.set(0, 0.3, -0.03);
  screen.rotation.y = Math.PI;
  const stand = box(0.08, 0.2, 0.08, 0x222228);
  stand.position.y = -0.08;
  monitor.add(frame, screen, stand);
  monitor.position.set(0, 0.92, 0.15);
  g.add(monitor);
  const kb = box(0.6, 0.03, 0.2, 0x3a3a42);
  kb.position.set(0, 0.84, -0.25);
  g.add(kb);
  // Лампа статуса (красная при ошибке).
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0x000000 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), lampMat);
  lamp.position.set(w / 2 - 0.25, 0.9, 0.3);
  g.add(lamp);
  // Стопка бумаг — растёт, когда приходят отчёты.
  const papers = box(0.35, 0.02, 0.45, 0xf7f3ea);
  papers.position.set(-(w / 2 - 0.35), 0.83, 0.15);
  papers.visible = false;
  g.add(papers);
  // Стул.
  const chair = new THREE.Group();
  const seat = box(0.6, 0.08, 0.6, 0x34343c);
  seat.position.y = 0.5;
  const back = box(0.6, 0.7, 0.08, 0x34343c);
  back.position.set(0, 0.88, -0.3);
  const post = box(0.06, 0.45, 0.06, 0x222228);
  post.position.y = 0.24;
  chair.add(seat, back, post);
  chair.position.z = -0.95;
  g.add(chair);
  return { group: g, screenMat, lampMat, papers };
}

/** Сотрудник из фигур: тело-капсула, голова, волосы, руки, аксессуар роли. */
function makePerson(look, seed) {
  const p = new THREE.Group();
  const skin = SKIN[seed % SKIN.length];
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.45, 6, 14), mat(look.shirt));
  body.position.y = 1.02;
  body.castShadow = true;
  p.add(body);
  const headPivot = new THREE.Group();
  headPivot.position.y = 1.55;
  p.add(headPivot);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 18), mat(skin));
  head.position.y = 0.12;
  head.castShadow = true;
  headPivot.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.275, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(look.hair));
  hair.position.y = 0.14;
  hair.rotation.x = -0.25;
  headPivot.add(hair);
  // Глаза — смотрят на монитор (+z).
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mat(0x1a1a1a));
    eye.position.set(sx * 0.09, 0.15, 0.24);
    headPivot.add(eye);
  }
  const arms = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.33, 1.28, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 4, 8), mat(look.shirt));
    arm.position.y = -0.25;
    arm.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), mat(skin));
    hand.position.y = -0.5;
    pivot.add(arm, hand);
    pivot.rotation.x = -1.1; // руки вперёд, к клавиатуре
    p.add(pivot);
    arms.push(pivot);
  }
  const acc = look.acc;
  if (acc === "tie") {
    const tie = box(0.09, 0.35, 0.02, 0xc0392b);
    tie.position.set(0, 1.18, 0.29);
    p.add(tie);
  } else if (acc === "glasses") {
    for (const sx of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 16), mat(0x111111));
      lens.position.set(sx * 0.09, 0.15, 0.25);
      headPivot.add(lens);
    }
  } else if (acc === "cap") {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.28, 0.12, 20), mat(look.shirt));
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
    const beret = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.07, 20), mat(0xb03050));
    beret.position.set(0.04, 0.36, 0);
    beret.rotation.z = 0.2;
    headPivot.add(beret);
  }
  return { group: p, body, headPivot, arms };
}

function makeWallScreen() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.6), new THREE.MeshBasicMaterial({ map: tex }));
  const frame = box(5.4, 2.8, 0.08, 0x1a1a1f);
  const g = new THREE.Group();
  frame.position.z = -0.05;
  g.add(frame, mesh);
  return { group: g, canvas, tex };
}

export function drawWallScreen(screen, kpis, title) {
  const c = screen.canvas.getContext("2d");
  c.fillStyle = "#14161c";
  c.fillRect(0, 0, 1024, 512);
  c.fillStyle = "#b77cf0";
  c.font = "600 40px system-ui, sans-serif";
  c.fillText(title, 40, 70);
  const list = (kpis || []).slice(0, 6);
  if (!list.length) {
    c.fillStyle = "#9aa0aa";
    c.font = "32px system-ui, sans-serif";
    c.fillText("Данных WB пока нет", 40, 160);
    c.fillText("Добавьте ключ (/setup) или откройте демо", 40, 210);
  }
  list.forEach((k, i) => {
    const x = 40 + (i % 3) * 330;
    const y = 150 + Math.floor(i / 3) * 170;
    c.fillStyle = "#9aa0aa";
    c.font = "28px system-ui, sans-serif";
    c.fillText(k.label, x, y);
    c.fillStyle = "#ffffff";
    c.font = "600 46px system-ui, sans-serif";
    c.fillText(formatKpi(k), x, y + 56);
    if (typeof k.delta === "number") {
      c.fillStyle = k.delta >= 0 ? "#57c486" : "#ef6b5b";
      c.font = "28px system-ui, sans-serif";
      c.fillText(`${k.delta > 0 ? "+" : ""}${k.delta}%`, x, y + 96);
    }
  });
  screen.tex.needsUpdate = true;
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

export class Office3D {
  constructor(container, agents, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.people = new Map();
    this.timer = new THREE.Timer();
    this.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.style.position = "absolute";
    labels.domElement.style.inset = "0";
    labels.domElement.style.pointerEvents = "none";
    container.appendChild(labels.domElement);
    this.labels = labels;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe9e2d6);
    scene.fog = new THREE.Fog(0xe9e2d6, 30, 60);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    camera.position.set(11, 13, 17);
    this.camera = camera;
    this.home = { pos: camera.position.clone(), target: new THREE.Vector3(0, 0.5, -0.5) };

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(this.home.target);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.44;
    controls.minDistance = 6;
    controls.maxDistance = 38;
    controls.enablePan = true;
    this.controls = controls;

    scene.add(new THREE.HemisphereLight(0xfff6e8, 0x8a7a66, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(8, 16, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
    scene.add(sun);

    this.buildRoom();

    agents.forEach((a, i) => this.addPerson(a, i));

    // Клик по сотруднику или его столу.
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    let down = null;
    renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    renderer.domElement.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // это было вращение камеры
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const hit = ray.intersectObjects([...this.people.values()].map((p) => p.root), true)[0];
      let o = hit?.object;
      while (o && !o.userData.agentId) o = o.parent;
      if (o) this.onSelect?.(o.userData.agentId);
    });
    renderer.domElement.addEventListener("pointermove", (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const hit = ray.intersectObjects([...this.people.values()].map((p) => p.root), true).length > 0;
      renderer.domElement.style.cursor = hit ? "pointer" : "";
    });

    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(container);
    this.resize();
    this.active = false;
    this.setActive(true);
  }

  buildRoom() {
    const s = this.scene;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(26, 20), mat(0xd8c7ad, { roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -0.5;
    floor.receiveShadow = true;
    s.add(floor);
    // Ковёр под рабочими местами.
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(17, 9), mat(0xb9a58a, { roughness: 1 }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.005, 1.5);
    rug.receiveShadow = true;
    s.add(rug);
    const back = box(26, 4.2, 0.2, 0xf3ede3);
    back.position.set(0, 2.1, -10.5);
    const left = box(0.2, 4.2, 20, 0xebe3d6);
    left.position.set(-13, 2.1, -0.5);
    s.add(back, left);
    // Кабинет директора — стеклянная перегородка.
    const glass = new THREE.Mesh(new THREE.BoxGeometry(9, 2.2, 0.05), new THREE.MeshStandardMaterial({ color: 0xbfd8e8, transparent: true, opacity: 0.25, roughness: 0.1 }));
    glass.position.set(0, 1.1, -3.4);
    s.add(glass);
    // Экран с цифрами магазина на стене.
    this.wall = makeWallScreen();
    this.wall.group.position.set(-7, 2.3, -10.35);
    s.add(this.wall.group);
    drawWallScreen(this.wall, [], "Магазин");
    // Растения — для уюта.
    for (const [x, z] of [[-11.5, -9], [11.5, -9], [-11.5, 7], [11, 7]]) {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.28, 0.6, 16), mat(0xa0522d));
      pot.position.set(x, 0.3, z);
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 0), mat(0x4f8a4b, { flatShading: true }));
      leaves.position.set(x, 1.1, z);
      pot.castShadow = leaves.castShadow = true;
      s.add(pot, leaves);
    }
    // Окно на левой стене.
    const win = new THREE.Mesh(new THREE.PlaneGeometry(6, 2), new THREE.MeshBasicMaterial({ color: 0xcfe6f5 }));
    win.position.set(-12.89, 2.3, 0);
    win.rotation.y = Math.PI / 2;
    s.add(win);
  }

  addPerson(agent, i) {
    const look = LAYOUT[agent.id] ?? { x: (i % 4) * 4 - 6, z: 7, shirt: 0x777777, hair: 0x333333, acc: "none" };
    const root = new THREE.Group();
    root.position.set(look.x, 0, look.z);
    root.userData.agentId = agent.id;
    const desk = makeDesk(look.big);
    root.add(desk.group);
    const person = makePerson(look, i);
    person.group.position.z = -0.95; // на стуле, лицом к монитору
    person.group.position.y = -0.05;
    root.add(person.group);
    this.scene.add(root);

    const nameEl = document.createElement("div");
    nameEl.className = "label";
    nameEl.textContent = agent.name;
    const name = new CSS2DObject(nameEl);
    name.position.set(0, 0.05, -1.6);
    root.add(name);

    const bubbleEl = document.createElement("div");
    bubbleEl.className = "bubble";
    bubbleEl.hidden = true;
    const bubble = new CSS2DObject(bubbleEl);
    bubble.position.set(0, 2.45, -0.95);
    root.add(bubble);

    // «!» — ждёт решения человека.
    const bang = new THREE.Group();
    const bar = box(0.12, 0.42, 0.12, 0xf0a72a, { emissive: 0xf0a72a, emissiveIntensity: 0.5 });
    bar.position.y = 0.3;
    const dot = box(0.12, 0.12, 0.12, 0xf0a72a, { emissive: 0xf0a72a, emissiveIntensity: 0.5 });
    bang.add(bar, dot);
    bang.position.set(0, 2.15, -0.95);
    bang.visible = false;
    root.add(bang);

    this.people.set(agent.id, { root, desk, person, nameEl, bubbleEl, bang, status: "idle", phase: i * 1.7, papers: 0 });
    this.setAgent(agent.id, agent.status, agent.activity);
  }

  setAgent(id, status, activity) {
    const p = this.people.get(id);
    if (!p) return;
    p.status = status;
    const text = status === "waiting" ? "! ждёт вашего решения" : activity;
    p.bubbleEl.textContent = text || "";
    p.bubbleEl.className = `bubble ${status}`;
    p.bubbleEl.hidden = !(status !== "idle" && text);
    p.bang.visible = status === "waiting";
    p.desk.lampMat.color.set(status === "error" ? 0xc0392b : status === "working" ? 0x2f7d4f : 0x555555);
    p.desk.lampMat.emissive.set(status === "error" ? 0x8a1a10 : status === "working" ? 0x1a5a33 : 0x000000);
  }

  /** Включить/выключить отрисовку: в 2D-режиме сцена не рисуется и не грузит видеокарту. */
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.renderer.setAnimationLoop(on ? () => this.frame() : null);
    if (on) {
      this.timer.update(); // без скачка анимации после паузы
      this.resize();
    }
  }

  /** Отчёт пришёл — на столе прибавилось бумаг. */
  addPaper(id) {
    const p = this.people.get(id);
    if (!p) return;
    p.papers = Math.min(p.papers + 1, 8);
    p.desk.papers.visible = true;
    p.desk.papers.scale.y = p.papers * 2;
    p.desk.papers.position.y = 0.83 + p.papers * 0.02;
  }

  select(id) {
    for (const [pid, p] of this.people) p.nameEl.classList.toggle("sel", pid === id);
    const p = this.people.get(id);
    if (!p) {
      this.flyTo(this.home.pos, this.home.target);
      return;
    }
    // Справа откроется панель — смещаем точку взгляда вправо от сотрудника,
    // чтобы он оказался в левой, свободной части экрана (на узком экране панель на весь экран — не смещаем).
    const shift = this.container.clientWidth > 900 ? 2.2 : 0;
    const t = p.root.position.clone().add(new THREE.Vector3(shift * 0.8, 1, -0.6 - shift * 0.6));
    this.flyTo(t.clone().add(new THREE.Vector3(3.5, 4.2, 6)), t);
  }

  flyTo(pos, target) {
    this.fly = { from: this.camera.position.clone(), to: pos.clone(), tFrom: this.controls.target.clone(), tTo: target.clone(), t: 0 };
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    // На узком экране отодвигаемся, чтобы весь офис помещался.
    this.camera.fov = w < 700 ? 55 : 38;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt * 1.4);
      const k = 1 - Math.pow(1 - this.fly.t, 3);
      this.camera.position.lerpVectors(this.fly.from, this.fly.to, k);
      this.controls.target.lerpVectors(this.fly.tFrom, this.fly.tTo, k);
      if (this.fly.t >= 1) this.fly = null;
    }
    const m = this.reduceMotion ? 0.2 : 1;
    for (const p of this.people.values()) {
      const ph = t + p.phase;
      const { person, desk } = p;
      if (p.status === "working") {
        // Печатает: руки по очереди, голова чуть кивает, экран мигает.
        person.arms[0].rotation.x = -1.15 + Math.sin(ph * 14) * 0.12 * m;
        person.arms[1].rotation.x = -1.15 + Math.sin(ph * 14 + Math.PI) * 0.12 * m;
        person.headPivot.rotation.x = 0.1 + Math.sin(ph * 3) * 0.04 * m;
        person.headPivot.rotation.y = 0;
        desk.screenMat.emissiveIntensity = 0.9 + Math.sin(ph * 9) * 0.25 * m;
        desk.screenMat.emissive.setHex(0x3a6a9a);
      } else {
        person.arms[0].rotation.x = person.arms[1].rotation.x = -0.9;
        desk.screenMat.emissiveIntensity = 0.5;
        desk.screenMat.emissive.setHex(p.status === "waiting" ? 0x8a5a10 : p.status === "error" ? 0x7a1a10 : 0x24384f);
        // Отдыхает: дышит и иногда смотрит по сторонам.
        person.headPivot.rotation.y = Math.sin(ph * 0.5) * 0.35 * m;
        person.headPivot.rotation.x = 0;
      }
      person.body.scale.y = 1 + Math.sin(ph * 2) * 0.015 * m;
      if (p.bang.visible) p.bang.position.y = 2.15 + Math.abs(Math.sin(ph * 4)) * 0.2 * m;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
