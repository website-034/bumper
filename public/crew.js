import * as THREE from 'three';
import { makeStars } from './characters.js';
import { buildCorgi, furry, paint, deform, smooth, glossy, std, mesh, limbGeo, makeEye, rigFrom } from './fluffy.js';

// The playable roster: furry, dressed-up critters built in code. Ids must match ANIMALS in server.js.
export const FLUFFY = {
  corgi: { label: 'Cowboy Corgi', color: '#e8954a' },
  cat: { label: 'Pirate Cat', color: 'linear-gradient(135deg, #8d99a8 62%, #2a2421 62%)' },
  panda: { label: 'Viking Panda', color: 'linear-gradient(90deg, #f4f1ea 50%, #232025 50%)' },
  bunny: { label: 'Chef Bunny', color: 'linear-gradient(#ffffff 62%, #d63a3a 62%)' },
  raccoon: { label: 'Bandit Raccoon', color: 'linear-gradient(#8a7d70 35%, #26221f 35%, #26221f 62%, #8a7d70 62%)' },
  sheep: { label: 'Farmer Sheep', color: 'radial-gradient(circle at 50% 62%, #3b302b 34%, #f3ead6 36%)' },
  hamster: { label: 'Astronaut Hamster', color: 'radial-gradient(circle at 35% 35%, #fff4e4 18%, #e2a24f 22%)' },
  bulldog: { label: 'Biker Bulldog', color: 'linear-gradient(135deg, #8a6844 55%, #f7f1e8 55%)' },
  pig: { label: 'Superhero Pig', color: 'linear-gradient(135deg, #f6a9b8 58%, #d8282e 58%)' },
  skunk: { label: 'Detective Skunk', color: 'linear-gradient(90deg, #26222b 38%, #f4f2ee 38%, #f4f2ee 62%, #26222b 62%)' },
};

// ---------- Small helpers ----------
const C = (hex) => new THREE.Color(hex);
const V2 = (x, y) => new THREE.Vector2(x, y);
const sph = (r, w = 24, h = 16, ...rest) => new THREE.SphereGeometry(r, w, h, ...rest);
const solid = (hex) => { const col = C(hex); return (v, c) => c.copy(col); };
const HALF_DOME = [0, Math.PI * 2, 0, Math.PI / 2];

const texCache = new Map();
function canvasTex(key, draw, repeat = [1, 1]) {
  if (texCache.has(key)) return texCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  draw(cv.getContext('2d'), 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  texCache.set(key, t);
  return t;
}
const stripes = (a, b, n, repeat, across = false) => canvasTex(`st${a}${b}${n}${across}`, (g, s) => {
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 2 ? b : a;
    if (across) g.fillRect(0, (i * s) / n, s, s / n + 1);
    else g.fillRect((i * s) / n, 0, s / n + 1, s);
  }
}, repeat);
const gingham = (a, b, repeat) => canvasTex(`gh${a}${b}`, (g, s) => {
  g.fillStyle = b;
  g.fillRect(0, 0, s, s);
  g.globalAlpha = 0.55;
  g.fillStyle = a;
  for (let i = 0; i < 4; i++) { g.fillRect(i * 16, 0, 8, s); g.fillRect(0, i * 16, s, 8); }
}, repeat);
const tweed = canvasTex.bind(null, 'tweed', (g, s) => {
  g.fillStyle = '#a07a4c';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#6b4c2c';
  for (let i = 0; i < 4; i++) { g.fillRect(i * 16, 0, 4, s); g.fillRect(0, i * 16, s, 4); }
  g.fillStyle = '#d2b07e';
  for (let i = 0; i < 4; i++) { g.fillRect(i * 16 + 10, 0, 1, s); g.fillRect(0, i * 16 + 10, s, 1); }
});
const braid = (a, b) => canvasTex(`br${a}${b}`, (g, s) => {
  g.fillStyle = a;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = b;
  g.lineWidth = 6;
  for (let i = -2; i < 4; i++) {
    g.beginPath(); g.moveTo(i * 22, 0); g.lineTo(i * 22 + 16, s / 2); g.lineTo(i * 22, s); g.stroke();
  }
}, [10, 1]);
const straw = () => canvasTex('straw', (g, s) => {
  for (let y = 0; y < s; y += 4) {
    g.fillStyle = (y / 4) % 2 ? '#e3c069' : '#d1a94f';
    g.fillRect(0, y, s, 4);
  }
  g.fillStyle = 'rgba(120, 80, 20, 0.25)';
  for (let x = 0; x < s; x += 8) g.fillRect(x, 0, 1, s);
}, [8, 3]);

// A tube along a curve that narrows toward the end (tails, horns).
function tube(points, radius, taper = 0.3, tubular = 40, radial = 10) {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  const p = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    curve.getPointAt(i / tubular, c);
    const k = 1 - (1 - taper) * (i / tubular);
    for (let j = 0; j <= radial; j++) {
      const n = i * (radial + 1) + j;
      v.fromBufferAttribute(p, n).sub(c).multiplyScalar(k).add(c);
      p.setXYZ(n, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

// ---------- Ears ----------
function ear(x, s, pos, rot, part) {
  const e = new THREE.Group();
  e.position.set(s * pos[0], pos[1], pos[2]);
  e.rotation.set(rot[0], s * rot[1], -s * rot[2]);
  e.add(part);
  e.userData.rz = e.rotation.z;
  x.head.add(e);
  x.ears.push(e);
  return e;
}
function coneEar(x, s, { pos, rot = [0, 0, 0], r, h, color, inner, fur = 0.035, flat = 0.42 }) {
  const g = new THREE.Group();
  const outer = furry(paint(new THREE.ConeGeometry(r, h, 24, 6), solid(color)), { len: fur, shells: 8, density: 18 });
  outer.scale.set(1, 1, flat);
  outer.position.y = h * 0.45;
  g.add(outer);
  if (inner) g.add(mesh(new THREE.ConeGeometry(r * 0.6, h * 0.68, 18), std(inner), [0, h * 0.4, r * flat * 0.6], [1, 1, 0.25]));
  return ear(x, s, pos, rot, g);
}
function roundEar(x, s, { pos, rot = [0, 0, 0], r, color, inner, fur = 0.04, flat = 0.55 }) {
  const g = new THREE.Group();
  const outer = furry(paint(sph(r, 20, 14), solid(color)), { len: fur, shells: 8, density: 16 });
  outer.scale.set(1, 1, flat);
  g.add(outer);
  if (inner) g.add(mesh(sph(r * 0.62, 16, 12), std(inner), [0, 0, r * flat * 0.6], [1, 1, 0.3]));
  return ear(x, s, pos, rot, g);
}

// ---------- Neckwear ----------
function neckerchief(mat) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.TorusGeometry(0.4, 0.075, 12, 40), mat, [0, 0, 0], [1, 1, 0.75], [Math.PI / 2, 0, 0]));
  g.userData.flap = mesh(new THREE.ConeGeometry(0.3, 0.42, 3, 1), mat, [0, -0.17, 0.29], [1, 1, 0.22], [Math.PI + 0.35, Math.PI / 6, 0]);
  g.add(g.userData.flap);
  g.add(mesh(sph(0.07, 14, 10), mat, [0, 0.02, -0.33]));
  [-1, 1].forEach((s) => g.add(mesh(new THREE.ConeGeometry(0.06, 0.18, 8), mat, [s * 0.07, -0.08, -0.34], [1, 1, 0.5], [0.3, 0, s * 0.5])));
  return g;
}
function scarf(ring, tail) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.TorusGeometry(0.41, 0.1, 12, 40), ring, [0, 0, 0], [1, 1, 0.8], [Math.PI / 2, 0, 0]));
  g.add(mesh(sph(0.1, 14, 10), ring, [0.2, -0.04, 0.36]));
  const end = new THREE.Group();
  end.position.set(0.22, -0.06, 0.38);
  end.add(mesh(new THREE.BoxGeometry(0.2, 0.5, 0.06), tail, [0, -0.25, 0]));
  [-0.06, 0, 0.06].forEach((dx) => end.add(mesh(new THREE.BoxGeometry(0.03, 0.08, 0.04), tail, [dx, -0.53, 0])));
  end.rotation.set(0.25, 0, 0.12);
  g.add(end);
  g.userData.end = end;
  return g;
}

