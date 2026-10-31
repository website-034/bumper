import * as THREE from 'three';

// One pooled particle system for every little effect (dust, splashes, fire, stars, leaves...).
// Two draw calls total: soft "normal" particles and glowing additive ones.
export const SHAPE = { puff: 0, glow: 1, drop: 2, star: 3, chunk: 4, leaf: 5 };

const VERT = `
attribute vec3 color;
attribute float size;
attribute float alpha;
attribute float shape;
attribute float rot;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vRot;
void main() {
  vColor = color; vAlpha = alpha; vShape = shape; vRot = rot;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * uScale / max(0.1, -mv.z);
}`;

const FRAG = `
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vRot;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  float c = cos(vRot), s = sin(vRot);
  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  float r2 = dot(p, p);
  float a = 0.0;
  vec3 col = vColor;
  if (vShape < 0.5) {
    // Soft cartoon puff: a little lit sphere with a feathered edge.
    if (r2 > 1.0) discard;
    vec3 n = vec3(p, sqrt(1.0 - r2));
    float lit = 0.62 + 0.38 * max(0.0, dot(n, normalize(vec3(-0.4, 0.6, 0.7))));
    col *= lit;
    a = smoothstep(1.0, 0.75, r2);
  } else if (vShape < 1.5) {
    a = pow(max(0.0, 1.0 - sqrt(r2)), 2.0);
  } else if (vShape < 2.5) {
    // Droplet with a highlight.
    if (r2 > 1.0) discard;
    float hl = smoothstep(0.18, 0.0, length(p - vec2(-0.35, 0.35)));
    col = mix(col * (0.75 + 0.25 * sqrt(1.0 - r2)), vec3(1.0), hl);
    a = smoothstep(1.0, 0.85, r2);
  } else if (vShape < 3.5) {
    // Five-point star.
    float ang = atan(q.y, q.x);
    float rr = length(q);
    float k = 0.55 + 0.45 * pow(abs(cos(ang * 2.5)), 3.0);
    if (rr > k) discard;
    a = smoothstep(k, k - 0.15, rr);
  } else if (vShape < 4.5) {
    // Chunky bit (grass, debris): rotated square.
    if (max(abs(q.x), abs(q.y)) > 0.6) discard;
    col *= 0.8 + 0.2 * step(0.0, q.x + q.y);
    a = 1.0;
  } else {
    // Leaf: pointed ellipse with a centre vein.
    float e = (q.x * q.x) / 0.16 + (q.y * q.y) / 0.9;
    if (e > 1.0) discard;
    col *= 0.85 + 0.15 * smoothstep(0.0, 0.08, abs(q.x));
    a = 1.0;
  }
  gl_FragColor = vec4(col, a * vAlpha);
  #include <colorspace_fragment>
}`;

class Pool {
  constructor(cap, additive) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.shape = new Float32Array(cap);
    this.rot = new Float32Array(cap);
    this.p = [];
    const g = new THREE.BufferGeometry();
    const attr = (name, arr, k) => {
      const a = new THREE.BufferAttribute(arr, k);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.aPos = attr('position', this.pos, 3);
    this.aCol = attr('color', this.col, 3);
    this.aSize = attr('size', this.size, 1);
    this.aAlpha = attr('alpha', this.alpha, 1);
    this.aShape = attr('shape', this.shape, 1);
    this.aRot = attr('rot', this.rot, 1);
    g.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 500 } };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }
  emit(o) {
    if (this.p.length >= this.cap) this.p.shift();
    this.p.push(o);
  }
  update(dt) {
    let w = 0;
    const list = this.p;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      e.life -= dt;
      if (e.life <= 0) continue;
      if (e.drag) { const k = Math.exp(-e.drag * dt); e.vx *= k; e.vy *= k; e.vz *= k; }
      e.vy -= e.gravity * dt;
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      if (e.floor != null && e.y < e.floor) { e.y = e.floor; e.vy *= -0.3; e.vx *= 0.6; e.vz *= 0.6; }
      if (e.sway) { e.x += Math.sin(e.life * 5 + e.seed) * e.sway * dt; e.z += Math.cos(e.life * 4 + e.seed) * e.sway * dt; }
      e.r += e.spin * dt;
      const t = 1 - e.life / e.max;
      list[w] = e;
      this.pos[w * 3] = e.x; this.pos[w * 3 + 1] = e.y; this.pos[w * 3 + 2] = e.z;
      this.col[w * 3] = e.cr; this.col[w * 3 + 1] = e.cg; this.col[w * 3 + 2] = e.cb;
      this.size[w] = e.size * (1 + e.grow * t);
      this.alpha[w] = e.alpha * (e.fadeIn ? Math.min(1, t / e.fadeIn) : 1) * Math.min(1, (e.life / e.max) / e.fade);
      this.shape[w] = e.shape;
      this.rot[w] = e.r;
      w++;
    }
    list.length = w;
    this.n = w;
    this.points.geometry.setDrawRange(0, w);
    for (const a of [this.aPos, this.aCol, this.aSize, this.aAlpha, this.aShape, this.aRot]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, w * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

const _c = new THREE.Color();
export class Particles {
  constructor(scene, cap = 3000) {
    this.normal = new Pool(cap, false);
    this.glow = new Pool(Math.round(cap / 2), true);
    this.limit = 1;
    scene.add(this.normal.points, this.glow.points);
  }
  // Tier budget: 1 = everything, lower values thin out the purely decorative bits.
  setBudget(k) { this.limit = k; }
  setViewport(height, fov) {
    const s = height / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    this.normal.uniforms.uScale.value = this.glow.uniforms.uScale.value = s;
  }
  // color may be a hex string / number / THREE.Color; intensity > 1 makes it bloom.
  spawn({
    x, y, z, vx = 0, vy = 0, vz = 0, life = 0.6, size = 0.3, grow = 0, color = '#ffffff', intensity = 1,
    alpha = 1, gravity = 0, drag = 0, shape = SHAPE.puff, add = false, floor = null, spin = 0, sway = 0,
    fade = 0.4, fadeIn = 0, decor = false,
  }) {
    if (decor && Math.random() > this.limit) return;
    _c.set(color);
    (add ? this.glow : this.normal).emit({
      x, y, z, vx, vy, vz, life, max: life, size, grow, alpha, gravity, drag, shape, floor, spin, sway, fade, fadeIn,
      cr: _c.r * intensity, cg: _c.g * intensity, cb: _c.b * intensity, r: Math.random() * 6.28, seed: Math.random() * 6.28,
    });
  }
  update(dt) {
    this.normal.update(dt);
    this.glow.update(dt);
  }
}
