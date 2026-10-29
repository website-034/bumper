import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ANIMALS, buildCritter } from './characters.js';
import { MODEL_CHARACTERS, loadManifest, loadModel, isModelReady, buildModelCritter } from './models.js';
import { FLUFFY, buildCorgi } from './fluffy.js';
import { WEAPON_INFO, buildWeapon, buildPickup, buildShot, animateBomb } from './weapons.js';

await loadManifest();
// Furry and jelly critters plus any .glb characters listed in /models/characters.json.
const CHARACTERS = { ...FLUFFY, ...ANIMALS, ...MODEL_CHARACTERS };

const socket = io();
const $ = (id) => document.getElementById(id);
const canvas = $('game');

const ISLAND_MAX = 28;
const BOMB_RADIUS = 3.2;
const TEAM_COLORS = ['#ff6b81', '#4dabf7', '#51cf66', '#ffc93c'];
const TEAM_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];
const ANIMAL_KEYS = Object.keys(CHARACTERS);

let myId = null;
let room = null;
let snap = null;
let snapTime = 0;
let lastPhase = null;
let time = 0;
let shake = 0;
let myAnimal = localStorage.getItem('bb-animal');
if (!CHARACTERS[myAnimal]) myAnimal = ANIMAL_KEYS[Math.floor(Math.random() * ANIMAL_KEYS.length)];

// ---------- Renderer / scene ----------
const isTouch = 'ontouchstart' in window;
const lowPower = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#f1e4ff', 80, 240);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
const camPos = new THREE.Vector3(-2, 5, 10);
const camLook = new THREE.Vector3(-2, 1, 0);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

scene.add(new THREE.HemisphereLight('#eef5ff', '#ffd3e4', 1.3));
const sun = new THREE.DirectionalLight('#fff3e0', 2.4);
sun.position.set(9, 20, 12);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(lowPower ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -36, right: 36, top: 36, bottom: -36, near: 1, far: 100 });
sun.shadow.radius = 5;
sun.shadow.bias = -0.0005;
scene.add(sun);

// Gradient sky dome
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(220, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color('#9fd3ff') },
      mid: { value: new THREE.Color('#e4dbff') },
      bottom: { value: new THREE.Color('#ffe8f1') },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.6, h)) : mix(mid, bottom, smoothstep(0.0, 0.4, -h));
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
      }`,
  }),
);
scene.add(sky);

// ---------- Island ----------
const island = new THREE.Group();
scene.add(island);
const islandScaled = new THREE.Group();
island.add(islandScaled);

const grassMat = new THREE.MeshStandardMaterial({ color: '#b3e6a4', roughness: 0.95 });
const grass = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.5, 72), grassMat);
grass.position.y = -0.25;
grass.receiveShadow = true;
islandScaled.add(grass);

const dirt = new THREE.Mesh(
  new THREE.CylinderGeometry(1.0, 0.93, 0.9, 72),
  new THREE.MeshStandardMaterial({ color: '#e6c2a0', roughness: 1 }),
);
dirt.position.y = -0.95;
islandScaled.add(dirt);

const rockGeo = new THREE.ConeGeometry(0.93, 1, 10, 4);
rockGeo.rotateX(Math.PI);
rockGeo.translate(0, -0.5, 0);
{
  const p = rockGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < -0.02 && p.getY(i) > -0.98) {
      p.setX(i, p.getX(i) * (0.85 + Math.random() * 0.3));
      p.setZ(i, p.getZ(i) * (0.85 + Math.random() * 0.3));
    }
  }
  rockGeo.computeVertexNormals();
}
const rock = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({ color: '#b9a0c9', roughness: 1, flatShading: true }));
rock.position.y = -1.4;
rock.scale.y = 7;
islandScaled.add(rock);

const edgeRing = new THREE.Mesh(
  new THREE.RingGeometry(0.965, 1.0, 96),
  new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
);
edgeRing.rotation.x = -Math.PI / 2;
edgeRing.position.y = 0.01;
islandScaled.add(edgeRing);

// Grass tufts and flowers (instanced so they can vanish as the island crumbles)
const decoDummy = new THREE.Object3D();
const tuftCount = 1500;
const tufts = new THREE.InstancedMesh(
  new THREE.ConeGeometry(0.07, 0.28, 5),
  new THREE.MeshStandardMaterial({ color: '#8fd38a', roughness: 1 }),
  tuftCount,
);
const flowerCount = 900;
const flowers = new THREE.InstancedMesh(
  new THREE.SphereGeometry(0.09, 8, 6),
  new THREE.MeshStandardMaterial({ roughness: 0.6 }),
  flowerCount,
);
const tuftData = [], flowerData = [];
const FLOWER_COLORS = ['#ffffff', '#ffd6e0', '#fff3a0', '#d9ccff', '#ffc8a8'];
for (let i = 0; i < tuftCount; i++) {
  const r = Math.sqrt(Math.random()) * (ISLAND_MAX - 0.3), a = Math.random() * Math.PI * 2;
  tuftData.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r, s: 0.6 + Math.random() * 0.8, rot: Math.random() });
}
for (let i = 0; i < flowerCount; i++) {
  const r = Math.sqrt(Math.random()) * (ISLAND_MAX - 0.3), a = Math.random() * Math.PI * 2;
  flowerData.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r });
  flowers.setColorAt(i, new THREE.Color(FLOWER_COLORS[i % FLOWER_COLORS.length]));
}
island.add(tufts, flowers);

// Stepping-stone paths: two rings joined by spokes.
const stoneData = [];
for (const [ringR, n] of [[3.4, 16], [9.6, 40], [15.6, 64], [21.8, 88]]) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
    stoneData.push({ x: Math.cos(a) * ringR, z: Math.sin(a) * ringR, s: 0.8 + Math.random() * 0.35, rot: Math.random() * 3 });
  }
}
for (let k = 0; k < 4; k++) {
  const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
  for (let d = 4.3; d < 9; d += 0.95) stoneData.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, s: 0.75 + Math.random() * 0.3, rot: Math.random() * 3 });
}
for (let k = 0; k < 8; k++) {
  const a = (k / 8) * Math.PI * 2;
  for (let d = 10.5; d < 21; d += 0.95) stoneData.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, s: 0.75 + Math.random() * 0.3, rot: Math.random() * 3 });
}
for (const st of stoneData) st.r = Math.hypot(st.x, st.z);
const stones = new THREE.InstancedMesh(
  new THREE.CylinderGeometry(0.34, 0.4, 0.08, 7),
  new THREE.MeshStandardMaterial({ color: '#efe6f7', roughness: 0.9, flatShading: true }),
  stoneData.length,
);
stones.receiveShadow = true;

// Little mushrooms dotted around.
const mushData = [];
for (let i = 0; i < 180; i++) {
  const r = 1.5 + Math.sqrt(Math.random()) * (ISLAND_MAX - 2), a = Math.random() * Math.PI * 2;
  mushData.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r, s: 0.7 + Math.random() * 0.6 });
}
const capGeo = new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const mushCaps = new THREE.InstancedMesh(capGeo, new THREE.MeshStandardMaterial({ roughness: 0.5 }), mushData.length);
const mushStems = new THREE.InstancedMesh(
  new THREE.CylinderGeometry(0.06, 0.08, 0.2, 8),
  new THREE.MeshStandardMaterial({ color: '#fff8ef', roughness: 0.8 }),
  mushData.length,
);
const CAP_COLORS = ['#ff8fa3', '#ffb37a', '#c7b8ff'];
mushData.forEach((_, i) => mushCaps.setColorAt(i, new THREE.Color(CAP_COLORS[i % CAP_COLORS.length])));
island.add(stones, mushCaps, mushStems);

let decoR = -1, decoRiver = null;
function updateDeco(R) {
  const rv = currentRiver();
  if (Math.abs(R - decoR) < 0.02 && rv === decoRiver) return;
  if (rv !== decoRiver) {
    for (const list of [tuftData, flowerData, stoneData, mushData]) {
      for (const d of list) d.wet = !!rv && riverDist(rv, d.x, d.z) < rv.half + 0.5;
    }
  }
  decoR = R;
  decoRiver = rv;
  tuftData.forEach((t, i) => {
    decoDummy.position.set(t.x, 0.1, t.z);
    decoDummy.rotation.set(0, t.rot * 6, (t.rot - 0.5) * 0.4);
    decoDummy.scale.setScalar(t.r < R - 0.25 && !t.wet ? t.s : 0);
    decoDummy.updateMatrix();
    tufts.setMatrixAt(i, decoDummy.matrix);
  });
  flowerData.forEach((f, i) => {
    decoDummy.position.set(f.x, 0.06, f.z);
    decoDummy.rotation.set(0, 0, 0);
    decoDummy.scale.set(1, 0.6, 1).multiplyScalar(f.r < R - 0.25 && !f.wet ? 1 : 0);
    decoDummy.updateMatrix();
    flowers.setMatrixAt(i, decoDummy.matrix);
  });
  stoneData.forEach((st, i) => {
    decoDummy.position.set(st.x, 0.02, st.z);
    decoDummy.rotation.set(0, st.rot, 0);
    decoDummy.scale.setScalar(st.r < R - 0.4 && !st.wet ? st.s : 0);
    decoDummy.updateMatrix();
    stones.setMatrixAt(i, decoDummy.matrix);
  });
  mushData.forEach((m, i) => {
    const s = m.r < R - 0.3 && !m.wet ? m.s : 0;
    decoDummy.rotation.set(0, 0, 0);
    decoDummy.scale.setScalar(s);
    decoDummy.position.set(m.x, 0.1 * s, m.z);
    decoDummy.updateMatrix();
    mushStems.setMatrixAt(i, decoDummy.matrix);
    decoDummy.position.set(m.x, 0.18 * s, m.z);
    decoDummy.updateMatrix();
    mushCaps.setMatrixAt(i, decoDummy.matrix);
  });
  tufts.instanceMatrix.needsUpdate = true;
  flowers.instanceMatrix.needsUpdate = true;
  stones.instanceMatrix.needsUpdate = true;
  mushCaps.instanceMatrix.needsUpdate = true;
  mushStems.instanceMatrix.needsUpdate = true;
}

// ---------- Background: cloud sea, puffy clouds, little islands ----------
const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#fff4fb', emissiveIntensity: 0.55 });
const seaCount = 180;
const cloudSea = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), cloudMat, seaCount);
for (let i = 0; i < seaCount; i++) {
  const r = 30 + Math.random() * 90, a = Math.random() * Math.PI * 2;
  decoDummy.position.set(Math.cos(a) * r, -17 - Math.random() * 4, Math.sin(a) * r);
  decoDummy.scale.set(4 + Math.random() * 6, 2 + Math.random() * 2, 4 + Math.random() * 6);
  decoDummy.rotation.set(0, 0, 0);
  decoDummy.updateMatrix();
  cloudSea.setMatrixAt(i, decoDummy.matrix);
}
scene.add(cloudSea);

const puffyClouds = [];
for (let i = 0; i < 9; i++) {
  const g = new THREE.Group();
  const n = 4 + Math.floor(Math.random() * 3);
  for (let j = 0; j < n; j++) {
    const m = new THREE.Mesh(cloudSea.geometry, cloudMat);
    m.position.set((j - n / 2) * 1.3, Math.random() * 0.6, (Math.random() - 0.5) * 1.2);
    m.scale.setScalar(1.1 + Math.random() * 0.9);
    g.add(m);
  }
  const a = Math.random() * Math.PI * 2;
  const r = 62 + Math.random() * 35;
  g.userData = { a, r, y: -8 + Math.random() * 10, v: 0.01 + Math.random() * 0.02 };
  g.scale.setScalar(1 + Math.random());
  scene.add(g);
  puffyClouds.push(g);
}

const miniIslands = [];
for (let i = 0; i < 6; i++) {
  const g = new THREE.Group();
  const s = 1.4 + Math.random() * 1.6;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(s, s, 0.4, 24), grassMat);
  top.receiveShadow = true;
  const under = new THREE.Mesh(new THREE.ConeGeometry(s * 0.95, s * 2.4, 8), rock.material);
  under.rotation.x = Math.PI;
  under.position.y = -s * 1.2 - 0.2;
  g.add(top, under);
  const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
  const r = 52 + Math.random() * 25;
  g.position.set(Math.cos(a) * r, -3 + Math.random() * 6, Math.sin(a) * r);
  g.userData = { base: g.position.y, k: Math.random() * 10, size: s };
  scene.add(g);
  miniIslands.push(g);
}

// Low-poly CC0 nature props (Gobkit) planted on the floating sky islands.
const NATURE_PROPS = {
  TreeLow001: 2.2, TreeLow002: 2.0, TreeLow003: 2.3, TreeLow004: 2.1,
  TreeMed001: 2.8, TreeMed002: 2.6, TreeMed003: 3.0, TreeHigh001: 3.6,
  Bush001: 0.8, Bush002: 0.9, Rock001: 0.6, Rock002: 0.7, Rock003: 0.5,
  Grass001: 0.4, Grass002: 0.4,
};
const natureLoader = new GLTFLoader();
Promise.all(Object.entries(NATURE_PROPS).map(([name, h]) =>
  natureLoader.loadAsync(`/models/gobkit/nature/${name}.glb`).then((gltf) => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = h / (size.y || 1);
    const center = box.getCenter(new THREE.Vector3());
    const holder = new THREE.Group();
    gltf.scene.scale.setScalar(scale);
    gltf.scene.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    holder.add(gltf.scene);
    return [name, holder];
  }).catch(() => null),
)).then((results) => {
  const props = Object.fromEntries(results.filter(Boolean));
  Object.assign(natureProps, props);
  buildObstacles();
  const pick = (prefix) => {
    const names = Object.keys(props).filter((n) => n.startsWith(prefix));
    return names.length ? props[names[Math.floor(Math.random() * names.length)]] : null;
  };
  const place = (island, proto, spread) => {
    if (!proto) return;
    const p = proto.clone(true);
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * island.userData.size * spread;
    p.position.set(Math.cos(a) * d, 0.2, Math.sin(a) * d);
    p.rotation.y = Math.random() * Math.PI * 2;
    p.scale.setScalar(0.85 + Math.random() * 0.3);
    island.add(p);
  };
  for (const island of miniIslands) {
    place(island, pick(Math.random() < 0.3 ? 'TreeHigh' : Math.random() < 0.5 ? 'TreeMed' : 'TreeLow'), 0.35);
    if (island.userData.size > 2) place(island, pick('TreeLow'), 0.6);
    place(island, pick('Bush'), 0.7);
    place(island, pick('Rock'), 0.75);
    for (let i = 0; i < 3; i++) place(island, pick('Grass'), 0.85);
  }
});

// ---------- Arena obstacles (server-placed trees, rocks and bushes) ----------
const natureProps = {};
const obstacleGroup = new THREE.Group();
island.add(obstacleGroup);
let obstacleKey = '';
let obstacleMeshes = [];
const OBSTACLE_LOOK = {
  tree: { names: ['TreeLow001', 'TreeLow002', 'TreeMed001', 'TreeMed002'] },
  rock: { names: ['Rock001', 'Rock002', 'Rock003', 'Rock001'] },
  bush: { names: ['Bush001', 'Bush002', 'Bush001', 'Bush002'] },
};
const fallbackObstacleMat = new THREE.MeshStandardMaterial({ color: '#b9a0c9', roughness: 1, flatShading: true });

function buildObstacles() {
  const list = room?.obstacles || [];
  const key = JSON.stringify(list) + Object.keys(natureProps).length;
  if (key === obstacleKey) return;
  obstacleKey = key;
  obstacleGroup.clear();
  obstacleMeshes = list.map((o) => {
    const look = OBSTACLE_LOOK[o.t] || OBSTACLE_LOOK.rock;
    const proto = natureProps[look.names[o.v % look.names.length]];
    let mesh;
    if (proto) {
      mesh = proto.clone(true);
      const size = new THREE.Box3().setFromObject(proto).getSize(new THREE.Vector3());
      // Trees: sized by height (the trunk is what blocks). Rocks/bushes: footprint matches the collider.
      mesh.scale.setScalar(o.t === 'tree' ? 3.4 / size.y : (o.r * 2.3) / Math.max(size.x, size.z));
    } else {
      mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(o.r), fallbackObstacleMat);
      mesh.position.y = o.r * 0.6;
    }
    const holder = new THREE.Group();
    holder.add(mesh);
    holder.position.set(o.x, 0, o.z);
    holder.rotation.y = o.v * 1.7;
    obstacleGroup.add(holder);
    return { holder, o, dist: Math.hypot(o.x, o.z), fallV: 0, spin: (Math.random() - 0.5) * 2 };
  });
}

function updateObstacles(dt, R, playing) {
  obstacleGroup.visible = playing;
  if (!playing) return;
  for (const m of obstacleMeshes) {
    if (m.dist < R - 0.3) {
      if (m.fallV === 0) m.holder.position.y = 0;
      continue;
    }
    m.fallV += 20 * dt;
    m.holder.position.y -= m.fallV * dt;
    m.holder.rotation.z += m.spin * dt;
    m.holder.visible = m.holder.position.y > -25;
  }
}

// ---------- River (server-defined centreline; the current carries players off the edge) ----------
const riverGroup = new THREE.Group();
island.add(riverGroup);
const riverUniforms = {
  uTime: { value: 0 }, uR: { value: ISLAND_MAX }, uHalf: { value: 1.7 }, uW: { value: 2.2 },
  uDeep: { value: new THREE.Color('#3f9fe8') }, uShallow: { value: new THREE.Color('#8fdcff') },
  uSand: { value: new THREE.Color('#efdcae') }, uGrass: { value: grassMat.color.clone() },
};
const riverMat = new THREE.MeshStandardMaterial({ roughness: 0.35 });
riverMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, riverUniforms);
  sh.vertexShader = 'attribute vec2 rUv;\nvarying vec2 vRUv;\nvarying vec2 vRXZ;\n' +
    sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRUv = rUv;\nvRXZ = position.xz;');
  sh.fragmentShader = 'uniform float uTime, uR, uHalf, uW;\nuniform vec3 uDeep, uShallow, uSand, uGrass;\nvarying vec2 vRUv;\nvarying vec2 vRXZ;\n' +
    sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      if (length(vRXZ) > uR - 0.05) discard;
      float across = abs(vRUv.y * 2.0 - 1.0) * uW;
      if (across > uHalf) {
        diffuseColor.rgb = mix(uSand, uGrass, smoothstep(uHalf + 0.05, uW, across));
      } else {
        float s = vRUv.x - uTime * 3.2;
        float wave = sin(s * 1.7 + sin(vRUv.y * 11.0 + vRUv.x * 0.6) * 1.4) * 0.5 + 0.5;
        float streak = smoothstep(0.86, 0.97, wave);
        float edge = smoothstep(uHalf - 0.3, uHalf, across);
        vec3 col = mix(uDeep, uShallow, across / uHalf * 0.55 + wave * 0.2);
        diffuseColor.rgb = mix(col, vec3(1.0), clamp(streak * 0.7 + edge * 0.8, 0.0, 1.0));
      }`);
};