// ---------- Hats & gear ----------
function tricorn() {
  const hat = new THREE.Group();
  const felt = std('#2a2421', { roughness: 0.85 });
  const fold = (v) => {
    const r = Math.hypot(v.x, v.z);
    if (r < 0.01) return;
    const corner = (1 + Math.cos(3 * Math.atan2(v.x, v.z))) / 2; // 1 at the front and two back points
    const out = Math.max(0, r - 0.26);
    const k = 1 - (1 - corner) * 0.25 * (out / 0.38);
    v.x *= k; v.z *= k;
    v.y += out * (1 - corner) * 1.5 + out * 0.15;
  };
  hat.add(mesh(deform(new THREE.LatheGeometry([V2(0.22, 0), V2(0.62, 0), V2(0.64, 0.025), V2(0.62, 0.05), V2(0.22, 0.05)], 72), fold), felt));
  const trimPts = [];
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI * 2; trimPts.push(V2(0.635 + Math.cos(a) * 0.022, 0.03 + Math.sin(a) * 0.022)); }
  hat.add(mesh(deform(new THREE.LatheGeometry(trimPts, 72), fold), std('#d9b44a', { metalness: 0.6, roughness: 0.35 })));
  hat.add(mesh(new THREE.LatheGeometry([V2(0.001, 0.34), V2(0.17, 0.33), V2(0.29, 0.26), V2(0.33, 0.12), V2(0.34, 0.02)], 48), felt));
  const bone = std('#f4efe4');
  hat.add(mesh(sph(0.065, 14, 10), bone, [0, 0.2, 0.32], [1, 1, 0.6]));
  [-1, 1].forEach((s) => {
    hat.add(mesh(sph(0.016, 8, 6), std('#1a1716'), [s * 0.024, 0.205, 0.36]));
    hat.add(mesh(new THREE.CapsuleGeometry(0.014, 0.16, 4, 6), bone, [0, 0.2, 0.3], [1, 1, 1], [0, 0, s * 0.8]));
  });
  return hat;
}

function vikingHelmet() {
  const g = new THREE.Group();
  const metal = std('#a8b0b8', { metalness: 0.7, roughness: 0.32 });
  const bronze = std('#b8843f', { metalness: 0.6, roughness: 0.4 });
  g.add(mesh(sph(0.6, 36, 18, ...HALF_DOME), metal, [0, 0, 0], [1.24, 0.95, 1.12]));
  g.add(mesh(new THREE.TorusGeometry(0.6, 0.05, 8, 48), bronze, [0, 0.01, 0], [1.24, 1.12, 1], [Math.PI / 2, 0, 0]));
  g.add(mesh(new THREE.TorusGeometry(0.6, 0.035, 8, 32, Math.PI), bronze, [0, 0, 0], [1.12, 0.95, 1], [0, Math.PI / 2, 0]));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    g.add(mesh(sph(0.025, 8, 6), bronze, [Math.sin(a) * 0.76, 0.02, Math.cos(a) * 0.69]));
  }
  g.add(mesh(new THREE.BoxGeometry(0.08, 0.26, 0.04), metal, [0, -0.1, 0.7], [1, 1, 1], [-0.12, 0, 0]));
  const hornGeo = deform(new THREE.ConeGeometry(0.14, 0.82, 16, 8), (v) => { const t = (v.y + 0.41) / 0.82; v.x -= t * t * 0.42; });
  const ivory = std('#f1e6c8', { roughness: 0.5 });
  [-1, 1].forEach((s) => {
    const side = new THREE.Group();
    side.scale.x = s;
    side.add(mesh(hornGeo, ivory, [0.9, 0.4, 0], [1, 1, 1], [0, 0, -0.95]));
    side.add(mesh(new THREE.TorusGeometry(0.13, 0.035, 8, 20), bronze, [0.66, 0.2, 0], [1, 1, 1], [Math.PI / 2, 0.95, 0]));
    g.add(side);
  });
  return g;
}

function chefHat() {
  const g = new THREE.Group();
  const cotton = std('#ffffff', { roughness: 0.9 });
  g.add(mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.12, 36), std('#f1efeb', { roughness: 0.9 }), [0, 0.06, 0]));
  g.add(mesh(new THREE.CylinderGeometry(0.4, 0.35, 0.36, 36, 1, true), cotton, [0, 0.3, 0]));
  g.add(mesh(sph(0.3, 20, 14), cotton, [0, 0.6, 0], [1.1, 0.8, 1.1]));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(mesh(sph(0.2, 16, 12), cotton, [Math.sin(a) * 0.28, 0.52, Math.cos(a) * 0.28]));
  }
  return g;
}

function beanie(main, band) {
  const g = new THREE.Group();
  const knit = std(main, { roughness: 0.95 });
  g.add(mesh(sph(0.66, 36, 18, ...HALF_DOME), knit, [0, 0, 0], [1.17, 0.82, 1.06]));
  g.add(mesh(new THREE.TorusGeometry(0.75, 0.085, 10, 48), std(band, { roughness: 0.95 }), [0, 0.03, 0], [1.03, 0.95, 1], [Math.PI / 2, 0, 0]));
  const pom = furry(paint(sph(0.14, 16, 12), solid(band)), { len: 0.05, shells: 6, density: 12 });
  pom.position.set(0, 0.58, 0);
  g.add(pom);
  g.userData.pom = pom;
  return g;
}

