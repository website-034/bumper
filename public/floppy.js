import * as THREE from 'three';

// Visual-only secondary motion shared by every critter rig: spring chains for ears, tails and
// cloth, a lagging head, belly jiggle and a verlet ragdoll for
// knockouts, throws and falls. Nothing here feeds back into gameplay.
const H = 1 / 120; // fixed step so the springs behave the same at any frame rate
const MAX_STEPS = 6;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3(), _p = new THREE.Vector3(), _p2 = new THREE.Vector3();

// Natural frequency (stiff), springiness (damp, relative to the anchor) and air drag per kind of part.
export const FLOP = {
  ear: { stiff: 260, damp: 10, drag: 1.5, n: 3, maxBend: 1.0 },
  tail: { stiff: 150, damp: 7, drag: 1.5, n: 4, maxBend: 1.1 },
  cloth: { stiff: 90, damp: 6, drag: 3.5, n: 3, maxBend: 1.3 },
  bob: { stiff: 320, damp: 9, drag: 1, n: 2, maxBend: 0.8 },
};

// Re-parent obj under a pivot at `at` (parent space), so a chain can swing it without
// disturbing the rotation the recipe or its idle sway gives the object itself.
export function hinge(obj, at = obj.position) {
  const h = new THREE.Group();
  h.position.copy(at);
  obj.parent.add(h);
  obj.position.sub(h.position);
  h.add(obj);
  return h;
}

class Chain {
  constructor(h, dir, len, kind, rotate) {
    Object.assign(this, FLOP[kind]);
    this.h = h;
    this.dir = dir.clone().normalize();
    this.len = len;
    this.seg = len / (this.n - 1);
    this.rotate = rotate;
    this.cosMax = Math.cos(this.maxBend);
    this.sinMax = Math.sin(this.maxBend);
    this.p = Array.from({ length: this.n }, () => new THREE.Vector3());
    this.o = Array.from({ length: this.n }, () => new THREE.Vector3());
    this.anchor = new THREE.Vector3();
    this.sim = new THREE.Vector3();
    this.restW = new THREE.Vector3();
    this.tip = this.dir.clone();
    this.bend = new THREE.Vector3(); // how far the tip has swung from rest, in parent space
    this.ready = false;
    this.acc = 0;
  }

  rest() {
    this.ready = false;
    this.h.quaternion.identity();
    this.bend.set(0, 0, 0);
  }

  step(dt, slack) {
    const par = this.h.parent;
    par.updateWorldMatrix(true, false);
    const mw = par.matrixWorld;
    this.anchor.copy(this.h.position).applyMatrix4(mw);
    this.restW.copy(this.dir).transformDirection(mw);
    const n = this.n, seg = this.seg;
    if (!this.ready || this.anchor.distanceToSquared(this.sim) > 4) {
      for (let i = 0; i < n; i++) { this.p[i].copy(this.anchor).addScaledVector(this.restW, seg * i); this.o[i].copy(this.p[i]); }
      this.sim.copy(this.anchor);
      this.acc = 0;
      this.ready = true;
    }
    this.acc = Math.min(this.acc + dt, H * MAX_STEPS);
    const steps = Math.floor(this.acc / H);
    this.acc -= steps * H;
    const k = this.stiff * (1 - 0.8 * slack) * H * H;
    const g = 14 * slack * H * H;
    const keep = Math.exp(-this.damp * H), air = Math.exp(-this.drag * H);
    for (let s = 1; s <= steps; s++) {
      _a.lerpVectors(this.sim, this.anchor, s / steps);
      _b.subVectors(_a, this.p[0]); // the anchor's motion this substep
      this.p[0].copy(_a);
      this.o[0].copy(_a);
      for (let i = 1; i < n; i++) {
        const p = this.p[i], o = this.o[i];
        // Swinging relative to the anchor is damped (springiness); moving through the air drags.
        const vx = ((p.x - o.x - _b.x) * keep + _b.x) * air;
        const vy = ((p.y - o.y - _b.y) * keep + _b.y) * air;
        const vz = ((p.z - o.z - _b.z) * keep + _b.z) * air;
        o.copy(p);
        const r = seg * i;
        p.x += vx + (_a.x + this.restW.x * r - p.x) * k;
        p.y += vy + (_a.y + this.restW.y * r - p.y) * k - g;
        p.z += vz + (_a.z + this.restW.z * r - p.z) * k;
      }
      for (let i = 1; i < n; i++) {
        _c.subVectors(this.p[i], this.p[i - 1]);
        this.p[i].copy(this.p[i - 1]).addScaledVector(_c, seg / (_c.length() || 1e-6));
        // Never bend further than maxBend (radians) from the rest line.
        _c.subVectors(this.p[i], _a);
        const dist = _c.length() || 1e-6;
        _c.divideScalar(dist);
        const cos = _c.dot(this.restW);
        if (cos < this.cosMax) {
          _d.copy(_c).addScaledVector(this.restW, -cos);
          const perp = _d.length();
          if (perp > 1e-5) _d.divideScalar(perp); else _d.set(1, 0, 0);
          this.p[i].copy(_a).addScaledVector(this.restW, this.cosMax * dist).addScaledVector(_d, this.sinMax * dist);
        }
      }
    }
    if (steps) this.sim.copy(this.anchor);

    _m.copy(mw).invert();
    this.tip.copy(this.p[n - 1]).applyMatrix4(_m).sub(this.h.position).normalize();
    this.bend.subVectors(this.tip, this.dir);
    if (this.rotate) this.h.quaternion.setFromUnitVectors(this.dir, this.tip);
  }
}

