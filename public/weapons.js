import * as THREE from 'three';
import { mergeRigidParts } from './merge.js';

// len = grip-to-tip length; windup, spin, turns and sweep must match the server's WEAPONS table.
export const WEAPON_INFO = {
  pan: { label: 'Frying Pan', icon: '🍳', len: 1.85, windup: 0.3, sweep: true, words: ['CLANG!', 'DONG!', 'TONK!'] },
  hammer: { label: 'Squeaky Mallet', icon: '🔨', len: 2.05, windup: 0.45, spin: 0.65, turns: 2, words: ['BONK!', 'SQUEAK!', 'KA-BONK!'] },
  blaster: { label: 'Foam Blaster', icon: '🔫', len: 1.2, windup: 0, ranged: true, words: ['SPLAT!', 'FWUMP!', 'PLOP!'] },
  // Worn one on each paw; every hit knocks out, and they wear out after 3 knockouts.
  gloves: { label: 'Boxing Gloves', icon: '🥊', len: 0.6, windup: 0.15, gloves: true, kos: 3, words: ['KNOCKOUT!', 'K.O.!', 'POW!'] },
};

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...opts });

function mesh(geo, material) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  return m;
}
function cyl(rTop, rBot, h, material, seg = 18) {
  return mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), material);
}
function lathe(points, material, seg = 28) {
  return mesh(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), seg), material);
}

function buildPan() {
  const g = new THREE.Group();
  const handle = lathe([[0, -0.15], [0.08, -0.15], [0.09, -0.1], [0.075, 0.6], [0.06, 0.78], [0, 0.78]], mat('#7a4f36', { roughness: 0.8 }));
  const hole = mesh(new THREE.TorusGeometry(0.05, 0.018, 8, 16), mat('#3d2a20'));
  hole.position.y = -0.05;
  const iron = mat('#55536b', { roughness: 0.32, metalness: 0.85 });
  const neck = cyl(0.05, 0.06, 0.3, iron);
  neck.position.y = 0.88;
  // Pan bowl, built flat then stood up so its face points forward when swung.
  const bowl = new THREE.Group();
  const shell = lathe([[0, 0], [0.5, 0], [0.56, 0.04], [0.6, 0.16], [0.56, 0.17], [0.52, 0.06], [0, 0.06]], iron, 36);
  const inner = cyl(0.51, 0.51, 0.02, mat('#a9a7c6', { roughness: 0.16, metalness: 0.95 }), 36);
  inner.position.y = 0.065;
  const egg = new THREE.Group();
  const white = mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.03, 20), mat('#ffffff', { roughness: 0.3 }));
  const yolk = mesh(new THREE.SphereGeometry(0.09, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat('#ffc23d', { roughness: 0.25 }));
  yolk.position.y = 0.015;
  egg.add(white, yolk);
  egg.position.set(0.08, 0.08, -0.05);
  bowl.add(shell, inner, egg);
  bowl.rotation.x = Math.PI / 2;
  bowl.position.y = 1.6;
  bowl.position.z = 0.03;
  g.add(handle, hole, neck, bowl);
  return g;
}

function buildHammer() {
  const g = new THREE.Group();
  const handle = lathe([[0, -0.2], [0.1, -0.2], [0.08, -0.1], [0.065, 1.5], [0, 1.5]], mat('#ffcf5a'));
  const pink = mat('#ff8fa3', { roughness: 0.32 });
  const head = cyl(0.42, 0.42, 0.95, pink, 32);
  head.rotation.z = Math.PI / 2;
  head.position.y = 1.72;
  const white = mat('#ffffff', { roughness: 0.4 });
  for (const side of [-1, 1]) {
    const end = cyl(0.44, 0.44, 0.12, white, 32);
    end.rotation.z = Math.PI / 2;
    end.position.set(side * 0.5, 1.72, 0);
    const bump = mesh(new THREE.SphereGeometry(0.36, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), white);
    bump.rotation.z = -side * Math.PI / 2;
    bump.scale.y = 0.35;
    bump.position.set(side * 0.56, 1.72, 0);
    g.add(end, bump);
  }
  const band = cyl(0.435, 0.435, 0.09, mat('#ffcf5a'), 32);
  band.rotation.z = Math.PI / 2;
  band.position.y = 1.72;
  g.add(handle, head, band);
  return g;
}

