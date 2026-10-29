import * as THREE from 'three';

// len = grip-to-tip length; windup must match the server's WEAPONS table.
export const WEAPON_INFO = {
  bat: { label: 'Baseball Bat', len: 2.25, windup: 0.38, words: ['WHACK!', 'SMACK!', 'HOME RUN!'] },
  pan: { label: 'Frying Pan', len: 1.85, windup: 0.3, words: ['CLANG!', 'DONG!', 'TONK!'] },
  hammer: { label: 'Squeaky Mallet', len: 2.05, windup: 0.55, words: ['BONK!', 'SQUEAK!', 'KA-BONK!'] },
  lollipop: { label: 'Giant Lollipop', len: 2.3, windup: 0.4, words: ['SWEET!', 'THWAP!', 'SUGAR RUSH!'] },
  chicken: { label: 'Rubber Chicken', len: 1.8, windup: 0.26, words: ['BAWK!', 'SQUAWK!', 'FLOP!'] },
  blaster: { label: 'Foam Blaster', len: 1.2, windup: 0, ranged: true, words: ['SPLAT!', 'FWUMP!', 'PLOP!'] },
  bomb: { label: 'Bomb', len: 1.2, windup: 0, bomb: true, words: ['KABOOM!', 'BOOM!', 'KA-POW!'] },
  sticky: { label: 'Sticky Bomb', len: 1.2, windup: 0, bomb: true, sticky: true, words: ['KABLOOEY!', 'SPLOOSH!', 'GLORP-BOOM!'] },
};
export const BOMB_FUSE = 5;

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

// Chunky cartoon baseball bat: thin taped handle swelling into a fat rounded barrel.
function buildBat() {
  const g = new THREE.Group();
  const wood = mat('#e2a564', { roughness: 0.42 });
  const prof = [[0, -0.2], [0.12, -0.2], [0.13, -0.17], [0.09, -0.13], [0.075, -0.05], [0.075, 0.55], [0.09, 0.85],
    [0.13, 1.2], [0.19, 1.6], [0.23, 1.95], [0.235, 2.08], [0.2, 2.18], [0.12, 2.24], [0, 2.25]];
  g.add(lathe(prof, wood));
  const tape = mat('#8b6fd6', { roughness: 0.85 });
  for (let i = 0; i < 6; i++) {
    const wrap = cyl(0.085, 0.085, 0.06, tape);
    wrap.position.y = -0.02 + i * 0.085;
    wrap.rotation.z = 0.08;
    g.add(wrap);
  }
  const stripe = mat('#ff8fa3', { roughness: 0.4 });
  for (const y of [1.45, 1.55]) {
    const s = cyl(0.18 + (y - 1.45) * 0.4, 0.17 + (y - 1.45) * 0.4, 0.04, stripe, 28);
    s.position.y = y;
    g.add(s);
  }
  const knot = mesh(new THREE.SphereGeometry(0.05, 10, 8), mat('#b77a3e'));
  knot.position.set(0.2, 1.8, 0.1);
  g.add(knot);
  return g;
}