const fallCanvas = document.createElement('canvas');
fallCanvas.width = 64; fallCanvas.height = 128;
{
  const g = fallCanvas.getContext('2d');
  g.fillStyle = '#7fd0ff';
  g.fillRect(0, 0, 64, 128);
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.5})`;
    g.fillRect(Math.random() * 64, Math.random() * 128, 2 + Math.random() * 4, 14 + Math.random() * 30);
  }
}
const fallTex = new THREE.CanvasTexture(fallCanvas);
fallTex.colorSpace = THREE.SRGBColorSpace;
fallTex.wrapS = fallTex.wrapT = THREE.RepeatWrapping;
fallTex.repeat.set(1, 2);
const waterfall = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshStandardMaterial({ map: fallTex, transparent: true, opacity: 0.85, side: THREE.DoubleSide, roughness: 0.3, emissive: '#5fb8ff', emissiveIntensity: 0.25 }),
);
riverGroup.add(waterfall);

const plankMat = new THREE.MeshStandardMaterial({ color: '#c98b5a', roughness: 0.85 });
const railMat = new THREE.MeshStandardMaterial({ color: '#a86c43', roughness: 0.9 });
function buildBridge(half) {
  const g = new THREE.Group();
  const span = (half + 0.7) * 2;
  for (let i = 0; i < 6; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(span, 0.12, 0.34), plankMat);
    p.position.set(0, 0.06 + Math.sin((i / 5) * Math.PI) * 0.03, -0.95 + i * 0.38);
    p.rotation.y = (Math.random() - 0.5) * 0.04;
    p.castShadow = p.receiveShadow = true;
    g.add(p);
  }
  for (const z of [-1.12, 1.12]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.1, 0.1), railMat);
    rail.position.set(0, 0.62, z);
    rail.castShadow = true;
    g.add(rail);
    for (const x of [-span / 2 + 0.1, 0, span / 2 - 0.1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.65, 6), railMat);
      post.position.set(x, 0.32, z);
      post.castShadow = true;
      g.add(post);
    }
  }
  return g;
}

function riverSegs(pts) {
  const segs = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0) || 1e-4;
    segs.push({ x0, z0, dx: (x1 - x0) / len, dz: (z1 - z0) / len, len, s });
    s += len;
  }
  return segs;
}
function riverDist(rv, x, z) {
  let best = Infinity;
  for (const sg of rv.segs) {
    const px = x - sg.x0, pz = z - sg.z0;
    const t = Math.max(0, Math.min(sg.len, px * sg.dx + pz * sg.dz));
    best = Math.min(best, Math.hypot(px - sg.dx * t, pz - sg.dz * t));
  }
  return best;
}

let riverCache = null, riverKey = '', riverMesh = null, bridgeMeshes = [], sprayT = 0;
function currentRiver() {
  const r = room && room.phase !== 'lobby' && room.river;
  if (!r) return null;
  const key = r.pts.join(';');
  if (key !== riverKey) {
    riverKey = key;
    riverCache = { ...r, segs: riverSegs(r.pts) };
    buildRiverMesh(riverCache);
  }
  return riverCache;
}

function buildRiverMesh(rv) {
  if (riverMesh) { riverGroup.remove(riverMesh); riverMesh.geometry.dispose(); }
  for (const b of bridgeMeshes) riverGroup.remove(b);
  const W = rv.half + 0.5;
  const n = rv.pts.length;
  const pos = new Float32Array(n * 2 * 3), nor = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = rv.pts[Math.max(0, i - 1)], b = rv.pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    if (i > 0) s += Math.hypot(rv.pts[i][0] - rv.pts[i - 1][0], rv.pts[i][1] - rv.pts[i - 1][1]);
    const [x, z] = rv.pts[i];
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1, j = i * 2 + k;
      pos.set([x - tz * W * side, 0.012, z + tx * W * side], j * 3);
      nor.set([0, 1, 0], j * 3);
      uv.set([s, k], j * 2);
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('rUv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  riverMesh = new THREE.Mesh(geo, riverMat);
  riverMesh.receiveShadow = true;
  riverGroup.add(riverMesh);
  riverUniforms.uHalf.value = rv.half;
  riverUniforms.uW.value = W;
  waterfall.scale.set(rv.half * 2, 9, 1);
  bridgeMeshes = rv.bridges.map((b) => {
    const g = buildBridge(rv.half);
    g.position.set(b.x, 0, b.z);
    g.rotation.y = b.a;
    g.userData.dist = Math.hypot(b.x, b.z);
    riverGroup.add(g);
    return g;
  });
}

function updateRiver(dt, R) {
  const rv = currentRiver();
  riverGroup.visible = !!rv;
  if (!rv) return;
  riverUniforms.uTime.value = time;
  riverUniforms.uR.value = R;
  for (const b of bridgeMeshes) b.visible = b.userData.dist < R - 1.2;
  // Waterfall where the river spills over the downstream edge.
  let exit = null;
  for (const sg of rv.segs) {
    const ex = sg.x0 + sg.dx * sg.len, ez = sg.z0 + sg.dz * sg.len;
    if (Math.hypot(sg.x0, sg.z0) < R && Math.hypot(ex, ez) >= R) {
      let lo = 0, hi = sg.len;
      for (let k = 0; k < 12; k++) {
        const m = (lo + hi) / 2;
        if (Math.hypot(sg.x0 + sg.dx * m, sg.z0 + sg.dz * m) < R) lo = m; else hi = m;
      }
      exit = { x: sg.x0 + sg.dx * lo, z: sg.z0 + sg.dz * lo, tx: sg.dx, tz: sg.dz };
    }
  }
  waterfall.visible = !!exit;
  if (!exit) return;
  waterfall.position.set(exit.x + exit.tx * 0.15, -4.4, exit.z + exit.tz * 0.15);
  waterfall.rotation.set(0, Math.atan2(exit.tx, exit.tz), 0);
  fallTex.offset.y += dt * 1.6;
  sprayT -= dt;
  if (sprayT <= 0) {
    sprayT = 0.12;
    puff(exit.x + exit.tx * 0.6 + (Math.random() - 0.5) * rv.half, -0.3 + island.position.y, exit.z + exit.tz * 0.6 + (Math.random() - 0.5) * rv.half, 1, '#dff4ff', 1.2);
  }
}

// ---------- Floating rock platforms just off the edge ----------
const platformGroup = new THREE.Group();
island.add(platformGroup);
let platformKey = '', platformMeshes = [];
const platformDirtMat = new THREE.MeshStandardMaterial({ color: '#e6c2a0', roughness: 1 });

function buildPlatform(pl) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(pl.r, pl.r * 0.97, 0.5, 32), grassMat);
  top.position.y = -0.25;
  top.receiveShadow = true;
  const dirt = new THREE.Mesh(new THREE.CylinderGeometry(pl.r * 0.97, pl.r * 0.85, 0.7, 24), platformDirtMat);
  dirt.position.y = -0.85;
  const under = new THREE.Mesh(new THREE.ConeGeometry(pl.r * 0.85, pl.r * 2.2, 9), rock.material);
  under.rotation.x = Math.PI;
  under.position.y = -1.2 - pl.r * 1.1;
  const edge = new THREE.Mesh(new THREE.RingGeometry(pl.r * 0.94, pl.r, 40), edgeRing.material);
  edge.rotation.x = -Math.PI / 2;
  edge.position.y = 0.01;
  g.add(top, dirt, under, edge);
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (pl.r - 0.3);
    const t = new THREE.Mesh(tufts.geometry, tufts.material);
    t.position.set(Math.sin(a) * d, 0.1, Math.cos(a) * d);
    t.scale.setScalar(0.7 + Math.random() * 0.7);
    g.add(t);
  }
  const prop = natureProps[Math.random() < 0.5 ? 'Rock002' : 'Bush001'];
  if (prop) {
    // Off to the outer side so the middle stays free to stand on.
    const p = prop.clone(true);
    p.position.set(Math.sin(pl.a) * pl.r * 0.65, 0, Math.cos(pl.a) * pl.r * 0.65);
    g.add(p);
  }
  g.position.set(pl.x, 0, pl.z);
  return g;
}

function updatePlatforms(dt, R, playing) {
  platformGroup.visible = playing;
  if (!playing || !room) return;
  const list = room.platforms || [];
  const key = JSON.stringify(list) + Object.keys(natureProps).length;
  if (key !== platformKey) {
    platformKey = key;
    platformGroup.clear();
    platformMeshes = list.map((pl) => {
      const g = buildPlatform(pl);
      platformGroup.add(g);
      return { g, fallV: 0, spin: (Math.random() - 0.5) * 1.5, bob: Math.random() * 6 };
    });
  }
  const flags = snap?.plat || [];
  platformMeshes.forEach((m, i) => {
    if (flags[i] !== 0) {
      m.g.position.y = 0;
      m.g.visible = true;
      return;
    }
    m.fallV += 16 * dt;
    m.g.position.y -= m.fallV * dt;
    m.g.rotation.z += m.spin * dt;
    m.g.visible = m.g.position.y > -40;
  });
}

// ---------- Picket fences guarding parts of the edge ----------
const FENCE_STEP = 1.1;
const fencePostGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.0, 8);
fencePostGeo.translate(0, 0.5, 0);
const fenceRailGeo = new THREE.BoxGeometry(0.08, 0.1, 1);
const fenceMaxPosts = 200;
const fencePosts = new THREE.InstancedMesh(fencePostGeo, new THREE.MeshStandardMaterial({ color: '#fff3e6', roughness: 0.7 }), fenceMaxPosts);
const fenceRails = new THREE.InstancedMesh(fenceRailGeo, new THREE.MeshStandardMaterial({ color: '#ffb7c9', roughness: 0.6 }), fenceMaxPosts * 2);
fencePosts.castShadow = fenceRails.castShadow = true;
// The instances move every round and as the island shrinks, so a cached bounding sphere goes stale.
fencePosts.frustumCulled = fenceRails.frustumCulled = false;
island.add(fencePosts, fenceRails);
let fenceKey = '';

function updateGuards(R, playing) {
  const guards = playing && room ? room.guards || [] : [];
  const key = JSON.stringify(guards) + R.toFixed(2);
  if (key === fenceKey) return;
  fenceKey = key;
  const rr = R - (room?.guardInset ?? 0.5);
  let np = 0, nr = 0;
  for (const g of guards) {
    const n = Math.min(60, Math.ceil((2 * g.h * ISLAND_MAX) / FENCE_STEP) + 1);
    let prev = null;
    for (let j = 0; j < n && np < fenceMaxPosts; j++) {
      const th = g.c - g.h + (2 * g.h * j) / (n - 1);
      const x = Math.sin(th) * rr, z = Math.cos(th) * rr;
      decoDummy.position.set(x, 0, z);
      decoDummy.rotation.set(0, th, 0);
      decoDummy.scale.setScalar(1);
      decoDummy.updateMatrix();
      fencePosts.setMatrixAt(np++, decoDummy.matrix);
      if (prev) {
        const dx = x - prev[0], dz = z - prev[1], len = Math.hypot(dx, dz);
        for (const y of [0.4, 0.78]) {
          decoDummy.position.set((x + prev[0]) / 2, y, (z + prev[1]) / 2);
          decoDummy.rotation.set(0, Math.atan2(dx, dz), 0);
          decoDummy.scale.set(1, 1, len);
          decoDummy.updateMatrix();
          fenceRails.setMatrixAt(nr++, decoDummy.matrix);
        }
      }
      prev = [x, z];
    }
  }
  fencePosts.count = np;
  fenceRails.count = nr;
  fencePosts.instanceMatrix.needsUpdate = true;
  fenceRails.instanceMatrix.needsUpdate = true;
}

// ---------- Bomb explosions ----------
function explosion(x, y, z, sticky) {
  y += island.position.y;
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.6, 20, 14), new THREE.MeshBasicMaterial({ color: sticky ? '#c9ffb0' : '#fff1a8', transparent: true }));
  flash.position.set(x, y, z);
  addEffect(flash, { vel: new THREE.Vector3(), life: 0.35, max: 0.35, grow: 5.5, gravity: 0 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, island.position.y + 0.08, z);
  addEffect(ring, { vel: new THREE.Vector3(), life: 0.45, max: 0.45, grow: BOMB_RADIUS * 1.3, gravity: 0 });
  puff(x, y, z, 16, sticky ? '#7dff9a' : '#ffad5c', 5);
  puff(x, y + 0.6, z, 10, '#ffffff', 3.5);
  puff(x, y + 0.3, z, 8, sticky ? '#3fbf6a' : '#7b6c8c', 2.5);
  comicWord(x, y + 1.5, z, true, WEAPON_INFO[sticky ? 'sticky' : 'bomb'].words);
  const me = critters.get(myId);
  const d = me ? Math.hypot(me.x - x, me.z - z) : 10;
  shake = Math.max(shake, d < 8 ? 1.1 : 0.5);
}

// ---------- Weapons on the ground and foam-ball shots ----------
const pickups = new Map();
const shotMeshes = new Map();
function syncItems(s, dt) {
  const showItems = s && s.phase !== 'lobby' && room?.phase !== 'lobby';
  const seen = new Set();
  for (const it of showItems ? s.items || [] : []) {
    seen.add(it.i);
    let p = pickups.get(it.i);
    if (!p) {
      p = buildPickup(it.t);
      p.root.position.set(it.x, it.y, it.z);
      p.baseY = p.holder.position.y;
      p.ringS = p.ring.scale.x;
      scene.add(p.root);
      pickups.set(it.i, p);
    }
    const info = WEAPON_INFO[it.t] || {};
    const victim = it.k && critters.get(it.k);
    if (victim) {
      // Stuck on someone's back.
      const bx = victim.x - Math.sin(victim.face) * 0.55, bz = victim.z - Math.cos(victim.face) * 0.55;
      p.root.position.set(bx, victim.root.position.y + (victim.height || 2.3) * 0.45, bz);
      p.root.rotation.y = victim.face;
      p.holder.rotation.x = -0.5;
      p.holder.position.y = p.baseY;
      p.ring.visible = p.glow.visible = false;
    } else {
      const k = 1 - Math.exp(-dt * 14);
      if (Math.abs(it.y - (p.root.position.y - island.position.y)) > 6) p.root.position.y = it.y + island.position.y;
      p.root.position.x += (it.x - p.root.position.x) * k;
      p.root.position.y += (it.y + island.position.y - p.root.position.y) * k;
      p.root.position.z += (it.z - p.root.position.z) * k;
      const landed = it.y < 0.05;
      p.root.rotation.y = it.r;
      // Tumble while airborne, then settle and bob gently (bombs just sit and fizz).
      p.holder.rotation.x = landed ? 0 : p.holder.rotation.x + dt * (info.bomb ? 3 : 6);
      p.holder.position.y = p.baseY + (landed && !info.bomb ? Math.abs(Math.sin(time * 2.5 + it.i)) * 0.08 : 0);
      p.ring.visible = p.glow.visible = landed;
      p.ring.scale.setScalar(p.ringS * (1 + Math.sin(time * 5 + it.i) * 0.06));
    }
    if (info.bomb) {
      animateBomb(p.model, it.f, time);
      if (it.f >= 0 && Math.random() < dt * 14) {
        const sp = p.model.userData.spark.getWorldPosition(tmpSpark);
        sparkle(sp.x, sp.y, sp.z);
      }
    }
  }
  for (const [id, p] of pickups) if (!seen.has(id)) { scene.remove(p.root); pickups.delete(id); }

  const seenShots = new Set();
  const age = Math.min(0.1, (performance.now() - snapTime) / 1000);
  for (const sh of showItems ? s.shots || [] : []) {
    seenShots.add(sh.i);
    let m = shotMeshes.get(sh.i);
    if (!m) { m = buildShot(); scene.add(m); shotMeshes.set(sh.i, m); }
    m.position.set(sh.x + sh.vx * age, sh.y, sh.z + sh.vz * age);
  }
  for (const [id, m] of shotMeshes) if (!seenShots.has(id)) { scene.remove(m); shotMeshes.delete(id); }
}

const tmpSpark = new THREE.Vector3();
const sparkGeo = new THREE.SphereGeometry(0.05, 6, 4);
function sparkle(x, y, z) {
  const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: Math.random() < 0.5 ? '#ffd15a' : '#ff8a3d', transparent: true }));
  m.position.set(x, y, z);
  const a = Math.random() * Math.PI * 2;
  addEffect(m, { vel: new THREE.Vector3(Math.cos(a) * 1.5, 1.5 + Math.random() * 1.5, Math.sin(a) * 1.5), life: 0.35, max: 0.35, gravity: 8 });
}

const sweatGeo = new THREE.SphereGeometry(0.07, 8, 6);
function sweat(c) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const h = c.height || 2.3;
  const m = new THREE.Mesh(sweatGeo, new THREE.MeshStandardMaterial({ color: '#a8dcff', emissive: '#a8dcff', emissiveIntensity: 0.4, transparent: true }));
  m.scale.set(0.8, 1.2, 0.8);
  m.position.set(c.x + Math.cos(c.face) * side * 0.5, c.y + h * 0.85, c.z - Math.sin(c.face) * side * 0.5);
  addEffect(m, { vel: new THREE.Vector3(Math.cos(c.face) * side * 1.5, 2.2, -Math.sin(c.face) * side * 1.5), life: 0.55, max: 0.55, gravity: 10 });
}

const tipV = new THREE.Vector3();
// Heavy weapons are dragged along the ground with both hands, heaved overhead
// during the wind-up, then slammed forward. The blaster is carried at the hip.
function updateHeldWeapon(c, dt, s) {
  const type = s && s.st === 'alive' && !s.fl ? s.w || '' : '';
  if (type !== (c.weaponType || '')) {
    if (c.weaponMesh) c.weaponMesh.parent?.remove(c.weaponMesh);
    c.weaponMesh = null;
    c.weaponType = type;
    if (type) {
      const info = WEAPON_INFO[type];
      const holder = new THREE.Group();
      holder.add(buildWeapon(type));
      const r = c.restArm?.[1];
      const g = r ? new THREE.Vector3(r.x * 0.8, r.y * 0.9, 0.3) : new THREE.Vector3(0.5, (c.height || 2.3) * 0.33, 0.25);
      c.grip = g;
      const beta = Math.acos(Math.min(1, Math.max(0, (g.y - 0.3) / info.len)));
      c.dragTheta = -(Math.PI - beta);
      // Start on the ground so the pickup reads as a heave.
      holder.position.set(g.x, 0.2, g.z + 0.3);
      holder.rotation.set(info.ranged || info.bomb ? 0 : -Math.PI / 2, 0, 0);
      if (info.bomb) holder.scale.setScalar(0.8);
      c.pivot.add(holder);
      c.weaponMesh = holder;
      c.wPhase = 'drag';
      c.wLean = 0;
      c.sweatT = 0.3;
    }
  }
  if (!c.weaponMesh) { c.wLean = 0; return; }

  const info = WEAPON_INFO[type];
  const wm = c.weaponMesh, g = c.grip;
  const sw = s ? s.sw || 0 : 0;
  const phase = sw === 1 ? 'wind' : sw === 2 ? 'strike' : 'drag';
  if (phase !== c.wPhase) {
    if (phase === 'wind') c.sq += 0.25;
    if (phase === 'strike') { c.sq -= 0.35; if (c.id === myId) shake = Math.max(shake, 0.15); }
    c.wPhase = phase;
  }
  const moving = Math.hypot(c.dvx, c.dvz) > 1;
  let px, py, pz, rx, rz, lean, k;
  if (info.bomb) {
    // Held up in front with both paws, fuse fizzing.
    px = 0; py = g.y - 0.15 + Math.sin(time * 9) * 0.03; pz = 0.75;
    rx = 0; rz = 0; lean = 0.08; k = 14;
    animateBomb(wm.children[0], s ? s.wf ?? -1 : -1, time);
    if (s && s.wf >= 0 && Math.random() < dt * 14) {
      const sp = wm.children[0].userData.spark.getWorldPosition(tmpSpark);
      sparkle(sp.x, sp.y, sp.z);
    }
  } else if (info.ranged) {
    const recoil = phase === 'strike' ? 1 : 0;
    px = g.x * 0.7; py = g.y + 0.1; pz = 0.45 - recoil * 0.2;
    rx = -0.05 - recoil * 0.4; rz = 0; lean = 0; k = 18;
  } else if (phase === 'wind') {
    // Struggling to lift it: trembling, leaning back.
    px = g.x * 0.25; py = g.y + 0.75; pz = -0.1;
    rx = -0.4 + Math.sin(time * 45) * 0.06; rz = 0; lean = -0.38; k = 7;
  } else if (phase === 'strike') {
    px = g.x * 0.2; py = g.y + 0.3; pz = 0.5;
    rx = 1.95; rz = 0; lean = 0.42; k = 38;
  } else {
    px = g.x; py = g.y; pz = g.z;
    rx = c.dragTheta + (moving ? Math.abs(Math.sin(c.walk * 1.3)) * 0.1 : 0);
    rz = -0.22; lean = moving ? 0.16 : 0.05; k = 7;
  }
  const f = 1 - Math.exp(-dt * k);
  wm.position.x += (px - wm.position.x) * f;
  wm.position.y += (py - wm.position.y) * f;
  wm.position.z += (pz - wm.position.z) * f;
  wm.rotation.x += (rx - wm.rotation.x) * f;
  wm.rotation.z += (rz - wm.rotation.z) * f;
  c.wLean += (lean - c.wLean) * (1 - Math.exp(-dt * 10));
  c.pivot.rotation.x += c.wLean;

  // Effort: sweat drops and dust kicked up by the dragging tip.
  if (!info.ranged && !info.bomb && (moving || phase === 'wind')) {
    c.sweatT -= dt;
    if (c.sweatT <= 0) {
      c.sweatT = 0.45 + Math.random() * 0.4;
      sweat(c);
      if (phase === 'drag') {
        wm.localToWorld(tipV.set(0, info.len, 0));
        puff(tipV.x, Math.max(0.1, tipV.y), tipV.z, 2, '#f3e6d6', 0.8);
      }
    }
  }
}

// ---------- Audio ----------
let audio = null;
let noiseBuf = null;
function initAudio() {
  if (audio) return;
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = audio.createBuffer(1, audio.sampleRate * 0.5, audio.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { audio = null; }
}
function tone({ type = 'sine', f0, f1, dur, vol = 0.2, delay = 0 }) {
  if (!audio) return;
  const t = audio.currentTime + delay;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}
function noise({ dur, vol, f0, f1, q = 1, type = 'lowpass' }) {
  if (!audio) return;
  const t = audio.currentTime;
  const src = audio.createBufferSource();
  src.buffer = noiseBuf;
  const filt = audio.createBiquadFilter();
  filt.type = type;
  filt.Q.value = q;
  filt.frequency.setValueAtTime(f0, t);
  filt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = audio.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(audio.destination);
  src.start(t);
  src.stop(t + dur);
}
const sfx = {
  swing: () => noise({ dur: 0.12, vol: 0.08, f0: 800, f1: 2500, q: 2, type: 'bandpass' }),
  hit: (big) => {
    noise({ dur: 0.15, vol: 0.35, f0: 1200, f1: 200 });
    tone({ f0: big ? 220 : 160, f1: 60, dur: 0.18, vol: 0.25 });
  },
  jump: () => tone({ type: 'triangle', f0: 280, f1: 620, dur: 0.15, vol: 0.08 }),
  land: () => tone({ f0: 120, f1: 50, dur: 0.12, vol: 0.12 }),
  grab: () => tone({ type: 'triangle', f0: 480, f1: 760, dur: 0.1, vol: 0.09 }),
  throw: () => {
    noise({ dur: 0.35, vol: 0.15, f0: 400, f1: 3000, q: 1.5, type: 'bandpass' });
    tone({ type: 'triangle', f0: 400, f1: 1000, dur: 0.4, vol: 0.08 });
  },
  ko: () => [0, 0.12, 0.24].forEach((d, i) => tone({ type: 'sine', f0: 900 - i * 150, f1: 700 - i * 150, dur: 0.12, vol: 0.08, delay: d })),
  fall: () => tone({ f0: 1000, f1: 140, dur: 1.1, vol: 0.12 }),
  beep: (hi) => tone({ type: 'square', f0: hi ? 880 : 520, f1: hi ? 880 : 520, dur: hi ? 0.35 : 0.15, vol: 0.05 }),
  pickup: () => [660, 880, 1320].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f * 1.05, dur: 0.09, vol: 0.08, delay: i * 0.06 })),
  shoot: () => {
    tone({ type: 'square', f0: 900, f1: 180, dur: 0.14, vol: 0.06 });
    noise({ dur: 0.1, vol: 0.12, f0: 3000, f1: 600, q: 1, type: 'bandpass' });
  },
  whoosh: () => noise({ dur: 0.22, vol: 0.14, f0: 500, f1: 2600, q: 1.5, type: 'bandpass' }),
  clang: () => [1200, 1750, 2600].forEach((f) => tone({ type: 'sine', f0: f, f1: f * 0.98, dur: 0.45, vol: 0.05 })),
  squeak: () => tone({ type: 'sine', f0: 1500, f1: 2600, dur: 0.16, vol: 0.12 }),
  breakIt: () => {
    noise({ dur: 0.3, vol: 0.25, f0: 2500, f1: 300 });
    tone({ type: 'triangle', f0: 500, f1: 150, dur: 0.3, vol: 0.08 });
  },
  drop: () => tone({ f0: 300, f1: 140, dur: 0.1, vol: 0.08 }),
  heave: () => tone({ type: 'triangle', f0: 180, f1: 320, dur: 0.35, vol: 0.09 }),
  squawk: () => [0, 0.09].forEach((d) => tone({ type: 'sawtooth', f0: 900, f1: 1400, dur: 0.08, vol: 0.05, delay: d })),
  boom: () => {
    noise({ dur: 0.9, vol: 0.6, f0: 1800, f1: 60 });
    tone({ f0: 110, f1: 30, dur: 0.7, vol: 0.35 });
  },
  whistle: () => tone({ type: 'sine', f0: 1900, f1: 450, dur: 1.6, vol: 0.05 }),
  splat: () => {
    noise({ dur: 0.25, vol: 0.2, f0: 900, f1: 200, q: 1.2 });
    tone({ type: 'sine', f0: 300, f1: 90, dur: 0.25, vol: 0.12 });
  },
  fuse: () => noise({ dur: 0.4, vol: 0.06, f0: 5000, f1: 3000, q: 0.7, type: 'highpass' }),
  splash: () => noise({ dur: 0.35, vol: 0.18, f0: 2500, f1: 400, q: 0.8, type: 'bandpass' }),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f, dur: 0.25, vol: 0.1, delay: i * 0.11 })),
};

// ---------- Critters ----------
const critters = new Map();
const labelsEl = $('labels');

// Model characters show a jelly stand-in until their .glb has finished loading.
function buildCharacter(animal) {
  if (animal === 'corgi') return buildCorgi();
  if (!MODEL_CHARACTERS[animal]) return buildCritter(animal);
  if (isModelReady(animal)) return buildModelCritter(animal);
  return Object.assign(buildCritter('bear'), { placeholderFor: animal });
}

function makeCritterEntry(id, animal) {
  const c = buildCharacter(animal);
  scene.add(c.root);
  return Object.assign(c, {
    id, animal,
    x: 0, y: 0, z: 0, face: 0,
    tx: 0, ty: 0, tz: 0, tvx: 0, tvy: 0, tvz: 0, tface: 0,
    dvx: 0, dvz: 0,
    s: null,
    walk: Math.random() * 6,
    lean: 0, leanV: 0, sq: 0, sqV: 0, tilt: 0, tiltV: 0,
    punch: [0, 0], lastPa: 0,
    ko: 0, tumble: 0,
    jx: 0, jz: 0, jvx: 0, jvz: 0, rip: 0, ouch: 0,
    blink: Math.random() * 4,
    label: null,
  });
}

function removeCritter(c) {
  scene.remove(c.root);
  if (c.label) c.label.remove();
}

function rebuildCritter(c) {
  const fresh = makeCritterEntry(c.id, c.animal);
  for (const k of ['x', 'y', 'z', 'face', 'tx', 'ty', 'tz', 'tvx', 'tvy', 'tvz', 'tface', 's', 'label']) fresh[k] = c[k];
  scene.remove(c.root);
  return fresh;
}

for (const id of Object.keys(MODEL_CHARACTERS)) {
  loadModel(id).then(() => {
    for (const [pid, c] of critters) if (c.placeholderFor === id) critters.set(pid, rebuildCritter(c));
    if (preview && preview.placeholderFor === id) setPreview(myAnimal);
  }).catch(() => {});
}

function syncCritters() {
  if (!room) return;
  const ids = new Set(room.players.map((p) => p.id));
  for (const [id, c] of critters) if (!ids.has(id)) { removeCritter(c); critters.delete(id); }
  for (const p of room.players) {
    let c = critters.get(p.id);
    if (c && c.animal !== p.animal) {
      c.animal = p.animal;
      critters.set(p.id, rebuildCritter(c));
    }
    if (!c) critters.set(p.id, makeCritterEntry(p.id, p.animal));
    c = critters.get(p.id);
    if (!c.label) {
      c.label = document.createElement('div');
      c.label.className = 'label' + (p.id === myId ? ' me' : '');
      labelsEl.append(c.label);
    }
    c.label.textContent = p.name;
  }
  if (preview) preview.root.visible = false;
}

// Spring helper: x is position, v is velocity.
function spring(o, key, vKey, target, k, d, dt) {
  o[vKey] += ((target - o[key]) * k - o[vKey] * d) * dt;
  o[key] += o[vKey] * dt;
}

function angleLerp(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

function animateCritter(c, dt, s, opts = {}) {
  const ox = c.x, oz = c.z;
  if (s) {
    const age = Math.min(0.1, (performance.now() - snapTime) / 1000);
    const px = c.tx + c.tvx * age, py = c.ty + c.tvy * age * (s.g ? 0 : 1), pz = c.tz + c.tvz * age;
    if (Math.hypot(px - c.x, pz - c.z) > 4) { c.x = px; c.z = pz; c.y = py; }
    const k = 1 - Math.exp(-dt * 16);
    c.x += (px - c.x) * k;
    c.y += (py - c.y) * k;
    c.z += (pz - c.z) * k;
    c.face = angleLerp(c.face, c.tface, 1 - Math.exp(-dt * 14));
  }
  const vx = (c.x - ox) / Math.max(dt, 1e-3), vz = (c.z - oz) / Math.max(dt, 1e-3);
  const pvx = c.dvx, pvz = c.dvz;
  c.dvx += (vx - c.dvx) * Math.min(1, dt * 10);
  c.dvz += (vz - c.dvz) * Math.min(1, dt * 10);
  const speed = Math.hypot(c.dvx, c.dvz);

  // Jelly wobble: the top of the body lags behind acceleration, in body-local space.
  const ax = (c.dvx - pvx) / Math.max(dt, 1e-3), az = (c.dvz - pvz) / Math.max(dt, 1e-3);
  const cf = Math.cos(c.face), sf = Math.sin(c.face);
  const lax = ax * cf - az * sf, laz = ax * sf + az * cf;
  const clampJ = (v) => Math.max(-0.35, Math.min(0.35, v));
  c.jvx += ((clampJ(-lax * 0.006) - c.jx) * 140 - c.jvx * 5) * dt;
  c.jvz += ((clampJ(-laz * 0.006) - c.jz) * 140 - c.jvz * 5) * dt;
  c.jx += c.jvx * dt;
  c.jz += c.jvz * dt;
  c.rip *= Math.exp(-dt * 3);
  c.ouch = Math.max(0, c.ouch - dt);
  if (c.updateJelly) c.updateJelly(c.jx, c.jz, c.rip + (c.ko > 0.5 ? 0.15 : 0), time);

  const grounded = s ? !!s.g : true;
  const held = s && s.hb;
  const holding = s && s.h;
  const ko = s && s.ko;
  const falling = s && s.fl;
  const airborne = !grounded && !held;

  c.root.position.set(c.x, c.y, c.z);
  c.root.rotation.y = c.face;
  // Wading: sink into the river and kick up splashes.
  const wet = !!(s && s.rv);
  if (wet && !c.wasWet) { puff(c.x, 0.2, c.z, 6, '#cfeeff', 2); if (opts.sound !== false) sfx.splash(); }
  c.wasWet = wet;
  c.wade = (c.wade || 0) + ((wet ? 1 : 0) - (c.wade || 0)) * Math.min(1, dt * 8);
  c.root.position.y -= c.wade * 0.4;
  if (wet && Math.random() < dt * 7) puff(c.x + (Math.random() - 0.5), 0.15, c.z + (Math.random() - 0.5), 1, '#cfeeff', 1.2);

  // Walk cycle
  const amt = grounded ? Math.min(1, speed / 4) : 0;
  c.walk += dt * (2 + speed * 2.4) * (amt > 0.05 ? 1 : 0);
  const sw = Math.sin(c.walk);

  // Lean & squash springs
  spring(c, 'lean', 'leanV', Math.min(0.32, speed * 0.04), 120, 9, dt);
  spring(c, 'sq', 'sqV', 0, 220, 8, dt);
  const heavy = c.weaponType && !WEAPON_INFO[c.weaponType]?.ranged ? 2.4 : 1;
  spring(c, 'tilt', 'tiltV', sw * 0.1 * amt * heavy + (held ? Math.sin(time * 18) * 0.3 : 0), 160, 10, dt);

  c.ko += ((ko ? 1 : 0) - c.ko) * Math.min(1, dt * 8);
  if (falling) c.tumble += dt * 5; else c.tumble *= Math.exp(-dt * 10);

  const isModel = c.kind === 'model';
  const p = c.pivot;
  const bounce = Math.abs(sw) * 0.08 * amt * (isModel && c.animated ? 0 : 1) + (opts.hop ? Math.abs(Math.sin(time * 7)) * 0.6 : 0);
  p.position.y = bounce;
  const koTip = isModel && c.hasKoClip ? 0 : c.ko;
  const leanAmt = isModel && c.animated ? 0.4 : 1;
  p.rotation.set(c.lean * leanAmt * (1 - c.ko) - koTip * 1.45 + c.tumble, 0, c.tilt * leanAmt);
  const sq = c.sq * (isModel ? 0.5 : 1);
  p.scale.set(1 - sq * 0.5, 1 + sq, 1 - sq * 0.5);
  updateHeldWeapon(c, dt, s);

  if (isModel) {
    animateModel(c, dt, { s, speed, held, holding, ko, falling, airborne, opts });
    c.stars.visible = c.ko > 0.3;
    if (c.stars.visible) {
      c.stars.rotation.y += dt * 4;
      c.stars.position.y = c.hasKoClip ? 0.9 : c.height * 0.55 + 0.3;
    }
    c.root.visible = !(s && s.st === 'out' && room?.phase !== 'lobby');
    return;
  }

  // Feet: kick around when airborne, lift into the air when knocked flat
  const kick = airborne || held || falling ? Math.sin(time * 18) * 0.2 : 0;
  const koLift = c.ko * 0.5;
  c.footL.position.set(-0.34, 0.13 + Math.max(0, sw) * 0.16 * amt + koLift + kick, 0.08 + sw * 0.28 * amt + koLift * 0.8);
  c.footR.position.set(0.34, 0.13 + Math.max(0, -sw) * 0.16 * amt + koLift - kick, 0.08 - sw * 0.28 * amt + koLift * 0.8);

  // Arms
  if (s && s.pa && s.pa !== c.lastPa && !c.weaponType) c.punch[s.pa - 1] = 1;
  c.lastPa = s ? s.pa : 0;
  c.punch[0] = Math.max(0, c.punch[0] - dt * 4.5);
  c.punch[1] = Math.max(0, c.punch[1] - dt * 4.5);

  [c.armL, c.armR].forEach((arm, i) => {
    const side = i === 0 ? -1 : 1;
    const rest = c.restArm[i];
    let tx = rest.x, ty = rest.y + Math.sin(time * 2.5 + i) * 0.03, tz = rest.z - side * sw * 0.3 * amt;
    if (holding) { tx = side * 0.5; ty = 1.65; tz = 0.9; }
    else if (c.weaponMesh && !(c.ko > 0.5)) {
      const wp = c.weaponMesh.position;
      tx = wp.x + (i === 0 ? -0.3 : 0.06);
      ty = wp.y + (i === 0 ? 0.08 : -0.04);
      tz = wp.z + (i === 0 ? 0.08 : 0);
    }
    else if (airborne || held || falling) {
      tx = side * 1.05; ty = 2.0 + Math.sin(time * 22 + i * 2) * 0.15; tz = 0.05;
    } else if (c.ko > 0.5) {
      tx = side * 1.15; ty = 1.0; tz = 0.4;
    } else if (opts.wave && i === 1) {
      tx = 0.95 + Math.sin(time * 9) * 0.12; ty = 2.05; tz = 0.25;
    }
    const pn = c.punch[i];
    if (pn > 0) {
      const e = Math.sin(pn * Math.PI);
      tx = side * 0.45 * (1 - e) + side * 0.2 * e;
      ty = 1.35;
      tz = 0.35 + e * 1.05;
    }
    const k = 1 - Math.exp(-dt * (c.weaponMesh ? 40 : 22));
    arm.position.x += (tx - arm.position.x) * k;
    arm.position.y += (ty - arm.position.y) * k;
    arm.position.z += (tz - arm.position.z) * k;
    arm.scale.setScalar(1 + pn * 0.35);
  });
  if (c.punch[0] > 0 || c.punch[1] > 0) p.rotation.y = (c.punch[1] - c.punch[0]) * 0.35;
  c.updateLimbs(bounce);

  // Eyes: blink, squeeze shut when KO'd or falling
  c.blink -= dt;
  if (c.blink < -0.12) c.blink = 2 + Math.random() * 4;
  const shut = c.blink < 0 || c.ko > 0.5 || falling;
  for (const e of c.eyes) e.scale.y = shut ? 0.12 : 1;

  // Expressions: angry brows while fighting, open mouth when hurt or flying
  const angry = c.punch[0] > 0 || c.punch[1] > 0 || holding;
  for (const b of c.brows) {
    const target = angry ? -b.userData.side * 0.45 : c.ouch > 0 || held || falling ? b.userData.side * 0.35 : 0;
    b.userData.tilt = (b.userData.tilt || 0) + (target - (b.userData.tilt || 0)) * Math.min(1, dt * 12);
    b.rotation.z = Math.PI / 2 + b.userData.tilt;
  }
  const yell = c.ouch > 0 || held || falling || airborne || c.ko > 0.5;
  c.openMouth.visible = yell;
  c.smile.visible = !yell && c.smileDefault !== false;

  c.stars.visible = c.ko > 0.3;
  if (c.stars.visible) {
    c.stars.rotation.y += dt * 4;
    c.stars.position.set(0, 1.3 + c.ko * 0.2, -c.ko * 1.2);
  }
  if (s && s.dz > 55 && !ko) p.rotation.z += Math.sin(time * 8) * 0.08;

  c.root.visible = !(s && s.st === 'out' && room?.phase !== 'lobby');
}

function animateModel(c, dt, { s, speed, held, holding, ko, falling, airborne, opts }) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  if (s && s.pa && s.pa !== c.lastPa) {
    c.punchT = 0.45;
    c.setState('punch', { restart: true, duration: 0.45 });
  }
  c.lastPa = s ? s.pa : 0;
  c.punchT = Math.max(0, (c.punchT || 0) - dt);
  if (c.punchT <= 0) {
    if (ko) c.setState('ko');
    else if (held) c.setState('held');
    else if (falling || (airborne && (s?.vy || 0) < -2)) c.setState('fall');
    else if (airborne) c.setState('jump');
    else if (holding) c.setState('carry', { timeScale: clamp(speed / 3, 0.6, 1.4) });
    else if (opts.hop) c.setState('win');
    else if (opts.wave && speed < 0.5) c.setState('wave');
    else if (speed > 4.5) c.setState('run', { timeScale: clamp(speed / 6, 0.7, 1.4) });
    else if (speed > 0.4) c.setState('walk', { timeScale: clamp(speed / 2.5, 0.6, 1.6) });
    else c.setState('idle');
  }
  c.update(dt);
}

// Menu preview critter
let preview = null;
function setPreview(animal) {
  if (preview) scene.remove(preview.root);
  preview = makeCritterEntry('preview', animal);
  preview.face = 0.4;
  preview.sq = -0.35;
}
setPreview(myAnimal);

// ---------- Effects ----------
const effects = [];
const puffGeo = new THREE.SphereGeometry(0.25, 12, 8);
const wordCache = new Map();
function wordTexture(word, color) {
  const key = word + color;
  if (wordCache.has(key)) return wordCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  g.translate(128, 64);
  g.fillStyle = '#ffffff';
  g.beginPath();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = i % 2 ? 46 : 62;
    g.lineTo(Math.cos(a) * r * 1.7, Math.sin(a) * r * 0.9);
  }
  g.fill();
  g.font = '700 54px Fredoka, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.strokeStyle = '#5a4a6b';
  g.strokeText(word, 0, 4);
  g.fillStyle = color;
  g.fillText(word, 0, 4);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  wordCache.set(key, tex);
  return tex;
}

function addEffect(obj, data) {
  scene.add(obj);
  effects.push({ obj, ...data });
}

function puff(x, y, z, n, color = '#ffffff', spread = 3) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(puffGeo, new THREE.MeshStandardMaterial({ color, transparent: true, roughness: 1, emissive: color, emissiveIntensity: 0.3 }));
    m.position.set(x, y, z);
    const a = Math.random() * Math.PI * 2;
    addEffect(m, {
      vel: new THREE.Vector3(Math.cos(a) * spread * Math.random(), Math.random() * 2.5, Math.sin(a) * spread * Math.random()),
      life: 0.5 + Math.random() * 0.3, max: 0.8, grow: 1.5 + Math.random(), gravity: 0,
    });
  }
}

function comicWord(x, y, z, big, custom) {
  const words = custom || (big ? ['KO!', 'WHAM!'] : ['POW!', 'BONK!', 'BOP!', 'THWACK!', 'BAM!']);
  const colors = ['#ff8fa3', '#7cc8f0', '#ffcf5a', '#9b86e0'];
  const word = words[Math.floor(Math.random() * words.length)];
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: wordTexture(word, colors[Math.floor(Math.random() * colors.length)]), transparent: true, depthTest: false }));
  sp.position.set(x, y + 0.8, z);
  sp.scale.set(0.1, 0.05, 1);
  sp.renderOrder = 10;
  addEffect(sp, { vel: new THREE.Vector3(0, 1.5, 0), life: 0.75, max: 0.75, word: big ? 3.2 : 2.2, gravity: 0 });
}

function confetti(x, y, z) {
  const colors = ['#ff9aa2', '#a0e7e5', '#b5ead7', '#fff3a0', '#c7b8ff', '#ffb7e0'];
  const geo = new THREE.PlaneGeometry(0.18, 0.1);
  for (let i = 0; i < 120; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide, transparent: true }));
    m.position.set(x, y + 2, z);
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
    addEffect(m, {
      vel: new THREE.Vector3(Math.cos(a) * sp, 6 + Math.random() * 6, Math.sin(a) * sp),
      life: 2.5 + Math.random(), max: 3.5, gravity: 9, spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0), drag: 1.5,
    });
  }
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    if (e.life <= 0) {
      scene.remove(e.obj);
      e.obj.material.dispose();
      effects.splice(i, 1);
      continue;
    }
    if (e.drag) e.vel.multiplyScalar(Math.exp(-e.drag * dt));
    e.vel.y -= (e.gravity || 0) * dt;
    e.obj.position.addScaledVector(e.vel, dt);
    const t = 1 - e.life / e.max;
    if (e.word) {
      const pop = t < 0.15 ? t / 0.15 : 1 + Math.sin(t * 20) * 0.03;
      e.obj.scale.set(e.word * pop, e.word * 0.5 * pop, 1);
      e.obj.material.opacity = Math.min(1, e.life * 4);
    } else if (e.grow) {
      e.obj.scale.setScalar(1 + t * e.grow);
      e.obj.material.opacity = 1 - t;
    } else {
      if (e.spin) { e.obj.rotation.x += e.spin.x * dt; e.obj.rotation.y += e.spin.y * dt; }
      e.obj.material.opacity = Math.min(1, e.life);
    }
  }
}

// ---------- Menu / lobby UI ----------
const nameInput = $('nameInput');
const codeInput = $('codeInput');
nameInput.value = localStorage.getItem('bb-name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) codeInput.value = urlRoom.toUpperCase();

function buildPicker(el, onPick) {
  el.innerHTML = '';
  for (const key of ANIMAL_KEYS) {
    const b = document.createElement('button');
    b.dataset.animal = key;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = CHARACTERS[key].color;
    b.append(sw, CHARACTERS[key].label);
    b.onclick = () => onPick(key);
    el.append(b);
  }
}
function markPicker() {
  document.querySelectorAll('.animal-picker button').forEach((b) => b.classList.toggle('selected', b.dataset.animal === myAnimal));
}
function pickAnimal(key) {
  myAnimal = key;
  localStorage.setItem('bb-animal', key);
  markPicker();
  if (!room) setPreview(key);
  else socket.emit('setAnimal', key);
  initAudio();
  sfx.jump();
}
buildPicker($('animalPicker'), pickAnimal);
buildPicker($('lobbyPicker'), pickAnimal);
markPicker();

function getName() {
  const n = nameInput.value.trim() || 'Buddy' + Math.floor(Math.random() * 100);
  localStorage.setItem('bb-name', n);
  return n;
}
const isInstalled = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
function goFullscreen() {
  if (!isTouch || document.fullscreenElement || !document.fullscreenEnabled) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation?.lock?.('landscape'))
    .catch(() => {});
}
function updateScreenUi() {
  $('fullscreenBtn').classList.toggle('hidden', !isTouch || isInstalled || !document.fullscreenEnabled || !!document.fullscreenElement);
  $('rotateHint').classList.toggle('hidden', !isTouch || !myId || innerWidth > innerHeight);
}
$('fullscreenBtn').onclick = goFullscreen;
document.addEventListener('fullscreenchange', updateScreenUi);
window.addEventListener('resize', updateScreenUi);
updateScreenUi();
$('createBtn').onclick = () => { initAudio(); goFullscreen(); socket.emit('create', { name: getName(), animal: myAnimal }); };
$('joinBtn').onclick = () => {
  initAudio();
  goFullscreen();
  if (codeInput.value.trim().length !== 4) return showError('Enter a 4-letter room code');
  socket.emit('join', { code: codeInput.value, name: getName(), animal: myAnimal });
};
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') (codeInput.value ? $('joinBtn') : $('createBtn')).click(); });

// A host playing on localhost needs to hand phones the laptop's Wi-Fi address instead.
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let shareOrigin = location.origin;
if (isLocalHost) {
  fetch('/lan').then((r) => r.json()).then(({ urls }) => {
    if (urls.length) { shareOrigin = urls[0]; renderShareUrl(); }
  }).catch(() => {});
}
function inviteLink() { return `${shareOrigin}/?room=${room.code}`; }
function renderShareUrl() {
  if (!room) return;
  $('shareUrl').textContent = inviteLink().replace(/^https?:\/\//, '');
}
$('copyBtn').onclick = async () => {
  const link = inviteLink();
  try { await navigator.clipboard.writeText(link); $('copyBtn').textContent = 'Copied!'; }
  catch { $('copyBtn').textContent = link; }
  setTimeout(() => ($('copyBtn').textContent = 'Copy invite link'), 1800);
};
if (isTouch) {
  document.querySelector('.controls-grid').innerHTML =
    '<span><b>Drag</b> anywhere to move</span><span><b>JUMP</b> button</span>' +
    '<span><b>PUNCH</b> button</span><span><b>Hold GRAB</b></span>' +
    '<span class="wide">Tap PUNCH while grabbing to <b>THROW</b></span>' +
    '<span class="wide"><b>PICK UP</b> ✨ weapons, then <b>SWING</b> / <b>SHOOT</b></span>' +
    '<span class="wide"><b>🎥 Follow</b> cam: drag the right side to look around</span>';
}
$('startBtn').onclick = () => socket.emit('start');
for (const b of document.querySelectorAll('#teamPicker button')) {
  b.onclick = () => { if (room && room.hostId === myId) socket.emit('setTeams', Number(b.dataset.size)); };
}
$('addBotBtn').onclick = () => socket.emit('addBot');
$('removeBotsBtn').onclick = () => socket.emit('removeBots');

function showError(msg) {
  $('menuError').textContent = msg;
  setTimeout(() => ($('menuError').textContent = ''), 3000);
}

socket.on('errorMsg', showError);
socket.on('joined', ({ code, id }) => {
  myId = id;
  history.replaceState(null, '', `?room=${code}`);
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('touchButtons').classList.toggle('desktop', !isTouch);
  $('viewBtn').classList.remove('hidden');
  updateScreenUi();
});

socket.on('room', (r) => {
  room = r;
  buildObstacles();
  syncCritters();
  renderLobby();
  renderScoreboard();
  onPhase(r.phase);
});

function playerItem(p, extra = '') {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = teamOf(p) >= 0 ? TEAM_COLORS[p.team] : CHARACTERS[p.animal]?.color || '#ccc';
  const name = document.createElement('span');
  name.textContent = p.name + (p.id === myId ? ' (you)' : '');
  li.append(dot, name);
  if (extra) {
    const tag = document.createElement('span');
    tag.className = extra.startsWith('score') ? 'score' : 'tag';
    tag.textContent = extra.replace(/^score:/, '');
    li.append(tag);
  }
  return li;
}

function renderLobby() {
  if (!room) return;
  $('roomCode').textContent = room.code;
  renderShareUrl();
  const list = $('playerList');
  list.innerHTML = '';
  for (const p of room.players) {
    const tag = [p.id === room.hostId ? 'host' : p.isBot ? 'bot' : '', CHARACTERS[p.animal]?.label].filter(Boolean).join(' · ');
    list.append(playerItem(p, tag));
  }
  const isHost = room.hostId === myId;
  for (const b of document.querySelectorAll('#teamPicker button')) b.classList.toggle('on', Number(b.dataset.size) === room.teamSize);
  $('teamPicker').classList.toggle('locked', !isHost);
  $('teamNote').classList.toggle('hidden', !room.teamSize);
  $('teamNote').textContent = room.teamSize
    ? `Teams of ${room.teamSize} are shuffled when the round starts. Friendly fire is ON, so watch your swings! Last team standing wins.`
    : '';
  $('hostControls').classList.toggle('hidden', !isHost);
  $('waitingText').classList.toggle('hidden', isHost);
  $('startBtn').textContent = room.players.length < 2 ? 'Start (practice)' : 'Start Round';
  const me = room.players.find((p) => p.id === myId);
  if (me) { myAnimal = me.animal; markPicker(); }
}

function renderScoreboard() {
  if (!room) return;
  const sb = $('scoreboard');
  sb.innerHTML = '';
  const states = new Map((snap?.players || []).map((p) => [p.id, p.st === 'out' || p.fl]));
  const teams = room.players.some((p) => teamOf(p) >= 0);
  let lastTeam = null;
  [...room.players].sort((a, b) => (teams ? a.team - b.team : 0) || b.score - a.score).forEach((p) => {
    if (teams && p.team !== lastTeam) {
      lastTeam = p.team;
      const head = document.createElement('li');
      head.className = 'team-head';
      head.style.setProperty('--team', TEAM_COLORS[p.team] || '#aaa');
      head.textContent = `${TEAM_NAMES[p.team] || 'Solo'} Team`;
      sb.append(head);
    }
    const li = playerItem(p, 'score:' + p.score);
    if (room.phase !== 'lobby' && states.get(p.id)) li.classList.add('out');
    sb.append(li);
  });
}

// Team colours only apply once a round has assigned teams.
function teamOf(p) {
  return room && room.phase !== 'lobby' && room.teamSize && p.team >= 0 ? p.team : -1;
}

const teamRingGeo = new THREE.RingGeometry(0.85, 1.05, 36);
function updateTeamMarker(c, p) {
  const t = teamOf(p);
  if (!c.teamRing || c.teamRing.parent !== c.root) {
    c.teamRing = new THREE.Mesh(teamRingGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false }));
    c.teamRing.rotation.x = -Math.PI / 2;
    c.teamRing.position.y = 0.05;
    c.root.add(c.teamRing);
  }
  c.teamRing.visible = t >= 0 && !(c.s && c.s.fl);
  if (t >= 0) c.teamRing.material.color.set(TEAM_COLORS[t]);
  const cls = 'label' + (p.id === myId ? ' me' : '') + (t >= 0 ? ' team' : '');
  if (c.label.className !== cls) c.label.className = cls;
  if (t >= 0) c.label.style.setProperty('--team', TEAM_COLORS[t]);
}

function onPhase(phase) {
  if (phase === lastPhase) return;
  lastPhase = phase;
  $('lobby').classList.toggle('hidden', phase !== 'lobby');
  $('scoreboard').classList.toggle('hidden', phase === 'lobby');
  $('touchButtons').classList.toggle('hidden', phase === 'lobby');
  if (phase === 'lobby') setBanner('');
  if (phase === 'roundover') {
    const w = room.players.find((p) => p.id === room.winnerId);
    if (room.winnerTeam >= 0) {
      const team = room.players.filter((p) => p.team === room.winnerTeam);
      const mine = team.some((p) => p.id === myId);
      setBanner(mine ? 'Your team wins! 🎉' : `${TEAM_NAMES[room.winnerTeam]} Team wins!`, team.map((p) => p.name).join(' · '));
      sfx.win();
      for (const p of team) {
        const c = critters.get(p.id);
        if (c) confetti(c.x, c.y, c.z);
      }
    } else if (w) {
      setBanner(w.id === myId ? 'You win! 🎉' : `${w.name} wins!`, 'Back to lobby soon…');
      sfx.win();
      const c = critters.get(w.id);
      if (c) confetti(c.x, c.y, c.z);
    } else {
      setBanner('Everyone fell!', 'Nobody survived');
    }
  }
}

let bannerText = '';
function setBanner(text, sub = '') {
  const html = text ? `${text}${sub ? `<small>${sub}</small>` : ''}` : '';
  if (html === bannerText) return;
  bannerText = html;
  const el = $('banner');
  el.innerHTML = html;
  el.classList.remove('bump');
  void el.offsetWidth;
  if (text) el.classList.add('bump');
}

// ---------- State sync ----------
let lastCount = -1;
socket.on('state', (s) => {
  snap = s;
  snapTime = performance.now();
  if (s.phase !== 'lobby') {
    for (const p of s.players) {
      const c = critters.get(p.id);
      if (!c) continue;
      if (c.s && c.s.st !== 'alive' && p.st === 'alive') { c.x = p.x; c.y = p.y; c.z = p.z; c.face = p.f; }
      c.tx = p.x; c.ty = p.y; c.tz = p.z;
      c.tvx = p.vx; c.tvy = p.vy; c.tvz = p.vz;
      c.tface = p.f;
      c.s = p;
    }
  }
  for (const e of s.events) handleEvent(e);

  if (s.phase === 'countdown') {
    const n = Math.ceil(s.countdown - s.phaseTime);
    if (n !== lastCount && n > 0) { lastCount = n; sfx.beep(false); }
    const mine = room?.players.find((p) => p.id === myId);
    const t = mine ? teamOf(mine) : -1;
    setBanner(String(Math.max(1, n)), t >= 0 ? `You're on the <span style="color:${TEAM_COLORS[t]}">${TEAM_NAMES[t]} Team</span>` : '');
  } else if (s.phase === 'playing') {
    if (lastCount !== 0) { lastCount = 0; sfx.beep(true); }
    const me = s.players.find((p) => p.id === myId);
    if (s.phaseTime < 1) setBanner('BRAWL!');
    else if (me && (me.st === 'out' || me.fl)) setBanner('You fell off!', 'Spectating…');
    else setBanner('');
  } else {
    lastCount = -1;
  }
  renderScoreboard();
});