function strawHat() {
  const g = new THREE.Group();
  const weave = new THREE.MeshStandardMaterial({ map: straw(), roughness: 0.95 });
  const brim = deform(new THREE.LatheGeometry([V2(0.3, 0), V2(0.86, 0), V2(0.88, 0.02), V2(0.86, 0.04), V2(0.3, 0.04)], 56), (v) => {
    const out = Math.max(0, Math.hypot(v.x, v.z) - 0.5);
    v.y -= out * out * 0.6;
  });
  g.add(mesh(brim, weave));
  g.add(mesh(new THREE.LatheGeometry([V2(0.001, 0.3), V2(0.3, 0.3), V2(0.36, 0.26), V2(0.38, 0.02)], 40), weave));
  g.add(mesh(new THREE.CylinderGeometry(0.372, 0.378, 0.07, 40, 1, true), std('#c23b2e'), [0, 0.07, 0]));
  return g;
}

const glass = new THREE.MeshPhysicalMaterial({
  color: '#e8f6ff', transparent: true, opacity: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false,
  ior: 1.45, specularIntensity: 1, envMapIntensity: 1.4, thickness: 0.25,
});
// High tier: real refraction through the bubble. Other tiers: a cheap see-through glaze.
export function setGlassQuality(high) {
  glass.transmission = high ? 1 : 0;
  glass.opacity = high ? 1 : 0.2;
}

function bubbleHelmet() {
  const g = new THREE.Group();
  const bubble = mesh(sph(1.0, 40, 28), glass);
  bubble.castShadow = false;
  bubble.renderOrder = 2;
  g.add(bubble);
  const glint = mesh(sph(1.01, 16, 8, 2.1, 0.5, 0.55, 0.35), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthWrite: false }));
  glint.castShadow = false;
  glint.renderOrder = 3;
  g.add(glint);
  const steel = std('#e9edf2', { metalness: 0.5, roughness: 0.35 });
  g.add(mesh(new THREE.TorusGeometry(0.63, 0.09, 12, 40), steel, [0, -0.78, 0], [1, 1, 1], [Math.PI / 2, 0, 0]));
  g.add(mesh(new THREE.TorusGeometry(0.64, 0.025, 8, 40), std('#ff8a3d'), [0, -0.7, 0], [1, 1, 1], [Math.PI / 2, 0, 0]));
  const antenna = new THREE.Group();
  antenna.position.set(0.28, 0.96, 0);
  antenna.rotation.z = -0.28;
  antenna.add(mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.06, 12), steel, [0, 0.02, 0]));
  antenna.add(mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 6), steel, [0, 0.24, 0]));
  antenna.add(mesh(sph(0.05, 12, 10), std('#ff4d4d', { emissive: '#ff2a2a', emissiveIntensity: 0.8 }), [0, 0.47, 0]));
  g.add(antenna);
  g.userData.antenna = antenna;
  return g;
}

function bikerCap() {
  const g = new THREE.Group();
  const leather = std('#26201d', { roughness: 0.45, metalness: 0.1 });
  g.add(mesh(new THREE.CylinderGeometry(0.47, 0.42, 0.26, 40), leather, [0, 0.13, 0]));
  g.add(mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.025, 40), std('#1a1614', { roughness: 0.35 }), [0, 0.265, 0]));
  g.add(mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.025, 32, 1, false, -Math.PI / 2, Math.PI), glossy('#141110'), [0, 0.02, 0.12], [1, 1, 1], [0.18, 0, 0]));
  const silver = std('#d7dce2', { metalness: 0.8, roughness: 0.25 });
  g.add(mesh(new THREE.TorusGeometry(0.43, 0.018, 6, 40), silver, [0, 0.05, 0], [1, 1, 1], [Math.PI / 2, 0, 0]));
  g.add(mesh(new THREE.OctahedronGeometry(0.06), silver, [0, 0.15, 0.45], [1.6, 1, 0.4]));
  return g;
}

function spikedCollar() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.TorusGeometry(0.42, 0.06, 10, 40), std('#1d1a18', { roughness: 0.5 }), [0, 0, 0], [1, 1, 1.1], [Math.PI / 2, 0, 0]));
  const silver = std('#d7dce2', { metalness: 0.85, roughness: 0.2 });
  for (let i = 0; i < 9; i++) {
    const spoke = new THREE.Group();
    spoke.rotation.y = (i / 9) * Math.PI * 2;
    spoke.add(mesh(new THREE.ConeGeometry(0.04, 0.12, 10), silver, [0, 0, 0.5], [1, 1, 1], [Math.PI / 2, 0, 0]));
    g.add(spoke);
  }
  return g;
}

function deerstalker() {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ map: tweed([3, 2]), roughness: 0.95, side: THREE.DoubleSide });
  g.add(mesh(sph(0.62, 36, 18, ...HALF_DOME), cloth, [0, 0, 0], [1.18, 0.82, 1.08]));
  [1, -1].forEach((s) => g.add(mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.03, 32, 1, false, -Math.PI / 2, Math.PI), cloth, [0, 0.02, s * 0.42], [1, 1, 0.8], [s * 0.25, s > 0 ? 0 : Math.PI, 0])));
  [-1, 1].forEach((s) => g.add(mesh(new THREE.BoxGeometry(0.3, 0.32, 0.035), cloth, [s * 0.46, 0.3, 0], [1, 1, 1], [0, Math.PI / 2, -s * 0.75])));
  const ribbon = std('#5a3e22');
  g.add(mesh(sph(0.045, 10, 8), ribbon, [0, 0.52, 0]));
  [-1, 1].forEach((s) => g.add(mesh(new THREE.TorusGeometry(0.05, 0.015, 6, 14), ribbon, [s * 0.06, 0.53, 0], [1, 0.7, 1], [0, Math.PI / 2, 0])));
  return g;
}

function magnifier() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.TorusGeometry(0.085, 0.018, 8, 24), std('#d9b44a', { metalness: 0.7, roughness: 0.3 })));
  g.add(mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.01, 20), new THREE.MeshPhysicalMaterial({ color: '#cfe9ff', transparent: true, opacity: 0.5, roughness: 0.05, clearcoat: 1 }), [0, 0, 0], [1, 1, 1], [Math.PI / 2, 0, 0]));
  g.add(mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.14, 8), std('#5a3e22'), [0.085, -0.095, 0], [1, 1, 1], [0, 0, 0.75]));
  return g;
}

