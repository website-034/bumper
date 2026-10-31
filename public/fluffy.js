import * as THREE from 'three';
import { makeStars } from './characters.js';
import { makeFloppy } from './floppy.js';
import { mergeRigidParts } from './merge.js';

// Cowboy Corgi plus the plush toolkit the rest of the crew (crew.js) is built from.

// ---------- Plush ----------
// Each furry part is a single smooth mesh in a soft velvet material: matte, a felt-like micro
// normal map, and a brightening rim at glancing angles so it still reads as fluffy.

// One small tiling felt normal map, shared by every critter.
let feltTex = null;
function feltNormalMap() {
  if (feltTex) return feltTex;
  const N = 64;
  const h = new Float32Array(N * N).map(() => Math.random());
  const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  // Soften the noise a little so it reads as fibres, not grit.
  const s = h.map((_, i) => {
    const x = i % N, y = (i / N) | 0;
    return (at(x, y) * 4 + at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1)) / 8;
  });
  const sAt = (x, y) => s[((y + N) % N) * N + ((x + N) % N)];
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (sAt(x + 1, y) - sAt(x - 1, y)) * 2, dy = (sAt(x, y + 1) - sAt(x, y - 1)) * 2;
      const l = Math.hypot(dx, dy, 1), i = (y * N + x) * 4;
      data[i] = (-dx / l * 0.5 + 0.5) * 255;
      data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  feltTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  feltTex.wrapS = feltTex.wrapT = THREE.RepeatWrapping;
  feltTex.repeat.set(6, 3);
  feltTex.magFilter = THREE.LinearFilter;
  feltTex.minFilter = THREE.LinearMipmapLinearFilter;
  feltTex.generateMipmaps = true;
  feltTex.needsUpdate = true;
  return feltTex;
}

// Colours come from the vertex colours paint() bakes in, so every coat pattern is kept.
// The high tier adds a physical sheen; every other tier stays on the cheaper standard material.
const plushMats = {};
function plushMaterial(high) {
  const key = high ? 'high' : 'std';
  if (plushMats[key]) return plushMats[key];
  const opts = { vertexColors: true, roughness: 0.9, normalMap: feltNormalMap(), normalScale: new THREE.Vector2(0.35, 0.35) };
  const m = high
    ? new THREE.MeshPhysicalMaterial({ ...opts, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.45, 0.45, 0.45) })
    : new THREE.MeshStandardMaterial(opts);
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `outgoingLight += diffuseColor.rgb * 0.45 * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.5);
       #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => `plush-${key}`;
  plushMats[key] = m;
  return m;
}

let plushHigh = false;
const plushMeshes = new Set();
export function setPlushQuality(high) {
  if (high === plushHigh) return;
  plushHigh = high;
  const m = plushMaterial(high);
  for (const mesh of plushMeshes) {
    let top = mesh;
    while (top.parent) top = top.parent;
    if (top.isScene) mesh.material = m;
    else plushMeshes.delete(mesh); // its critter is gone
  }
}

// Push every vertex out along its normal by d. Normals are averaged over vertices that share a
// position, so UV seams and cone tips stay closed.
function inflate(geometry, d) {
  if (!d || geometry.userData.inflated) return;
  geometry.userData.inflated = true;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const p = geometry.attributes.position, n = geometry.attributes.normal;
  const key = (i) => `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
  const sums = new Map();
  const keys = [];
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    keys.push(k);
    const s = sums.get(k) || [0, 0, 0];
    s[0] += n.getX(i); s[1] += n.getY(i); s[2] += n.getZ(i);
    sums.set(k, s);
  }
  for (let i = 0; i < p.count; i++) {
    const s = sums.get(keys[i]);
    const l = Math.hypot(s[0], s[1], s[2]) || 1;
    p.setXYZ(i, p.getX(i) + (s[0] / l) * d, p.getY(i) + (s[1] / l) * d, p.getZ(i) + (s[2] / l) * d);
  }
  p.needsUpdate = true;
  geometry.computeBoundingSphere();
  geometry.boundingBox = null;
}

// len is the coat length: the part is puffed out by half of it so silhouettes stay chunky.
export function furry(geometry, { len = 0.07 } = {}) {
  inflate(geometry, len * 0.5);
  const group = new THREE.Group();
  const plush = new THREE.Mesh(geometry, plushMaterial(plushHigh));
  plush.castShadow = true;
  plush.receiveShadow = true;
  plushMeshes.add(plush);
  group.add(plush);
  group.userData.fur = len;
  return group;
}