function handleEvent(e) {
  const c = critters.get(e.id);
  if (e.t === 'hit') {
    const target = critters.get(e.b);
    if (target) { target.sq -= e.big ? 0.4 : 0.28; target.leanV -= 9; target.rip = 1; target.ouch = 0.5; target.jvz -= 4; }
    puff(e.x, e.y, e.z, e.big ? 10 : 6, e.w === 'blaster' ? '#ffc79a' : '#ffffff');
    comicWord(e.x, e.y, e.z, e.big, e.w && !e.big ? WEAPON_INFO[e.w]?.words : null);
    shake = Math.max(shake, e.big ? 0.5 : e.w ? 0.35 : 0.25);
    sfx.hit(e.big || !!e.w);
    if (e.w === 'pan') sfx.clang();
    if (e.w === 'hammer') sfx.squeak();
    if (e.w === 'chicken') sfx.squawk();
  } else if (e.t === 'windup') {
    sfx.heave();
  } else if (e.t === 'swing') {
    if (e.w) sfx.whoosh(); else sfx.swing();
  } else if (e.t === 'shoot') {
    sfx.shoot();
    } else if (e.t === 'pickup') {
    if (c) { c.sq -= 0.4; puff(c.x, 0.2, c.z, 6, '#f3e6d6', 1.5); }
    sfx.pickup();
    if (WEAPON_INFO[e.w]?.bomb) sfx.fuse(); else sfx.heave();
  } else if (e.t === 'toss') {
    sfx.whoosh();
  } else if (e.t === 'break') {
    puff(e.x, e.y, e.z, 9, '#e3a867', 2.5);
    comicWord(e.x, e.y, e.z, false, ['BROKE!', 'CRACK!']);
    sfx.breakIt();
  } else if (e.t === 'pop') {
    puff(e.x, e.y, e.z, 4, '#ffc79a', 1.5);
  } else if (e.t === 'itemLand') {
    puff(e.x, 0.1, e.z, 5, '#fff3a0', 1.8);
    sfx.drop();
  } else if (e.t === 'jump') {
    if (c) c.sq += 0.3;
    if (e.id === myId) sfx.jump();
  } else if (e.t === 'land') {
    if (c) { c.sq -= 0.3; c.rip = 0.7; puff(c.x, 0.1, c.z, 4, '#ffffff', 2); }
    sfx.land();
  } else if (e.t === 'grab') {
    sfx.grab();
  } else if (e.t === 'throw') {
    if (c) c.leanV += 8;
    shake = Math.max(shake, 0.2);
    sfx.throw();
  } else if (e.t === 'ko') {
    if (c) puff(c.x, c.y + 2, c.z, 8, '#fff3a0', 2);
    sfx.ko();
  } else if (e.t === 'fall') {
    sfx.fall();
  } else if (e.t === 'bombWarn') {
    sfx.whistle();
  } else if (e.t === 'boom') {
    explosion(e.x, e.y ?? 0.6, e.z, e.w === 'sticky');
    sfx.boom();
  } else if (e.t === 'stick') {
    if (c) { c.sq -= 0.3; c.ouch = 0.6; }
    puff(e.x, e.y, e.z, 8, '#7dff9a', 2);
    comicWord(e.x, e.y, e.z, false, ['STUCK!', 'SPLAT!', 'GLOOP!']);
    sfx.splat();
  }
}

