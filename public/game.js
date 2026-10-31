import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildCritter } from './characters.js';
import { MODEL_CHARACTERS, loadManifest, loadModel, isModelReady, buildModelCritter } from './models.js';
import { FLUFFY, buildFluffy, setGlassQuality } from './crew.js';
import { setPlushQuality } from './fluffy.js';
import { Ragdoll, poseRagdoll, ragdollHead } from './floppy.js';
import { Particles, SHAPE } from './particles.js';
import {
  FOAM_SLOTS, PUSH_SLOTS, mixMood, makeEnvironment, makeSky, makePost, grassGroundTexture, riverMaterial,
  makeWaterfall, makeGrass, makeContactShadows, cliffMaterial,
} from './gfx.js';
import { WEAPON_INFO, buildWeapon, buildGlove, buildPickup, buildShot } from './weapons.js';

await loadManifest();
// Furry and jelly critters plus any .glb characters listed in /models/characters.json.
const CHARACTERS = { ...FLUFFY, ...MODEL_CHARACTERS };

// Straight to WebSocket (skips the long-polling handshake), falling back to polling if blocked.
const socket = io({ transports: ['websocket', 'polling'], tryAllTransports: true });
// Per-tab id so a reconnect on a fresh socket replaces this tab's stranded critter.
const SESSION_ID = sessionStorage.getItem('bb-sid') || Math.random().toString(36).slice(2) + Date.now().toString(36);
sessionStorage.setItem('bb-sid', SESSION_ID);
const $ = (id) => document.getElementById(id);
const canvas = $('game');

const ISLAND_MAX = 28;
const ISLAND_MIN = 6;
const TEAM_COLORS = ['#ff6b81', '#4dabf7', '#51cf66', '#ffc93c'];
const TEAM_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];
const ANIMAL_KEYS = Object.keys(CHARACTERS);

let myId = null;
let room = null;
let snap = null;
let snapTime = 0;
let snapSentAt = null; // local time the latest snapshot would have arrived with no extra delay
let lastPhase = null;
let time = 0;
let shake = 0;
// Visual-only pacing: hit-stop freezes the picture briefly; slow-mo plays the final knock-off.
let hitStop = 0, slowMo = 0, slowTarget = null;
const SLOW_MO = 1.4, SLOW_RATE = 0.3;
let myAnimal = localStorage.getItem('bb-animal');
if (!CHARACTERS[myAnimal]) myAnimal = ANIMAL_KEYS[Math.floor(Math.random() * ANIMAL_KEYS.length)];

// ---------- Renderer / scene ----------
const lowPower = matchMedia('(pointer: coarse)').matches;

// ---------- Quality tiers (visual only: gameplay is identical on every tier) ----------
const QUALITY_PREFS = ['auto', 'high', 'medium', 'low'];
let qualityPref = QUALITY_PREFS.includes(localStorage.getItem('bb-quality')) ? localStorage.getItem('bb-quality') : 'auto';
// Phones run hot on anything heavier, so they start on low until the player picks otherwise.
if (lowPower && localStorage.getItem('bb-quality') === null) {
  qualityPref = 'low';
  localStorage.setItem('bb-quality', qualityPref);
}
let autoTier = lowPower ? 'low' : 'high';
const tier = () => (qualityPref === 'auto' ? autoTier : qualityPref);
let fpsAcc = 0, fpsFrames = 0, slowFor = 0;
// Auto mode steps down a tier when the frame rate stays under 45 fps for 3 seconds of play.
function watchFrameRate(rawDt, playing) {
  if (qualityPref !== 'auto' || !playing || rawDt > 0.25 || document.hidden) return;
  fpsAcc += rawDt;
  fpsFrames++;
  if (fpsAcc < 0.5) return;
  slowFor = fpsFrames / fpsAcc < 45 ? slowFor + fpsAcc : 0;
  fpsAcc = fpsFrames = 0;
  if (slowFor >= 3 && autoTier !== 'low') {
    autoTier = autoTier === 'high' ? 'medium' : 'low';
    slowFor = 0;
    renderQualityPicker();
  }
}
function renderQualityPicker() {
  for (const b of document.querySelectorAll('#qualityPicker button')) {
    b.classList.toggle('on', b.dataset.q === qualityPref);
    if (b.dataset.q === 'auto') b.textContent = `Auto (${autoTier[0].toUpperCase()}${autoTier.slice(1)})`;
  }
}
for (const b of document.querySelectorAll('#qualityPicker button')) {
  b.onclick = () => {
    qualityPref = b.dataset.q;
    localStorage.setItem('bb-quality', qualityPref);
    slowFor = 0;
    renderQualityPicker();
  };
}
renderQualityPicker();

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
const post = makePost(renderer, scene, camera);
const particles = new Particles(scene, 3000);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  post.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  particles.setViewport(h * renderer.getPixelRatio(), camera.fov);
}
window.addEventListener('resize', resize);
resize();

// Warm sun, cool sky fill, and image-based light from a little sunny sky for reflections.
let moodK = 0, envMood = 0;
const moodNow = mixMood(0);
const SUN_DIR = new THREE.Vector3(9, 20, 12).normalize();
const hemi = new THREE.HemisphereLight(moodNow.hemiSky, moodNow.hemiGround, moodNow.hemiI);
scene.add(hemi);
const sun = new THREE.DirectionalLight(moodNow.sun, moodNow.sunI);
sun.position.copy(SUN_DIR).multiplyScalar(40);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(lowPower ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 90 });
sun.shadow.radius = 4;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
let envRT = makeEnvironment(renderer, moodNow, SUN_DIR);
scene.environment = envRT.texture;
scene.environmentIntensity = moodNow.env;

const skyDome = makeSky(moodNow);
skyDome.uniforms.sunDir.value.copy(SUN_DIR);
scene.add(skyDome.mesh);

// ---------- Island ----------
const island = new THREE.Group();
scene.add(island);
const islandScaled = new THREE.Group();
island.add(islandScaled);

const GRASS_COLOR = new THREE.Color('#b3e6a4');
const groundTex = grassGroundTexture();
groundTex.repeat.set(7, 7);
const grassMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95 });
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
const rock = new THREE.Mesh(rockGeo, cliffMaterial());
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

// Grass blades, flowers and pebbles (instanced so they can vanish as the island crumbles)
const decoDummy = new THREE.Object3D();
const GRASS_BLADES = { high: 16000, medium: 7000, low: 2500 };
const blades = makeGrass(GRASS_BLADES.high, ISLAND_MAX);
island.add(blades.mesh);
const pebbleData = [];
for (let i = 0; i < 360; i++) {
  const r = Math.sqrt(Math.random()) * (ISLAND_MAX - 0.4), a = Math.random() * Math.PI * 2;
  pebbleData.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r, s: 0.5 + Math.random() * 0.9, rot: Math.random() * 6 });
}
const pebbles = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.07, 0),
  new THREE.MeshStandardMaterial({ color: '#cfc4da', roughness: 0.85, flatShading: true }),
  pebbleData.length,
);
pebbles.receiveShadow = true;
const flowerCount = 900;
const flowers = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.09, 0),
  new THREE.MeshStandardMaterial({ roughness: 0.6 }),
  flowerCount,
);
const flowerData = [];
const FLOWER_COLORS = ['#ffffff', '#ffd6e0', '#fff3a0', '#d9ccff', '#ffc8a8'];
for (let i = 0; i < flowerCount; i++) {
  const r = Math.sqrt(Math.random()) * (ISLAND_MAX - 0.3), a = Math.random() * Math.PI * 2;
  flowerData.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r });
  flowers.setColorAt(i, new THREE.Color(FLOWER_COLORS[i % FLOWER_COLORS.length]));
}
island.add(pebbles, flowers);

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
    for (const list of [pebbleData, flowerData, stoneData, mushData]) {
      for (const d of list) d.wet = !!rv && riverDist(rv, d.x, d.z) < rv.half + 0.5;
    }
    // Blades fade out at the crumbling edge in the shader; only the river bed needs clearing here.
    blades.place(rv ? (b) => riverDist(rv, b.x, b.z) < rv.half + 0.35 : null);
  }
  decoR = R;
  decoRiver = rv;
  pebbleData.forEach((t, i) => {
    decoDummy.position.set(t.x, 0.02, t.z);
    decoDummy.rotation.set(t.rot, t.rot * 2, 0);
    decoDummy.scale.set(1, 0.6, 1).multiplyScalar(t.r < R - 0.3 && !t.wet ? t.s : 0);
    decoDummy.updateMatrix();
    pebbles.setMatrixAt(i, decoDummy.matrix);
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
  pebbles.instanceMatrix.needsUpdate = true;
  flowers.instanceMatrix.needsUpdate = true;
  stones.instanceMatrix.needsUpdate = true;
  mushCaps.instanceMatrix.needsUpdate = true;
  mushStems.instanceMatrix.needsUpdate = true;
}

// ---------- Background: cloud sea, puffy clouds, little islands ----------
const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#fff4fb', emissiveIntensity: 0.55 });
const seaCount = 180;
const cloudSea = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 11, 8), cloudMat, seaCount);
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
  // One merged mesh per cloud instead of a draw call per puff.
  const puffs = [];
  for (let j = 0; j < n; j++) {
    decoDummy.position.set((j - n / 2) * 1.3, Math.random() * 0.6, (Math.random() - 0.5) * 1.2);
    decoDummy.scale.setScalar(1.1 + Math.random() * 0.9);
    decoDummy.rotation.set(0, 0, 0);
    decoDummy.updateMatrix();
    puffs.push(cloudSea.geometry.clone().applyMatrix4(decoDummy.matrix));
  }
  g.add(new THREE.Mesh(mergeGeometries(puffs), cloudMat));
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
  uSand: { value: new THREE.Color('#efdcae') }, uGrass: { value: GRASS_COLOR.clone() },
};
const riverMat = riverMaterial(riverUniforms);

const waterfall = makeWaterfall();
riverGroup.add(waterfall.mesh);
let mistT = 0;

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
  const pos = new Float32Array(n * 2 * 3), nor = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), dir = new Float32Array(n * 2 * 2);
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
      dir.set([tx, tz], j * 2);
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
  geo.setAttribute('rDir', new THREE.BufferAttribute(dir, 2));
  geo.setIndex(idx);
  riverMesh = new THREE.Mesh(geo, riverMat);
  riverMesh.receiveShadow = true;
  riverGroup.add(riverMesh);
  riverUniforms.uHalf.value = rv.half;
  riverUniforms.uW.value = W;
  waterfall.mesh.scale.set(rv.half * 2, 1, 1);
  // Foam rings and wakes behind the bridges' middle posts, which stand in the water.
  const foam = riverUniforms.uFoam.value;
  foam.forEach((f) => f.set(0, 0, 0));
  let slot = 0;
  for (const b of rv.bridges) {
    for (const side of [-1, 1]) {
      if (slot < FOAM_SLOTS) foam[slot++].set(b.x + Math.sin(b.a) * 1.12 * side, b.z + Math.cos(b.a) * 1.12 * side, 0.16);
    }
  }
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
  waterfall.mesh.visible = !!exit;
  if (!exit) return;
  waterfall.mesh.position.set(exit.x, 0.0, exit.z);
  waterfall.mesh.rotation.set(0, Math.atan2(exit.tx, exit.tz), 0);
  waterfall.uniforms.uTime.value = time;
  // Spray off the lip, and a mist cloud rolling up from below.
  const iy = island.position.y, sx = -exit.tz, sz = exit.tx;
  sprayT -= dt;
  while (sprayT <= 0) {
    sprayT += 0.03;
    const across = (Math.random() - 0.5) * rv.half * 2;
    particles.spawn({
      x: exit.x + sx * across + exit.tx * 0.2, y: iy + 0.05, z: exit.z + sz * across + exit.tz * 0.2,
      vx: exit.tx * (1.5 + Math.random() * 2) + sx * (Math.random() - 0.5), vy: 0.5 + Math.random() * 1.8, vz: exit.tz * (1.5 + Math.random() * 2) + sz * (Math.random() - 0.5),
      life: 0.7, size: 0.1 + Math.random() * 0.08, color: '#e6f6ff', shape: SHAPE.drop, gravity: 12, decor: true,
    });
  }
  mistT -= dt;
  while (mistT <= 0) {
    mistT += 0.12;
    const t = 0.35 + Math.random() * 0.65, out = 0.05 + Math.sqrt(t) * 2.4, across = (Math.random() - 0.5) * rv.half * 2 * (1 + t * 0.5);
    particles.spawn({
      x: exit.x + exit.tx * out + sx * across, y: iy - t * waterfall.height, z: exit.z + exit.tz * out + sz * across,
      vx: exit.tx * 0.6 + (Math.random() - 0.5) * 0.6, vy: 0.4 + Math.random() * 0.5, vz: exit.tz * 0.6 + (Math.random() - 0.5) * 0.6,
      life: 2.2, size: 1.4 + t * 2.2, grow: 1.2, alpha: 0.28, color: '#f4fbff', drag: 0.6, fadeIn: 0.25, fade: 0.6, decor: true,
    });
  }
}

// ---------- Picket fence around the whole edge, open where the river spills off ----------
const FENCE_STEP = 1.1;
const fencePostGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.0, 8);
fencePostGeo.translate(0, 0.5, 0);
const fenceRailGeo = new THREE.BoxGeometry(0.08, 0.1, 1);
const fenceMaxPosts = 260;
const fencePosts = new THREE.InstancedMesh(fencePostGeo, new THREE.MeshStandardMaterial({ color: '#fff3e6', roughness: 0.7 }), fenceMaxPosts);
const fenceRails = new THREE.InstancedMesh(fenceRailGeo, new THREE.MeshStandardMaterial({ color: '#ffb7c9', roughness: 0.6 }), fenceMaxPosts * 2);
fencePosts.castShadow = fenceRails.castShadow = true;
// The instances move every round and as the island shrinks, so a cached bounding sphere goes stale.
fencePosts.frustumCulled = fenceRails.frustumCulled = false;
island.add(fencePosts, fenceRails);
let fenceKey = '';

// Fenced arcs [from, to] between the river gaps ([centre, half-width] pairs from the server).
function fenceArcs(gaps) {
  if (!gaps.length) return [[0, Math.PI * 2]];
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  return sorted.map(([c, h], i) => {
    const [nc, nh] = sorted[(i + 1) % sorted.length];
    const to = nc - nh + (i + 1 === sorted.length ? Math.PI * 2 : 0);
    return [c + h, to];
  }).filter(([a, b]) => b - a > 0.02);
}

