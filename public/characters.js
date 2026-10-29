import * as THREE from 'three';

export const ANIMALS = {
  bear:    { label: 'Bear',    color: '#e0b48a', belly: '#f8e4cf', iris: '#7a4a2a' },
  cat:     { label: 'Cat',     color: '#ffbf98', belly: '#fff0e4', iris: '#3f9b6b' },
  bunny:   { label: 'Bunny',   color: '#ffd9ea', belly: '#ffffff', iris: '#c0507a' },
  duck:    { label: 'Duck',    color: '#ffe680', belly: '#fff8d0', iris: '#3a5a9a' },
  frog:    { label: 'Frog',    color: '#9fe39a', belly: '#e9fad4', iris: '#c99a1a' },
  pig:     { label: 'Pig',     color: '#ffb3c6', belly: '#ffe0e8', iris: '#7a3a5a' },
  penguin: { label: 'Penguin', color: '#8fa2d8', belly: '#ffffff', iris: '#2a3a6a' },
  fox:     { label: 'Fox',     color: '#ffa572', belly: '#fff3e8', iris: '#a0601a' },
};

const BODY_Y = 0.35; // lifts the body so the legs show underneath
const BODY_R = 0.85;

const geoCache = new Map();
function geo(key, make) {
  if (!geoCache.has(key)) geoCache.set(key, make());
  return geoCache.get(key);
}
const sphere = (r = 1, w = 24, h = 16) => geo(`s${r}-${w}`, () => new THREE.SphereGeometry(r, w, h));
const limbGeo = geo('limb', () => {
  const g = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  g.translate(0, 0.5, 0);
  return g;
});