// Per-vertex colouring so one furry mesh can carry a coat pattern.
export function paint(geometry, fn) {
  const p = geometry.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v, c);
    c.toArray(cols, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geometry;
}

export function deform(geometry, fn) {
  const p = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- Shared bits ----------
const glossyCache = new Map();
export function glossy(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!glossyCache.has(key)) glossyCache.set(key, new THREE.MeshPhysicalMaterial({ color, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, ...opts }));
  return glossyCache.get(key);
}
export function std(color, opts = {}) {
  const key = 's' + color + JSON.stringify(opts);
  if (!glossyCache.has(key)) glossyCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts }));
  return glossyCache.get(key);
}
export function mesh(geometry, material, pos = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0]) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(...pos);
  m.scale.set(...scale);
  m.rotation.set(...rot);
  m.castShadow = true;
  return m;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
export function stretchLimb(limb, from, to, radius) {
  tmpDir.subVectors(to, from);
  const len = Math.max(0.001, tmpDir.length());
  limb.position.copy(from);
  limb.quaternion.setFromUnitVectors(UP, tmpDir.divideScalar(len));
  limb.scale.set(radius, len, radius);
}
export const limbGeo = (() => {
  const g = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  g.translate(0, 0.5, 0);
  return g;
})();

let dotTex = null;
function polkaDots() {
  if (dotTex) return dotTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#2fa7a0';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#fff4ea';
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      g.beginPath();
      g.arc(x * 32 + (y % 2) * 16 + 8, y * 32 + 16, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  }
  dotTex = new THREE.CanvasTexture(cv);
  dotTex.colorSpace = THREE.SRGBColorSpace;
  dotTex.wrapS = dotTex.wrapT = THREE.RepeatWrapping;
  dotTex.repeat.set(3, 3);
  return dotTex;
}

// ---------- Cowboy Corgi ----------
const ORANGE = new THREE.Color('#e48a3e');
const CREAM = new THREE.Color('#fff3e2');
const PINK = new THREE.Color('#f4aaa8');

// Shared by every eye of every critter; detail sized to how small they are on screen.
const EYE_GEO = [
  new THREE.SphereGeometry(0.118, 18, 14),
  new THREE.SphereGeometry(0.075, 16, 12),
  new THREE.SphereGeometry(0.045, 12, 8),
  new THREE.SphereGeometry(0.032, 8, 6),
  new THREE.SphereGeometry(0.015, 6, 4),
];
export function makeEye(side, iris = '#6d3a1c', [x, y, z] = [0.26, 0.05, 0.62]) {
  const eye = new THREE.Group();
  eye.position.set(side * x, y, z);
  eye.rotation.y = side * 0.32;
  eye.add(mesh(EYE_GEO[0], glossy('#2a1710'), [0, 0, 0], [1, 1.12, 0.7]));
  eye.add(mesh(EYE_GEO[1], glossy(iris), [0, -0.02, 0.06], [1, 1.1, 0.45]));
  eye.add(mesh(EYE_GEO[2], glossy('#0d0806'), [0, -0.02, 0.085], [1, 1.1, 0.45]));
  eye.add(mesh(EYE_GEO[3], glossy('#ffffff'), [0.04, 0.05, 0.08]));
  eye.add(mesh(EYE_GEO[4], glossy('#ffffff'), [-0.035, -0.045, 0.085]));
  // Knocked-out swirl, drawn over the eye.
  const swirl = new THREE.Mesh(new THREE.CircleGeometry(0.125, 28), new THREE.MeshBasicMaterial({ map: swirlTexture(), transparent: true }));
  swirl.position.z = 0.092;
  swirl.scale.set(1, 1.12, 1);
  swirl.visible = false;
  eye.add(swirl);
  eye.userData.swirl = swirl;
  return eye;
}