function updateGuards(R, playing) {
  const gaps = playing && snap ? snap.gaps || [] : null;
  const key = JSON.stringify(gaps) + R.toFixed(2);
  if (key === fenceKey) return;
  fenceKey = key;
  const rr = R - (room?.guardInset ?? 0.25);
  let np = 0, nr = 0;
  for (const [a0, a1] of gaps ? fenceArcs(gaps) : []) {
    const n = Math.max(2, Math.ceil(((a1 - a0) * rr) / FENCE_STEP) + 1);
    let prev = null;
    for (let j = 0; j < n && np < fenceMaxPosts; j++) {
      const th = a0 + ((a1 - a0) * j) / (n - 1);
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
    const q = sampleAt('items', it.i, interpOut) || it;
    p.root.position.set(q.x, q.y + island.position.y, q.z);
    const landed = q.y < 0.05;
    p.root.rotation.y = it.r;
    // Tumble while airborne, then settle and bob gently.
    p.holder.rotation.x = landed ? 0 : p.holder.rotation.x + dt * 6;
    p.holder.position.y = p.baseY + (landed ? Math.abs(Math.sin(time * 2.5 + it.i)) * 0.08 : 0);
    p.ring.visible = p.glow.visible = landed;
    p.ring.scale.setScalar(p.ringS * (1 + Math.sin(time * 5 + it.i) * 0.06));
  }
  for (const [id, p] of pickups) if (!seen.has(id)) { scene.remove(p.root); pickups.delete(id); }

  const seenShots = new Set();
  for (const sh of showItems ? s.shots || [] : []) {
    seenShots.add(sh.i);
    let m = shotMeshes.get(sh.i);
    if (!m) { m = buildShot(); scene.add(m); shotMeshes.set(sh.i, m); }
    const q = sampleAt('shots', sh.i, interpOut) || sh;
    m.position.set(q.x, q.y, q.z);
  }
  for (const [id, m] of shotMeshes) if (!seenShots.has(id)) { scene.remove(m); shotMeshes.delete(id); }
}

function sweat(c) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const h = c.height || 2.3;
  particles.spawn({
    x: c.x + Math.cos(c.face) * side * 0.5, y: c.y + h * 0.85, z: c.z - Math.sin(c.face) * side * 0.5,
    vx: Math.cos(c.face) * side * 1.5, vy: 2.2, vz: -Math.sin(c.face) * side * 1.5, gravity: 10, life: 0.55,
    size: 0.17, color: '#a8dcff', shape: SHAPE.drop,
  });
}

// ---------- Ground and water particles ----------
function dust(x, z, n, spread = 0.6, color = '#efe3d3') {
  const y = island.position.y + 0.08;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = Math.random() * spread;
    particles.spawn({
      x, y, z, vx: Math.cos(a) * sp, vy: 0.3 + Math.random() * 0.6, vz: Math.sin(a) * sp, drag: 2.5, life: 0.45 + Math.random() * 0.25,
      size: 0.3 + Math.random() * 0.15, grow: 1.4, alpha: 0.6, color, fade: 0.8, decor: true,
    });
  }
}

function landPuff(x, z, strength = 1) {
  const y = island.position.y + 0.1;
  const n = Math.round(6 + strength * 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.3, sp = (2 + Math.random()) * strength;
    particles.spawn({
      x: x + Math.cos(a) * 0.3, y, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * sp, vy: 0.4, vz: Math.sin(a) * sp, drag: 4,
      life: 0.5, size: 0.42, grow: 1.2, alpha: 0.75, color: '#f6eee4', fade: 0.7,
    });
  }
}

function grassBits(x, z, n = 12) {
  const y = island.position.y + 0.05;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 3;
    particles.spawn({
      x, y, z, vx: Math.cos(a) * sp, vy: 3 + Math.random() * 3, vz: Math.sin(a) * sp, gravity: 16, floor: y, life: 0.9 + Math.random() * 0.4,
      size: 0.11, color: i % 2 ? '#7ccf6a' : '#a9e38f', shape: SHAPE.chunk, spin: (Math.random() - 0.5) * 18, fade: 0.3, decor: true,
    });
  }
}

const ringGeo = new THREE.RingGeometry(0.8, 1, 40);
// Bigger, faster hits make bigger splashes (strength roughly 0.25-1.5).
function splash(x, z, strength) {
  const y = island.position.y + 0.05;
  const n = Math.round(8 + strength * 26);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = (0.8 + Math.random() * 2.6) * (0.6 + strength * 0.6);
    particles.spawn({
      x, y, z, vx: Math.cos(a) * sp, vy: (2.5 + Math.random() * 4) * (0.6 + strength * 0.5), vz: Math.sin(a) * sp, gravity: 16, floor: y - 0.1,
      life: 0.8 + Math.random() * 0.4, size: 0.12 + Math.random() * 0.08 * (1 + strength), color: '#d8f1ff', shape: SHAPE.drop, fade: 0.25,
    });
  }
  for (let i = 0; i < 3 + strength * 5; i++) {
    const a = Math.random() * Math.PI * 2;
    particles.spawn({
      x: x + Math.cos(a) * 0.3, y: y + 0.1, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * 1.2, vy: 0.6, vz: Math.sin(a) * 1.2, drag: 2.5,
      life: 0.6, size: 0.5 + strength * 0.3, grow: 1.3, alpha: 0.8, color: '#ffffff', fade: 0.7,
    });
  }
  for (let k = 0; k < (strength > 0.7 ? 2 : 1); k++) {
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y, z);
    ring.scale.setScalar(0.4);
    const life = 0.6 + k * 0.25;
    addEffect(ring, { vel: new THREE.Vector3(), life, max: life, grow: 1.5 + strength * 2.5 + k, gravity: 0 });
  }
}

// Boxing gloves sit over both paws; the paw meshes hide underneath until the gloves come off.
function setGloves(c, on) {
  if (!c.armL || !!c.gloves === !!on) return;
  const paws = [c.armL, c.armR];
  if (on) {
    c.gloves = paws.map((paw, i) => {
      for (const m of paw.children) m.visible = false;
      const glove = buildGlove(i ? 1 : -1);
      paw.add(glove);
      return glove;
    });
  } else {
    paws.forEach((paw, i) => {
      paw.remove(c.gloves[i]);
      for (const m of paw.children) m.visible = true;
    });
    c.gloves = null;
  }
}

const tipV = new THREE.Vector3();
// Heavy weapons are dragged along the ground with both hands, heaved overhead
// during the wind-up, then slammed forward. The blaster is carried at the hip; boxing gloves
// replace the paws themselves.
function updateHeldWeapon(c, dt, s) {
  const type = s && s.st === 'alive' && !s.fl ? s.w || '' : '';
  if (type !== (c.weaponType || '')) {
    if (c.weaponMesh) c.weaponMesh.parent?.remove(c.weaponMesh);
    c.weaponMesh = null;
    c.weaponType = type;
    setGloves(c, WEAPON_INFO[type]?.gloves);
    if (type && !WEAPON_INFO[type]?.gloves) {
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
      // Yaw outermost so the pan can sweep flat and the hammer can be held straight out.
      holder.rotation.order = 'YXZ';
      holder.rotation.set(info.ranged ? 0 : -Math.PI / 2, 0, 0);
      c.pivot.add(holder);
      c.weaponMesh = holder;
      c.wPhase = 'drag';
      c.wLean = 0;
      c.sweatT = 0.3;
    }
  }
  c.twistT = 0;
  if (!c.weaponMesh) { c.wLean = 0; return; }

  const info = WEAPON_INFO[type];
  const wm = c.weaponMesh, g = c.grip;
  const sw = s ? s.sw || 0 : 0;
  const phase = sw === 1 ? 'wind' : sw === 2 ? 'strike' : sw === 3 ? 'spin' : 'drag';
  if (phase !== c.wPhase) {
    if (phase === 'wind') c.sq += 0.25;
    if (phase === 'strike' || phase === 'spin') { c.sq -= 0.35; if (c.id === myId) shake = Math.max(shake, 0.15); }
    if (phase === 'spin') c.spinClock = 0;
    if (c.wPhase === 'spin') c.spinDizzyT = 1.1; // staggers about after the mallet spin
    c.wPhase = phase;
  }
  const moving = Math.hypot(c.dvx, c.dvz) > 1;
  const side = s && s.sd < 0 ? -1 : 1;
  let px, py, pz, rx, rz, lean, k, ry = 0, roll = 0;
  if (info.ranged) {
    const recoil = phase === 'strike' ? 1 : 0;
    px = g.x * 0.7; py = g.y + 0.1; pz = 0.45 - recoil * 0.2;
    rx = -0.05 - recoil * 0.4; rz = 0; lean = 0; k = 18;
  } else if (info.sweep && (phase === 'wind' || phase === 'strike')) {
    // Flat sweep: pulled back on the side it's held, then whipped across to the other side.
    const from = phase === 'wind' ? side : -side;
    px = from * Math.abs(g.x) * 0.9; py = g.y + 0.25; pz = phase === 'wind' ? -0.05 : 0.35;
    rx = Math.PI / 2; ry = from * (Math.PI / 2 + (phase === 'wind' ? 0.55 : 0.35)); rz = 0;
    roll = -side * Math.PI / 2;
    lean = phase === 'wind' ? -0.15 : 0.25; k = phase === 'wind' ? 9 : 26;
    c.twistT = phase === 'wind' ? side * 0.45 : -side * 0.5;
  } else if (info.spin && (phase === 'wind' || phase === 'spin')) {
    // Hammer held straight out to the side; the whole critter spins with it.
    px = Math.abs(g.x) * 1.1; py = g.y + 0.35 + (phase === 'wind' ? Math.sin(time * 45) * 0.03 : 0); pz = 0.1;
    rx = Math.PI / 2; ry = Math.PI / 2 - (phase === 'wind' ? 0.5 : 0.1); rz = 0;
    lean = phase === 'wind' ? -0.2 : 0.05; k = phase === 'wind' ? 8 : 30;
  } else if (phase === 'wind') {
    // Struggling to lift it: trembling, leaning back.
    px = g.x * 0.25; py = g.y + 0.75; pz = -0.1;
    rx = -0.4 + Math.sin(time * 45) * 0.06; rz = 0; lean = -0.38; k = info.windup < 0.15 ? 30 : 7;
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
  wm.rotation.y += (ry - wm.rotation.y) * f;
  wm.rotation.z += (rz - wm.rotation.z) * f;
  const model = wm.children[0];
  if (model) model.rotation.y += (roll - model.rotation.y) * f;
  c.wLean += (lean - c.wLean) * (1 - Math.exp(-dt * 10));
  c.pivot.rotation.x += c.wLean;

  if (phase === 'spin' && info.spin) {
    c.spinClock += dt;
    const u = Math.min(1, c.spinClock / info.spin);
    c.pivot.rotation.y = (1 - (1 - u) * (1 - u)) * info.turns * Math.PI * 2;
    // Whoosh trail off the hammer head.
    wm.localToWorld(tipV.set(0, info.len * 0.85, 0));
    if (u < 1) puff(tipV.x, tipV.y, tipV.z, 1, '#ffffff', 0.3);
  }

  // Effort: sweat drops and dust kicked up by the dragging tip.
  if (!info.ranged && (moving || phase === 'wind')) {
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
  boing: () => [0, 0.07].forEach((d, i) => tone({ type: 'sine', f0: 180 + i * 60, f1: 620 + i * 120, dur: 0.18, vol: 0.12, delay: d })),
  breakIt: () => {
    noise({ dur: 0.3, vol: 0.25, f0: 2500, f1: 300 });
    tone({ type: 'triangle', f0: 500, f1: 150, dur: 0.3, vol: 0.08 });
  },
  drop: () => tone({ f0: 300, f1: 140, dur: 0.1, vol: 0.08 }),
  heave: () => tone({ type: 'triangle', f0: 180, f1: 320, dur: 0.35, vol: 0.09 }),
  // Boxing glove: a deep padded thump, then a ring-bell ding.
  pow: () => {
    noise({ dur: 0.18, vol: 0.4, f0: 700, f1: 90 });
    tone({ f0: 140, f1: 45, dur: 0.22, vol: 0.32 });
    tone({ type: 'triangle', f0: 1760, f1: 1700, dur: 0.5, vol: 0.06, delay: 0.08 });
  },
  splash: () => noise({ dur: 0.35, vol: 0.18, f0: 2500, f1: 400, q: 0.8, type: 'bandpass' }),
  kick: () => {
    noise({ dur: 0.1, vol: 0.12, f0: 600, f1: 2000, q: 1.5, type: 'bandpass' });
    tone({ f0: 180, f1: 70, dur: 0.1, vol: 0.12 });
  },
  spin: () => noise({ dur: 0.6, vol: 0.18, f0: 400, f1: 3200, q: 2, type: 'bandpass' }),
  climb: () => [440, 660, 880].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f * 1.2, dur: 0.1, vol: 0.08, delay: i * 0.08 })),
  warn: () => [0, 0.25, 0.5].forEach((d) => tone({ type: 'square', f0: 660, f1: 440, dur: 0.18, vol: 0.05, delay: d })),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f, dur: 0.25, vol: 0.1, delay: i * 0.11 })),
};

// ---------- Critters ----------
const critters = new Map();
const labelsEl = $('labels');

// Model characters show a jelly stand-in until their .glb has finished loading.
function buildCharacter(animal) {
  if (!MODEL_CHARACTERS[animal]) return buildFluffy(animal);
  if (isModelReady(animal)) return buildModelCritter(animal);
  return Object.assign(buildCritter('bear'), { placeholderFor: animal });
}

// Tiny bits (pupils, eye shines, brows, buttons) are invisible in the shadow map but each costs a
// shadow draw call, so only the bigger parts cast.
const _ws = new THREE.Vector3();
function trimShadowCasters(root) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.castShadow || !o.geometry) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    o.getWorldScale(_ws);
    if (o.geometry.boundingSphere.radius * Math.max(_ws.x, _ws.y, _ws.z) < 0.13) o.castShadow = false;
  });
}

function makeCritterEntry(id, animal) {
  const c = buildCharacter(animal);
  trimShadowCasters(c.root);
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
  if (c.bar) c.bar.remove();
}