// ---------- Input ----------
const keys = new Set();
let viewMode = localStorage.getItem('bb-view') === 'follow' ? 'follow' : 'arena';
let camYaw = 0;
let camDrag = { id: null, x: 0 };
let moveForward = 0;
function followActive() {
  if (viewMode !== 'follow' || !snap || snap.phase === 'lobby') return false;
  const me = critters.get(myId);
  return !!(me && me.s && me.s.st === 'alive' && !me.s.fl);
}
function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('bb-view', mode);
  const me = critters.get(myId);
  if (me) camYaw = me.face + Math.PI;
  $('viewBtn').textContent = mode === 'follow' ? '🎥 Follow' : '🏝️ Arena';
}
$('viewBtn').onclick = () => setViewMode(viewMode === 'follow' ? 'arena' : 'follow');
setViewMode(viewMode);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && !e.repeat && myId && document.activeElement?.tagName !== 'INPUT') $('viewBtn').click();
});
let joy = { x: 0, y: 0, id: null, ox: 0, oy: 0 };
let punchQueued = false, jumpQueued = false, mouseGrab = false, touchGrab = false;

window.addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  keys.add(e.code);
  if (!e.repeat) {
    if (e.code === 'KeyJ') punchQueued = true;
    if (e.code === 'Space') jumpQueued = true;
  }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); mouseGrab = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// pointerdown rather than mousedown: taps emit emulated mouse events that would punch.
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (e.button === 0) punchQueued = true;
  if (e.button === 2) mouseGrab = true;
});
window.addEventListener('mouseup', (e) => { if (e.button === 2) mouseGrab = false; });