function buildPan() {
  const g = new THREE.Group();
  const handle = lathe([[0, -0.15], [0.08, -0.15], [0.09, -0.1], [0.075, 0.6], [0.06, 0.78], [0, 0.78]], mat('#7a4f36', { roughness: 0.8 }));
  const hole = mesh(new THREE.TorusGeometry(0.05, 0.018, 8, 16), mat('#3d2a20'));
  hole.position.y = -0.05;
  const iron = mat('#4a4860', { roughness: 0.35, metalness: 0.45 });
  const neck = cyl(0.05, 0.06, 0.3, iron);
  neck.position.y = 0.88;
  // Pan bowl, built flat then stood up so its face points forward when swung.
  const bowl = new THREE.Group();
  const shell = lathe([[0, 0], [0.5, 0], [0.56, 0.04], [0.6, 0.16], [0.56, 0.17], [0.52, 0.06], [0, 0.06]], iron, 36);
  const inner = cyl(0.51, 0.51, 0.02, mat('#9d9bbd', { roughness: 0.2, metalness: 0.6 }), 36);
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

let swirlTex = null;
function lollipopTexture() {
  if (swirlTex) return swirlTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, 256, 256);
  c.translate(128, 128);
  const colors = ['#ff6f9a', '#7cc8f0', '#ffcf5a', '#9b86e0'];
  for (let i = 0; i < 4; i++) {
    c.beginPath();
    for (let t = 0; t < 1; t += 0.01) {
      const a = t * Math.PI * 5 + (i * Math.PI) / 2;
      const r = t * 128;
      c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.lineWidth = 22;
    c.strokeStyle = colors[i];
    c.stroke();
  }
  swirlTex = new THREE.CanvasTexture(cv);
  swirlTex.colorSpace = THREE.SRGBColorSpace;
  return swirlTex;
}

function buildLollipop() {
  const g = new THREE.Group();
  const stick = cyl(0.06, 0.06, 1.75, mat('#fffaf2', { roughness: 0.6 }));
  stick.position.y = 0.6;
  const candyFace = new THREE.MeshPhysicalMaterial({ map: lollipopTexture(), roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.1 });
  const candySide = new THREE.MeshPhysicalMaterial({ color: '#ff8fb0', roughness: 0.2, clearcoat: 1 });
  const candy = mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.24, 40), [candySide, candyFace, candyFace]);
  candy.rotation.x = Math.PI / 2;
  candy.position.y = 1.68;
  const bow = new THREE.Group();
  const ribbon = mat('#7cc8f0', { roughness: 0.4 });
  for (const s of [-1, 1]) {
    const loop = mesh(new THREE.ConeGeometry(0.12, 0.26, 10), ribbon);
    loop.rotation.z = s * Math.PI / 2;
    loop.position.x = s * 0.13;
    bow.add(loop);
  }
  bow.add(mesh(new THREE.SphereGeometry(0.06, 10, 8), ribbon));
  bow.position.y = 0.98;
  g.add(stick, candy, bow);
  return g;
}

// Held by its feet; the floppy body hangs along the swing.
function buildChicken() {
  const g = new THREE.Group();
  const orange = mat('#ff9a3d', { roughness: 0.45 });
  const rubber = mat('#fff1b8', { roughness: 0.35 });
  for (const s of [-1, 1]) {
    const leg = cyl(0.035, 0.03, 0.4, orange);
    leg.position.set(s * 0.07, 0.05, 0);
    const toe = mesh(new THREE.ConeGeometry(0.07, 0.14, 6), orange);
    toe.position.set(s * 0.07, -0.18, 0);
    toe.rotation.x = Math.PI;
    g.add(leg, toe);
  }
  const body = mesh(new THREE.SphereGeometry(0.34, 22, 16), rubber);
  body.scale.set(0.9, 1.45, 0.85);
  body.position.y = 0.68;
  const wingL = mesh(new THREE.SphereGeometry(0.16, 12, 10), rubber);
  wingL.scale.set(0.4, 1.1, 0.8);
  const wingR = wingL.clone();
  wingL.position.set(-0.3, 0.72, 0);
  wingR.position.set(0.3, 0.72, 0);
  const neck = cyl(0.1, 0.14, 0.45, rubber);
  neck.position.y = 1.28;
  const head = mesh(new THREE.SphereGeometry(0.2, 18, 14), rubber);
  head.position.y = 1.58;
  const beak = mesh(new THREE.ConeGeometry(0.08, 0.22, 10), orange);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 1.56, 0.25);
  const comb = mat('#ff5a6e', { roughness: 0.4 });
  [[0, 1.8, 0.02, 0.08], [0, 1.77, -0.09, 0.065], [0, 1.77, 0.12, 0.065]].forEach(([x, y, z, r]) => {
    const c = mesh(new THREE.SphereGeometry(r, 10, 8), comb);
    c.position.set(x, y, z);
    g.add(c);
  });
  const wattle = mesh(new THREE.SphereGeometry(0.05, 8, 6), comb);
  wattle.position.set(0, 1.44, 0.18);
  const eyeMat = mat('#2e2438', { roughness: 0.2 });
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.035, 8, 6), eyeMat);
    eye.position.set(s * 0.12, 1.63, 0.14);
    g.add(eye);
  }
  g.add(body, wingL, wingR, neck, head, beak, wattle);
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