function rebuildCritter(c) {
  const fresh = makeCritterEntry(c.id, c.animal);
  for (const k of ['x', 'y', 'z', 'face', 'tx', 'ty', 'tz', 'tvx', 'tvy', 'tvz', 'tface', 's', 'label', 'bar']) fresh[k] = c[k];
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

// ---------- Snapshot buffer: everything but my own critter is drawn INTERP_DELAY in the past ----------
const INTERP_DELAY = 0.1;
const snapBuf = [];
let clockOffset = null; // server clock minus local clock, tracking the fastest-arriving snapshots

function bufferSnapshot(s) {
  const now = performance.now() / 1000;
  const off = s.t - now;
  const lastT = snapBuf.length ? snapBuf[snapBuf.length - 1].t : -Infinity;
  if (s.t <= lastT - 1) snapBuf.length = 0; // server restarted
  if (clockOffset == null || !snapBuf.length || off > clockOffset || Math.abs(off - clockOffset) > 1) clockOffset = off;
  else clockOffset += (off - clockOffset) * 0.02; // let latency creep upward slowly
  if (s.t <= lastT) return;
  snapBuf.push({
    t: s.t,
    players: new Map(s.players.map((p) => [p.id, p])),
    items: new Map((s.items || []).map((it) => [it.i, it])),
    shots: new Map((s.shots || []).map((sh) => [sh.i, sh])),
  });
  while (snapBuf.length > 2 && snapBuf[1].t < s.t - 2.5) snapBuf.shift();
}

// Slow motion draws the world a little further in the past, then fast-forwards back to live.
let slowLag = 0;
const renderTime = () => performance.now() / 1000 + (clockOffset ?? 0) - INTERP_DELAY - slowLag;
// Position of a player / item / shot at renderTime(): blended between the snapshots either side,
// or nudged forward along its velocity (at most 100 ms) if the newer snapshot hasn't arrived yet.
function sampleAt(kind, id, out) {
  const rt = renderTime();
  let a = null, at = 0, b = null, bt = 0;
  for (let i = snapBuf.length - 1; i >= 0; i--) {
    const e = snapBuf[i][kind].get(id);
    if (!e) continue;
    if (snapBuf[i].t <= rt) { a = e; at = snapBuf[i].t; break; }
    b = e; bt = snapBuf[i].t;
  }
  if (!a && !b) return null;
  if (a && b && Math.hypot(b.x - a.x, b.z - a.z) < 6) {
    const k = (rt - at) / Math.max(1e-3, bt - at);
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.f = a.f != null ? angleLerp(a.f, b.f, k) : 0;
    return out;
  }
  const e = b || a;
  const ext = a && !b ? Math.min(0.1, rt - at) : 0;
  out.x = e.x + (e.vx || 0) * ext;
  out.y = e.y + (e.g ? 0 : (e.vy || 0) * ext);
  out.z = e.z + (e.vz || 0) * ext;
  out.f = e.f ?? 0;
  return out;
}

// ---------- Local prediction: my critter reacts to my input instantly, then eases onto the server ----------
// Defaults mirror server.js; the room info sends the real values (room.move).
const PRED = { accel: 9, airAccel: 2.5, jump: 8.5, gravity: 24, punchCd: 420, kickCd: 700, aimTurn: 22, body: 0.85, flow: 6, bridge: 1.15 };
const PRED_SNAP = 1.5; // metres of disagreement before we stop easing and just jump to the server
const STALL_MS = 350; // no snapshot for this long: the connection is stuck, so hold still instead of drifting
const LATE_MS = 200; // snapshots arriving this late (a burst after a hiccup) are too stale to correct against
function applyMoveConstants(m) {
  if (!m) return;
  Object.assign(PRED, { accel: m.accel, airAccel: m.airAccel, jump: m.jump, gravity: m.gravity, aimTurn: m.aimTurn });
  if (m.body) Object.assign(PRED, { body: m.body, flow: m.flow, bridge: m.bridge });
  PRED.punchCd = m.punchCd * 1000;
  PRED.kickCd = m.kickCd * 1000;
}

// Same river test as the server: the current's direction here, or null on land / a bridge.
function riverFlowAt(x, z) {
  const rv = currentRiver();
  if (!rv) return null;
  let best = null, bestD = Infinity;
  for (const sg of rv.segs) {
    const px = x - sg.x0, pz = z - sg.z0;
    const t = Math.max(0, Math.min(sg.len, px * sg.dx + pz * sg.dz));
    const d = Math.hypot(px - sg.dx * t, pz - sg.dz * t);
    if (d < bestD) { bestD = d; best = sg; }
  }
  if (bestD > rv.half) return null;
  for (const b of rv.bridges) {
    if (Math.abs((x - b.x) * Math.sin(b.a) + (z - b.z) * Math.cos(b.a)) < PRED.bridge) return null;
  }
  return best;
}

// Mirrors the server's obstacle and fence pushes, so my critter stops where the server stops it.
function collidePredicted(c) {
  const R = snap.islandR;
  for (const o of room.obstacles || []) {
    if (Math.hypot(o.x, o.z) >= R - 0.3) continue;
    const dx = c.x - o.x, dz = c.z - o.z;
    const d = Math.hypot(dx, dz) || 1e-4;
    const minD = o.r + PRED.body * 0.8;
    if (d >= minD) continue;
    const nx = dx / d, nz = dz / d;
    c.x = o.x + nx * minD;
    c.z = o.z + nz * minD;
    const vn = c.pvx * nx + c.pvz * nz;
    if (vn < 0) { c.pvx -= vn * nx * 1.3; c.pvz -= vn * nz * 1.3; }
  }
  const d = Math.hypot(c.x, c.z);
  const lim = R - (room.guardInset ?? 0.25) - 0.6;
  if (d <= lim || d > R + 0.4) return;
  const a = Math.atan2(c.x, c.z);
  if ((snap.gaps || []).some(([gc, gh]) => Math.abs(Math.atan2(Math.sin(a - gc), Math.cos(a - gc))) < gh)) return;
  const nx = c.x / d, nz = c.z / d;
  c.x = nx * lim; c.z = nz * lim;
  const vn = c.pvx * nx + c.pvz * nz;
  if (vn > 0) { c.pvx -= vn * nx * 1.3; c.pvz -= vn * nz * 1.3; }
}
const myMove = { x: 0, z: 0 };let rtt = -1;
setInterval(() => {
  if (!socket.connected) return;
  const t0 = performance.now();
  socket.volatile.emit('rtt', () => {
    const r = performance.now() - t0;
    rtt = rtt < 0 ? r : rtt + (r - rtt) * 0.25;
  });
}, 2000);

const canPredict = (s) => !!s && snap?.phase === 'playing' && s.st === 'alive' && !s.fl && !s.ko && !s.sn && !s.hb && !s.hg && !s.lt;
const recent = (t, ms) => performance.now() - (t || 0) < ms;

// Where my critter was (locally) at time t, so a snapshot is compared against the same moment.
function predAt(hist, t) {
  if (!hist.length || t <= hist[0].t) return hist[0];
  for (let i = hist.length - 1; i > 0; i--) {
    const a = hist[i - 1], b = hist[i];
    if (a.t <= t) {
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
    }
  }
  return hist[0];
}

function predictMe(c, s, dt) {
  if (!canPredict(s)) { c.pred = false; return false; }
  const now = performance.now();
  if (!c.pred) { c.pred = true; c.pvx = s.vx; c.pvz = s.vz; c.ex = c.ez = 0; c.hist = []; c.reconT = snapTime; }
  // Connection stuck: freeze with the rest of the world rather than run off on stale data.
  if (now - snapTime > STALL_MS) return true;

  // Movement is relative to the water, exactly like the server, so the current carries me too.
  const flow = s.y < 0.4 && !(invLeft() > 0) ? riverFlowAt(c.x, c.z) : null;
  const fx = flow ? flow.dx * PRED.flow : 0, fz = flow ? flow.dz * PRED.flow : 0;
  const k = Math.min(1, (s.g ? PRED.accel : PRED.airAccel) * (flow ? 0.5 : 1) * dt);
  c.pvx += (myMove.x * s.ms - (c.pvx - fx)) * k;
  c.pvz += (myMove.z * s.ms - (c.pvz - fz)) * k;
  c.x += c.pvx * dt;
  c.z += c.pvz * dt;

  if (c.reconT !== snapTime) {
    c.reconT = snapTime;
    // Compare against where I was when the server produced this snapshot (its send time, not when
    // it happened to arrive), and skip ones that turned up late in a burst.
    const sent = snapSentAt ?? snapTime;
    if (snapTime - sent < LATE_MS) {
      const h = predAt(c.hist, sent - Math.max(0, rtt));
      c.ex = s.x - (h ? h.x : c.x);
      c.ez = s.z - (h ? h.z : c.z);
      if (Math.hypot(c.ex, c.ez) > PRED_SNAP) { c.x += c.ex; c.z += c.ez; c.ex = c.ez = 0; c.hist.length = 0; c.pvx = s.vx; c.pvz = s.vz; }
    }
  }
  const ke = 1 - Math.exp(-dt * 8);
  const dx = c.ex * ke, dz = c.ez * ke;
  c.x += dx; c.z += dz; c.ex -= dx; c.ez -= dz;
  collidePredicted(c);
  for (const h of c.hist) { h.x += dx; h.z += dz; }
  c.hist.push({ t: now, x: c.x, z: c.z });
  while (c.hist.length > 2 && c.hist[0].t < now - 1000) c.hist.shift();

  // Facing follows the same rules as the server: aim first, otherwise the way we move.
  const ml = Math.hypot(myMove.x, myMove.z);
  if (myAim) c.face = angleLerp(c.face, Math.atan2(myAim.x, myAim.z), Math.min(1, dt * PRED.aimTurn));
  else if (ml > 0.15) c.face = angleLerp(c.face, Math.atan2(myMove.x, myMove.z), Math.min(1, dt * 14));
  else c.face = angleLerp(c.face, c.tface, 1 - Math.exp(-dt * 6));
  return true;
}

// Start the jump / punch / kick animation the moment the button is pressed.
function predictActions(punch, jump, kick) {
  const c = critters.get(myId), s = c?.s;
  if (!canPredict(s) || !c.pred) return;
  if (jump && s.g && !(c.lift > 0)) {
    const melee = s.w && !WEAPON_INFO[s.w]?.ranged;
    c.liftV = PRED.jump * (melee ? 0.75 : 1);
    c.lift = 0.001;
    c.liftBase = c.y;
    c.sq += 0.3;
    c.localJump = performance.now();
  }
  if (punch && !s.w && !s.h && !recent(c.localPunch, PRED.punchCd)) {
    c.localPunch = performance.now();
    c.localArm = 1 - (c.localArm || 0);
    if (c.kind === 'model') { c.punchT = 0.45; c.setState('punch', { restart: true, duration: 0.45 }); }
    else c.punch[c.localArm] = 1;
  }
  if (kick && !s.h && !recent(c.localKick, PRED.kickCd)) {
    c.localKick = performance.now();
    c.kickNow = true;
  }
}

const interpOut = { x: 0, y: 0, z: 0, f: 0 };
function carriedByMe(c, s) {
  const me = critters.get(myId);
  if (!me?.pred || !me.s) return false;
  c.x = me.x + (s.x - me.s.x);
  c.y = me.y + (s.y - me.s.y);
  c.z = me.z + (s.z - me.s.z);
  c.face = s.f;
  return true;
}
const _rv = new THREE.Vector3(), _rs = new THREE.Vector3(), _rt = new THREE.Vector3(), _hv = new THREE.Vector3();
const easeOut = (u) => 1 - (1 - u) * (1 - u);
const clampAbs = (v, m) => Math.max(-m, Math.min(m, v));
const STUMBLE = 0.75, GET_UP = 0.75, PEEL = 0.4, THROW_FOLLOW = 0.45;

// Ragdoll from the pose on screen, carrying the snapshot velocity; thrown critters tumble head over heels.
function startRagdoll(c, s) {
  const rd = c.ragdoll || (c.ragdoll = new Ragdoll(c));
  _rv.set(s.vx || 0, s.vy || 0, s.vz || 0);
  const h = Math.hypot(_rv.x, _rv.z);
  if (c.thrownVis && h > 0.5) _rs.set(_rv.z / h, 0, -_rv.x / h).multiplyScalar(7 + Math.random() * 3);
  else _rs.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
  rd.start(c, _rv, _rs);
  c.rag = true;
  c.ragW = 1;
  c.ragAir = !s.g;
  c.hop = c.hopV = 0;
}

// Low tier: only my critter and the three nearest get spring chains and ragdolls.
let detailT = 0;
function assignDetail(dt) {
  detailT -= dt;
  if (detailT > 0) return;
  detailT = 0.25;
  if (tier() !== 'low') { for (const c of critters.values()) c.full = true; return; }
  const me = critters.get(myId);
  const rx = me ? me.x : camPos.x, rz = me ? me.z : camPos.z;
  const near = [...critters.values()].filter((c) => c !== me).sort((a, b) => Math.hypot(a.x - rx, a.z - rz) - Math.hypot(b.x - rx, b.z - rz));
  for (const c of near) c.full = false;
  near.slice(0, 3).forEach((c) => (c.full = true));
  if (me) me.full = true;
}

function animateCritter(c, dt, s, opts = {}) {
  const ox = c.x, oz = c.z, oy = c.y;
  if (s && opts.me && predictMe(c, s, dt)) {
    const age = Math.min(0.1, (performance.now() - snapTime) / 1000);
    const py = c.ty + c.tvy * age * (s.g ? 0 : 1);
    c.y += (py - c.y) * (1 - Math.exp(-dt * 16));
  } else if (s && opts.interp && s.hb === myId && carriedByMe(c, s)) {
    // Someone I'm carrying stays in my (predicted) hands rather than 100 ms behind them.
  } else if (s && opts.interp && sampleAt('players', c.id, interpOut)) {
    c.x = interpOut.x; c.y = interpOut.y; c.z = interpOut.z;
    c.face = interpOut.f;
  } else if (s) {
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
  c.dvy = (c.dvy || 0) + ((c.y - oy) / Math.max(dt, 1e-3) - (c.dvy || 0)) * Math.min(1, dt * 12);

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
  if (c.lift > 0) {
    c.liftV -= PRED.gravity * dt;
    c.lift = Math.max(0, c.lift + c.liftV * dt);
    if (!opts.me || !c.pred) c.lift = 0;
  }
  const airborne = (!grounded || c.lift > 0) && !held;

  c.root.position.set(c.x, c.lift > 0 ? Math.max(c.y, c.liftBase + c.lift) : c.y, c.z);
  c.root.rotation.y = c.face;
  // Wading: sink into the river and kick up splashes.
  const wet = !!(s && s.rv);
  if (wet && !c.wasWet) { puff(c.x, 0.2, c.z, 6, '#cfeeff', 2); if (opts.sound !== false) sfx.splash(); }
  c.wasWet = wet;
  c.wade = (c.wade || 0) + ((wet ? 1 : 0) - (c.wade || 0)) * Math.min(1, dt * 8);
  c.root.position.y -= c.wade * 0.4;
  if (wet && Math.random() < dt * 7) puff(c.x + (Math.random() - 0.5), 0.15, c.z + (Math.random() - 0.5), 1, '#cfeeff', 1.2);

  // ---- Visual-only states (all read from the snapshot; none of this touches gameplay) ----
  const now = performance.now();
  const fl = c.floppy;
  const full = c.full !== false;
  const inPlay = room?.phase !== 'lobby' && snap?.phase !== 'lobby';
  if (c.thrownVis && ((s && s.g && !s.sn && now - c.thrownAt > 300) || now - c.thrownAt > 4000 || held)) c.thrownVis = false;
  c.peelT = Math.max(0, (c.peelT || 0) - dt);
  const peeling = c.peelT > 0;
  const hangRaw = s ? s.hg || 0 : 0;
  if (hangRaw) c.lastHang = hangRaw;
  const hang = hangRaw || (peeling ? c.lastHang || 0.5 : 0);
  const swept = !!(s && s.rv && (s.sn || ko));
  const wantRag = !!(fl && full && s && inPlay && s.st === 'alive' && !held && !hang && (ko || falling || c.thrownVis || swept));
  if (wantRag && !c.rag) startRagdoll(c, s);
  else if (!wantRag && c.rag) {
    c.rag = false;
    if (!falling && s?.st === 'alive') c.getUpT = GET_UP;
  }
  if (!c.rag) c.ragW = Math.max(0, (c.ragW || 0) - dt / 0.4);
  if (!c.ragdoll) c.ragW = 0;
  const ragging = c.ragW > 0;
  if (s && s.g && !s.rv) c.groundY = c.y;
  if (c.rag) {
    if (!s.g) c.ragAir = true;
    else if (c.ragAir) {
      // One bounce on landing, then a flop.
      c.ragAir = false;
      c.hopV = c.thrownVis ? 4.2 : 2.2;
      fl.jiggle(1);
      puff(c.x, c.y + 0.1, c.z, 6, '#f3e6d6', 2.2);
    }
  }
  c.hopV = (c.hopV || 0) - 22 * dt;
  c.hop = Math.max(0, (c.hop || 0) + c.hopV * dt);
  if (c.hop === 0 && c.hopV < 0) c.hopV = 0;

  c.getUpT = Math.max(0, (c.getUpT || 0) - dt);
  const getting = c.getUpT > 0, gu = getting ? 1 - c.getUpT / GET_UP : 1;
  c.stumbleT = Math.max(0, (c.stumbleT || 0) - dt);
  const st = c.stumbleT / STUMBLE;
  c.throwT = Math.max(0, (c.throwT || 0) - dt);
  const th = c.throwT > 0 ? 1 - c.throwT / THROW_FOLLOW : -1;
  c.smugT = Math.max(0, (c.smugT || 0) - dt);
  c.spinDizzyT = Math.max(0, (c.spinDizzyT || 0) - dt);
  const dizzyWant = Math.max(s && s.dz > 55 && !ko ? Math.min(1, 0.45 + (s.dz - 55) / 40) : 0, Math.min(1, c.spinDizzyT * 1.4));
  c.dizzy = (c.dizzy || 0) + (dizzyWant - (c.dizzy || 0)) * Math.min(1, dt * 4);
  const dz = c.dizzy;

  // Landing: squash and a belly jiggle sized by how hard we came down.
  const inAir = airborne && !hang;
  if (inAir) c.minVy = Math.min(c.minVy || 0, c.dvy);
  else if (c.wasAir) {
    const imp = Math.min(1, Math.max(0, -(c.minVy || 0)) / 12);
    if (imp > 0.15 && !ragging) { c.sqV -= 7 * imp; fl?.jiggle(imp); }
    c.minVy = 0;
  }
  c.wasAir = inAir;

  // Walk cycle (drunk and irregular when dizzy)
  const amt = grounded ? Math.min(1, speed / 4) : 0;
  c.walk += dt * (2 + speed * 2.4) * (amt > 0.05 ? 1 : 0) * (1 + Math.sin(time * 3.3) * 0.45 * dz);
  const sw = Math.sin(c.walk);

  // Lean into acceleration and tip back when stopping hard; roll into turns. Damped springs overshoot a little.
  spring(c, 'lean', 'leanV', grounded ? clampAbs(speed * 0.03 + laz * 0.012, 0.32) : speed * 0.02, 120, 9, dt);
  spring(c, 'sq', 'sqV', 0, 220, 8, dt);
  const heavy = c.weaponMesh && !WEAPON_INFO[c.weaponType]?.ranged ? 2.4 : 1;
  spring(c, 'tilt', 'tiltV', sw * 0.1 * amt * heavy - (grounded ? clampAbs(lax * 0.01, 0.2) : 0), 160, 10, dt);

  c.ko += ((ko ? 1 : 0) - c.ko) * Math.min(1, dt * 8);
  if (falling && !ragging) c.tumble += dt * 5; else c.tumble *= Math.exp(-dt * 10);

  const isModel = c.kind === 'model';
  const p = c.pivot;
  let bounce = Math.abs(sw) * 0.08 * amt * (isModel && c.animated ? 0 : 1) + (opts.hop ? Math.abs(Math.sin(time * 7)) * 0.6 : 0);
  bounce -= dz * (0.1 + Math.sin(time * 5.3) * 0.04); // knees buckle
  p.position.set(0, bounce, 0);
  const koTip = isModel && c.hasKoClip ? 0 : c.ko;
  const leanAmt = isModel && c.animated ? 0.4 : 1;
  p.rotation.set(c.lean * leanAmt * (1 - c.ko) - koTip * 1.45 + c.tumble, 0, c.tilt * leanAmt);
  const sq = c.sq * (isModel ? 0.5 : 1);
  p.scale.set(1 - sq * 0.5, 1 + sq, 1 - sq * 0.5);
  updateHeldWeapon(c, dt, s);

  // Kick: lean back and shoot one leg forward.
  const kickStart = (!!(s && s.kk && !c.lastKk) && !recent(c.localKick, Math.max(0, rtt) + 250)) || !!c.kickNow;
  c.kickNow = false;
  if (kickStart) c.kickA = 1;
  c.lastKk = s ? s.kk : 0;
  c.kickA = Math.max(0, (c.kickA || 0) - dt * 3.2);
  const kickE = Math.sin(c.kickA * Math.PI);
  p.rotation.x -= kickE * 0.3;
  // Hanging off the fence: pulled up toward the rail as the climb progresses, swaying.
  if (hang) {
    p.rotation.x = 0.25 + Math.sin(time * 10) * 0.05;
    p.rotation.z += Math.sin(time * 2.3) * 0.12;
    p.position.y = Math.sin(hang * Math.PI * 7) * 0.05;
  }
  if (!isModel && fl) {
    // Stagger with the knock, side to side for a couple of steps.
    if (st > 0) {
      const e = Math.sin(st * Math.PI);
      p.rotation.x += (c.knockZ || 0) * 0.45 * e;
      p.rotation.z -= (c.knockX || 0) * 0.45 * e;
      p.rotation.z += Math.sin((1 - st) * Math.PI * 3) * 0.14 * st;
    }
    // Dizzy: drunk wobble, the head rolling round.
    if (dz > 0.01) {
      p.rotation.z += (Math.sin(time * 2.7) * 0.14 + Math.sin(time * 1.3) * 0.08) * dz;
      p.rotation.x += Math.sin(time * 2.1) * 0.06 * dz;
      c.root.rotation.y += Math.sin(time * 1.9) * 0.2 * dz;
      fl.extra.x += Math.sin(time * 4.5) * 0.22 * dz;
      fl.extra.z += Math.cos(time * 4.5) * 0.22 * dz;
    }
    // Heavy weapons: dragging pulls the shoulder down; pan sweeps twist the torso.
    if (c.wPhase === 'drag' && c.weaponMesh && c.weaponType === 'hammer') p.rotation.z -= 0.14;
    spring(c, 'twist', 'twistV', c.twistT || 0, 140, 12, dt);
    p.rotation.y += c.twist || 0;
    // Getting up: push up off the ground, then shake it off.
    if (getting) {
      p.rotation.x += 0.5 * Math.max(0, 1 - gu * 2);
      if (gu > 0.45) fl.extra.y += Math.sin(time * 30) * 0.5 * (1 - gu);
    }
    if (th >= 0) p.rotation.x += 0.35 * Math.sin(th * Math.PI);
    // Carried: swing like a pendulum under the grip, around chest height.
    if (held) {
      c.pendVX = (c.pendVX || 0) + (-(c.pendX || 0) * 30 - c.pendVX * 2.2 + laz * 0.8) * dt;
      c.pendVZ = (c.pendVZ || 0) + (-(c.pendZ || 0) * 30 - c.pendVZ * 2.2 - lax * 0.8) * dt;
      c.pendX = clampAbs((c.pendX || 0) + c.pendVX * dt, 0.9);
      c.pendZ = clampAbs((c.pendZ || 0) + c.pendVZ * dt, 0.9);
      const G = 1.2;
      p.rotation.x += c.pendX;
      p.rotation.z += c.pendZ;
      p.position.x += G * Math.sin(c.pendZ);
      p.position.y += G * (1 - Math.cos(c.pendX)) + G * (1 - Math.cos(c.pendZ));
      p.position.z -= G * Math.sin(c.pendX);
    } else c.pendX = c.pendZ = c.pendVX = c.pendVZ = 0;
  }

  if (isModel) {
    animateModel(c, dt, { s, speed, held: held || hang, holding, ko, falling, airborne, opts, kickStart });
    c.stars.visible = c.ko > 0.3;
    if (c.stars.visible) {
      c.stars.rotation.y += dt * 4;
      c.stars.position.y = c.hasKoClip ? 0.9 : c.height * 0.55 + 0.3;
    }
    c.root.visible = !(s && s.st === 'out' && room?.phase !== 'lobby');
    return;
  }

  // Feet: kick around when airborne, lift into the air when knocked flat
  const kick = airborne || held || falling ? Math.sin(time * (hang ? 12 : 18)) * 0.2 : 0;
  const koLift = c.ko * 0.5;
  const splay = dz * 0.12;
  c.footL.position.set(-0.34 - splay, 0.13 + Math.max(0, sw) * 0.16 * amt + koLift + kick, 0.08 + sw * 0.28 * amt + koLift * 0.8);
  c.footR.position.set(0.34 + splay, 0.13 + Math.max(0, -sw) * 0.16 * amt + koLift - kick + kickE * 0.55, 0.08 - sw * 0.28 * amt + koLift * 0.8 + kickE * 0.95);
  c.footR.scale.setScalar(1 + kickE * 0.3);
  if (st > 0 && grounded) {
    // Stagger steps in the direction of the knock.
    const ph = (1 - st) * Math.PI * 3;
    c.footL.position.y += Math.max(0, Math.sin(ph)) * 0.22 * st;
    c.footR.position.y += Math.max(0, -Math.sin(ph)) * 0.22 * st;
    c.footL.position.z += (c.knockZ || 0) * 0.25 * st * Math.sin(ph);
    c.footR.position.z -= (c.knockZ || 0) * 0.25 * st * Math.sin(ph);
  }
  if (hang) {
    // Scrambling against the fence.
    [c.footL, c.footR].forEach((f, i) => f.position.set((i ? 1 : -1) * 0.28, 0.4 + Math.sin(time * 15 + i * Math.PI) * 0.25, 0.42 + Math.cos(time * 15 + i * Math.PI) * 0.12));
  } else if (held || (c.ko > 0.5 && !ragging)) {
    // Feet hang off the body (swinging with it), kicking hard while mashing to escape.
    p.updateMatrix();
    const mash = held && s.mh;
    [c.footL, c.footR].forEach((f, i) => {
      const k = held ? Math.sin(time * (mash ? 24 : 5) + i * Math.PI) * (mash ? 0.32 : 0.08) : 0;
      _hv.set((i ? 1 : -1) * 0.25, 0.1 + Math.max(0, k), 0.08 + k).applyMatrix4(p.matrix);
      if (!held) _hv.y += 0.35 + kick;
      f.position.copy(_hv);
    });
  }

  // Arms
  if (s && s.pa && s.pa !== c.lastPa && !c.weaponMesh && !recent(c.localPunch, Math.max(0, rtt) + 250)) c.punch[s.pa - 1] = 1;
  c.lastPa = s ? s.pa : 0;
  c.punch[0] = Math.max(0, c.punch[0] - dt * 4.5);
  c.punch[1] = Math.max(0, c.punch[1] - dt * 4.5);
  let gripReady = false;
  if (!c.armV) c.armV = [new THREE.Vector3(), new THREE.Vector3()];

  [c.armL, c.armR].forEach((arm, i) => {
    const side = i === 0 ? -1 : 1;
    const rest = c.restArm[i];
    let tx = rest.x, ty = rest.y + Math.sin(time * 2.5 + i) * 0.03, tz = rest.z - side * sw * 0.3 * amt;
    let locked = false;
    const peeled = peeling && c.peelT < (i === 0 ? PEEL - 0.02 : PEEL * 0.5);
    if (hang && !peeled) {
      // Paws gripping the rail, hauling up hand over hand.
      tx = side * 0.42; ty = 1.75 + Math.max(0, Math.sin(time * 7 + i * Math.PI)) * 0.18; tz = 0.6;
      locked = true;
    } else if (peeled) {
      tx = side * 1.05; ty = 2.0 + Math.sin(time * 22 + i * 2) * 0.15; tz = 0.05;
    } else if (holding) {
      // Reach for the buddy we're carrying and lock on either side of them.
      const v = critters.get(s.h);
      tx = side * 0.5; ty = 1.65; tz = 0.9;
      if (v) {
        if (!gripReady) { p.updateWorldMatrix(true, false); gripReady = true; }
        _hv.set(v.x, v.root.position.y + 0.95, v.z);
        p.worldToLocal(_hv);
        tx = _hv.x + side * 0.42; ty = _hv.y; tz = _hv.z - 0.1;
        const sh = c.shoulders?.[i];
        if (sh) {
          _rt.set(tx - sh.x, ty - sh.y, tz - sh.z);
          const reach = _rt.length();
          if (reach > 1.15) { _rt.multiplyScalar(1.15 / reach); tx = sh.x + _rt.x; ty = sh.y + _rt.y; tz = sh.z + _rt.z; }
        }
      }
      locked = true;
    } else if (th >= 0) {
      // Throw follow-through: paws fling forward and up, then drop.
      tx = side * 0.4; ty = 1.5 + Math.sin(th * Math.PI) * 0.7; tz = 0.7 + th * 0.5;
      locked = true;
    } else if (c.weaponMesh && !(c.ko > 0.5)) {
      const wp = c.weaponMesh.position;
      tx = wp.x + (i === 0 ? -0.3 : 0.06);
      ty = wp.y + (i === 0 ? 0.08 : -0.04);
      tz = wp.z + (i === 0 ? 0.08 : 0);
      locked = true;
    } else if (c.gloves && !(c.ko > 0.5) && !airborne && !held && !falling && !(st > 0)) {
      // Boxer's guard: both gloves up in front of the chin, bobbing; drawn back while winding up.
      const wind = s && s.sw === 1 ? 0.18 : 0;
      tx = side * 0.36; ty = 1.4 + Math.sin(time * 6 + i * Math.PI) * 0.05; tz = 0.5 - wind;
    }
    else if (airborne || held || falling) {
      const fast = held && s.mh ? 34 : 22;
      tx = side * 1.05; ty = 2.0 + Math.sin(time * fast + i * 2) * 0.15; tz = 0.05;
    } else if (c.ko > 0.5) {
      tx = side * 1.15; ty = 1.0; tz = 0.4;
    } else if (st > 0) {
      // Windmilling to keep balance.
      const a = time * 16 + i * Math.PI;
      tx = side * (0.85 + Math.cos(a) * 0.15); ty = 1.35 + Math.sin(a) * 0.45 * st; tz = Math.cos(a) * 0.35;
    } else if (getting && gu < 0.5) {
      // Paws on the ground, pushing up.
      tx = side * 0.55; ty = 0.2 - bounce; tz = 0.65;
    } else if (opts.wave && i === 1) {
      tx = 0.95 + Math.sin(time * 9) * 0.12; ty = 2.05; tz = 0.25;
    }
    const pn = c.punch[i];
    if (pn > 0) {
      const e = Math.sin(pn * Math.PI);
      tx = side * 0.45 * (1 - e) + side * 0.2 * e;
      ty = 1.35;
      tz = 0.35 + e * 1.05;
      locked = true;
    }
    const av = c.armV[i];
    if (locked || !fl) {
      const k = 1 - Math.exp(-dt * (c.weaponMesh ? 40 : 22));
      arm.position.x += (tx - arm.position.x) * k;
      arm.position.y += (ty - arm.position.y) * k;
      arm.position.z += (tz - arm.position.z) * k;
      av.set(0, 0, 0);
    } else {
      // Floppy: a springy paw that lags the body, so a hard stop swings the arms forward.
      tx -= clampAbs(lax * 0.012, 0.3);
      tz -= clampAbs(laz * 0.012, 0.3);
      av.x += ((tx - arm.position.x) * 260 - av.x * 14) * dt;
      av.y += ((ty - arm.position.y) * 260 - av.y * 14) * dt;
      av.z += ((tz - arm.position.z) * 260 - av.z * 14) * dt;
      arm.position.addScaledVector(av, dt);
    }
    arm.scale.setScalar(1 + pn * 0.35);
  });
  if (c.punch[0] > 0 || c.punch[1] > 0) p.rotation.y = (c.punch[1] - c.punch[0]) * 0.35;

  // Faces react: swirly KO eyes, a yelp on big hits, shock when grabbed, grit while winding up, smug after a throw.
  c.blink -= dt;
  if (c.blink < -0.12) c.blink = 2 + Math.random() * 4;
  const swirly = c.ko > 0.5;
  const yelp = st > 0.35 && c.stumbleBig;
  const shocked = !!held && !swirly;
  const winding = !!(s && s.sw === 1);
  const smug = c.smugT > 0 && !held && !swirly;
  let eyeX = 1, eyeY = 1;
  if (swirly) eyeY = 1;
  else if (yelp) { eyeX = 1.15; eyeY = 0.1; }
  else if (c.blink < 0 || falling) eyeY = 0.12;
  else if (shocked) eyeX = eyeY = 1.22;
  else if (winding) eyeY = 0.62;
  else if (smug) eyeY = 0.5;
  c.eyes.forEach((e, i) => {
    e.scale.set(eyeX, eyeY, 1);
    const sp = e.userData.swirl;
    if (sp) { sp.visible = swirly; if (swirly) sp.rotation.z += dt * 9 * (i ? 1 : -1); }
  });
  const angry = c.punch[0] > 0 || c.punch[1] > 0 || holding || winding;
  for (const b of c.brows) {
    const sd = b.userData.side;
    const target = winding ? -sd * 0.6 : angry ? -sd * 0.45 : smug ? (sd > 0 ? 0.3 : -0.15) : c.ouch > 0 || held || falling || yelp ? sd * 0.35 : 0;
    b.userData.tilt = (b.userData.tilt || 0) + (target - (b.userData.tilt || 0)) * Math.min(1, dt * 12);
    b.rotation.z = Math.PI / 2 + b.userData.tilt;
    if (b.userData.y0 === undefined) b.userData.y0 = b.position.y;
    b.position.y = b.userData.y0 + (shocked ? 0.06 : smug && sd > 0 ? 0.04 : 0);
  }
  const yell = c.ouch > 0 || held || falling || airborne || c.ko > 0.5 || yelp;
  c.openMouth.visible = yell;
  c.openMouth.scale.set(shocked ? 0.8 : yelp ? 1.3 : 1, shocked ? 1.35 : yelp ? 1.5 : 1, 1);
  c.smile.visible = !yell && c.smileDefault !== false;
  c.smile.scale.set(smug ? 1.45 : winding ? 1.1 : 1, smug ? 0.85 : winding ? 0.25 : 1, 1);
  c.smile.rotation.z = smug ? 0.14 : 0;

  // Stars circle the head when knocked out or dizzy.
  c.stars.visible = c.ko > 0.3 || dz > 0.35;
  if (c.stars.visible) {
    c.stars.rotation.y += dt * (c.ko > 0.3 ? 4 : 5.5);
    c.stars.scale.setScalar(c.ko > 0.3 ? 1 : 0.8);
    if (!ragging) c.stars.position.set(0, c.ko > 0.3 ? 1.3 + c.ko * 0.2 : (c.height || 2.75) * 0.62 + 0.55 + bounce, c.ko > 0.3 ? -c.ko * 1.2 : 0);
  }

  if (fl) {
    const slack = ragging || c.ko > 0.5 ? 1 : held ? 0.4 : 0;
    fl.update(dt, slack, full);
    if (ragging) {
      const rd = c.ragdoll;
      const ground = falling ? -Infinity : s?.rv ? c.y - 0.25 : c.groundY ?? 0;
      _rt.set(c.root.position.x, c.root.position.y + 0.5 + (c.hop || 0), c.root.position.z);
      rd.step(dt, _rt, ground, !!(c.rag && (c.ragAir || falling)), !!(c.rag && ko));
      poseRagdoll(c, rd, easeOut(c.ragW));
      if (c.stars.visible) {
        ragdollHead(rd, _hv);
        _hv.y += 0.75;
        c.stars.position.copy(c.root.worldToLocal(_hv));
      }
    }
  }
  c.updateLimbs(bounce);
  fl?.stepChains(dt);

  c.root.visible = !(s && s.st === 'out' && room?.phase !== 'lobby');
}

function animateModel(c, dt, { s, speed, held, holding, ko, falling, airborne, opts, kickStart }) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  if ((s && s.pa && s.pa !== c.lastPa && !recent(c.localPunch, Math.max(0, rtt) + 250)) || kickStart) {
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
    const a = Math.random() * Math.PI * 2, sp = spread * Math.random();
    particles.spawn({
      x, y, z, vx: Math.cos(a) * sp, vy: Math.random() * 2.5, vz: Math.sin(a) * sp, drag: 1.2,
      life: 0.5 + Math.random() * 0.3, size: 0.55, grow: 1.5 + Math.random(), color, fade: 0.8,
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
const ROOM_CODE = 'ghouse';
let wantedAnimal = null;
const nameInput = $('nameInput');
nameInput.value = localStorage.getItem('bb-name') || '';
let myName = '';

function buildPicker(el, onPick) {
  el.innerHTML = '';
  for (const key of ANIMAL_KEYS) {
    const b = document.createElement('button');
    b.dataset.animal = key;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = CHARACTERS[key].color;
    const label = document.createElement('span');
    label.textContent = CHARACTERS[key].label;
    b.append(sw, label);
    b.onclick = () => onPick(key);
    el.append(b);
  }
}
// Characters other players in the room already have: animal -> their name.
function takenAnimals() {
  return new Map((room?.players || []).filter((p) => p.id !== myId).map((p) => [p.animal, p.name]));
}
function markPicker() {
  const taken = takenAnimals();
  document.querySelectorAll('.animal-picker button').forEach((b) => {
    const by = taken.get(b.dataset.animal);
    b.classList.toggle('selected', b.dataset.animal === myAnimal);
    b.classList.toggle('taken', !!by);
    b.disabled = !!by;
    b.title = by ? `Taken by ${by}` : '';
    let tag = b.querySelector('small');
    if (by && !tag) b.append((tag = document.createElement('small')));
    if (tag) tag.textContent = by ? `taken` : '';
  });
}
function pickAnimal(key) {
  if (takenAnimals().has(key)) return;
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
  if (document.fullscreenElement || !document.fullscreenEnabled) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation?.lock?.('landscape'))
    .catch(() => {});
}
function updateScreenUi() {
  $('fullscreenBtn').classList.toggle('hidden', isInstalled || !document.fullscreenEnabled || !!document.fullscreenElement);
  $('rotateHint').classList.toggle('hidden', !myId || innerWidth > innerHeight);
}
$('fullscreenBtn').onclick = goFullscreen;
document.addEventListener('fullscreenchange', updateScreenUi);
window.addEventListener('resize', updateScreenUi);
updateScreenUi();
// There is a single room, so Play always joins it (creating it if nobody is there yet).
$('playBtn').onclick = () => {
  initAudio();
  goFullscreen();
  wantedAnimal = myAnimal;
  myName = getName();
  unlockVideoSound();
  socket.emit('join', { code: ROOM_CODE, name: myName, animal: myAnimal, sid: SESSION_ID });
};
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('playBtn').click(); });

// A host playing on localhost needs to hand phones the laptop's Wi-Fi address instead.
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let shareOrigin = location.origin;
if (isLocalHost) {
  fetch('/lan').then((r) => r.json()).then(({ urls }) => {
    if (urls.length) { shareOrigin = urls[0]; renderShareUrl(); }
  }).catch(() => {});
}
function inviteLink() { return `${shareOrigin}/?room=${ROOM_CODE}`; }
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
  history.replaceState(null, '', `?room=${code.toLowerCase()}`);
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('viewBtn').classList.remove('hidden');
  updateScreenUi();
  if (isAdminName()) socket.emit('adm', { op: 'auth', pin: localStorage.getItem(PIN_KEY) || '' });
});