let swirlTex = null;
function swirlTexture() {
  if (swirlTex) return swirlTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#fffaf2';
  g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#2a1710';
  g.lineWidth = 9;
  g.lineCap = 'round';
  g.beginPath();
  for (let a = 0; a < Math.PI * 6; a += 0.1) {
    const r = 4 + a * 2.9;
    g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.stroke();
  swirlTex = new THREE.CanvasTexture(cv);
  swirlTex.colorSpace = THREE.SRGBColorSpace;
  return swirlTex;
}

// ---------- Shared rig ----------
// Every critter (corgi and the crew) ends up with this exact rig, so they all animate and
// flop identically. flops: parts that become spring chains ({ obj, dir, len, kind, at }).
export function rigFrom({ root, pivot, head, body, headFur, eyes, brows, smile, openMouth, arms, armLimbs, feet, legLimbs, stars, height, ears = [], flops = [], updates = [] }) {
  const shoulders = [new THREE.Vector3(-0.44, 1.05, 0.05), new THREE.Vector3(0.44, 1.05, 0.05)];
  const hips = [new THREE.Vector3(-0.22, 0.5, 0.02), new THREE.Vector3(0.22, 0.5, 0.02)];
  const tmpHip = new THREE.Vector3();
  // Ears point along their own up axis; their length comes from their size.
  const box = new THREE.Box3(), size = new THREE.Vector3();
  root.updateMatrixWorld(true);
  const earFlops = ears.map((e) => {
    box.setFromObject(e).getSize(size);
    return { obj: e, dir: new THREE.Vector3(0, 1, 0).applyQuaternion(e.quaternion), len: Math.max(0.15, Math.min(1.1, Math.max(size.x, size.y, size.z) * 0.8)), kind: 'ear' };
  });
  const rig = {
    root,
    pivot,
    head,
    face: head,
    eyes,
    brows,
    smile,
    smileDefault: true,
    openMouth,
    armL: arms[0],
    armR: arms[1],
    footL: feet[0],
    footR: feet[1],
    stars,
    height,
    shoulders,
    restArm: [new THREE.Vector3(-0.72, 0.72, 0.15), new THREE.Vector3(0.72, 0.72, 0.15)],
    footRest: [new THREE.Vector3(-0.25, 0.1, 0.08), new THREE.Vector3(0.25, 0.1, 0.08)],

    // Legs hang off the hips wherever the body is (leaning, tipped over or ragdolled).
    updateLimbs() {
      pivot.updateMatrix();
      for (let i = 0; i < 2; i++) {
        stretchLimb(armLimbs[i], shoulders[i], arms[i].position, 0.085);
        tmpHip.copy(hips[i]).applyMatrix4(pivot.matrix);
        stretchLimb(legLimbs[i], tmpHip, feet[i].position, 0.095);
      }
    },

    // Big head bobbles with the body's momentum (a beat late); ears flop on impacts.
    updateJelly(ox, oz, ripple, t) {
      rig.floppy.setJelly(ox, oz);
      ears.forEach((e, i) => { e.rotation.z = e.userData.rz + Math.sin(t * 24 + i) * ripple * 0.35; });
      for (const u of updates) u(ox, oz, ripple, t);
    },
  };
  rig.floppy = makeFloppy(rig, { body, headFur, flops: [...earFlops, ...flops] });
  mergeRigidParts(root, new Set([...armLimbs, ...legLimbs, ...brows, ...flops.map((f) => f.obj)]));
  return rig;
}

function makeHat() {
  const hat = new THREE.Group();
  const felt = std('#c99a62', { roughness: 0.95 });
  const band = std('#4a2a1a', { roughness: 0.7 });

  const brimGeo = new THREE.LatheGeometry(
    [new THREE.Vector2(0.24, 0.0), new THREE.Vector2(0.6, 0.0), new THREE.Vector2(0.625, 0.022), new THREE.Vector2(0.6, 0.042), new THREE.Vector2(0.24, 0.042)],
    64,
  );
  deform(brimGeo, (v) => {
    const sideCurl = Math.max(0, Math.abs(v.x) - 0.28);
    v.y += sideCurl * sideCurl * 1.6 - v.z * v.z * 0.12;
  });
  hat.add(mesh(brimGeo, felt));

  const crownGeo = new THREE.LatheGeometry(
    [new THREE.Vector2(0.001, 0.4), new THREE.Vector2(0.16, 0.42), new THREE.Vector2(0.27, 0.39), new THREE.Vector2(0.32, 0.27), new THREE.Vector2(0.34, 0.12), new THREE.Vector2(0.345, 0.02)],
    48,
  );
  deform(crownGeo, (v) => {
    if (v.y > 0.25) v.y -= 0.09 * (1 - Math.min(1, Math.abs(v.x) / 0.22)) * smooth(0.25, 0.4, v.y);
  });
  hat.add(mesh(crownGeo, felt));
  hat.add(mesh(new THREE.CylinderGeometry(0.348, 0.35, 0.075, 48, 1, true), band, [0, 0.08, 0]));

  const feather = new THREE.Group();
  feather.position.set(0.3, 0.1, 0.14);
  feather.rotation.set(0.2, 0.4, -0.5);
  feather.add(mesh(new THREE.SphereGeometry(0.07, 14, 10), std('#7fd4c9', { roughness: 0.7 }), [0, 0.15, 0], [0.45, 1.9, 0.15]));
  feather.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.36, 6), std('#f5ecd8'), [0, 0.13, 0.012]));
  hat.add(feather);
  return hat;
}