{
  const hold = (id, down, up) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('down');
      down();
    });
    const release = (e) => {
      if (!el.classList.contains('down')) return;
      e.preventDefault();
      el.classList.remove('down');
      up && up();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  hold('tPunch', () => (punchQueued = true));
  hold('tJump', () => (jumpQueued = true));
  hold('tGrab', () => (touchGrab = true), () => (touchGrab = false));
}

if (isTouch) {
  const base = $('joyBase'), knob = $('joyKnob');
  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (followActive() && camDrag.id === null && t.clientX > innerWidth * 0.5) {
        camDrag = { id: t.identifier, x: t.clientX };
      } else if (joy.id === null) {
        joy = { x: 0, y: 0, id: t.identifier, ox: t.clientX, oy: t.clientY };
        base.style.left = t.clientX + 'px';
        base.style.top = t.clientY + 'px';
        base.classList.remove('hidden');
        knob.style.transform = '';
      }
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === camDrag.id) {
        camYaw -= (t.clientX - camDrag.x) * 0.012;
        camDrag.x = t.clientX;
        continue;
      }
      if (t.identifier !== joy.id) continue;
      let dx = t.clientX - joy.ox, dy = t.clientY - joy.oy;
      const len = Math.hypot(dx, dy), max = 50;
      if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
      joy.x = dx / max; joy.y = dy / max;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }, { passive: true });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) { joy = { x: 0, y: 0, id: null }; base.classList.add('hidden'); }
      if (t.identifier === camDrag.id) camDrag = { id: null, x: 0 };
    }
  };
  canvas.addEventListener('touchend', end);
  canvas.addEventListener('touchcancel', end);
}