socket.on('room', (r) => {
  room = r;
  applyMoveConstants(r.move);
  buildObstacles();
  syncCritters();
  renderLobby();
  renderScoreboard();
  onPhase(r.phase);
  if (adm.open) renderSecret();
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
  if (me) {
    if (wantedAnimal && wantedAnimal !== me.animal) {
      const note = $('pickNote');
      note.textContent = `${CHARACTERS[wantedAnimal]?.label || 'That critter'} was taken, so you're ${CHARACTERS[me.animal]?.label || me.animal}. Pick any free one!`;
      note.classList.remove('hidden');
      setTimeout(() => note.classList.add('hidden'), 6000);
    }
    wantedAnimal = null;
    myAnimal = me.animal;
  }
  markPicker();
}

// Called on every snapshot, but the DOM is only rebuilt when something on it actually changed.
let scoreboardKey = '';
function renderScoreboard() {
  if (!room) return;
  const states = new Map((snap?.players || []).map((p) => [p.id, p.st === 'out' || p.fl]));
  const key = room.phase + '|' + myId + '|' + room.players.map((p) => `${p.id}:${p.name}:${p.animal}:${p.score}:${teamOf(p)}:${states.get(p.id) ? 1 : 0}`).join(',');
  if (key === scoreboardKey) return;
  scoreboardKey = key;
  const sb = $('scoreboard');
  sb.innerHTML = '';
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
  if (phase === 'loading') {
    closeSecret();
    showLoading();
    // Compile the round's shaders behind the loading screen instead of hitching mid-fight.
    requestAnimationFrame(() => renderer.compileAsync?.(scene, camera).catch(() => {}));
  } else {
    hideLoading();
    if (phase !== 'lobby') videoLoad = false;
  }
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
  // Out-of-order leftovers are dropped (a big jump back means the server restarted).
  if (snap && s.t <= snap.t && s.t > snap.t - 1) return;
  snap = s;
  snapTime = performance.now();
  if (s.phase === 'lobby') snapBuf.length = 0;
  else bufferSnapshot(s);
  snapSentAt = clockOffset == null ? null : (s.t - clockOffset) * 1000;
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

  if (s.phase === 'countdown') {
    const n = Math.ceil(s.countdown - s.phaseTime);
    if (n !== lastCount && n > 0) { lastCount = n; sfx.beep(false); }
    const mine = room?.players.find((p) => p.id === myId);
    const t = mine ? teamOf(mine) : -1;
    const late = s.players.find((p) => p.id === myId)?.lt;
    if (late) setBanner('Round starting', 'Spectating… you join next round');
    else setBanner(String(Math.max(1, n)), t >= 0 ? `You're on the <span style="color:${TEAM_COLORS[t]}">${TEAM_NAMES[t]} Team</span>` : '');
  } else if (s.phase === 'playing') {
    if (lastCount !== 0) { lastCount = 0; sfx.beep(true); }
    const me = s.players.find((p) => p.id === myId);
    if (me && me.lt) setBanner('Round in progress', 'Spectating… you join next round');
    else if (s.phaseTime < 1) setBanner('BRAWL!');
    else if (me && (me.st === 'out' || me.fl)) setBanner('You fell off!', 'Spectating…');
    else if (s.shrinkIn <= 0 && s.shrinkIn > -2.5) setBanner('The island is shrinking!', 'The fence moves in with it');
    else setBanner('');
  } else {
    lastCount = -1;
  }
  renderScoreboard();
});