// ---------- Ragdoll ----------
// Ten points: pelvis, shoulders, head, elbows, paws and feet. The pelvis is pinned to the
// server position; everything else hangs off it with distance constraints and joint limits.
const P = 0, SL = 1, SR = 2, HD = 3, EL = 4, PL = 5, ER = 6, PR = 7, FL = 8, FR = 9;
const RADII = [0.42, 0.3, 0.3, 0.55, 0.1, 0.14, 0.1, 0.14, 0.12, 0.12];
const GRAVITY = 22;
const ITER = 4;

function torsoQuat(pts, out) {
  _p.addVectors(pts[SL], pts[SR]).multiplyScalar(0.5).sub(pts[P]).normalize(); // up
  _p2.subVectors(pts[SR], pts[SL]);
  _p2.addScaledVector(_p, -_p2.dot(_p)).normalize(); // right
  _d.crossVectors(_p2, _p); // forward
  _m3.makeBasis(_p2, _p, _d);
  return out.setFromRotationMatrix(_m3);
}

export class Ragdoll {
  constructor(rig) {
    const sh = rig.shoulders, arm = rig.restArm;
    const elbow = (i, s) => new THREE.Vector3().addVectors(sh[i], arm[i]).multiplyScalar(0.5).add(new THREE.Vector3(s * 0.08, 0.04, 0));
    this.rest = [
      new THREE.Vector3(0, 0.62, 0), sh[0].clone(), sh[1].clone(), rig.head.position.clone(),
      elbow(0, -1), arm[0].clone(), elbow(1, 1), arm[1].clone(),
      rig.footRest[0].clone(), rig.footRest[1].clone(),
    ];
    this.p = this.rest.map((v) => v.clone());
    this.o = this.rest.map((v) => v.clone());
    this.cons = [];
    const d = (a, b) => this.rest[a].distanceTo(this.rest[b]);
    const add = (a, b, min, max, st = 1) => this.cons.push([a, b, min, max, st]);
    const fix = (a, b, st = 1) => { const l = d(a, b); add(a, b, l, l, st); };
    fix(P, SL); fix(P, SR); fix(SL, SR);
    fix(HD, SL, 0.3); fix(HD, SR, 0.3); fix(HD, P, 0.3); // wobbly neck
    fix(SL, EL); fix(EL, PL); fix(SR, ER); fix(ER, PR);
    add(SL, PL, d(SL, PL) * 0.55, Infinity); add(SR, PR, d(SR, PR) * 0.55, Infinity); // elbows never fold flat
    add(PL, P, 0.5, Infinity); add(PR, P, 0.5, Infinity); // paws stay outside the tummy
    add(PL, HD, 0.6, Infinity); add(PR, HD, 0.6, Infinity);
    const leg = d(P, FL);
    add(P, FL, leg * 0.65, leg * 1.05); add(P, FR, leg * 0.65, leg * 1.05);
    add(FL, FR, 0.3, Infinity);
    add(FL, SL, d(FL, SL) * 0.75, Infinity); add(FR, SR, d(FR, SR) * 0.75, Infinity); // knees don't fold up past the chest
    this.q0inv = torsoQuat(this.rest, new THREE.Quaternion()).invert();
    this.neckRest = new THREE.Vector3().addVectors(this.rest[SL], this.rest[SR]).multiplyScalar(0.5).negate().add(this.rest[HD]).normalize();
    this.pin = new THREE.Vector3();
    this.acc = 0;
    this.flailT = 0;
  }