// ---------- Looks ----------
const CAT = C('#8d99a8'), CAT_D = C('#6c7787'), CAT_L = C('#b9c2cc');
const PANDA_W = C('#f4f1ea'), PANDA_B = C('#232025');
const RAC = C('#8a7d70'), RAC_L = C('#c9bfb2'), RAC_D = C('#26221f'), RAC_W = C('#ece6de');
const HAM = C('#e2a24f'), HAM_W = C('#fff4e4');
const BRIN = C('#8a6844'), BRIN_D = C('#4b3522'), BULL_W = C('#f7f1e8');
const SK_B = C('#26222b'), SK_W = C('#f4f2ee');
const lowerFace = (v) => smooth(-0.05, -0.3, v.y) * smooth(0.1, 0.45, v.z);
const brindle = (v, c) => {
  c.copy(BRIN);
  if (Math.sin(v.y * 40 + Math.sin(v.x * 9 + v.z * 7) * 2.2) > 0.3) c.lerp(BRIN_D, 0.65);
};
const sway = (x, fn) => x.updates.push(fn);
// Parts that swing on spring chains (shared presets in floppy.js, so every critter flops alike).
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const flop = (x, obj, dir, len, kind, at, rotate = true) => x.flops.push({ obj, dir, len, kind, at, rotate });
const flapOf = (x, kerchief) => flop(x, kerchief.userData.flap, V3(0, -1, 0.3), 0.4, 'cloth', V3(0, 0.02, 0.3));