socket.on('ev', (list) => { for (const e of list) handleEvent(e); });

// ---------- Connection drops: keep the same critter if the server still has it, else rejoin ----------
const netWarn = document.createElement('div');
netWarn.id = 'netWarn';
netWarn.className = 'hidden';
netWarn.textContent = 'Reconnecting…';
document.body.append(netWarn);
function rejoin() {
  if (!myId) return;
  myId = null;
  socket.emit('join', { code: ROOM_CODE, name: myName, animal: wantedAnimal || myAnimal, sid: SESSION_ID });
}
socket.on('connect', () => {
  snapBuf.length = 0;
  clockOffset = null;
  if (myId && !socket.recovered) rejoin();
});
socket.on('rejoin', rejoin);
let netWarnOn = false;
function updateNetWarn(now, playing) {
  const on = !!room && (!socket.connected || (playing && now - snapTime > 1500));
  if (on === netWarnOn) return;
  netWarnOn = on;
  netWarn.classList.toggle('hidden', !on);
}

// True when this fall leaves a single player (or team) standing: time for the slow-mo finish.
function lastStanding(id) {
  if (!snap || snap.phase !== 'playing' || !room) return false;
  const sideOf = (pid) => {
    const p = room.players.find((q) => q.id === pid);
    const t = p ? teamOf(p) : -1;
    return t >= 0 ? `t${t}` : pid;
  };
  const before = new Set(), after = new Set();
  for (const p of snap.players) {
    if (p.st !== 'alive' || (p.fl && p.id !== id)) continue;
    before.add(sideOf(p.id));
    if (p.id !== id) after.add(sideOf(p.id));
  }
  return before.size > 1 && after.size === 1;
}