let lastSent = '';
let lastSendTime = 0;
function sendInput(now) {
  if (!myId) { punchQueued = jumpQueued = false; return; }
  let x = 0, z = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) z -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) z += 1;
  if (joy.id !== null) { x = joy.x; z = joy.y; }
  const len = Math.hypot(x, z);
  if (len > 1) { x /= len; z /= len; }
  moveForward = -z;
  if (followActive()) {
    const cs = Math.cos(camYaw), sn = Math.sin(camYaw);
    [x, z] = [x * cs + z * sn, -x * sn + z * cs];
  }
  const grab = keys.has('KeyK') || keys.has('ShiftLeft') || keys.has('ShiftRight') || mouseGrab || touchGrab;
  const key = `${x.toFixed(2)},${z.toFixed(2)},${grab}`;
  // The follow camera keeps turning, so cap steady-state sends at ~30 Hz.
  if (punchQueued || jumpQueued || (key !== lastSent && now - lastSendTime > 33) || now - lastSendTime > 150) {
    socket.emit('input', { x, z, grab, punch: punchQueued, jump: jumpQueued });
    lastSent = key;
    lastSendTime = now;
    punchQueued = jumpQueued = false;
  }
}

// ---------- Camera ----------
const tmpV = new THREE.Vector3();
function updateCamera(dt, R) {
  const aspectBoost = Math.max(1, 1.45 / camera.aspect);
  let pos, look;
  if (!room || room.phase === 'lobby') {
    // Frame the critters in the space right of the side panel.
    const W = window.innerWidth;
    const panelRight = W > 760 ? Math.min(W * 0.5, 430) : 0;
    const free = (W - panelRight) / W;
    const subjectW = room ? 2.5 + room.players.length * 0.9 : 2.4;
    const subjectH = room ? 4 : 2.6;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(subjectH / 0.42, subjectW / (0.8 * free * camera.aspect)) / (2 * tanHalf);
    const visW = 2 * dist * tanHalf * camera.aspect;
    const shift = (panelRight / 2 / W) * visW;
    const elev = room ? 0.45 : 0.22;
    look = new THREE.Vector3(-shift, room ? 0.6 : 1.1, 0);
    pos = tmpV.set(-shift, look.y + dist * elev, dist);
  } else if (followActive()) {
    const me = critters.get(myId);
    const turn = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    camYaw -= turn * dt * 2.4;
    if (moveForward > 0.3 && camDrag.id === null && !turn) camYaw = angleLerp(camYaw, me.face + Math.PI, dt * 1.5 * moveForward);
    const dist = 7 * aspectBoost, height = 3.6 * aspectBoost;
    look = new THREE.Vector3(me.x - Math.sin(camYaw) * 2, me.y + 1.6, me.z - Math.cos(camYaw) * 2);
    pos = tmpV.set(me.x + Math.sin(camYaw) * dist, me.y + height, me.z + Math.cos(camYaw) * dist);
    const kf = 1 - Math.exp(-dt * 10);
    camPos.lerp(pos, kf);
    camLook.lerp(look, kf);
    camera.position.copy(camPos);
    shake *= Math.exp(-dt * 9);
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.lookAt(camLook);
    return;
  } else {
    let cx = 0, cz = 0, n = 0;
    for (const c of critters.values()) {
      if (!c.s || c.s.st !== 'alive' || c.s.fl) continue;
      cx += c.x; cz += c.z; n++;
    }
    if (n) { cx /= n; cz /= n; }
    // The island is too big to show whole, so frame the spread of players still standing.
    let spread = 0;
    for (const c of critters.values()) {
      if (!c.s || c.s.st !== 'alive' || c.s.fl) continue;
      spread = Math.max(spread, Math.hypot(c.x - cx, c.z - cz));
    }
    const fit = n ? THREE.MathUtils.clamp((spread + 6) / 11, 0.85, 2.5) : 0.6 + 0.9 * (R / ISLAND_MAX);
    const zoom = fit * aspectBoost;
    look = new THREE.Vector3(cx * 0.85, 0, cz * 0.85 + 0.8);
    pos = tmpV.set(look.x, 12.5 * zoom, look.z + 14 * zoom);
  }
  const k = 1 - Math.exp(-dt * 3);
  camPos.lerp(pos, k);
  camLook.lerp(look, k);
  camera.position.copy(camPos);
  shake *= Math.exp(-dt * 9);
  camera.position.x += (Math.random() - 0.5) * shake;
  camera.position.y += (Math.random() - 0.5) * shake;
  camera.lookAt(camLook);
}