const LOOKS = {
  cat: {
    fur: 0.055, iris: '#62b04f', brow: '#59636f', limb: '#7f8b9a', paw: '#a9b3bf',
    body: (v, c) => {
      c.copy(CAT);
      if (v.z < 0.15 && Math.sin(v.y * 26 + Math.abs(v.x) * 5) > 0.55) c.lerp(CAT_D, 0.55);
      c.lerp(CAT_L, smooth(0.1, 0.35, v.z) * (1 - smooth(0.2, 0.45, v.y)));
    },
    head: (v, c) => {
      c.copy(CAT);
      if (v.y > 0.22 && Math.abs(v.x) < 0.3 && Math.sin(Math.abs(v.x) * 24 + 1.2) > 0.5) c.lerp(CAT_D, 0.6);
      c.lerp(CAT_L, lowerFace(v));
    },
    muzzle: { color: '#b4bec9', pos: [0, -0.2, 0.52], scale: [1.15, 0.72, 0.9] },
    nose: { color: '#e88a9a', pos: [0, -0.1, 0.78], scale: [0.9, 0.6, 0.6] },
    build(x) {
      [-1, 1].forEach((s) => coneEar(x, s, { pos: [0.4, 0.44, -0.02], rot: [-0.1, 0, 0.38], r: 0.22, h: 0.48, color: '#8a96a5', inner: '#f2b6bf' }));
      const whisker = new THREE.CylinderGeometry(0.006, 0.006, 0.38, 4);
      [-1, 1].forEach((s) => [0.03, -0.03].forEach((dy) => x.head.add(mesh(whisker, std('#f4f6f8'), [s * 0.42, -0.22 + dy, 0.62], [1, 1, 1], [0, 0, Math.PI / 2 + s * dy * 5]))));

      const tail = new THREE.Group();
      tail.position.set(0, 0.62, -0.42);
      const tailGeo = paint(tube([[0, 0, 0], [0.05, -0.12, -0.43], [0.12, 0.13, -0.78], [0.22, 0.58, -0.8], [0.1, 0.88, -0.56]].map((p) => new THREE.Vector3(...p)), 0.085, 0.45), (v, c) => {
        c.copy(CAT);
        if (Math.sin(v.y * 18 - v.z * 10) > 0.6) c.lerp(CAT_D, 0.6);
      });
      tail.add(furry(tailGeo, { len: 0.04, shells: 8, density: 12 }));
      x.pivot.add(tail);
      sway(x, (ox, oz, rip, t) => { tail.rotation.y = Math.sin(t * 2.2) * 0.3; });
      flop(x, tail, V3(0, 0.25, -1), 0.9, 'tail');

      const hat = tricorn();
      hat.position.set(0, 0.5, -0.02);
      hat.rotation.set(-0.15, 0, 0.06);
      x.head.add(hat);

      // Eyepatch over the right eye, strap running round the head.
      const patch = new THREE.Group();
      patch.position.copy(x.eyes[1].position);
      patch.rotation.y = 0.32;
      patch.add(mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.03, 24), std('#1a1716', { roughness: 0.6 }), [0, 0, 0.09], [1, 1, 1.05], [Math.PI / 2, 0, 0]));
      x.head.add(patch);
      const strap = new THREE.Group();
      strap.position.y = 0.14;
      strap.rotation.z = -0.3;
      strap.add(mesh(new THREE.TorusGeometry(0.77, 0.014, 6, 56), std('#1a1716'), [0, 0, 0], [1, 0.9, 1], [Math.PI / 2, 0, 0]));
      x.head.add(strap);

      const kerchief = neckerchief(new THREE.MeshStandardMaterial({ map: stripes('#c62f3a', '#f6efe4', 8, [6, 1]), roughness: 0.85 }));
      kerchief.position.set(0, 1.22, 0.02);
      x.pivot.add(kerchief);
      flapOf(x, kerchief);
    },
  },

  panda: {
    fur: 0.06, iris: '#3a2418', brow: '#1f1d20', limb: '#232025', paw: '#2c292e',
    body: (v, c) => c.copy(PANDA_W).lerp(PANDA_B, smooth(0.12, 0.2, v.y) * (1 - smooth(0.4, 0.47, v.y))),
    head: (v, c) => {
      c.copy(PANDA_W);
      if (v.z < 0.25) return;
      for (const s of [-1, 1]) {
        const dx = (v.x - s * 0.28) / 0.2, dy = (v.y - 0.02 + (Math.abs(v.x) - 0.28) * 0.5) / 0.27;
        c.lerp(PANDA_B, 1 - smooth(0.7, 1.0, dx * dx + dy * dy));
      }
    },
    muzzle: { color: '#ffffff', pos: [0, -0.21, 0.5], scale: [1.25, 0.78, 0.95] },
    nose: { color: '#141214', pos: [0, -0.1, 0.78], scale: [1.5, 1, 0.9] },
    build(x) {
      [-1, 1].forEach((s) => roundEar(x, s, { pos: [0.8, 0.2, -0.06], rot: [0, 0, 0.9], r: 0.2, color: '#232025' }));
      const helmet = vikingHelmet();
      helmet.position.set(0, 0.26, 0);
      x.head.add(helmet);

      const red = new THREE.MeshStandardMaterial({ map: braid('#c0392b', '#8e2a20'), roughness: 0.9 });
      const ring = mesh(new THREE.TorusGeometry(0.41, 0.09, 12, 40), red, [0, 1.22, 0.02], [1, 1, 0.8], [Math.PI / 2, 0, 0]);
      x.pivot.add(ring);
      const plait = std('#a83224', { roughness: 0.9 });
      [-1, 1].forEach((s) => {
        const b = new THREE.Group();
        b.position.set(s * 0.17, 1.16, 0.38);
        for (let i = 0; i < 5; i++) b.add(mesh(sph(0.065 - i * 0.006, 12, 10), plait, [0, -i * 0.085, 0], [1, 1.3, 0.8], [0, 0, (i % 2 ? 1 : -1) * 0.5]));
        b.add(mesh(new THREE.ConeGeometry(0.05, 0.12, 10), std('#e6b84a'), [0, -0.46, 0]));
        b.rotation.x = 0.35;
        x.pivot.add(b);
        sway(x, (ox, oz, rip, t) => { b.rotation.z = Math.sin(t * 3 + s) * 0.06; });
        flop(x, b, V3(0, -0.94, -0.34), 0.45, 'cloth');
      });
    },
  },

  bunny: {
    fur: 0.06, iris: '#4a2a30', brow: '#d8cfc8', limb: '#f4efe9', paw: '#fbf8f4', height: 3.05,
    body: solid('#fbf8f4'),
    head: solid('#fbf8f4'),
    muzzle: { color: '#ffffff', pos: [0, -0.22, 0.5], scale: [1.15, 0.7, 0.9] },
    nose: { color: '#f08aa6', pos: [0, -0.12, 0.77], scale: [0.8, 0.6, 0.6] },
    mouth: [0, -0.29, 0.74],
    build(x) {
      const white = solid('#fbf8f4');
      [-1, 1].forEach((s) => {
        const e = new THREE.Group();
        const lower = furry(paint(new THREE.CapsuleGeometry(0.12, 0.75, 8, 16), white), { len: 0.035, shells: 8, density: 16 });
        lower.position.y = 0.49;
        lower.scale.z = 0.6;
        e.add(lower);
        e.add(mesh(new THREE.CapsuleGeometry(0.065, 0.6, 6, 10), std('#f6b3c4'), [0, 0.5, 0.06], [1, 1, 0.3]));
        const tip = new THREE.Group();
        tip.position.y = 0.95;
        const upper = furry(paint(new THREE.CapsuleGeometry(0.12, 0.34, 8, 14), white), { len: 0.035, shells: 8, density: 16 });
        upper.position.y = 0.26;
        upper.scale.z = 0.6;
        tip.add(upper, mesh(new THREE.CapsuleGeometry(0.065, 0.26, 6, 10), std('#f6b3c4'), [0, 0.26, 0.06], [1, 1, 0.3]));
        e.add(tip);
        ear(x, s, [0.2, 0.45, -0.06], [0, 0, 0.22], e);
        const floppy = s > 0;
        sway(x, (ox, oz, rip, t) => {
          tip.rotation.x = (floppy ? 1.35 : 0.15) + Math.sin(t * 3 + s) * 0.08 + oz * 1.2;
          tip.rotation.z = floppy ? -0.2 : s * 0.1;
        });
      });
      const hat = chefHat();
      hat.position.set(0, 0.48, -0.02);
      hat.rotation.x = -0.08;
      x.head.add(hat);
      [-1, 1].forEach((s) => x.head.add(mesh(new THREE.BoxGeometry(0.065, 0.085, 0.03), std('#ffffff', { roughness: 0.3 }), [s * 0.036, -0.35, 0.735])));
      const pom = furry(paint(sph(0.17, 18, 14), white), { len: 0.09, shells: 10, density: 14 });
      pom.position.set(0, 0.66, -0.5);
      x.pivot.add(pom);
      flop(x, pom, V3(0, 0, -1), 0.2, 'bob');
      const kerchief = neckerchief(std('#d63a3a', { roughness: 0.8 }));
      kerchief.position.set(0, 1.22, 0.02);
      x.pivot.add(kerchief);
      flapOf(x, kerchief);
    },
  },

  raccoon: {
    fur: 0.065, iris: '#3a2416', brow: '#efe9e1', limb: '#3a3431', paw: '#2e2927',
    body: (v, c) => c.copy(RAC).lerp(RAC_L, smooth(0.05, 0.3, v.z) * (1 - smooth(0.25, 0.45, v.y))),
    head: (v, c) => {
      c.copy(RAC);
      if (v.z < 0.2) return;
      const ax = Math.abs(v.x);
      const mask = (1 - smooth(0.1, 0.16, Math.abs(v.y - 0.03 + ax * 0.15))) * (1 - smooth(0.55, 0.62, ax));
      const brow = (1 - smooth(0.035, 0.07, Math.abs(v.y - 0.25))) * smooth(0.08, 0.14, ax) * (1 - smooth(0.4, 0.46, ax));
      c.lerp(RAC_W, Math.max(brow, lowerFace(v))).lerp(RAC_D, mask);
    },
    muzzle: { color: '#ece6de', pos: [0, -0.2, 0.52], scale: [1.05, 0.72, 1.05] },
    nose: { color: '#151212', pos: [0, -0.12, 0.81], scale: [1.0, 0.75, 0.8] },
    build(x) {
      [-1, 1].forEach((s) => coneEar(x, s, { pos: [0.42, 0.6, -0.05], rot: [0, 0, 0.3], r: 0.17, h: 0.3, color: '#7d7166', inner: '#ece6de' }));
      const hat = beanie('#3d6b4a', '#e0c06a');
      hat.position.set(0, 0.2, -0.02);
      hat.rotation.x = -0.1;
      x.head.add(hat);
      flop(x, hat.userData.pom, V3(0, 1, 0), 0.18, 'bob');
      const wrap = scarf(
        new THREE.MeshStandardMaterial({ map: stripes('#e8803a', '#f3e3c3', 10, [8, 1]), roughness: 0.9 }),
        new THREE.MeshStandardMaterial({ map: stripes('#e8803a', '#f3e3c3', 6, [1, 1], true), roughness: 0.9 }),
      );
      wrap.position.set(0, 1.22, 0.02);
      x.pivot.add(wrap);
      flop(x, wrap.userData.end, V3(0, -1, 0.25), 0.5, 'cloth');

      const tailGeo = paint(new THREE.CapsuleGeometry(0.17, 0.75, 8, 18), (v, c) => {
        c.copy(Math.floor((v.y + 0.55) / 0.19) % 2 ? RAC_D : RAC_L);
        if (v.y > 0.42) c.copy(RAC_D);
      });
      const tail = new THREE.Group();
      tail.position.set(0, 0.58, -0.45);
      const fluff = furry(tailGeo, { len: 0.09, shells: 10, density: 14 });
      fluff.position.y = 0.5;
      fluff.scale.set(1.15, 1, 1.15);
      tail.add(fluff);
      x.pivot.add(tail);
      sway(x, (ox, oz, rip, t) => { tail.rotation.set(-1.05, 0, Math.sin(t * 2.4) * 0.25); });
      flop(x, tail, V3(0, 0.5, -0.87), 1.0, 'tail');
    },
  },

  sheep: {
    fur: 0.13, density: 16, headFur: 0.03, iris: '#5a3a20', brow: '#9a8a80', limb: '#3b302b', paw: '#2a221f',
    mouthColor: '#d9c9bc',
    body: solid('#f3ead6'),
    head: solid('#3b302b'),
    eyePos: [0.24, 0.04, 0.6],
    muzzle: { color: '#4a3d37', pos: [0, -0.24, 0.5], scale: [1.2, 0.8, 0.95], fur: 0.02 },
    nose: { color: '#22191a', pos: [0, -0.16, 0.77], scale: [1.1, 0.6, 0.6] },
    mouth: [0, -0.32, 0.74],
    build(x) {
      const wool = solid('#f3ead6');
      const cap = furry(paint(sph(0.7, 40, 24, 0, Math.PI * 2, 0, 1.75), wool), { len: 0.12, density: 16 });
      cap.rotation.x = -0.55;
      cap.scale.set(1.12, 0.95, 1.02);
      cap.position.set(0, 0.04, -0.04);
      x.head.add(cap);

      const hornGeo = tube(Array.from({ length: 25 }, (_, i) => {
        const t = i / 24, a = t * Math.PI * 2.1, r = 0.24 * (1 - 0.55 * t);
        return new THREE.Vector3(t * 0.16, Math.sin(a) * r, Math.cos(a) * r - 0.24);
      }), 0.085, 0.35, 48, 10);
      const horn = std('#c9a77a', { roughness: 0.55 });
      [-1, 1].forEach((s) => {
        const side = new THREE.Group();
        side.scale.x = s;
        side.position.set(s * 0.8, 0.12, 0.06);
        side.rotation.x = -0.6;
        side.add(mesh(hornGeo, horn));
        x.head.add(side);
      });
      [-1, 1].forEach((s) => roundEar(x, s, { pos: [0.72, -0.14, 0.1], rot: [0, 0, 0.45], r: 0.13, color: '#3b302b', inner: '#c89a90', fur: 0.02, flat: 0.5 }).scale.set(1.6, 0.7, 1));

      const hat = strawHat();
      hat.position.set(0, 0.66, -0.06);
      hat.rotation.set(-0.12, 0, -0.08);
      x.head.add(hat);
      const kerchief = neckerchief(new THREE.MeshStandardMaterial({ map: gingham('#d23b3b', '#fff8f0', [4, 1]), roughness: 0.85 }));
      kerchief.position.set(0, 1.3, 0.04);
      kerchief.scale.setScalar(1.2);
      x.pivot.add(kerchief);
      flapOf(x, kerchief);
      const tail = furry(paint(sph(0.14, 16, 12), wool), { len: 0.1, shells: 8, density: 12 });
      tail.position.set(0, 0.7, -0.6);
      x.pivot.add(tail);
      flop(x, tail, V3(0, 0, -1), 0.2, 'bob');
    },
  },

  hamster: {
    fur: 0.065, cheeks: 0.16, iris: '#1e120c', brow: '#b9772f', limb: '#d99645', paw: '#f2b8b0', height: 3.1,
    body: (v, c) => c.copy(HAM).lerp(HAM_W, smooth(0.0, 0.3, v.z) * (1 - smooth(0.15, 0.4, v.y))),
    head: (v, c) => {
      const cheek = smooth(0.05, -0.2, v.y) * smooth(0.15, 0.45, Math.abs(v.x)) * smooth(-0.1, 0.3, v.z);
      c.copy(HAM).lerp(HAM_W, Math.max(cheek, lowerFace(v)));
    },
    eyePos: [0.27, 0.08, 0.62],
    muzzle: { color: '#fff4e4', pos: [0, -0.2, 0.52], scale: [1.0, 0.7, 0.85] },
    nose: { color: '#e98a95', pos: [0, -0.11, 0.77], scale: [0.7, 0.5, 0.5] },
    build(x) {
      [-1, 1].forEach((s) => roundEar(x, s, { pos: [0.42, 0.5, -0.02], rot: [0, 0, 0.3], r: 0.11, color: '#d9933f', inner: '#f2b8b0' }));
      [-1, 1].forEach((s) => x.head.add(mesh(new THREE.BoxGeometry(0.055, 0.07, 0.03), std('#ffffff', { roughness: 0.3 }), [s * 0.03, -0.34, 0.72])));
      const helmet = bubbleHelmet();
      helmet.position.set(0, 0.08, 0.02);
      x.head.add(helmet);
      const antenna = helmet.userData.antenna;
      sway(x, (ox, oz, rip, t) => { antenna.rotation.z = -0.28 + Math.sin(t * 20) * rip * 0.4; });
      flop(x, antenna, V3(-0.28, 1, 0), 0.45, 'ear');
      const pack = new THREE.Group();
      pack.position.set(0, 1.0, -0.62);
      pack.add(mesh(new THREE.BoxGeometry(0.56, 0.56, 0.22), std('#f1f3f6', { roughness: 0.5 })));
      [-1, 1].forEach((s) => pack.add(mesh(new THREE.CapsuleGeometry(0.09, 0.32, 6, 12), std('#ff8a3d', { roughness: 0.4 }), [s * 0.15, 0, -0.14])));
      x.pivot.add(pack);
    },
  },

  bulldog: {
    fur: 0.035, headW: 1.24, headH: 0.86, cheeks: 0.1, iris: '#4a2a14', brow: '#3e2a1a', limb: '#7a5a3a', paw: '#f7f1e8',
    body: (v, c) => { brindle(v, c); c.lerp(BULL_W, smooth(0.08, 0.3, v.z) * (1 - smooth(0.3, 0.45, v.y))); },
    head: (v, c) => {
      brindle(v, c);
      const blaze = v.z > 0.2 ? (1 - smooth(0.07, 0.12, Math.abs(v.x))) * (1 - smooth(0.3, 0.4, v.y)) : 0;
      c.lerp(BULL_W, Math.max(blaze, lowerFace(v)));
    },
    muzzle: { color: '#f7f1e8', pos: [0, -0.22, 0.5], scale: [1.65, 0.85, 0.95], fur: 0.025 },
    nose: { color: '#1a1210', pos: [0, -0.08, 0.8], scale: [1.7, 1.0, 0.8] },
    mouth: [0, -0.31, 0.77],
    build(x) {
      [-1, 1].forEach((s) => {
        const jowl = furry(paint(sph(0.17, 18, 14), solid('#f7f1e8')), { len: 0.02, shells: 6, density: 20 });
        jowl.position.set(s * 0.22, -0.35, 0.55);
        jowl.scale.set(1.1, 1.25, 0.9);
        x.head.add(jowl);
        x.head.add(mesh(new THREE.ConeGeometry(0.03, 0.08, 8), std('#ffffff', { roughness: 0.3 }), [s * 0.12, -0.36, 0.73]));
      });
      [-1, 1].forEach((s) => coneEar(x, s, { pos: [0.52, 0.32, -0.06], rot: [1.1, 0, 0.9], r: 0.15, h: 0.24, color: '#5a4029', inner: '#d99a8f', flat: 0.45 }));
      const cap = bikerCap();
      cap.position.set(0, 0.42, -0.02);
      cap.rotation.x = -0.12;
      x.head.add(cap);
      const collar = spikedCollar();
      collar.position.set(0, 1.2, 0.02);
      x.pivot.add(collar);
      const nub = furry(paint(sph(0.1, 14, 10), brindle), { len: 0.03, shells: 6, density: 16 });
      nub.position.set(0, 0.62, -0.52);
      x.pivot.add(nub);
      flop(x, nub, V3(0, 0, -1), 0.15, 'bob');
    },
  },

  pig: {
    fur: 0.025, density: 40, iris: '#3a1e26', brow: '#d9798f', limb: '#f3a0b2', paw: '#e07f95',
    body: solid('#f6a9b8'),
    head: solid('#f6a9b8'),
    eyePos: [0.26, 0.06, 0.65],
    mouth: [0, -0.33, 0.69],
    build(x) {
      x.head.add(mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.2, 28), std('#f28ba1', { roughness: 0.6 }), [0, -0.15, 0.7], [1.15, 1, 0.85], [Math.PI / 2, 0, 0]));
      [-1, 1].forEach((s) => x.head.add(mesh(sph(0.045, 12, 10), std('#b9536c'), [s * 0.08, -0.15, 0.8], [0.8, 1.2, 0.4])));
      [-1, 1].forEach((s) => coneEar(x, s, { pos: [0.45, 0.46, 0.02], rot: [0.6, 0, 0.55], r: 0.2, h: 0.34, color: '#f6a9b8', inner: '#e98aa0', fur: 0.02, flat: 0.4 }));
      const mask = mesh(sph(0.69, 40, 10, Math.PI / 2 - 0.95, 1.9, 1.3, 0.38), std('#1f2050', { roughness: 0.4, side: THREE.DoubleSide }), [0, 0, 0], [1.14, 0.94, 1]);
      x.head.add(mask);

      const curl = tube(Array.from({ length: 17 }, (_, i) => {
        const a = (i / 16) * Math.PI * 3;
        return new THREE.Vector3(Math.sin(a) * 0.07, Math.cos(a) * 0.07 - 0.07, -(i / 16) * 0.25);
      }), 0.026, 0.6, 40, 8);
      const curlTail = mesh(curl, std('#f3a0b2'), [0, 0.66, -0.5]);
      x.pivot.add(curlTail);
      flop(x, curlTail, V3(0, 0, -1), 0.25, 'bob');

      // Cape: hangs from the shoulders and streams out behind when running.
      const W = 1.05, H = 1.25;
      const capeGeo = new THREE.PlaneGeometry(W, H, 8, 12);
      capeGeo.translate(0, -H / 2, 0);
      const base = Float32Array.from(capeGeo.attributes.position.array);
      const cape = mesh(capeGeo, std('#d8282e', { roughness: 0.6, side: THREE.DoubleSide }), [0, 1.34, -0.42], [1, 1, 1], [0.1, Math.PI, 0]);
      x.pivot.add(cape);
      const gold = std('#f2c14e', { metalness: 0.6, roughness: 0.3 });
      x.pivot.add(mesh(new THREE.TorusGeometry(0.39, 0.035, 8, 36), std('#b81f26'), [0, 1.3, 0.02], [1, 1, 0.8], [Math.PI / 2, 0, 0]));
      [-1, 1].forEach((s) => x.pivot.add(mesh(sph(0.05, 12, 10), gold, [s * 0.14, 1.28, 0.36])));
      x.pivot.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 24), gold, [0, 0.98, 0.52], [1, 1, 1], [Math.PI / 2 - 0.25, 0, 0]));
      x.pivot.add(mesh(new THREE.BoxGeometry(0.05, 0.14, 0.02), std('#d8282e'), [0, 0.985, 0.535], [1, 1, 1], [-0.25, 0, 0.4]));
      const pos = capeGeo.attributes.position;
      // The cape's spring chain says how far its hem has swung; the cloth bends to follow it.
      flop(x, cape, V3(0, -1, -0.1), 1.2, 'cloth', undefined, false);
      sway(x, (ox, oz, rip, t) => {
        const bend = cape.userData.chain?.bend;
        // Cape space is turned round (rotation.y = PI): pivot -z is the cape's +z.
        const bx_ = bend ? -bend.x * H : 0, by_ = bend ? bend.y * H : 0, bz_ = bend ? -bend.z * H : 0;
        const swing = Math.min(1.5, Math.hypot(bx_, bz_));
        for (let i = 0; i < pos.count; i++) {
          const bx = base[i * 3], by = base[i * 3 + 1];
          const h = -by / H, h2 = h * h;
          const nx = bx * (0.55 + 0.45 * h);
          const flap = Math.sin(t * 9 - h * 5 + bx * 3) * 0.05 * h * (0.4 + swing * 1.2) + rip * Math.sin(t * 22 + h * 6) * 0.08 * h;
          pos.setXYZ(i, nx + h2 * bx_, by + h2 * (0.04 + Math.max(0, by_)), -nx * nx * 0.5 + h2 * 0.12 + h2 * Math.max(0, bz_) + flap);
        }
        pos.needsUpdate = true;
        capeGeo.computeVertexNormals();
      });
    },
  },

  skunk: {
    fur: 0.065, iris: '#c08a2a', brow: '#f4f2ee', limb: '#221f27', paw: '#2b2730',
    body: (v, c) => c.copy(SK_B).lerp(SK_W, (1 - smooth(0.15, 0.21, Math.abs(v.x))) * smooth(0.15, -0.05, v.z)),
    head: (v, c) => {
      c.copy(SK_B);
      const top = (1 - smooth(0.15, 0.21, Math.abs(v.x))) * Math.max(smooth(0.12, 0.22, v.y), smooth(0.0, -0.15, v.z));
      const blaze = v.z > 0.45 && v.y > -0.15 ? 1 - smooth(0.04, 0.07, Math.abs(v.x)) : 0;
      c.lerp(SK_W, Math.max(top, blaze));
    },
    muzzle: { color: '#3a3542', pos: [0, -0.2, 0.52], scale: [1.1, 0.72, 0.95] },
    nose: { color: '#121014', pos: [0, -0.11, 0.8], scale: [1.0, 0.7, 0.8] },
    mouthColor: '#e7dfe9',
    build(x) {
      [-1, 1].forEach((s) => roundEar(x, s, { pos: [0.58, 0.32, -0.04], rot: [0, 0, 0.5], r: 0.13, color: '#26222b', inner: '#d9a6b4' }));
      const hat = deerstalker();
      hat.position.set(0, 0.24, -0.02);
      hat.rotation.x = -0.08;
      x.head.add(hat);

      const L = 0.88;
      const tailGeo = deform(sph(0.42, 30, 24), (v) => {
        v.y *= 2.1;
        const h = (v.y + L) / (2 * L);
        v.z -= h * h * 0.55;
        v.x *= 1 + 0.2 * Math.sin(h * Math.PI);
      });
      paint(tailGeo, (v, c) => {
        const h = (v.y + L) / (2 * L);
        const back = smooth(-0.1, -0.25, v.z + h * h * 0.55);
        c.copy(SK_B).lerp(SK_W, Math.max((1 - smooth(0.16, 0.24, Math.abs(v.x))) * back, smooth(0.9, 0.97, h)));
      });
      const tail = new THREE.Group();
      tail.position.set(0, 0.5, -0.52);
      const fluff = furry(tailGeo, { len: 0.12, density: 14 });
      fluff.position.y = L;
      tail.add(fluff);
      x.pivot.add(tail);
      sway(x, (ox, oz, rip, t) => { tail.rotation.set(-0.35, 0, Math.sin(t * 1.8) * 0.12); });
      flop(x, tail, V3(0, 0.94, -0.34), 1.6, 'tail');

      const badge = magnifier();
      badge.position.set(0.2, 1.0, 0.55);
      badge.rotation.set(-0.2, 0.3, 0.2);
      x.pivot.add(badge);
    },
  },
};