function handleEvent(e) {
  const c = critters.get(e.id);
  if (e.t === 'hit' && e.df) {
    // Bounced off an invincible player: a funny block, no stagger.
    const target = critters.get(e.b);
    if (target) { target.sq -= 0.2; target.jvz -= 1.5; }
    puff(e.x, e.y, e.z, 4, '#ffffff', 2);
    comicWord(e.x, e.y, e.z, false, ['BOING!']);
    shake = Math.max(shake, 0.12);
    sfx.hit(false);
    sfx.boing();
  } else if (e.t === 'hit') {
    const target = critters.get(e.b);
    if (target) {
      target.sq -= e.big ? 0.4 : 0.28; target.rip = 1; target.ouch = 0.5; target.jvz -= 4;
      // Stagger away from the attacker; the head snaps back the same way.
      const from = critters.get(e.a);
      let kx = target.x - (from ? from.x : e.x), kz = target.z - (from ? from.z : e.z);
      const kl = Math.hypot(kx, kz) || 1;
      kx /= kl; kz /= kl;
      const cf = Math.cos(target.face), sf = Math.sin(target.face);
      target.knockX = kx * cf - kz * sf;
      target.knockZ = kx * sf + kz * cf;
      target.stumbleT = STUMBLE;
      target.stumbleBig = !!e.big;
      target.floppy?.kickHead(target.knockZ * (e.big ? 10 : 7), -target.knockX * (e.big ? 10 : 7));
      target.floppy?.jiggle(e.big ? 0.8 : 0.5);
    }
    puff(e.x, e.y, e.z, e.big ? 10 : 6, e.w === 'blaster' ? '#ffc79a' : '#ffffff');
    comicWord(e.x, e.y, e.z, e.big, e.w && (!e.big || e.w === 'gloves') ? WEAPON_INFO[e.w]?.words : null);
    shake = Math.max(shake, e.big ? 0.5 : e.w ? 0.35 : 0.25);
    if (e.big) {
      grassBits(target ? target.x : e.x, target ? target.z : e.z);
      if (e.a === myId || e.b === myId) hitStop = Math.max(hitStop, 0.07);
    }
    sfx.hit(e.big || !!e.w);
    if (e.w === 'pan') sfx.clang();
    if (e.w === 'hammer') sfx.squeak();
    if (e.w === 'gloves') sfx.pow();
  } else if (e.t === 'windup') {
    sfx.heave();
  } else if (e.t === 'swing') {
    if (e.w) sfx.whoosh(); else sfx.swing();
  } else if (e.t === 'shoot') {
    sfx.shoot();
    } else if (e.t === 'pickup') {
    if (c) { c.sq -= 0.4; puff(c.x, 0.2, c.z, 6, '#f3e6d6', 1.5); }
    sfx.pickup();
    sfx.heave();
  } else if (e.t === 'toss') {
    sfx.whoosh();
  } else if (e.t === 'break') {
    puff(e.x, e.y, e.z, 9, '#e3a867', 2.5);
    comicWord(e.x, e.y, e.z, false, e.w === 'gloves' ? ['WORN OUT!', 'RIPPED!'] : ['BROKE!', 'CRACK!']);
    sfx.breakIt();
  } else if (e.t === 'pop') {
    puff(e.x, e.y, e.z, 4, '#ffc79a', 1.5);
  } else if (e.t === 'itemLand') {
    puff(e.x, 0.1, e.z, 5, '#fff3a0', 1.8);
    sfx.drop();
  } else if (e.t === 'jump') {
    if (c && !(e.id === myId && recent(c.localJump, Math.max(0, rtt) + 400))) c.sq += 0.3;
    if (e.id === myId) sfx.jump();
  } else if (e.t === 'land') {
    if (c && !c.s?.rv) { c.rip = 0.7; landPuff(c.x, c.z, Math.min(1.4, 0.5 + Math.max(0, -(c.minVy || 0)) * 0.06)); }
    sfx.land();
  } else if (e.t === 'grab') {
    const v = critters.get(e.target);
    v?.floppy?.kickHead(-6, 0);
    sfx.grab();
  } else if (e.t === 'throw') {
    if (c) { c.leanV += 8; c.throwT = THROW_FOLLOW; c.smugT = 1.8; }
    const v = critters.get(e.target);
    if (v) { v.thrownVis = true; v.thrownAt = performance.now(); }
    shake = Math.max(shake, 0.2);
    if (e.id === myId || e.target === myId) hitStop = Math.max(hitStop, 0.05);
    sfx.throw();
  } else if (e.t === 'ko') {
    if (c) puff(c.x, c.y + 2, c.z, 8, '#fff3a0', 2);
    hitStop = Math.max(hitStop, 0.08);
    sfx.ko();
  } else if (e.t === 'fall') {
    if (c && lastStanding(e.id)) { slowMo = SLOW_MO; slowTarget = c; }
    sfx.fall();
  } else if (e.t === 'spin') {
    if (c) c.sq -= 0.2;
    sfx.spin();
  } else if (e.t === 'kick') {
    sfx.kick();
  } else if (e.t === 'hang') {
    if (c) { c.sq -= 0.3; comicWord(c.x, c.y + 1.4, c.z, false, ['GRAB!', 'HANG ON!', 'PHEW!']); }
    sfx.grab();
  } else if (e.t === 'climb') {
    if (c) { c.sq += 0.4; puff(c.x, c.y + 0.4, c.z, 6, '#ffffff', 2); comicWord(c.x, c.y + 1.6, c.z, false, ['BACK!', 'SAFE!', 'HUP!']); }
    sfx.climb();
  } else if (e.t === 'letgo') {
    if (c) { c.peelT = PEEL; comicWord(c.x, c.y + 1.2, c.z, true, ['BYE!', 'NOOO!', 'SEE YA!']); }
  } else if (e.t === 'shrinkWarn') {
    sfx.warn();
  }
}

// ---------- Input ----------
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
let swallowViewClick = false;
$('viewBtn').onclick = () => {
  if (swallowViewClick) { swallowViewClick = false; return; }
  setViewMode(viewMode === 'follow' ? 'arena' : 'follow');
};
setViewMode(viewMode);
{
  const btn = $('viewBtn');
  let holdTimer = 0;
  const cancel = () => {
    clearTimeout(holdTimer);
    holdTimer = 0;
    if (swallowViewClick) setTimeout(() => (swallowViewClick = false), 400);
  };
  btn.addEventListener('pointerdown', (e) => {
    swallowViewClick = false;
    clearTimeout(holdTimer);
    if (!isAdminName()) return;
    holdTimer = setTimeout(() => { holdTimer = 0; swallowViewClick = true; openSecret(); }, 1500);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
let joy = { x: 0, y: 0, id: null, ox: 0, oy: 0 };
let punchQueued = false, jumpQueued = false, kickQueued = false, fireQueued = false, touchGrab = false;
// Aiming: drag from the THROW button; letting go throws in the aimed direction.
const AIM_DEADZONE = 26;
let touchAim = { id: null, dx: 0, dy: 0 };
let myAim = null, fireAim = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const camFwd = new THREE.Vector3();
// A screen-space drag turned into a ground direction, whichever way the camera faces.
function screenToGround(dx, dy) {
  camera.getWorldDirection(camFwd);
  camFwd.y = 0;
  camFwd.normalize();
  const x = -camFwd.z * dx - camFwd.x * dy, z = camFwd.x * dx - camFwd.z * dy;
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}
function computeAim() {
  const me = critters.get(myId);
  if (!me || !snap || snap.phase === 'lobby') return null;
  const facing = { x: Math.sin(me.face), z: Math.cos(me.face) };
  if (touchAim.id === null) return null;
  return Math.hypot(touchAim.dx, touchAim.dy) < AIM_DEADZONE ? facing : screenToGround(touchAim.dx, touchAim.dy);
}

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
  hold('tKick', () => (kickQueued = true));
  hold('tGrab', () => (touchGrab = true), () => (touchGrab = false));

  // THROW works like a second mini-joystick: drag to aim, let go to throw, let go on the button to cancel.
  const el = $('tThrow'), knob = el.querySelector('.aimKnob');
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('down', 'aiming');
    const r = el.getBoundingClientRect();
    touchAim = { id: e.pointerId, ox: r.left + r.width / 2, oy: r.top + r.height / 2, dx: 0, dy: 0 };
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== touchAim.id) return;
    touchAim.dx = e.clientX - touchAim.ox;
    touchAim.dy = e.clientY - touchAim.oy;
    const l = Math.hypot(touchAim.dx, touchAim.dy), k = l > 44 ? 44 / l : 1;
    knob.style.transform = `translate(${touchAim.dx * k}px, ${touchAim.dy * k}px)`;
    el.classList.toggle('cancel', l < AIM_DEADZONE);
  });
  const end = (e) => {
    if (e.pointerId !== touchAim.id) return;
    if (e.type === 'pointerup' && Math.hypot(touchAim.dx, touchAim.dy) >= AIM_DEADZONE) {
      fireAim = computeAim();
      fireQueued = !!fireAim;
    }
    touchAim = { id: null, dx: 0, dy: 0 };
    el.classList.remove('down', 'aiming', 'cancel');
    knob.style.transform = '';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

{
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
  // Nothing is sent while disconnected: socket.io would queue it and replay stale presses on reconnect.
  if (!myId || !socket.connected) { punchQueued = jumpQueued = kickQueued = fireQueued = false; return; }
  let x = 0, z = 0;
  if (joy.id !== null) { x = joy.x; z = joy.y; }
  const len = Math.hypot(x, z);
  if (len > 1) { x /= len; z /= len; }
  moveForward = -z;
  if (followActive()) {
    const cs = Math.cos(camYaw), sn = Math.sin(camYaw);
    [x, z] = [x * cs + z * sn, -x * sn + z * cs];
  }
  const grab = touchGrab;
  myAim = computeAim();
  myMove.x = x; myMove.z = z;
  const a = fireQueued ? fireAim : myAim;
  const key = `${x.toFixed(2)},${z.toFixed(2)},${grab},${a ? `${a.x.toFixed(2)},${a.z.toFixed(2)}` : ''}`;
  if (punchQueued || jumpQueued || kickQueued || fireQueued || (key !== lastSent && now - lastSendTime > 15) || now - lastSendTime > 150) {
    socket.emit('input', {
      x, z, grab, punch: punchQueued, jump: jumpQueued, kick: kickQueued,
      fire: fireQueued, aim: !!myAim, ax: a ? a.x : 0, az: a ? a.z : 0,
    });
    predictActions(punchQueued, jumpQueued, kickQueued);
    lastSent = key;
    lastSendTime = now;
    punchQueued = jumpQueued = kickQueued = fireQueued = false;
  }
}

// ---------- Aim preview: dotted arc (or line) to where the throw / shot will go ----------
const AIM_DOTS = 22;
const aimDots = new THREE.InstancedMesh(
  new THREE.SphereGeometry(0.1, 8, 6),
  new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false }),
  AIM_DOTS * 8,
);
aimDots.frustumCulled = false;
aimDots.renderOrder = 5;
aimDots.count = 0;
scene.add(aimDots);
const aimRings = [];
const aimRingGeo = new THREE.RingGeometry(0.55, 0.78, 32);
const MY_AIM = new THREE.Color('#fff3a0'), OTHER_AIM = new THREE.Color('#ffffff');

function aimProfile(s) {
  const arcs = room?.arcs;
  if (!arcs) return null;
  if (s.h) return arcs.player;
  const info = WEAPON_INFO[s.w];
  if (!info) return arcs.kick;
  return info.ranged ? arcs.blaster : arcs.weapon;
}