  // Start from the pose currently on screen, moving at vel and spinning at spin (rad/s, world).
  start(rig, vel, spin) {
    rig.pivot.updateWorldMatrix(true, false);
    const pw = rig.pivot.matrixWorld, rw = rig.root.matrixWorld;
    for (let i = 0; i < 10; i++) {
      if (i === FL || i === FR) this.p[i].copy((i === FL ? rig.footL : rig.footR).position).applyMatrix4(rw);
      else if (i === PL || i === PR) this.p[i].copy((i === PL ? rig.armL : rig.armR).position).applyMatrix4(pw);
      else this.p[i].copy(this.rest[i]).applyMatrix4(pw);
    }
    for (const [e, sh, paw, s] of [[EL, SL, PL, -1], [ER, SR, PR, 1]]) {
      this.p[e].addVectors(this.p[sh], this.p[paw]).multiplyScalar(0.5);
      _a.set(s * 0.08, 0.04, 0).transformDirection(pw);
      this.p[e].addScaledVector(_a, 0.09);
    }
    this.pin.copy(this.p[P]);
    for (let i = 0; i < 10; i++) {
      _a.subVectors(this.p[i], this.p[P]);
      _b.crossVectors(spin, _a).add(vel);
      this.o[i].copy(this.p[i]).addScaledVector(_b, -H);
    }
    this.acc = 0;
  }

  // target: where the pelvis must be (server position). ground: floor height, or -Infinity.
  step(dt, target, ground, flail, twitch) {
    this.acc = Math.min(this.acc + dt, H * MAX_STEPS);
    const steps = Math.floor(this.acc / H);
    this.acc -= steps * H;
    const g = GRAVITY * H * H, air = Math.exp(-0.6 * H);
    this.flailT -= dt;
    const kickNow = (flail || twitch) && this.flailT <= 0;
    if (kickNow) this.flailT = flail ? 0.09 + Math.random() * 0.06 : 0.6 + Math.random() * 1.4;
    for (let s = 1; s <= steps; s++) {
      _a.lerpVectors(this.pin, target, s / steps);
      this.p[P].copy(_a);
      this.o[P].copy(_a);
      for (let i = 1; i < 10; i++) {
        const p = this.p[i], o = this.o[i];
        const vx = (p.x - o.x) * air, vy = (p.y - o.y) * air, vz = (p.z - o.z) * air;
        o.copy(p);
        p.x += vx; p.y += vy - g; p.z += vz;
      }
      if (kickNow && s === 1) {
        // Flailing: random shoves on the paws and feet (velocity change of a few m/s).
        const parts = flail ? [PL, PR, FL, FR, EL, ER] : [Math.random() < 0.5 ? FL : FR];
        for (const i of parts) {
          const k = (flail ? 5 : 3.5) * H;
          this.o[i].x -= (Math.random() - 0.5) * 2 * k;
          this.o[i].y -= (flail ? (Math.random() - 0.3) : 1) * k;
          this.o[i].z -= (Math.random() - 0.5) * 2 * k;
        }
      }
      for (let it = 0; it < ITER; it++) {
        for (const [a, b, min, max, st] of this.cons) {
          const pa = this.p[a], pb = this.p[b];
          _c.subVectors(pb, pa);
          const len = _c.length() || 1e-6;
          const want = len < min ? min : len > max ? max : len;
          if (want === len) continue;
          const diff = ((len - want) / len) * st;
          if (a === P) pb.addScaledVector(_c, -diff);
          else if (b === P) pa.addScaledVector(_c, diff);
          else { pa.addScaledVector(_c, diff * 0.5); pb.addScaledVector(_c, -diff * 0.5); }
        }
        for (let i = 1; i < 10; i++) {
          const p = this.p[i], floor = ground + RADII[i];
          if (p.y < floor) {
            const o = this.o[i];
            const vy = p.y - o.y;
            p.y = floor;
            o.y = p.y + vy * 0.3; // small bounce
            o.x += (p.x - o.x) * 0.35; // ground friction
            o.z += (p.z - o.z) * 0.35;
          }
        }
      }
    }
    if (steps) this.pin.copy(target);
  }

  // Pivot orientation and position (world) implied by the torso points.
  frame(outQ, outPos) {
    torsoQuat(this.p, outQ).multiply(this.q0inv);
    outPos.copy(this.rest[P]).applyQuaternion(outQ).negate().add(this.p[P]);
  }
}

const _rq = new THREE.Quaternion(), _rp = new THREE.Vector3();
const _ap = new THREE.Vector3(), _aq = new THREE.Quaternion(), _as = new THREE.Vector3();
const _rootInv = new THREE.Matrix4(), _pivInv = new THREE.Matrix4(), _animPiv = new THREE.Matrix4(), _bPiv = new THREE.Matrix4();