// Context-sensitive prompts: what GRAB and PUNCH will do right now.
let hintState = '';
function updateActionHints(me) {
  let grab = 'GRAB', punch = 'PUNCH', hint = '';
  if (me) {
    const near = (snap.items || []).find((it) => it.y < 0.5 && Math.hypot(it.x - me.x, it.z - me.z) < 1.9);
    if (me.h) punch = 'THROW';
    else if (me.w) {
      punch = me.w === 'blaster' ? 'SHOOT' : WEAPON_INFO[me.w]?.bomb ? 'THROW' : 'SWING';
      grab = 'TOSS';
      if (WEAPON_INFO[me.w]?.bomb) hint = `${WEAPON_INFO[me.w].label} is lit! ${isTouch ? 'Tap <b>THROW</b>' : '<b>J</b> to throw it'} before it blows`;
      else hint = isTouch ? '' : `${WEAPON_INFO[me.w].label}: <b>J</b> ${punch.toLowerCase()} · <b>K</b> throw it`;
    } else if (near) {
      grab = 'PICK UP';
      hint = isTouch ? `Tap <b>PICK UP</b> for the ${WEAPON_INFO[near.t].label}` : `Press <b>K</b> to pick up the ${WEAPON_INFO[near.t].label}`;
    }
  }
  const key = grab + punch + hint;
  if (key === hintState) return;
  hintState = key;
  const keyHint = (k) => (isTouch ? '' : `<small>${k}</small>`);
  $('tGrab').innerHTML = grab + keyHint('K');
  $('tPunch').innerHTML = punch + keyHint('J');
  $('tGrab').classList.toggle('glow', grab === 'PICK UP');
  $('tPunch').classList.toggle('armed', punch === 'SWING' || punch === 'SHOOT' || (punch === 'THROW' && !!me?.w));
  $('actionHint').innerHTML = hint;
  $('actionHint').classList.toggle('hidden', !hint);
}