function updateAimPreview(R) {
  let n = 0, rings = 0;
  const players = snap && snap.phase === 'playing' ? snap.players : [];
  for (const s of players) {
    const c = critters.get(s.id);
    const mine = s.id === myId;
    if (!c || s.st !== 'alive' || s.fl || s.hb || s.hg || s.ko || !(mine ? myAim : s.am)) continue;
    const prof = aimProfile(s);
    if (!prof) continue;
    const dir = mine ? myAim : { x: Math.sin(c.face), z: Math.cos(c.face) };
    const y0 = island.position.y;
    const pts = [];
    let land = null;
    if (prof.line) {
      const dots = Math.min(AIM_DOTS, Math.ceil(prof.line / 0.45));
      for (let i = 1; i <= dots; i++) {
        const d = 1.1 + (prof.line - 1.1) * (i / dots);
        pts.push([c.x + dir.x * d, y0 + prof.y, c.z + dir.z * d]);
      }
    } else {
      const g = room.arcs.g;
      const sx = c.x + dir.x * prof.off, sz = c.z + dir.z * prof.off, sy = c.y + prof.y;
      const vx = dir.x * prof.s + c.dvx * prof.carry, vz = dir.z * prof.s + c.dvz * prof.carry;
      const T = (prof.vy + Math.sqrt(prof.vy * prof.vy + 2 * g * Math.max(0, sy))) / g;
      for (let i = 1; i <= AIM_DOTS; i++) {
        const t = (T * i) / AIM_DOTS;
        pts.push([sx + vx * t, y0 + sy + prof.vy * t - 0.5 * g * t * t, sz + vz * t]);
      }
      land = [sx + vx * T, sz + vz * T];
    }
    for (const [x, y, z] of pts) {
      if (n >= aimDots.instanceMatrix.count) break;
      decoDummy.position.set(x, y, z);
      decoDummy.rotation.set(0, 0, 0);
      decoDummy.scale.setScalar(mine ? 1 : 0.7);
      decoDummy.updateMatrix();
      aimDots.setMatrixAt(n, decoDummy.matrix);
      aimDots.setColorAt(n++, mine ? MY_AIM : OTHER_AIM);
    }
    if (land) {
      if (!aimRings[rings]) {
        const m = new THREE.Mesh(aimRingGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        scene.add(m);
        aimRings[rings] = m;
      }
      const ring = aimRings[rings++];
      // Red when it lands off the island.
      ring.material.color.set(Math.hypot(land[0], land[1]) > R ? '#ff6b81' : mine ? '#fff3a0' : '#ffffff');
      ring.position.set(land[0], y0 + 0.06, land[1]);
      ring.scale.setScalar((mine ? 1 : 0.7) * (1 + Math.sin(time * 8) * 0.08));
      ring.visible = true;
    }
  }
  aimDots.count = n;
  aimDots.instanceMatrix.needsUpdate = true;
  if (aimDots.instanceColor) aimDots.instanceColor.needsUpdate = true;
  for (let i = rings; i < aimRings.length; i++) aimRings[i].visible = false;
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
  } else if (slowMo > 0 && slowTarget) {
    // Final knock-off: swoop in on the falling player while the world runs in slow motion.
    look = new THREE.Vector3(slowTarget.x, Math.max(-5, slowTarget.root.position.y) + 0.8, slowTarget.z);
    tmpV.copy(camPos).sub(look);
    tmpV.y = 0;
    pos = tmpV.multiplyScalar(7.5 / (tmpV.length() || 1)).add(look);
    pos.y = look.y + 3.2;
    const k = 1 - Math.exp(-dt * 4);
    camPos.lerp(pos, k);
    camLook.lerp(look, k);
    camera.position.copy(camPos);
    applyShake(dt);
    return;
  } else if (followActive()) {
    const me = critters.get(myId);
    if (moveForward > 0.3 && camDrag.id === null) camYaw = angleLerp(camYaw, me.face + Math.PI, dt * 1.5 * moveForward);
    const dist = 7 * aspectBoost, height = 3.6 * aspectBoost;
    look = new THREE.Vector3(me.x - Math.sin(camYaw) * 2, me.y + 1.6, me.z - Math.cos(camYaw) * 2);
    pos = tmpV.set(me.x + Math.sin(camYaw) * dist, me.y + height, me.z + Math.cos(camYaw) * dist);
    const kf = 1 - Math.exp(-dt * 10);
    camPos.lerp(pos, kf);
    camLook.lerp(look, kf);
    camera.position.copy(camPos);
    applyShake(dt);
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
  applyShake(dt);
}

// Smooth shake (no per-frame jitter) with a little roll; big hits push it hardest.
let shakeT = 0;
function applyShake(dt) {
  shake *= Math.exp(-dt * 9);
  shakeT += dt;
  const s = shake;
  camera.position.x += (Math.sin(shakeT * 53) + Math.sin(shakeT * 31.7) * 0.6) * 0.34 * s;
  camera.position.y += (Math.sin(shakeT * 47.3) + Math.sin(shakeT * 23.1) * 0.6) * 0.34 * s;
  camera.lookAt(camLook);
  camera.rotateZ(Math.sin(shakeT * 37.9) * 0.03 * s);
}

// Shadows only cover the play area around the camera's focus, so they stay sharp.
const SHADOW_OFFSET = new THREE.Vector3().copy(SUN_DIR).multiplyScalar(40);
let shadowHalf = 0;
function updateShadowFrustum() {
  const sc = sun.shadow.camera;
  const half = Math.ceil(THREE.MathUtils.clamp(camPos.distanceTo(camLook) * 0.7, 12, 30) / 2) * 2;
  if (half !== shadowHalf) {
    shadowHalf = half;
    Object.assign(sc, { left: -half, right: half, top: half, bottom: -half });
    sc.updateProjectionMatrix();
  }
  // Snap the focus to whole shadow texels (in the light's own frame) so edges don't shimmer.
  const texel = (2 * half) / sun.shadow.mapSize.x;
  shadowFocus.set(camLook.x, 0, camLook.z).applyMatrix4(LIGHT_INV);
  shadowFocus.x = Math.round(shadowFocus.x / texel) * texel;
  shadowFocus.y = Math.round(shadowFocus.y / texel) * texel;
  shadowFocus.applyMatrix4(LIGHT_ROT);
  sun.target.position.copy(shadowFocus);
  sun.position.copy(shadowFocus).add(SHADOW_OFFSET);
}
const LIGHT_ROT = new THREE.Matrix4().lookAt(SUN_DIR, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
const LIGHT_INV = LIGHT_ROT.clone().transpose();
const shadowFocus = new THREE.Vector3();

// "Island shrinks in m:ss", turning urgent shortly before the edge starts crumbling.
let timerText = '';
function updateShrinkTimer(playing, shrinking) {
  const el = $('shrinkTimer');
  const left = playing && snap.phase !== 'roundover' ? snap.shrinkIn : null;
  let text = '';
  if (left != null && left > 0) {
    const sec = Math.ceil(left);
    text = `🏝️ Island shrinks in ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  } else if (shrinking) text = '🌊 Island shrinking!';
  el.classList.toggle('hidden', !text);
  el.classList.toggle('warn', !!text && (left == null || left <= 15));
  if (text !== timerText) { timerText = text; el.textContent = text; }
}

// Context-sensitive prompts: what each button will do right now.
let hintState = '';
const koLeftText = (n) => `${n} knockout${n === 1 ? '' : 's'} left`;
function updateActionHints(me) {
  let grab = 'GRAB', punch = 'PUNCH', toss = 'AIM', kick = 'KICK', hint = '';
  if (me) {
    const near = (snap.items || []).find((it) => it.y < 0.5 && Math.hypot(it.x - me.x, it.z - me.z) < 1.9);
    const info = WEAPON_INFO[me.w];
    if (me.hg) {
      hint = 'Hanging on! Mash <b>JUMP</b> to climb back in';
    } else if (me.h) {
      punch = 'THROW';
      toss = 'THROW';
      hint = 'Drag <b>THROW</b> to aim, let go to throw them';
    } else if (info) {
      punch = me.w === 'blaster' ? 'SHOOT' : info.gloves ? `PUNCH 🥊${me.wu}` : 'SWING';
      toss = me.w === 'blaster' ? 'FIRE' : 'AIM';
      grab = 'TOSS';
      const label = info.gloves ? `${info.label} (${koLeftText(me.wu)})` : info.label;
      if (info.spin) hint = '<b>SWING</b> to spin and bonk everyone around you';
      else if (info.gloves) hint = `${label}: every <b>PUNCH</b> that lands is a knockout`;
    } else if (near) {
      grab = 'PICK UP';
      const info = WEAPON_INFO[near.t];
      const label = info.gloves && near.u ? `${info.label} (${koLeftText(near.u)})` : info.label;
      hint = `Tap <b>PICK UP</b> for the ${label}`;
    }
  }
  const key = [grab, punch, toss, kick, hint].join('|');
  if (key === hintState) return;
  hintState = key;
  $('tGrab').textContent = grab;
  $('tPunch').textContent = punch;
  $('tKick').textContent = kick;
  $('tThrow').querySelector('.tlabel').textContent = toss;
  $('tGrab').classList.toggle('glow', grab === 'PICK UP');
  $('tPunch').classList.toggle('armed', !!me?.w && !me.h);
  $('tThrow').classList.toggle('armed', toss !== 'AIM');
  $('actionHint').innerHTML = hint;
  $('actionHint').classList.toggle('hidden', !hint);
}

// ---------- Quality tier, mood and per-critter world effects ----------
let appliedTier = null;
function applyTier(t) {
  appliedTier = t;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, t === 'high' ? 2 : t === 'medium' ? 1.5 : 1));
  post.setTier(t);
  resize();
  blades.setCount(GRASS_BLADES[t]);
  const sm = t === 'high' ? 2048 : t === 'medium' ? 1536 : 1024;
  if (sun.shadow.mapSize.x !== sm) {
    sun.shadow.mapSize.setScalar(sm);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  particles.setBudget(t === 'high' ? 1 : t === 'medium' ? 0.7 : 0.4);
  setPlushQuality(t === 'high');
  setGlassQuality(t === 'high');
  skyDome.setOctaves(t === 'low' ? 2 : 4);
}

// Sunny day, drifting to sunset once the island starts to shrink.
function updateMood(dt, playing) {
  const target = playing && snap.shrinkIn <= 0 ? 1 : 0;
  if (moodK === target) return;
  moodK += (target - moodK) * Math.min(1, dt * 0.35);
  if (Math.abs(target - moodK) < 0.003) moodK = target;
  const m = mixMood(moodK, moodNow), u = skyDome.uniforms;
  for (const k of ['top', 'mid', 'bottom', 'cloud', 'cloudShade']) u[k].value.copy(m[k]);
  u.sunCol.value.copy(m.sun);
  sun.color.copy(m.sun);
  sun.intensity = m.sunI;
  hemi.color.copy(m.hemiSky);
  hemi.groundColor.copy(m.hemiGround);
  hemi.intensity = m.hemiI;
  scene.fog.color.copy(m.fog);
  cloudMat.emissive.copy(m.cloudGlow);
  scene.environmentIntensity = m.env;
  if (Math.abs(moodK - envMood) > 0.3 || (moodK === target && envMood !== target)) {
    envRT.dispose();
    envRT = makeEnvironment(renderer, m, SUN_DIR);
    scene.environment = envRT.texture;
    envMood = moodK;
  }
}

const contact = makeContactShadows(20);
scene.add(contact.mesh);
function critterFx(dt, R, playing) {
  contact.begin();
  const push = blades.uniforms.uPush.value;
  let np = 0;
  const iy = island.position.y;
  for (const c of room ? critters.values() : preview ? [preview] : []) {
    if (!c.root.visible) continue;
    const s = c.s;
    const gy = s && s.g ? c.y : c.groundY ?? 0;
    const h = Math.max(0, c.root.position.y - iy - gy);
    if (Math.hypot(c.x, c.z) < R + 0.2 && !(s && s.fl)) {
      contact.add(c.x, iy + gy + 0.03, c.z, 1.9 * (1 + h * 0.12), 0.6 * Math.max(0, 1 - h / 5));
      if (np < PUSH_SLOTS) push[np++].set(c.x, c.z, Math.max(0, 1 - h / 1.2), 0);
    }
    if (!playing || !s || s.st !== 'alive') continue;
    const speed = Math.hypot(s.vx || 0, s.vz || 0);
    if (s.g && speed > 2.5) {
      c.dustT = (c.dustT ?? 0) - dt;
      if (c.dustT <= 0) {
        c.dustT = Math.max(0.12, 0.26 - speed * 0.012);
        const bx = c.x - (s.vx / speed) * 0.25, bz = c.z - (s.vz / speed) * 0.25;
        if (!s.rv) dust(bx, bz, 2);
        else {
          for (let i = 0; i < 4; i++) {
            particles.spawn({
              x: bx, y: iy + 0.05, z: bz, vx: (Math.random() - 0.5) * 2, vy: 1.5 + Math.random() * 1.5, vz: (Math.random() - 0.5) * 2,
              gravity: 14, life: 0.45, size: 0.11, color: '#d8f1ff', shape: SHAPE.drop, decor: true,
            });
          }
        }
      }
    }
    if (s.rv && !c.wasRv) splash(c.x, c.z, THREE.MathUtils.clamp(0.25 + speed * 0.06 + Math.max(0, -(c.airVy || 0)) * 0.08, 0.25, 1.5));
    c.wasRv = !!s.rv;
    c.airVy = s.g ? 0 : Math.min(c.airVy || 0, s.vy || 0);
    if ((s.ko || (s.dz || 0) > 55) && Math.random() < dt * 4) {
      const a = Math.random() * Math.PI * 2, hh = c.height || 2.3;
      particles.spawn({
        x: c.x + Math.cos(a) * 0.45, y: c.root.position.y + hh * (c.rag ? 0.35 : 1) + 0.1, z: c.z + Math.sin(a) * 0.45, vy: 0.5,
        life: 0.7, size: 0.24, color: '#ffe066', intensity: 2, shape: SHAPE.star, add: true, spin: 3, fade: 0.5, decor: true,
      });
    }
    if (appliedTier === 'high' && c.thrownVis && !s.g) {
      particles.spawn({ x: c.x, y: c.root.position.y + 0.9, z: c.z, life: 0.28, size: 1.3, grow: -0.7, alpha: 0.28, color: '#ffffff', fade: 1 });
    }
  }
  for (let i = np; i < PUSH_SLOTS; i++) push[i].set(0, 0, 0, 0);
  contact.end();
}

// ---------- Loading screen (everyone; a few get the video instead) ----------
// LOAD_TIME must match LOADING_TIME in server.js.
const LOAD_FADE = 250, LOAD_TIME = 1000;
let videoLoad = false, videoBroken = false, loadFadeT = 0, volAnim = 0;
const loadVideo = $('loadVideo');
loadVideo.muted = loadVideo.defaultMuted = true;
loadVideo.addEventListener('error', () => { videoBroken = true; loadVideo.classList.remove('show'); });

// Phones only allow sound on a video that was started from a tap, so the Play tap starts it silently once.
function unlockVideoSound() {
  if (videoBroken) return;
  loadVideo.muted = false;
  loadVideo.volume = 0;
  loadVideo.play().then(() => {
    loadVideo.pause();
    try { loadVideo.currentTime = 0; } catch {}
  }).catch(() => {});
}
function fadeVolume(to, ms) {
  clearInterval(volAnim);
  const from = loadVideo.volume, t0 = performance.now();
  volAnim = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    loadVideo.volume = from + (to - from) * k;
    if (k >= 1) clearInterval(volAnim);
  }, 30);
}
function showLoading() {
  clearTimeout(loadFadeT);
  $('loadingScreen').classList.add('show');
  // Fade out in time to be gone exactly when the countdown starts.
  loadFadeT = setTimeout(fadeOutLoading, LOAD_TIME - LOAD_FADE);
  if (!videoLoad || videoBroken) return;
  try { loadVideo.currentTime = 0; } catch {}
  loadVideo.volume = 0;
  const reveal = () => {
    if (lastPhase !== 'loading') return loadVideo.pause();
    loadVideo.classList.add('show');
    fadeVolume(1, LOAD_FADE);
  };
  // Revealed only once it actually plays, so a failure leaves the normal screen up.
  // With sound if the browser allows it, otherwise muted.
  loadVideo.muted = false;
  loadVideo.play().then(reveal).catch(() => {
    loadVideo.muted = true;
    loadVideo.play().then(reveal).catch(() => loadVideo.classList.remove('show'));
  });
}
function fadeOutLoading() {
  clearTimeout(loadFadeT);
  $('loadingScreen').classList.remove('show');
  if (!loadVideo.classList.contains('show')) return;
  loadVideo.classList.remove('show');
  fadeVolume(0, LOAD_FADE);
  loadFadeT = setTimeout(() => loadVideo.pause(), LOAD_FADE + 50);
}
function hideLoading() {
  if ($('loadingScreen').classList.contains('show') || loadVideo.classList.contains('show')) fadeOutLoading();
}
socket.on('pvLoad', () => {
  videoLoad = true;
  if (lastPhase === 'loading') showLoading();
});

// ---------- Admin panel: only offered to "ghouse"; the server re-checks every request ----------
const ADMIN_NAME = 'ghouse';
const PIN_KEY = 'bb-gpin';
const INV_TIME = 10;
const adm = { open: false, ok: false, s: null, pin: false, bad: false, locked: false, openedAt: 0, tried: '' };
const isAdminName = () => myName.trim().toLowerCase() === ADMIN_NAME;
const ADM_LIMITS = { blessed: [0, () => room?.players.length || 0], invCd: [0, () => 120], invUses: [1, () => 10] };
let secretEl = null;

socket.on('adm', (d) => {
  if (!d || !isAdminName()) return;
  if (d.ok) {
    Object.assign(adm, { ok: true, pin: false, bad: false, locked: false, s: d.s });
    if (adm.tried) localStorage.setItem(PIN_KEY, adm.tried);
    adm.tried = '';
    syncShield();
  } else if (d.pin) {
    Object.assign(adm, { pin: true, bad: !!d.bad, locked: !!d.locked });
    if (d.bad) localStorage.removeItem(PIN_KEY);
    adm.tried = '';
  }
  if (adm.open) renderSecret();
});

function openSecret() {
  if (!isAdminName() || !myId) return;
  if (!secretEl) buildSecret();
  adm.open = true;
  adm.openedAt = performance.now();
  secretEl.classList.remove('hidden');
  if (!adm.ok && !adm.pin) socket.emit('adm', { op: 'auth', pin: localStorage.getItem(PIN_KEY) || '' });
  renderSecret();
}
function closeSecret() {
  if (!adm.open) return;
  adm.open = false;
  secretEl.classList.add('hidden');
  if (document.activeElement?.tagName === 'INPUT') document.activeElement.blur();
}
function buildSecret() {
  secretEl = document.createElement('div');
  secretEl.className = 'secret-backdrop hidden';
  secretEl.innerHTML = '<div class="secret-card"><button class="secret-close" aria-label="Close">✕</button><h2>Secret settings</h2><div class="secret-body"></div></div>';
  document.body.append(secretEl);
  secretEl.addEventListener('click', (e) => {
    // The hold that opened the panel can end over the backdrop; don't let it close it again.
    if (e.target === secretEl) { if (performance.now() - adm.openedAt > 400) closeSecret(); return; }
    if (e.target.closest('.secret-close')) return closeSecret();
    if (e.target.closest('[data-unlock]')) return submitPin();
    const b = e.target.closest('[data-k]');
    if (!b || !adm.s) return;
    const k = b.dataset.k, s = adm.s;
    let v;
    if (b.dataset.t != null) v = !s[k];
    else {
      const [lo, hi] = ADM_LIMITS[k], d = Number(b.dataset.d);
      v = s[k] + d;
      if ((d > 0 && v > hi()) || (d < 0 && v < lo)) return;
    }
    s[k] = v;
    socket.emit('adm', { op: 'set', s: { [k]: v } });
    renderSecret();
  });
}
function submitPin() {
  const inp = secretEl?.querySelector('input');
  const pin = inp?.value.trim();
  if (!pin) return;
  adm.tried = pin;
  inp.value = '';
  socket.emit('adm', { op: 'auth', pin });
}
function renderSecret() {
  if (!secretEl) return;
  const body = secretEl.querySelector('.secret-body');
  if (!adm.ok) {
    if (!adm.pin) { body.innerHTML = '<p class="hint">…</p>'; return; }
    if (!body.querySelector('input')) {
      body.innerHTML = '<input type="password" inputmode="numeric" autocomplete="off" maxlength="64" placeholder="PIN" />'
        + '<button class="btn small" data-unlock>Unlock</button><p class="error"></p>';
      const inp = body.querySelector('input');
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });
      setTimeout(() => inp.focus(), 50);
    }
    body.querySelector('.error').textContent = adm.locked ? 'Too many tries, wait a minute' : adm.bad ? 'Wrong PIN' : '';
    return;
  }
  const s = adm.s, n = room?.players.length || 0;
  const stepper = (k, val, d) => `<div class="stepper"><button data-k="${k}" data-d="${-d}">−</button><b>${val}</b><button data-k="${k}" data-d="${d}">+</button></div>`;
  const toggle = (k) => `<button class="secret-toggle${s[k] ? ' on' : ''}" data-k="${k}" data-t>${s[k] ? 'ON' : 'OFF'}</button>`;
  const row = (label, ctl, on = true) => `<div class="secret-row${on ? '' : ' off'}"><span>${label}</span>${ctl}</div>`;
  body.innerHTML =
    row(`Blessed players<small>${s.blessed ? `${Math.min(s.blessed, n)} of ${n} picked at the start` : 'Off'}</small>`, stepper('blessed', s.blessed, 1))
    + row('Include me in the draw', toggle('includeMe'), s.blessed > 0)
    + row('Invincibility button<small>🛡️ during play</small>', toggle('invBtn'))
    + row('Cooldown', stepper('invCd', `${s.invCd} s`, 5), s.invBtn)
    + row('Uses per round', stepper('invUses', s.invUses, 1), s.invBtn);
}

// ---------- Private invincibility state (sent only to this player) ----------
let pv = { inv: 0, at: 0, ib: null };
let shieldEl = null, invRingEl = null, invGlow = null;
socket.on('pv', (d) => {
  pv = { inv: d?.inv || 0, at: performance.now(), ib: d?.ib || null };
  syncShield();
});
const invLeft = () => Math.max(0, pv.inv - (performance.now() - pv.at) / 1000);

function syncShield() {
  const ib = pv.ib;
  if (!ib || !adm.ok) { shieldEl?.remove(); shieldEl = null; return; }
  if (!shieldEl) {
    shieldEl = document.createElement('div');
    shieldEl.className = 'tbtn';
    shieldEl.id = 'tShield';
    shieldEl.textContent = '🛡️';
    shieldEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      shieldEl.classList.add('down');
      useShield();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) shieldEl.addEventListener(ev, () => shieldEl?.classList.remove('down'));
    shieldEl.addEventListener('contextmenu', (e) => e.preventDefault());
    $('touchButtons').append(shieldEl);
  }
  shieldEl.classList.toggle('cool', ib.cd > 0 || ib.left <= 0);
}
function useShield() {
  const ib = pv.ib;
  if (!ib || ib.cd > 0 || ib.left <= 0) return;
  socket.emit('adm', { op: 'inv' });
}

// Golden shimmer and a countdown ring, drawn only on my own screen.
const INV_RING_C = 2 * Math.PI * 16;
function updateInvFx(dt) {
  const left = room && room.phase !== 'lobby' ? invLeft() : 0;
  if (left > 0 && !invRingEl) {
    invRingEl = document.createElement('div');
    invRingEl.id = 'invRing';
    invRingEl.innerHTML = `<svg viewBox="0 0 40 40"><circle class="track" cx="20" cy="20" r="16"/><circle class="arc" cx="20" cy="20" r="16" stroke-dasharray="${INV_RING_C}"/></svg><span></span>`;
    $('hud').append(invRingEl);
  }
  if (invRingEl) {
    invRingEl.classList.toggle('hidden', !left);
    if (left) {
      invRingEl.querySelector('.arc').style.strokeDashoffset = `${INV_RING_C * (1 - Math.min(1, left / INV_TIME))}`;
      invRingEl.querySelector('span').textContent = String(Math.ceil(left));
    }
  }
  const me = critters.get(myId);
  const show = left > 0 && me && me.root.visible && me.s?.st === 'alive';
  if (!invGlow) {
    invGlow = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.2, 40),
      new THREE.MeshBasicMaterial({ color: '#ffd15a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    invGlow.rotation.x = -Math.PI / 2;
    scene.add(invGlow);
  }
  invGlow.visible = !!show;
  if (!show) return;
  // Flickers faster in the last two seconds as a heads-up that it's running out.
  const pulse = 0.5 + 0.5 * Math.sin(time * (left < 2 ? 16 : 5));
  invGlow.position.set(me.x, me.root.position.y + 0.07, me.z);
  invGlow.material.opacity = 0.25 + pulse * 0.25;
  invGlow.scale.setScalar(1 + pulse * 0.08);
  const h = me.height || 2.3;
  me.invFxT = (me.invFxT || 0) - dt;
  while (me.invFxT <= 0) {
    me.invFxT += 0.06;
    const a = Math.random() * Math.PI * 2, r = 0.5 + Math.random() * 0.35;
    particles.spawn({
      x: me.x + Math.cos(a) * r, y: me.root.position.y + Math.random() * h, z: me.z + Math.sin(a) * r, vy: 0.5 + Math.random() * 0.6,
      life: 0.5 + Math.random() * 0.3, size: 0.12 + Math.random() * 0.06, color: Math.random() < 0.6 ? '#ffd15a' : '#fff3a0',
      intensity: 2.5, shape: SHAPE.glow, add: true, fade: 0.5,
    });
  }
}

// ---------- Main loop ----------
const projV = new THREE.Vector3();
let lastFrame = performance.now();
// Touch devices are capped at 60 fps (high-refresh phones would otherwise run at 90-120 and heat up).
const FRAME_MS = lowPower ? 1000 / 60 : 0;
let nextFrameAt = 0, looping = true;
function frame(now) {
  if (document.hidden) { looping = false; return; }
  if (now < nextFrameAt - 1) { requestAnimationFrame(frame); return; }
  nextFrameAt = Math.max(nextFrameAt + FRAME_MS, now);
  const rawDt = (now - lastFrame) / 1000;
  const realDt = Math.min(0.05, rawDt);
  lastFrame = now;

  sendInput(now);
  if (tier() !== appliedTier) applyTier(tier());
  // Hit-stop: hold the picture for a beat (input and snapshots keep flowing underneath).
  if (hitStop > 0) {
    hitStop -= rawDt;
    post.render(realDt);
    requestAnimationFrame(frame);
    return;
  }
  let pace = 1;
  if (slowMo > 0) {
    slowMo -= realDt;
    pace = SLOW_RATE;
    slowLag = Math.min(1.2, slowLag + realDt * (1 - SLOW_RATE));
    if (slowMo <= 0) slowTarget = null;
  } else if (slowLag > 0) slowLag = Math.max(0, slowLag - realDt * 0.6);
  const dt = realDt * pace;
  time += dt;

  const playing = room && room.phase !== 'lobby' && snap && snap.phase !== 'lobby';
  updateNetWarn(now, playing);
  watchFrameRate(rawDt, playing);
  assignDetail(dt);
  const R = playing ? snap.islandR : ISLAND_MAX;
  islandScaled.scale.set(R, 1, R);
  rock.scale.y = 3 + 4 * (R / ISLAND_MAX);
  island.position.y = Math.sin(time * 0.7) * 0.12;
  updateDeco(R);
  updateObstacles(dt, R, !!playing);
  updateRiver(dt, R);
  syncItems(playing ? snap : null, dt);
  updateGuards(R, !!playing);
  const shrinking = playing && snap.phase === 'playing' && snap.shrinkIn <= 0 && R > ISLAND_MIN + 0.05;
  edgeRing.material.color.set(shrinking ? (Math.sin(time * 8) > 0 ? '#ff8fa3' : '#ffffff') : '#ffffff');
  updateShrinkTimer(playing, shrinking);
  updateAimPreview(R);

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
        // I'm drawn interpolated too while someone carries me, so I stay in their hands.
        animateCritter(c, dt, c.s, { hop, me: p.id === myId, interp: p.id !== myId || !!c.s?.hb });
      }
      updateTeamMarker(c, p);
      const show = c.root.visible && !(c.s && c.s.fl);
      c.label.style.display = show ? '' : 'none';
      const hang = show && snap?.phase !== 'lobby' ? c.s?.hg || 0 : 0;
      if (!c.bar) {
        c.bar = document.createElement('div');
        c.bar.className = 'climb-bar';
        c.bar.innerHTML = '<i></i>';
        labelsEl.append(c.bar);
      }
      c.bar.style.display = hang ? '' : 'none';
      if (show) {
        projV.set(c.x, c.y + (c.height || 2.3) + 0.6 + (c.ko > 0.5 ? -1.2 : 0), c.z).project(camera);
        const sx = (projV.x * 0.5 + 0.5) * window.innerWidth, sy = (-projV.y * 0.5 + 0.5) * window.innerHeight;
        c.label.style.left = `${sx}px`;
        c.label.style.top = `${sy}px`;
        if (hang) {
          // Climb progress under the name while hanging on the fence.
          c.bar.style.left = `${sx}px`;
          c.bar.style.top = `${sy + 6}px`;
          c.bar.firstChild.style.width = `${Math.round(hang * 100)}%`;
        }
      }
    });
  }

  const me = snap?.players.find((p) => p.id === myId);
  const showDizzy = room && room.phase === 'playing' && me && me.st === 'alive' && !me.fl;
  $('dizzyMeter').classList.toggle('hidden', !showDizzy);
  if (showDizzy) $('dizzyFill').style.width = `${me.ko ? 100 : me.dz}%`;
  updateActionHints(showDizzy ? me : null);
  updateInvFx(dt);

  blades.uniforms.uTime.value = time;
  blades.uniforms.uR.value = R;
  skyDome.uniforms.uTime.value = time;
  updateMood(realDt, !!playing);
  critterFx(dt, R, !!playing);
  updateEffects(dt);
  particles.update(dt);
  updateCamera(realDt, R);
  if (window.__cam) { const o = window.__cam(); camera.position.set(o.x, o.y, o.z); camera.lookAt(o.tx, o.ty, o.tz); }
  updateShadowFrustum();
  post.render(realDt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Nothing is drawn while the page is hidden; the loop picks up again when it comes back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || looping) return;
  looping = true;
  lastFrame = nextFrameAt = performance.now();
  requestAnimationFrame(frame);
});
window.__dbg = { crit: () => critters, me: () => myId, tier, applyTier, camera, renderer, scene, post, particles, blades, handleEvent, splash, snap: () => snap, setMood: (k) => { moodK = k - 0.01; } };