// Round cartoon bomb sitting on its base (origin at the bottom) with a curly fuse.
// The sticky version is translucent slime-green, softly glowing, with goo drips.
function buildBomb(sticky) {
  const g = new THREE.Group();
  const bodyMat = sticky
    ? mat('#6dff8e', { roughness: 0.25, emissive: '#2bff6a', emissiveIntensity: 0.45, transparent: true, opacity: 0.92 })
    : mat('#3b3552', { roughness: 0.3, metalness: 0.1, emissive: '#ff3b3b', emissiveIntensity: 0 });
  const body = mesh(new THREE.SphereGeometry(0.55, 22, 16), bodyMat);
  body.position.y = 0.55;
  const shine = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7 }));
  shine.position.set(-0.22, 0.82, 0.36);
  shine.scale.set(1, 1.4, 0.5);
  const cap = cyl(0.17, 0.21, 0.18, mat(sticky ? '#2f9e57' : '#9a94b4', { metalness: 0.4, roughness: 0.4 }), 12);
  cap.position.y = 1.12;
  g.add(body, shine, cap);
  if (sticky) {
    const goo = mat('#5cf07e', { roughness: 0.2, emissive: '#2bff6a', emissiveIntensity: 0.35 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const d = mesh(new THREE.SphereGeometry(0.1 + (i % 3) * 0.03, 8, 6), goo);
      d.position.set(Math.cos(a) * 0.5, 0.35 - (i % 2) * 0.15, Math.sin(a) * 0.5);
      d.scale.y = 1.6;
      g.add(d);
    }
  }
  const fuse = new THREE.Group();
  fuse.position.y = 1.2;
  const rope = cyl(0.04, 0.04, 0.4, mat('#e7c89b'), 6);
  rope.position.y = 0.2;
  fuse.add(rope);
  fuse.rotation.z = -0.35;
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffd15a' }));
  spark.position.y = 0.42;
  fuse.add(spark);
  g.add(fuse);
  g.userData = { bodyMat, fuse, rope, spark, sticky, glow: sticky ? 0.45 : 0 };
  return g;
}

// Lit bombs flicker their spark, burn the fuse down and flash faster as they near zero.
export function animateBomb(b, fuse, time) {
  const u = b.userData;
  if (!u || !u.fuse) return;
  const lit = fuse >= 0;
  u.spark.visible = lit;
  const left = lit ? Math.max(0.08, fuse / BOMB_FUSE) : 1;
  u.rope.scale.y = left;
  u.rope.position.y = 0.2 * left;
  u.spark.position.y = 0.42 * left;
  if (lit) u.spark.scale.setScalar(0.7 + Math.random() * 0.9);
  const rate = lit ? 3 + (1 - left) * 18 : 0;
  const flash = lit ? Math.max(0, Math.sin(time * rate)) : 0;
  u.bodyMat.emissiveIntensity = u.glow + flash * (u.sticky ? 0.5 : 0.7);
  if (lit && fuse < 1) b.scale.setScalar(1 + Math.sin(time * 40) * 0.05);
  else b.scale.setScalar(1);
}

const BUILDERS = {
  bat: buildBat, pan: buildPan, hammer: buildHammer, lollipop: buildLollipop, chicken: buildChicken, blaster: buildBlaster,
  bomb: () => buildBomb(false), sticky: () => buildBomb(true),
};

export function buildWeapon(type) {
  return (BUILDERS[type] || buildBat)();
}

const ringGeo = new THREE.RingGeometry(0.85, 1.0, 40);
const glowGeo = new THREE.CircleGeometry(0.85, 40);

// A weapon lying on the island with a glowing "pick me up" ring.
export function buildPickup(type) {
  const info = WEAPON_INFO[type] || WEAPON_INFO.bat;
  const root = new THREE.Group();
  const holder = new THREE.Group();
  const w = buildWeapon(type);
  if (!info.ranged && !info.bomb) {
    w.rotation.z = Math.PI / 2;
    w.position.x = info.len / 2;
  }
  holder.add(w);
  holder.position.y = info.bomb ? 0 : type === 'blaster' ? 0.1 : 0.28;
  const s = info.bomb ? 0.85 : Math.max(1, info.len / 1.7);
  const ringColor = info.sticky ? '#7dff9a' : info.bomb ? '#ffb38a' : '#fff3a0';
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
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
const shotMat = new THREE.MeshStandardMaterial({ color: '#ffa45c', emissive: '#ff8a3d', emissiveIntensity: 0.4, roughness: 0.6 });
export function buildShot() {
  const m = new THREE.Mesh(shotGeo, shotMat);
  m.castShadow = true;
  return m;
}