// ---------- Main loop ----------
const projV = new THREE.Vector3();
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  time += dt;

  sendInput(now);

  const playing = room && room.phase !== 'lobby' && snap && snap.phase !== 'lobby';
  const R = playing ? snap.islandR : ISLAND_MAX;
  islandScaled.scale.set(R, 1, R);
  rock.scale.y = 3 + 4 * (R / ISLAND_MAX);
  island.position.y = Math.sin(time * 0.7) * 0.12;
  updateDeco(R);
  updateObstacles(dt, R, !!playing);
  updateRiver(dt, R);
  syncItems(playing ? snap : null, dt);
  updatePlatforms(dt, R, !!playing);
  updateGuards(R, !!playing);
  const shrinking = playing && R < ISLAND_MAX - 0.05 && snap.phase === 'playing';
  edgeRing.material.color.set(shrinking ? (Math.sin(time * 8) > 0 ? '#ff8fa3' : '#ffffff') : '#ffffff');

  for (const g of puffyClouds) {
    g.userData.a += g.userData.v * dt;
    g.position.set(Math.cos(g.userData.a) * g.userData.r, g.userData.y, Math.sin(g.userData.a) * g.userData.r);
  }
  for (const m of miniIslands) m.position.y = m.userData.base + Math.sin(time * 0.6 + m.userData.k) * 0.4;

  if (!room && preview) {
    preview.root.visible = true;
    preview.tface = Math.sin(time * 0.6) * 0.5 + 0.2;
    preview.face = angleLerp(preview.face, preview.tface, dt * 3);
    animateCritter(preview, dt, null, { wave: true });
  }

  if (room) {
    const n = room.players.length;
    room.players.forEach((p, i) => {
      const c = critters.get(p.id);
      if (!c) return;
      if (room.phase === 'lobby' || !snap || snap.phase === 'lobby') {
        const a = (i / n) * Math.PI * 2;
        const r = n === 1 ? 0 : 1.6 + n * 0.25;
        c.tx = Math.sin(a) * r; c.tz = Math.cos(a) * r; c.ty = 0;
        c.tvx = c.tvy = c.tvz = 0;
        c.tface = Math.atan2(camPos.x - c.tx, camPos.z - c.tz);
        c.s = { g: 1, st: 'alive', pa: 0 };
        animateCritter(c, dt, c.s, { wave: p.id === myId });
      } else {
        const hop = room.phase === 'roundover' && (p.id === room.winnerId || (room.winnerTeam >= 0 && p.team === room.winnerTeam));
        animateCritter(c, dt, c.s, { hop });
      }
      updateTeamMarker(c, p);
      const show = c.root.visible && !(c.s && c.s.fl);
      c.label.style.display = show ? '' : 'none';
      if (show) {
        projV.set(c.x, c.y + (c.height || 2.3) + 0.6 + (c.ko > 0.5 ? -1.2 : 0), c.z).project(camera);
        c.label.style.left = `${(projV.x * 0.5 + 0.5) * window.innerWidth}px`;
        c.label.style.top = `${(-projV.y * 0.5 + 0.5) * window.innerHeight}px`;
      }
    });
  }

  const me = snap?.players.find((p) => p.id === myId);
  const showDizzy = room && room.phase === 'playing' && me && me.st === 'alive' && !me.fl;
  $('dizzyMeter').classList.toggle('hidden', !showDizzy);
  if (showDizzy) $('dizzyFill').style.width = `${me.ko ? 100 : me.dz}%`;
  updateActionHints(showDizzy ? me : null);

  updateEffects(dt);
  updateCamera(dt, R);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
