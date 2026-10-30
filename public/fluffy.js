import * as THREE from 'three';
import { makeStars } from './characters.js';

// Cowboy Corgi plus the shell-fur toolkit the rest of the crew (crew.js) is built from.
export const SHELLS = matchMedia('(pointer: coarse)').matches ? 9 : 14;

// ---------- Shell fur ----------
let furTex = null;
function furTexture() {
  if (furTex) return furTex;
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.pow(Math.random(), 1.4) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  furTex = new THREE.CanvasTexture(cv);
  furTex.wrapS = furTex.wrapT = THREE.RepeatWrapping;
  furTex.magFilter = THREE.NearestFilter;
  furTex.minFilter = THREE.NearestFilter;
  furTex.generateMipmaps = false;
  return furTex;
}

const shellMats = new Map();
function shellMaterial(layer, shells, len, density) {
  const key = `${layer}/${shells}/${len}/${density}`;
  if (shellMats.has(key)) return shellMats.get(key);
  const t = layer / shells;
  const tex = furTexture().clone();
  tex.needsUpdate = true;
  tex.repeat.set(density, density / 2);
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    alphaMap: tex,
    alphaTest: 0.12 + t * 0.8,
    color: new THREE.Color().setScalar(0.6 + 0.4 * t),
  });
  // Offsets are uniforms so every shell of every critter shares one shader program.
  const push = len * t;
  const droop = len * 0.5 * t * t;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.furPush = { value: push };
    shader.uniforms.furDroop = { value: droop };
    shader.vertexShader = 'uniform float furPush;\nuniform float furDroop;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       transformed += normal * furPush;
       transformed.y -= furDroop;`,
    );
  };
  m.customProgramCacheKey = () => 'fur-shell';
  shellMats.set(key, m);
  return m;
}

const skinMats = new Map();
function skinMaterial() {
  if (!skinMats.has('skin')) {
    skinMats.set('skin', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, color: new THREE.Color().setScalar(0.62) }));
  }
  return skinMats.get('skin');
}

export function furry(geometry, { len = 0.07, shells = SHELLS, density = 28 } = {}) {
  const group = new THREE.Group();
  const base = new THREE.Mesh(geometry, skinMaterial());
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);
  for (let i = 1; i <= shells; i++) {
    const shell = new THREE.Mesh(geometry, shellMaterial(i, shells, len, density));
    shell.receiveShadow = true;
    group.add(shell);
  }
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

export function makeEye(side, iris = '#6d3a1c', [x, y, z] = [0.26, 0.05, 0.62]) {
  const eye = new THREE.Group();
  eye.position.set(side * x, y, z);
  eye.rotation.y = side * 0.32;
  eye.add(mesh(new THREE.SphereGeometry(0.118, 24, 18), glossy('#2a1710'), [0, 0, 0], [1, 1.12, 0.7]));
  eye.add(mesh(new THREE.SphereGeometry(0.075, 20, 14), glossy(iris), [0, -0.02, 0.06], [1, 1.1, 0.45]));
  eye.add(mesh(new THREE.SphereGeometry(0.045, 16, 12), glossy('#0d0806'), [0, -0.02, 0.085], [1, 1.1, 0.45]));
  eye.add(mesh(new THREE.SphereGeometry(0.032, 12, 10), glossy('#ffffff'), [0.04, 0.05, 0.08]));
  eye.add(mesh(new THREE.SphereGeometry(0.015, 10, 8), glossy('#ffffff'), [-0.035, -0.045, 0.085]));
  return eye;
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
  g.add(mesh(flap, cloth, [0, -0.17, 0.29], [1, 1, 0.22], [Math.PI + 0.35, Math.PI / 6, 0]));
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
  head.add(furry(headGeo, { len: 0.065, density: 30 }));

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
  const shoulders = [new THREE.Vector3(-0.44, 1.05, 0.05), new THREE.Vector3(0.44, 1.05, 0.05)];
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
  const hips = [new THREE.Vector3(-0.22, 0.5, 0.02), new THREE.Vector3(0.22, 0.5, 0.02)];
  const tmpHip = new THREE.Vector3();

  const stars = makeStars();
  root.add(stars);

  return {
    root,
    pivot,
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
    height: 2.75,
    restArm: [new THREE.Vector3(-0.72, 0.72, 0.15), new THREE.Vector3(0.72, 0.72, 0.15)],

    updateLimbs(bounce) {
      for (let i = 0; i < 2; i++) {
        stretchLimb(armLimbs[i], shoulders[i], arms[i].position, 0.085);
        tmpHip.copy(hips[i]);
        tmpHip.y += bounce;
        stretchLimb(legLimbs[i], tmpHip, feet[i].position, 0.095);
      }
    },

    // Big head bobbles with the body's momentum; ears flop on impacts.
    updateJelly(ox, oz, ripple, t) {
      head.rotation.x = oz * 1.1;
      head.rotation.z = -ox * 1.1;
      ears.forEach((ear, i) => {
        const s = i === 0 ? -1 : 1;
        ear.rotation.z = -s * 0.62 + Math.sin(t * 24 + i) * ripple * 0.35;
      });
    },
  };
}