// ---------- Shared furry body: same rig as the corgi so the game animates every critter alike ----------
export function buildFluffy(id) {
  const L = LOOKS[id];
  if (!L) return buildCorgi();
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.add(pivot);
  const fur = L.fur ?? 0.06;
  const density = L.density ?? 26;

  const body = furry(paint(new THREE.SphereGeometry(0.52, 40, 30), L.body), { len: fur, density });
  body.position.set(0, 0.82, 0);
  body.scale.set(1.05, 1.0, 0.95);
  pivot.add(body);

  const head = new THREE.Group();
  head.position.set(0, 1.74, 0.04);
  pivot.add(head);
  const headGeo = deform(new THREE.SphereGeometry(0.66, 56, 40), (v) => {
    v.x *= L.headW ?? 1.14;
    v.y *= L.headH ?? 0.94;
    const cheek = smooth(0.05, -0.25, v.y) * smooth(0.25, 0.6, Math.abs(v.x));
    v.x += Math.sign(v.x) * cheek * (L.cheeks ?? 0.07);
  });
  const headFur = furry(paint(headGeo, L.head), { len: L.headFur ?? fur * 1.08, density: density + 4 });
  head.add(headFur);

  if (L.muzzle) {
    const m = L.muzzle;
    const mz = furry(paint(new THREE.SphereGeometry(0.29, 32, 24), solid(m.color)), { len: m.fur ?? 0.03, shells: 8, density: 22 });
    mz.position.set(...m.pos);
    mz.scale.set(...m.scale);
    head.add(mz);
  }
  if (L.nose) head.add(mesh(new THREE.SphereGeometry(0.1, 24, 18), glossy(L.nose.color), L.nose.pos, L.nose.scale));

  const eyePos = L.eyePos ?? [0.26, 0.05, 0.62];
  const eyes = [makeEye(-1, L.iris, eyePos), makeEye(1, L.iris, eyePos)];
  eyes.forEach((e) => head.add(e));
  const browMat = std(L.brow);
  const brows = [-1, 1].map((s) => {
    const b = mesh(new THREE.CapsuleGeometry(0.028, 0.12, 4, 8), browMat, [s * eyePos[0], eyePos[1] + 0.19, eyePos[2] - 0.02], [1, 1, 1], [0, 0, Math.PI / 2]);
    b.userData.side = s;
    head.add(b);
    return b;
  });
  [-1, 1].forEach((s) => head.add(mesh(new THREE.SphereGeometry(0.09, 14, 10), std('#ff9aa0', { transparent: true, opacity: 0.45 }), [s * 0.47, -0.16, 0.5], [1, 0.6, 0.3])));

  const [mx, my, mzPos] = L.mouth ?? [0, -0.27, 0.73];
  const mouthMat = glossy(L.mouthColor ?? '#3a2018');
  const smile = new THREE.Group();
  [-1, 1].forEach((s) => smile.add(mesh(new THREE.TorusGeometry(0.055, 0.014, 6, 14, Math.PI), mouthMat, [s * 0.055, 0, 0], [1, 1, 1], [0, 0, Math.PI])));
  smile.position.set(mx, my, mzPos);
  head.add(smile);
  const openMouth = new THREE.Group();
  openMouth.add(mesh(new THREE.SphereGeometry(0.085, 16, 12), glossy('#3a2018'), [0, 0, 0], [1.1, 1.1, 0.45]));
  openMouth.add(mesh(new THREE.SphereGeometry(0.06, 14, 10), std('#ff7d8e'), [0, -0.04, 0.03], [1, 0.6, 0.5]));
  openMouth.position.set(mx, my - 0.03, mzPos - 0.01);
  openMouth.visible = false;
  head.add(openMouth);

  const x = { root, pivot, head, body, eyes, ears: [], updates: [], flops: [] };
  L.build(x);

  const limbMat = std(L.limb, { roughness: 0.9 });
  const pawMat = std(L.paw ?? L.limb, { roughness: 0.9 });
  const arms = [-1, 1].map((s) => {
    const paw = new THREE.Group();
    paw.add(mesh(new THREE.SphereGeometry(0.15, 20, 14), pawMat, [0, 0, 0], [1, 0.9, 1.1]));
    paw.add(mesh(new THREE.SphereGeometry(0.065, 12, 10), pawMat, [-s * 0.11, 0.05, 0.08]));
    paw.position.set(s * 0.72, 0.72, 0.15);
    pivot.add(paw);
    return paw;
  });
  const armLimbs = [0, 1].map(() => { const l = mesh(limbGeo, limbMat); pivot.add(l); return l; });
  const feet = [-1, 1].map((s) => {
    const foot = new THREE.Group();
    foot.position.set(s * 0.25, 0.1, 0.08);
    foot.add(mesh(new THREE.SphereGeometry(0.17, 20, 14), pawMat, [0, 0, 0.05], [1, 0.6, 1.35]));
    root.add(foot);
    return foot;
  });
  const legLimbs = [0, 1].map(() => { const l = mesh(limbGeo, limbMat); root.add(l); return l; });

  const stars = makeStars();
  root.add(stars);

  return rigFrom({
    root, pivot, head, body, headFur, eyes, brows, smile, openMouth, arms, armLimbs, feet, legLimbs, stars,
    height: L.height ?? 2.75, ears: x.ears, flops: x.flops, updates: x.updates,
  });
}