// Blend the rig from its animated pose (already set) toward the ragdoll pose by w (0..1).
export function poseRagdoll(rig, rd, w) {
  const { root, pivot, head } = rig;
  root.updateWorldMatrix(true, false);
  pivot.updateMatrix();
  _animPiv.multiplyMatrices(root.matrixWorld, pivot.matrix);
  _animPiv.decompose(_ap, _aq, _as);
  rd.frame(_rq, _rp);
  _ap.lerp(_rp, w);
  _aq.slerp(_rq, w);
  _bPiv.compose(_ap, _aq, _as);
  _rootInv.copy(root.matrixWorld).invert();
  _m2.multiplyMatrices(_rootInv, _bPiv).decompose(pivot.position, pivot.quaternion, pivot.scale);
  _pivInv.copy(_bPiv).invert();
  for (const [paw, i] of [[rig.armL, PL], [rig.armR, PR]]) {
    _a.copy(paw.position).applyMatrix4(_animPiv).lerp(rd.p[i], w);
    paw.position.copy(_a.applyMatrix4(_pivInv));
  }
  for (const [foot, i] of [[rig.footL, FL], [rig.footR, FR]]) {
    _a.copy(foot.position).applyMatrix4(root.matrixWorld).lerp(rd.p[i], w);
    foot.position.copy(_a.applyMatrix4(_rootInv));
  }
  // Head nods along the neck direction relative to the torso.
  _a.addVectors(rd.p[SL], rd.p[SR]).multiplyScalar(0.5);
  _b.subVectors(rd.p[HD], _a).applyQuaternion(_q.copy(_rq).invert()).normalize();
  _q2.setFromUnitVectors(rd.neckRest, _b);
  head.quaternion.slerp(_q2, w);
}

// World position of the ragdoll's head (for stars and labels).
export function ragdollHead(rd, out) { return out.copy(rd.p[HD]); }

// ---------- Per-rig secondary motion ----------
export function makeFloppy(rig, { body, headFur, flops = [] }) {
  const chains = flops.map(({ obj, dir, len, kind = 'ear', at, rotate = true }) => {
    const h = hinge(obj, at);
    const c = new Chain(h, dir, len, kind, rotate);
    obj.userData.chain = c;
    return c;
  });
  const bodyScale = body.scale.clone();
  const headScale = headFur ? headFur.scale.clone() : null;
  const head = rig.head;
  const fl = {
    chains,
    hx: 0, hz: 0, hvx: 0, hvz: 0, tx: 0, tz: 0,
    extra: new THREE.Vector3(),
    j: 0, jv: 0,
    active: true,
    setJelly(ox, oz) { fl.tx = oz * 1.1; fl.tz = -ox * 1.1; },
    kickHead(x, z) { fl.hvx += x; fl.hvz += z; },
    jiggle(a) { fl.jv -= 9 * a; },
    // dt, slack (0 standing .. 1 limp), full: low-tier cutoff
    update(dt, slack, full) {
      // Head follows the body's wobble a beat late, with a little overshoot.
      fl.hvx += ((fl.tx - fl.hx) * 110 - fl.hvx * 9) * dt;
      fl.hvz += ((fl.tz - fl.hz) * 110 - fl.hvz * 9) * dt;
      fl.hx += fl.hvx * dt;
      fl.hz += fl.hvz * dt;
      head.rotation.set(fl.hx + fl.extra.x, fl.extra.y, fl.hz + fl.extra.z);
      fl.extra.set(0, 0, 0);

      fl.jv += (-fl.j * 280 - fl.jv * 7) * dt;
      fl.j += fl.jv * dt;
      const j = Math.max(-0.6, Math.min(0.6, fl.j));
      body.scale.set(bodyScale.x * (1 - j * 0.12), bodyScale.y * (1 + j * 0.15), bodyScale.z * (1 - j * 0.12));
      if (headFur) headFur.scale.set(headScale.x * (1 - j * 0.06), headScale.y * (1 + j * 0.03), headScale.z);
      fl.slack = slack;
      fl.full = full;
    },
    // After the final pose (including ragdoll) is set, so the chains read the real anchors.
    stepChains(dt) {
      if (!fl.full) {
        if (fl.active) { for (const c of chains) c.rest(); fl.active = false; }
        return;
      }
      fl.active = true;
      for (const c of chains) c.step(dt, fl.slack || 0);
    },
  };
  return fl;
}