function buildBlaster() {
  const g = new THREE.Group();
  const teal = mat('#7cc8f0', { roughness: 0.35 });
  const orange = mat('#ffa45c', { roughness: 0.4 });
  const grip = mesh(new THREE.BoxGeometry(0.2, 0.45, 0.26), orange);
  grip.position.set(0, -0.05, -0.08);
  grip.rotation.x = -0.25;
  const body = mesh(new THREE.BoxGeometry(0.32, 0.34, 0.8), teal);
  body.position.set(0, 0.28, 0.18);
  const barrel = cyl(0.1, 0.1, 0.55, orange);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.33, 0.8);
  const tip = cyl(0.13, 0.13, 0.08, mat('#ffffff'));
  tip.rotation.x = Math.PI / 2;
  tip.position.set(0, 0.33, 1.08);
  const tank = mesh(new THREE.SphereGeometry(0.19, 16, 12), mat('#ffcf5a', { roughness: 0.25 }));
  tank.position.set(0, 0.6, 0.08);
  g.add(grip, body, barrel, tip, tank);
  return g;
}

// ---------- Boxing gloves ----------
// Every glove shares the same two materials (red leather, white cuff and laces), and its parts
// merge into one mesh per material, so a glove costs two draw calls.
let gloveMats = null;
const gloveMaterials = () => (gloveMats ||= {
  red: mat('#e8333f', { roughness: 0.38 }),
  white: mat('#fff7ee', { roughness: 0.6 }),
});

// One chunky cartoon glove centred on the paw: knuckles face +z, the cuff trails back toward
// the wrist and the thumb sits on the inner side (side -1 = left paw).
export function buildGlove(side = 1) {
  const { red, white } = gloveMaterials();
  const g = new THREE.Group();
  const mitt = mesh(new THREE.SphereGeometry(0.24, 20, 16), red);
  mitt.scale.set(1, 0.88, 1.15);
  mitt.position.z = 0.07;
  const thumb = mesh(new THREE.SphereGeometry(0.1, 14, 10), red);
  thumb.scale.set(0.85, 1, 1.5);
  thumb.position.set(-side * 0.2, 0.03, 0.08);
  thumb.rotation.y = -side * 0.35;
  // Red tongue under the laces, along the back of the cuff.
  const tongue = mesh(new THREE.BoxGeometry(0.09, 0.04, 0.22), red);
  tongue.position.set(0, 0.155, -0.17);
  const cuff = cyl(0.17, 0.155, 0.2, white, 18);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = -0.17;
  const rim = mesh(new THREE.TorusGeometry(0.16, 0.035, 8, 20), white);
  rim.position.z = -0.27;
  g.add(mitt, thumb, tongue, cuff, rim);
  for (const z of [-0.1, -0.17, -0.24]) {
    for (const s of [-1, 1]) {
      const lace = mesh(new THREE.BoxGeometry(0.13, 0.018, 0.022), white);
      lace.position.set(0, 0.18, z);
      lace.rotation.y = s * 0.55;
      g.add(lace);
    }
  }
  mergeRigidParts(g);
  return g;
}

// The pair as it lies on the ground or flies through the air.
function buildGloves() {
  const g = new THREE.Group();
  for (const side of [-1, 1]) {
    const glove = buildGlove(side);
    glove.position.set(side * 0.24, 0, side * 0.05);
    glove.rotation.y = side * 0.3;
    g.add(glove);
  }
  return g;
}

const BUILDERS = { pan: buildPan, hammer: buildHammer, blaster: buildBlaster, gloves: buildGloves };

export function buildWeapon(type) {
  const w = (BUILDERS[type] || buildPan)();
  mergeRigidParts(w);
  return w;
}

const ringGeo = new THREE.RingGeometry(0.85, 1.0, 40);
const glowGeo = new THREE.CircleGeometry(0.85, 40);

// A weapon lying on the island with a glowing "pick me up" ring.
export function buildPickup(type) {
  const info = WEAPON_INFO[type] || WEAPON_INFO.pan;
  const root = new THREE.Group();
  const holder = new THREE.Group();
  const w = buildWeapon(type);
  if (!info.ranged && !info.gloves) {
    w.rotation.z = Math.PI / 2;
    w.position.x = info.len / 2;
  }
  holder.add(w);
  holder.position.y = type === 'blaster' ? 0.1 : info.gloves ? 0.22 : 0.28;
  const s = Math.max(1, info.len / 1.7);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#fff3a0', transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.scale.setScalar(s);
  const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: '#fffbe0', transparent: true, opacity: 0.35, depthWrite: false }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  glow.scale.setScalar(s);
  root.add(holder, ring, glow);
  return { root, holder, ring, glow, model: w };
}

const shotGeo = new THREE.SphereGeometry(0.24, 14, 10);
const shotMat = new THREE.MeshStandardMaterial({ color: '#ffa45c', emissive: '#ff8a3d', emissiveIntensity: 4, roughness: 0.6 });
export function buildShot() {
  const m = new THREE.Mesh(shotGeo, shotMat);
  m.castShadow = true;
  return m;
}