const matCache = new Map();
function cached(key, make) {
  if (!matCache.has(key)) matCache.set(key, make());
  return matCache.get(key);
}
function jelly(color, { transmission = 0.75, thickness = 0.9 } = {}) {
  return cached(`j${color}${transmission}`, () => {
    const c = new THREE.Color(color);
    return new THREE.MeshPhysicalMaterial({
      color: c,
      emissive: c,
      emissiveIntensity: 0.16,
      roughness: 0.15,
      metalness: 0,
      transmission,
      thickness,
      ior: 1.3,
      attenuationColor: c,
      attenuationDistance: 3.5,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      sheen: 0.4,
      sheenColor: c.clone().lerp(new THREE.Color('#ffffff'), 0.7),
    });
  });
}
function plain(color, opts = {}) {
  return cached(`p${color}${JSON.stringify(opts)}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.35, ...opts }));
}
function glossy(color) {
  return cached(`g${color}`, () => new THREE.MeshPhysicalMaterial({ color, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }));
}

function mesh(geometry, material, pos = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0]) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(...pos);
  m.scale.set(...scale);
  m.rotation.set(...rot);
  m.castShadow = true;
  return m;
}

function pairX(build) {
  return [build(-1), build(1)];
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
function stretchLimb(limb, from, to, radius) {
  tmpDir.subVectors(to, from);
  const len = Math.max(0.001, tmpDir.length());
  limb.position.copy(from);
  limb.quaternion.setFromUnitVectors(UP, tmpDir.divideScalar(len));
  limb.scale.set(radius, len, radius);
}

// Dizzy stars that circle a knocked-out character's head.
export function makeStars() {
  const stars = new THREE.Group();
  stars.position.set(0, 2.6, 0);
  const starMat = plain('#ffe066', { emissive: '#ffcc33', emissiveIntensity: 0.6 });
  for (let i = 0; i < 4; i++) {
    const st = mesh(geo('star', () => new THREE.OctahedronGeometry(0.13)), starMat);
    const a = (i / 4) * Math.PI * 2;
    st.position.set(Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6);
    stars.add(st);
  }
  stars.visible = false;
  return stars;
}

export function buildCritter(animal) {
  const def = ANIMALS[animal] || ANIMALS.bear;
  const body = jelly(def.color);
  const solidBody = jelly(def.color, { transmission: 0.25, thickness: 0.6 });
  const belly = jelly(def.belly, { transmission: 0.3, thickness: 0.5 });
  const core = plain(new THREE.Color(def.color).multiplyScalar(0.72).getStyle(), { roughness: 0.6 });
  const bubble = plain('#ffffff', { transparent: true, opacity: 0.7, roughness: 0.05 });
  const dark = glossy('#2e2238');
  const white = glossy('#ffffff');
  const iris = glossy(def.iris);
  const pink = plain('#ff8fab', { roughness: 0.6 });
  const orange = jelly('#ffa94d', { transmission: 0.25, thickness: 0.5 });

  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.add(pivot);
  const head = new THREE.Group();
  head.position.y = BODY_Y;
  pivot.add(head);

  // Jelly body with its own geometry so it can wobble independently.
  const bodyGeo = new THREE.SphereGeometry(BODY_R, 48, 36);
  const basePos = Float32Array.from(bodyGeo.attributes.position.array);
  const bodyMesh = mesh(bodyGeo, body, [0, 0.95, 0], [1, 1.05, 0.95]);
  head.add(bodyMesh);

  // Visible insides: a soft core and a few trapped bubbles.
  head.add(mesh(sphere(0.42), core, [0, 0.82, -0.05], [1, 1.1, 0.9]));
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.25 + Math.random() * 0.35;
    const b = mesh(sphere(0.035 + Math.random() * 0.05, 10, 8), bubble, [Math.cos(a) * r, 0.55 + Math.random() * 0.7, Math.sin(a) * r * 0.7]);
    b.castShadow = false;
    head.add(b);
  }

  if (animal === 'penguin') head.add(mesh(sphere(0.7), belly, [0, 0.92, 0.32], [1, 1.12, 0.66]));
  else head.add(mesh(sphere(0.5), belly, [0, 0.66, 0.5], [1, 1.05, 0.55]));

  // ---- Face ----
  const face = new THREE.Group();
  head.add(face);
  const eyes = [];
  const brows = [];
  const makeEye = (x, y, z, size = 1) => {
    const eye = new THREE.Group();
    eye.position.set(x, y, z);
    eye.add(mesh(sphere(0.16), white, [0, 0, 0], [size, size * 1.1, size * 0.55]));
    eye.add(mesh(sphere(0.1), iris, [0, -0.01, 0.06 * size], [size, size * 1.1, size * 0.5]));
    eye.add(mesh(sphere(0.055), dark, [0, -0.01, 0.1 * size], [size, size * 1.1, size * 0.5]));
    eye.add(mesh(sphere(0.03), white, [0.04 * size, 0.05 * size, 0.13 * size]));
    eye.add(mesh(sphere(0.015), white, [-0.035 * size, -0.04 * size, 0.13 * size]));
    face.add(eye);
    eyes.push(eye);
    return eye;
  };

  if (animal === 'frog') {
    pairX((s) => {
      head.add(mesh(sphere(0.27), body, [s * 0.34, 1.72, 0.3]));
      makeEye(s * 0.34, 1.76, 0.5, 1.3);
    });
  } else {
    pairX((s) => {
      const eye = makeEye(s * 0.29, 1.22, 0.79, 1.15);
      eye.rotation.y = s * 0.3;
    });
  }
  pairX((s) => {
    const brow = mesh(geo('brow', () => new THREE.CapsuleGeometry(0.03, 0.14, 4, 8)), dark, [s * 0.29, animal === 'frog' ? 2.03 : 1.48, animal === 'frog' ? 0.52 : 0.72], [1, 1, 1], [0, 0, Math.PI / 2]);
    brow.userData.side = s;
    face.add(brow);
    brows.push(brow);
  });
  pairX((s) => face.add(mesh(sphere(0.11), plain('#ff8fab', { transparent: true, opacity: 0.5 }), [s * 0.52, 1.0, 0.65], [1, 0.6, 0.3])));

  const smile = mesh(geo('smile', () => new THREE.TorusGeometry(0.075, 0.02, 6, 14, Math.PI)), dark, [0, 1.02, 0.84], [1, 1, 1], [0, 0, Math.PI]);
  const openMouth = new THREE.Group();
  openMouth.position.set(0, 0.98, 0.82);
  openMouth.add(mesh(sphere(0.1), dark, [0, 0, 0], [1, 1.2, 0.4]));
  openMouth.add(mesh(sphere(0.06), pink, [0, -0.05, 0.03], [1.1, 0.6, 0.5]));
  openMouth.visible = false;
  face.add(smile, openMouth);

  switch (animal) {
    case 'bear':
      pairX((s) => {
        head.add(mesh(sphere(0.25), body, [s * 0.52, 1.74, -0.05]));
        head.add(mesh(sphere(0.13), pink, [s * 0.52, 1.74, 0.1], [1, 1, 0.4]));
      });
      face.add(mesh(sphere(0.22), belly, [0, 0.97, 0.79], [1.25, 0.8, 0.55]));
      face.add(mesh(sphere(0.07), dark, [0, 1.05, 0.93], [1.3, 0.9, 1]));
      smile.position.set(0, 0.93, 0.92);
      smile.scale.setScalar(0.7);
      head.add(mesh(sphere(0.17), body, [0, 0.55, -0.82]));
      break;
    case 'cat': {
      pairX((s) => {
        head.add(mesh(geo('catEar', () => new THREE.ConeGeometry(0.24, 0.46, 12)), body, [s * 0.43, 1.84, 0], [1, 1, 0.6], [0, 0, -s * 0.3]));
        head.add(mesh(geo('catEarIn', () => new THREE.ConeGeometry(0.13, 0.28, 10)), pink, [s * 0.43, 1.8, 0.08], [1, 1, 0.35], [0, 0, -s * 0.3]));
      });
      face.add(mesh(sphere(0.05), pink, [0, 1.09, 0.86], [1.3, 1, 1]));
      pairX((s) => [0.04, -0.04].forEach((dy) => face.add(mesh(geo('whisk', () => new THREE.CylinderGeometry(0.008, 0.008, 0.32, 4)), dark, [s * 0.55, 1.06 + dy, 0.72], [1, 1, 1], [0, 0, Math.PI / 2 + s * dy * 4]))));
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0.5, -0.75), new THREE.Vector3(0, 0.55, -1.15),
        new THREE.Vector3(0, 1.0, -1.35), new THREE.Vector3(0.15, 1.35, -1.2),
      ]);
      head.add(mesh(geo('catTail', () => new THREE.TubeGeometry(curve, 24, 0.1, 10)), body));
      break;
    }
    case 'bunny':
      pairX((s) => {
        head.add(mesh(geo('bunEar', () => new THREE.CapsuleGeometry(0.15, 0.7, 8, 14)), body, [s * 0.26, 2.12, -0.08], [1, 1, 0.7], [0, 0, -s * 0.15]));
        head.add(mesh(geo('bunEarIn', () => new THREE.CapsuleGeometry(0.08, 0.55, 6, 10)), pink, [s * 0.26, 2.12, 0.03], [1, 1, 0.35], [0, 0, -s * 0.15]));
      });
      face.add(mesh(sphere(0.055), pink, [0, 1.08, 0.86], [1.3, 1, 1]));
      face.add(mesh(geo('tooth', () => new THREE.BoxGeometry(0.1, 0.09, 0.04)), white, [0, 0.93, 0.84]));
      head.add(mesh(sphere(0.25), belly, [0, 0.5, -0.82]));
      break;
    case 'duck':
      face.add(mesh(sphere(0.28), orange, [0, 1.02, 0.84], [1.3, 0.36, 1.05]));
      smile.visible = false;
      [-0.12, 0, 0.12].forEach((x, i) => head.add(mesh(sphere(0.1), body, [x, 1.95 + (i === 1 ? 0.06 : 0), 0.05], [0.8, 1.4, 0.8], [0, 0, -x * 3])));
      head.add(mesh(geo('duckTail', () => new THREE.ConeGeometry(0.2, 0.4, 12)), body, [0, 0.7, -0.88], [1, 1, 0.6], [-2.1, 0, 0]));
      break;
    case 'frog':
      smile.scale.set(2.6, 1.6, 1);
      smile.position.set(0, 1.12, 0.78);
      break;
    case 'pig':
      pairX((s) => head.add(mesh(geo('pigEar', () => new THREE.ConeGeometry(0.21, 0.32, 10)), body, [s * 0.46, 1.8, 0.1], [1, 1, 0.45], [0.5, 0, -s * 0.6])));
      face.add(mesh(geo('snout', () => new THREE.CylinderGeometry(0.2, 0.22, 0.14, 24)), jelly('#ff9fb8', { transmission: 0.2 }), [0, 1.02, 0.86], [1.15, 1, 0.85], [Math.PI / 2, 0, 0]));
      pairX((s) => face.add(mesh(sphere(0.04), plain('#c25a78'), [s * 0.07, 1.02, 0.94], [1, 1.3, 0.5])));
      smile.position.y = 0.86;
      head.add(mesh(geo('pigTail', () => new THREE.TorusGeometry(0.1, 0.035, 6, 16, Math.PI * 1.6)), body, [0, 0.7, -0.86], [1, 1, 1], [0, Math.PI / 2, 0]));
      break;
    case 'penguin':
      face.add(mesh(geo('pengBeak', () => new THREE.ConeGeometry(0.11, 0.3, 14)), orange, [0, 1.05, 0.92], [1.2, 1, 0.7], [Math.PI / 2, 0, 0]));
      smile.visible = false;
      head.add(mesh(sphere(0.14), body, [0, 1.9, 0.0], [1.2, 0.5, 1.4]));
      break;
    case 'fox':
      pairX((s) => {
        head.add(mesh(geo('foxEar', () => new THREE.ConeGeometry(0.25, 0.6, 12)), body, [s * 0.43, 1.9, -0.02], [1, 1, 0.55], [0, 0, -s * 0.25]));
        head.add(mesh(geo('foxTip', () => new THREE.ConeGeometry(0.1, 0.2, 10)), dark, [s * 0.43 + s * 0.065, 2.13, -0.02], [1, 1, 0.55], [0, 0, -s * 0.25]));
      });
      pairX((s) => face.add(mesh(sphere(0.22), belly, [s * 0.32, 0.95, 0.66], [1, 0.8, 0.45])));
      face.add(mesh(sphere(0.07), dark, [0, 1.06, 0.88], [1.2, 0.9, 1]));
      head.add(mesh(sphere(0.38), body, [0, 0.62, -1.05], [0.75, 0.75, 1.35], [-0.6, 0, 0]));
      head.add(mesh(sphere(0.2), belly, [0, 0.95, -1.48], [1, 1, 1.1]));
      break;
  }

  // ---- Noodle arms with mitten hands ----
  // Ears, tufts and other bits on top ride along with the wobbling jelly.
  const toppers = head.children
    .filter((o) => o !== bodyMesh && o.position.y > 1.4)
    .map((o) => ({ o, base: o.position.clone(), lag: Math.min(1.3, ((o.position.y - 0.95 + BODY_R) / (2 * BODY_R)) ** 2) }));

  const handMat = solidBody;
  const limbMat = solidBody;
  const shoulders = [new THREE.Vector3(-0.66, 1.28, 0.05), new THREE.Vector3(0.66, 1.28, 0.05)];
  const arms = pairX((s) => {
    const hand = new THREE.Group();
    hand.add(mesh(sphere(0.2), handMat, [0, 0, 0], [1, 0.9, 1.1]));
    hand.add(mesh(sphere(0.085), handMat, [-s * 0.15, 0.06, 0.1]));
    pivot.add(hand);
    return hand;
  });
  const armLimbs = pairX(() => {
    const l = mesh(limbGeo, limbMat);
    pivot.add(l);
    return l;
  });

  // ---- Stubby legs with round feet ----
  const feetMat = animal === 'duck' || animal === 'penguin' ? orange : solidBody;
  const feet = pairX((s) => {
    const foot = new THREE.Group();
    foot.position.set(s * 0.34, 0.13, 0.08);
    foot.add(mesh(sphere(0.24), feetMat, [0, 0, 0.06], [1, 0.55, 1.4]));
    foot.add(mesh(sphere(0.08), feetMat, [0, 0.03, 0.32], [1, 0.6, 0.8]));
    root.add(foot);
    return foot;
  });
  const legLimbs = pairX(() => {
    const l = mesh(limbGeo, limbMat);
    root.add(l);
    return l;
  });
  const hips = [new THREE.Vector3(-0.32, 0.7, 0.02), new THREE.Vector3(0.32, 0.7, 0.02)];

  const stars = makeStars();
  root.add(stars);

  const tmpHip = new THREE.Vector3();
  const pos = bodyGeo.attributes.position;
  let jellyActive = true;

  return {
    root,
    pivot,
    face,
    eyes,
    brows,
    smile,
    smileDefault: smile.visible,
    openMouth,
    armL: arms[0],
    armR: arms[1],
    footL: feet[0],
    footR: feet[1],
    stars,
    restArm: [new THREE.Vector3(-1.0, 0.95, 0.18), new THREE.Vector3(1.0, 0.95, 0.18)],

    updateLimbs(bounce) {
      for (let i = 0; i < 2; i++) {
        stretchLimb(armLimbs[i], shoulders[i], arms[i].position, 0.1);
        tmpHip.copy(hips[i]);
        tmpHip.y += bounce;
        stretchLimb(legLimbs[i], tmpHip, feet[i].position, 0.11);
      }
    },

    // Shear the top of the body by (ox, oz) and add a ripple; all in body-local units.
    updateJelly(ox, oz, ripple, t) {
      const active = Math.abs(ox) + Math.abs(oz) + Math.abs(ripple) > 0.002;
      if (!active && !jellyActive) return;
      jellyActive = active;
      const arr = pos.array;
      for (let i = 0; i < arr.length; i += 3) {
        const bx = basePos[i], by = basePos[i + 1], bz = basePos[i + 2];
        const h = (by + BODY_R) / (2 * BODY_R);
        const lag = h * h;
        const wave = 1 + ripple * Math.sin(by * 7 - t * 22) * 0.07;
        arr[i] = bx * wave + ox * lag;
        arr[i + 1] = by;
        arr[i + 2] = bz * wave + oz * lag;
      }
      pos.needsUpdate = true;
      bodyGeo.computeVertexNormals();
      face.position.set(ox * 0.75, 0, oz * 0.75);
      for (const tp of toppers) tp.o.position.set(tp.base.x + ox * tp.lag, tp.base.y, tp.base.z + oz * tp.lag);
    },
  };
}