function makeBandana() {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ map: polkaDots(), roughness: 0.85 });
  g.add(mesh(new THREE.TorusGeometry(0.4, 0.075, 12, 40), cloth, [0, 0, 0], [1, 1, 0.75], [Math.PI / 2, 0, 0]));
  const flap = new THREE.ConeGeometry(0.3, 0.42, 3, 1);
  g.userData.flap = mesh(flap, cloth, [0, -0.17, 0.29], [1, 1, 0.22], [Math.PI + 0.35, Math.PI / 6, 0]);
  g.add(g.userData.flap);
  g.add(mesh(new THREE.SphereGeometry(0.07, 14, 10), cloth, [0, 0.02, -0.33]));
  g.add(mesh(new THREE.ConeGeometry(0.06, 0.18, 8), cloth, [0.07, -0.08, -0.34], [1, 1, 0.5], [0.3, 0, 0.5]));
  g.add(mesh(new THREE.ConeGeometry(0.06, 0.18, 8), cloth, [-0.07, -0.08, -0.34], [1, 1, 0.5], [0.3, 0, -0.5]));
  return g;
}

export function buildCorgi() {
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.add(pivot);

  // Body: chubby, cream chest and belly
  const bodyGeo = paint(new THREE.SphereGeometry(0.52, 40, 30), (v, c) => {
    const front = smooth(0.05, 0.3, v.z) * (1 - smooth(0.25, 0.45, v.y));
    c.copy(ORANGE).lerp(CREAM, front);
  });
  const body = furry(bodyGeo, { len: 0.06, density: 26 });
  body.position.set(0, 0.82, 0);
  body.scale.set(1.05, 1.0, 0.95);
  pivot.add(body);

  const tail = furry(paint(new THREE.SphereGeometry(0.15, 20, 16), (v, c) => c.copy(ORANGE).lerp(CREAM, smooth(0, 0.12, -v.z))), { len: 0.08, shells: 10, density: 14 });
  tail.position.set(0, 0.68, -0.5);
  pivot.add(tail);

  const bandana = makeBandana();
  bandana.position.set(0, 1.22, 0.02);
  pivot.add(bandana);

  // Big bobbly head
  const head = new THREE.Group();
  head.position.set(0, 1.74, 0.04);
  pivot.add(head);

  const headGeo = deform(new THREE.SphereGeometry(0.66, 56, 40), (v) => {
    v.x *= 1.14;
    v.y *= 0.94;
    const cheek = smooth(0.05, -0.25, v.y) * smooth(0.25, 0.6, Math.abs(v.x));
    v.x += Math.sign(v.x) * cheek * 0.07;
  });
  paint(headGeo, (v, c) => {
    const blazeW = 0.05 + Math.max(0, 0.3 - v.y) * 0.55;
    const blaze = v.z > 0.15 ? 1 - smooth(blazeW, blazeW + 0.05, Math.abs(v.x)) : 0;
    const lowerFace = smooth(-0.05, -0.3, v.y) * smooth(0.1, 0.45, v.z);
    c.copy(ORANGE).lerp(CREAM, Math.max(blaze, lowerFace));
  });
  const headFur = furry(headGeo, { len: 0.065, density: 30 });
  head.add(headFur);

  const muzzleGeo = paint(new THREE.SphereGeometry(0.29, 32, 24), (v, c) => c.copy(CREAM));
  const muzzle = furry(muzzleGeo, { len: 0.03, shells: 8, density: 22 });
  muzzle.position.set(0, -0.2, 0.5);
  muzzle.scale.set(1.3, 0.8, 0.95);
  head.add(muzzle);

  head.add(mesh(new THREE.SphereGeometry(0.1, 24, 18), glossy('#1d1412'), [0, -0.09, 0.78], [1.45, 0.95, 0.9]));
  head.add(mesh(new THREE.SphereGeometry(0.025, 10, 8), glossy('#ffffff'), [0.04, -0.04, 0.86]));

  const eyes = [makeEye(-1), makeEye(1)];
  eyes.forEach((e) => head.add(e));

  const browMat = std('#9c5326');
  const brows = [-1, 1].map((s) => {
    const b = mesh(new THREE.CapsuleGeometry(0.028, 0.12, 4, 8), browMat, [s * 0.26, 0.24, 0.6], [1, 1, 1], [0, 0, Math.PI / 2]);
    b.userData.side = s;
    head.add(b);
    return b;
  });

  [-1, 1].forEach((s) => head.add(mesh(new THREE.SphereGeometry(0.09, 14, 10), std('#ff9aa0', { transparent: true, opacity: 0.45 }), [s * 0.47, -0.16, 0.5], [1, 0.6, 0.3])));

  const mouthMat = glossy('#3a2018');
  const smile = new THREE.Group();
  [-1, 1].forEach((s) => smile.add(mesh(new THREE.TorusGeometry(0.055, 0.014, 6, 14, Math.PI), mouthMat, [s * 0.055, 0, 0], [1, 1, 1], [0, 0, Math.PI])));
  smile.position.set(0, -0.27, 0.73);
  head.add(smile);
  const openMouth = new THREE.Group();
  openMouth.add(mesh(new THREE.SphereGeometry(0.085, 16, 12), mouthMat, [0, 0, 0], [1.1, 1.1, 0.45]));
  openMouth.add(mesh(new THREE.SphereGeometry(0.06, 14, 10), std('#ff7d8e'), [0, -0.04, 0.03], [1, 0.6, 0.5]));
  openMouth.position.set(0, -0.3, 0.72);
  openMouth.visible = false;
  head.add(openMouth);

  const ears = [-1, 1].map((s) => {
    const ear = new THREE.Group();
    ear.position.set(s * 0.5, 0.42, -0.06);
    ear.rotation.set(-0.12, 0, -s * 0.62);
    ear.userData.rz = ear.rotation.z;
    const earGeo = paint(new THREE.ConeGeometry(0.25, 0.62, 28, 6), (v, c) => c.copy(ORANGE));
    const outer = furry(earGeo, { len: 0.035, shells: 8, density: 18 });
    outer.scale.set(1, 1, 0.42);
    outer.position.y = 0.28;
    ear.add(outer);
    ear.add(mesh(new THREE.ConeGeometry(0.15, 0.42, 20), std('#f6b3ae'), [0, 0.25, 0.07], [1, 1, 0.25]));
    head.add(ear);
    return ear;
  });

  const hat = makeHat();
  hat.position.set(0, 0.5, -0.04);
  hat.rotation.set(-0.2, 0, 0.12);
  head.add(hat);

  // Limbs and white-sock paws
  const furSolid = std('#e48a3e', { roughness: 0.9 });
  const sock = std('#fff3e2', { roughness: 0.9 });
  const arms = [-1, 1].map((s) => {
    const paw = new THREE.Group();
    paw.add(mesh(new THREE.SphereGeometry(0.15, 20, 14), sock, [0, 0, 0], [1, 0.9, 1.1]));
    paw.add(mesh(new THREE.SphereGeometry(0.065, 12, 10), sock, [-s * 0.11, 0.05, 0.08]));
    paw.position.set(s * 0.72, 0.72, 0.15);
    pivot.add(paw);
    return paw;
  });
  const armLimbs = [0, 1].map(() => {
    const l = mesh(limbGeo, furSolid);
    pivot.add(l);
    return l;
  });

  const feet = [-1, 1].map((s) => {
    const foot = new THREE.Group();
    foot.position.set(s * 0.25, 0.1, 0.08);
    foot.add(mesh(new THREE.SphereGeometry(0.17, 20, 14), sock, [0, 0, 0.05], [1, 0.6, 1.35]));
    root.add(foot);
    return foot;
  });
  const legLimbs = [0, 1].map(() => {
    const l = mesh(limbGeo, furSolid);
    root.add(l);
    return l;
  });

  const stars = makeStars();
  root.add(stars);

  return rigFrom({
    root, pivot, head, body, headFur, eyes, brows, smile, openMouth, arms, armLimbs, feet, legLimbs, stars, ears,
    height: 2.75,
    flops: [
      { obj: tail, dir: new THREE.Vector3(0, 0, -1), len: 0.2, kind: 'bob' },
      { obj: bandana.userData.flap, at: new THREE.Vector3(0, 0.02, 0.3), dir: new THREE.Vector3(0, -1, 0.3), len: 0.4, kind: 'cloth' },
    ],
  });
}
