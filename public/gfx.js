import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

// Visual-only rendering helpers. Nothing here feeds back into gameplay.

// Shell-fur layers live on this layer so the AO pass can skip them (it sees the smooth body hull).
export const FUR_LAYER = 1;

// ---------- Moods: sunny day, then sunset once the island starts shrinking ----------
const hex = (h) => new THREE.Color(h);
export const MOODS = {
  day: {
    top: hex('#8fcaff'), mid: hex('#e6dcff'), bottom: hex('#ffe8f1'), cloud: hex('#ffffff'), cloudShade: hex('#d9d2f2'),
    sun: hex('#fff1dc'), sunI: 2.6, hemiSky: hex('#dcebff'), hemiGround: hex('#ffd9e6'), hemiI: 0.75,
    fog: hex('#f1e4ff'), cloudGlow: hex('#fff4fb'), env: 0.55,
  },
  dusk: {
    top: hex('#6f7fd6'), mid: hex('#ffb59a'), bottom: hex('#ff9fb4'), cloud: hex('#ffd2b8'), cloudShade: hex('#b58fc4'),
    sun: hex('#ffb07a'), sunI: 2.2, hemiSky: hex('#ffc4b0'), hemiGround: hex('#a98ad6'), hemiI: 0.7,
    fog: hex('#ffcfc0'), cloudGlow: hex('#ffd0c4'), env: 0.45,
  },
};
export function mixMood(k, out = {}) {
  const a = MOODS.day, b = MOODS.dusk;
  for (const key of Object.keys(a)) {
    if (a[key].isColor) (out[key] ||= new THREE.Color()).copy(a[key]).lerp(b[key], k);
    else out[key] = a[key] + (b[key] - a[key]) * k;
  }
  return out;
}

// ---------- Image-based lighting: a small sunny sky rendered into a prefiltered env map ----------
export function makeEnvironment(renderer, mood, sunDir) {
  const envScene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: mood.top }, mid: { value: mood.mid }, ground: { value: mood.hemiGround.clone().multiplyScalar(0.55).lerp(new THREE.Color('#8fcf7a'), 0.5) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top, mid, ground; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.7, h)) : mix(mid, ground, smoothstep(0.0, 0.25, -h));
      gl_FragColor = vec4(c * 1.1, 1.0); }`,
  }));
  envScene.add(dome);
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 8), new THREE.MeshBasicMaterial({ color: mood.sun.clone().multiplyScalar(40) }));
  sunBall.position.copy(sunDir).multiplyScalar(8);
  envScene.add(sunBall);
  // A couple of soft bright clouds give the glossy bits something to reflect.
  for (const [x, y, z, s] of [[-6, 3, -5, 1.8], [5, 2.2, -6, 1.5], [-4, 1.5, 6, 1.4]]) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(s, 12, 8), new THREE.MeshBasicMaterial({ color: mood.cloud.clone().multiplyScalar(1.6) }));
    c.position.set(x, y, z);
    c.scale.y = 0.5;
    envScene.add(c);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.035);
  pmrem.dispose();
  envScene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return rt;
}

// ---------- Sky dome: gradient, sun glow and drifting soft clouds ----------
export function makeSky(mood) {
  const uniforms = {
    top: { value: mood.top.clone() }, mid: { value: mood.mid.clone() }, bottom: { value: mood.bottom.clone() },
    cloud: { value: mood.cloud.clone() }, cloudShade: { value: mood.cloudShade.clone() }, sunCol: { value: mood.sun.clone() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    defines: { OCTAVES: 4 },
    uniforms,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top, mid, bottom, cloud, cloudShade, sunCol, sunDir; uniform float uTime; varying vec3 vP;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
      float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < OCTAVES; i++){ s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
      void main(){
        vec3 d = normalize(vP);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.6, h)) : mix(mid, bottom, smoothstep(0.0, 0.4, -h));
        float sd = max(0.0, dot(d, sunDir));
        c += sunCol * (pow(sd, 90.0) * 1.4 + pow(sd, 8.0) * 0.18);
        // Clouds on a virtual plane above the horizon; thicker near the horizon, clearer overhead.
        if (h > 0.0) {
          vec2 cp = d.xz / (h + 0.18) * 1.6 + vec2(uTime * 0.012, uTime * 0.005);
          float n = fbm(cp);
          float cov = smoothstep(0.48, 0.72, n) * smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.35, 0.8, h) * 0.6);
          float shade = smoothstep(0.5, 0.85, fbm(cp + vec2(0.06, 0.04)));
          vec3 cc = mix(cloud, cloudShade, shade * 0.55) + sunCol * pow(sd, 6.0) * 0.25;
          c = mix(c, cc, cov * 0.85);
        }
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(220, 48, 24), mat);
  return { mesh, uniforms, setOctaves(n) { if (mat.defines.OCTAVES !== n) { mat.defines.OCTAVES = n; mat.needsUpdate = true; } } };
}

// ---------- Post-processing, one chain per quality tier ----------
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.28 }, uWarm: { value: 0.06 }, uContrast: { value: 0.94 }, uSat: { value: 1.06 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVignette, uWarm, uContrast, uSat; varying vec2 vUv;
    void main(){
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = t.rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uSat);
      c = (c - 0.5) * uContrast + 0.5;
      // Warm the highlights, keep the shadows a touch cool.
      c += vec3(1.0, 0.55, 0.1) * uWarm * smoothstep(0.45, 1.0, l) - vec3(0.02, 0.0, -0.03) * (1.0 - l) * uWarm * 2.0;
      vec2 q = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
      gl_FragColor = vec4(c, t.a);
    }`,
};

// GTAO can leave NaN/garbage alpha on empty sky pixels, and sun glints on glossy water/metal reach
// thousands; bloom would smear either across the whole frame, so clamp before it.
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
      gl_FragColor = vec4(clamp(c, vec3(0.0), vec3(8.0)), 1.0);
    }`,
};

export function makePost(renderer, scene, camera) {
  let composer = null, chain = 'low', gtao = null, bloom = null, fxaa = null;
  const size = new THREE.Vector2();
  function build(t) {
    if (composer) { composer.dispose(); gtao?.dispose(); bloom?.dispose(); }
    composer = gtao = bloom = fxaa = null;
    chain = t;
    if (t === 'low') return;
    renderer.getSize(size);
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));
    const pr = renderer.getPixelRatio();
    if (t === 'high') {
      gtao = new GTAOPass(scene, camera, Math.round(size.x * pr), Math.round(size.y * pr));
      gtao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      gtao.blendIntensity = 0.85;
      const render = gtao.render.bind(gtao);
      gtao.render = (...a) => { camera.layers.disable(FUR_LAYER); render(...a); camera.layers.enable(FUR_LAYER); };
      composer.addPass(gtao);
    }
    composer.addPass(new ShaderPass(SanitizeShader));
    // Only genuinely bright things (sparks, fuses, goo, explosions, foam shots) pass the threshold.
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), t === 'high' ? 0.75 : 0.6, 0.45, 1.8);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    if (t === 'high') composer.addPass(new ShaderPass(GradeShader));
    fxaa = new FXAAPass();
    composer.addPass(fxaa);
  }
  return {
    setTier(t) { if (t !== chain) build(t); },
    setSize(w, h) { composer?.setPixelRatio(renderer.getPixelRatio()); composer?.setSize(w, h); },
    render(dt) { if (composer) composer.render(dt); else renderer.render(scene, camera); },
    get tier() { return chain; },
    get passes() { return composer ? composer.passes : []; },
  };
}

// ---------- Procedural textures ----------
function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export function grassGroundTexture() {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#b3e6a4';
    g.fillRect(0, 0, w, h);
    const blot = (n, r0, r1, cols, a) => {
      for (let i = 0; i < n; i++) {
        const x = Math.random() * w, y = Math.random() * h, r = r0 + Math.random() * (r1 - r0);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        const c = cols[i % cols.length];
        gr.addColorStop(0, c + a);
        gr.addColorStop(1, c + '00');
        g.fillStyle = gr;
        for (const [ox, oy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) { g.save(); g.translate(ox, oy); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore(); }
      }
    };
    blot(40, 30, 90, ['#9fd98f', '#c4efb2', '#a8dd96'], '99');
    blot(120, 6, 20, ['#8fcf80', '#d4f5c2'], '88');
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(120,190,110,0.35)' : 'rgba(225,250,210,0.3)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2 + Math.random() * 3);
    }
  });
}

export function woodTexture() {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#e2a564';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const x = Math.random() * w;
      g.strokeStyle = Math.random() < 0.6 ? 'rgba(160,100,50,0.35)' : 'rgba(255,215,160,0.3)';
      g.lineWidth = 1 + Math.random() * 3;
      g.beginPath();
      for (let y = 0; y <= h; y += 8) g.lineTo(x + Math.sin(y * 0.05 + i) * 3, y);
      g.stroke();
    }
  });
}

// Tileable water texture: rg = normal slope, b = height, a = foam/sparkle noise. A DataTexture so
// the browser can't premultiply the channels.
let waterTex = null;
export function waterTexture() {
  if (waterTex) return waterTex;
  const N = 128;
  const lattice = (cells, seed) => {
    const v = new Float32Array(cells * cells);
    for (let i = 0; i < v.length; i++) v[i] = Math.abs(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1;
    return (x, y) => {
      const fx = (x / N) * cells, fy = (y / N) * cells;
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const at = (a, b) => v[((b % cells + cells) % cells) * cells + ((a % cells + cells) % cells)];
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      return (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
    };
  };
  const o1 = lattice(4, 1), o2 = lattice(8, 2), o3 = lattice(16, 3), o4 = lattice(32, 4);
  const H = new Float32Array(N * N), F = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    H[y * N + x] = o1(x, y) * 0.5 + o2(x, y) * 0.3 + o3(x, y) * 0.2;
    F[y * N + x] = o3(x, y) * 0.55 + o4(x, y) * 0.45;
  }
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const h = (a, b) => H[((b + N) % N) * N + ((a + N) % N)];
    const dx = (h(x + 1, y) - h(x - 1, y)) * 4, dy = (h(x, y + 1) - h(x, y - 1)) * 4;
    const i = (y * N + x) * 4;
    data[i] = Math.max(0, Math.min(255, (dx * 0.5 + 0.5) * 255));
    data[i + 1] = Math.max(0, Math.min(255, (dy * 0.5 + 0.5) * 255));
    data[i + 2] = H[y * N + x] * 255;
    data[i + 3] = F[y * N + x] * 255;
  }
  waterTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.magFilter = THREE.LinearFilter;
  waterTex.minFilter = THREE.LinearMipmapLinearFilter;
  waterTex.generateMipmaps = true;
  waterTex.needsUpdate = true;
  return waterTex;
}

// ---------- River surface ----------
export const FOAM_SLOTS = 8;
export function riverMaterial(u) {
  Object.assign(u, {
    uWaterTex: { value: waterTexture() },
    uFoam: { value: Array.from({ length: FOAM_SLOTS }, () => new THREE.Vector3(0, 0, 0)) },
  });
  const m = new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'attribute vec2 rUv;\nattribute vec2 rDir;\nvarying vec2 vRUv;\nvarying vec2 vRXZ;\nvarying vec2 vRDir;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRUv = rUv;\nvRXZ = position.xz;\nvRDir = rDir;');
    sh.fragmentShader = `uniform float uTime, uR, uHalf, uW;
uniform vec3 uDeep, uShallow, uSand, uGrass;
uniform sampler2D uWaterTex;
uniform vec3 uFoam[${FOAM_SLOTS}];
varying vec2 vRUv; varying vec2 vRXZ; varying vec2 vRDir;
vec3 rN = vec3(0.0, 1.0, 0.0); float rWater = 0.0; float rSpark = 0.0; float rFoam = 0.0;
` + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
      if (length(vRXZ) > uR - 0.05) discard;
      float across = abs(vRUv.y * 2.0 - 1.0) * uW;
      if (across > uHalf) {
        float wet = smoothstep(uHalf + 0.3, uHalf, across);
        diffuseColor.rgb = mix(uSand, uGrass, smoothstep(uHalf + 0.05, uW, across)) * (1.0 - wet * 0.22);
      } else {
        rWater = 1.0;
        vec2 dir = normalize(vRDir);
        vec2 side = vec2(-dir.y, dir.x);
        vec2 uv = vec2(vRUv.x, (vRUv.y - 0.5) * uW * 2.0);
        vec4 n1 = texture2D(uWaterTex, uv * vec2(0.16, 0.2) + vec2(-uTime * 0.5, 0.0));
        vec4 n2 = texture2D(uWaterTex, uv * vec2(0.31, 0.37) + vec2(-uTime * 0.85, uTime * 0.04) + 0.37);
        vec2 sl = (n1.xy * 2.0 - 1.0) + (n2.xy * 2.0 - 1.0) * 0.7;
        rN = normalize(vec3(0.0, 1.0, 0.0) + (vec3(dir.x, 0.0, dir.y) * sl.x + vec3(side.x, 0.0, side.y) * sl.y) * 0.4);
        float depth = 1.0 - across / uHalf;
        vec3 col = mix(uShallow, uDeep, smoothstep(0.05, 0.9, depth));
        col *= 0.92 + n1.z * 0.16;
        float fn = n1.w * 0.55 + n2.w * 0.45;
        float foam = smoothstep(uHalf - 0.5, uHalf - 0.05, across + (fn - 0.5) * 0.55);
        for (int i = 0; i < ${FOAM_SLOTS}; i++) {
          vec3 f = uFoam[i];
          if (f.z <= 0.0) continue;
          vec2 d = vRXZ - f.xy;
          float ring = smoothstep(0.45, 0.0, length(d) - f.z + (fn - 0.5) * 0.35);
          float down = dot(d, dir);
          float wake = step(0.0, down) * smoothstep(f.z * 0.9, 0.0, abs(dot(d, side))) * smoothstep(3.0, 0.2, down) * smoothstep(0.35, 0.7, fn);
          foam = max(foam, max(ring, wake * 0.8));
        }
        float s = vRUv.x - uTime * 3.0;
        float wave = sin(s * 1.7 + sin(vRUv.y * 11.0 + vRUv.x * 0.6) * 1.4) * 0.5 + 0.5;
        foam = max(foam, smoothstep(0.9, 0.99, wave) * smoothstep(0.35, 0.75, fn) * 0.6);
        rFoam = clamp(foam, 0.0, 1.0);
        diffuseColor.rgb = mix(col, vec3(1.0), rFoam * 0.92);
        float sp = texture2D(uWaterTex, uv * vec2(0.7, 0.9) + vec2(-uTime * 1.2, uTime * 0.3)).w;
        rSpark = smoothstep(0.8, 0.95, sp * fn * 1.55) * (1.0 - rFoam);
      }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.95, mix(0.06, 0.6, rFoam), rWater);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nif (rWater > 0.5) normal = normalize((viewMatrix * vec4(rN, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.98, 0.9) * rSpark * 2.2 + diffuseColor.rgb * rWater * 0.08;');
  };
  return m;
}

// ---------- Waterfall: a curved sheet of falling water ----------
export function makeWaterfall() {
  const H = 11;
  const geo = new THREE.PlaneGeometry(1, 1, 6, 24);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const t = 1 - uv.getY(i);
    const x = p.getX(i) * (1 + t * 0.5);
    p.setXYZ(i, x, -t * H, 0.05 + Math.sqrt(t) * 2.4);
  }
  geo.computeVertexNormals();
  const uniforms = { uTime: { value: 0 }, uTex: { value: waterTexture() }, uDeep: { value: new THREE.Color('#5ab6f2') }, uLight: { value: new THREE.Color('#d8f2ff') } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uTime; uniform sampler2D uTex; uniform vec3 uDeep, uLight; varying vec2 vUv;
      void main(){
        float t = 1.0 - vUv.y;
        float n = texture2D(uTex, vec2(vUv.x * 2.5, vUv.y * 0.9 + uTime * 1.4)).w;
        float n2 = texture2D(uTex, vec2(vUv.x * 5.0 + 0.3, vUv.y * 1.7 + uTime * 2.3)).w;
        float streak = smoothstep(0.42, 0.75, n * 0.6 + n2 * 0.5);
        vec3 c = mix(uDeep, uLight, clamp(streak + t * 0.45 + smoothstep(0.92, 1.0, vUv.y) * 0.8, 0.0, 1.0));
        float edge = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
        float a = (0.5 + streak * 0.45) * edge * smoothstep(0.0, 0.35, vUv.y) * (1.0 - t * 0.35);
        gl_FragColor = vec4(c * 1.15, a);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return { mesh, uniforms, height: H };
}

// ---------- Instanced grass that sways in the wind and bends away from players ----------
export const PUSH_SLOTS = 10;
const BLADE_H = 0.42;
export function makeGrass(max, radius) {
  const geo = new THREE.BufferGeometry();
  const pos = [], col = [], nor = [];
  const base = new THREE.Color('#6fbf62'), tip = new THREE.Color('#d2f5b0');
  const rows = [0, 0.38, 0.72];
  for (const h of rows) {
    const w = 0.055 * Math.pow(1 - h, 0.7);
    pos.push(-w, h * BLADE_H, 0, w, h * BLADE_H, 0);
    const c = base.clone().lerp(tip, h);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  pos.push(0, BLADE_H, 0);
  col.push(tip.r, tip.g, tip.b);
  for (let i = 0; i < pos.length / 3; i++) nor.push(0, 1, 0);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6]);
  const uniforms = {
    uTime: { value: 0 }, uR: { value: radius }, uWind: { value: new THREE.Vector2(0.8, 0.6) },
    uPush: { value: Array.from({ length: PUSH_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
  };
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = `uniform float uTime, uR; uniform vec2 uWind; uniform vec4 uPush[${PUSH_SLOTS}];\n` + sh.vertexShader.replace('#include <project_vertex>', `
      vec4 iw = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float hgt = clamp(position.y / ${BLADE_H.toFixed(2)}, 0.0, 1.0);
      float bend = hgt * hgt;
      vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
      float gust = sin(uTime * 1.5 + iw.x * 0.3 + iw.z * 0.22) * 0.6 + sin(uTime * 2.9 + iw.x * 0.9 - iw.z * 0.7) * 0.25;
      mvPosition.xz += uWind * (gust + 0.5) * 0.1 * bend;
      for (int i = 0; i < ${PUSH_SLOTS}; i++) {
        vec4 pp = uPush[i];
        vec2 d = iw.xz - pp.xy;
        float L = length(d);
        float f = pp.z * smoothstep(1.15, 0.15, L);
        mvPosition.xz += (d / max(L, 0.05)) * f * 0.3 * bend;
        mvPosition.y -= f * 0.16 * bend;
      }
      if (length(iw.xz) > uR - 0.25) mvPosition.xyz = iw.xyz;
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.customProgramCacheKey = () => 'grass-blades';
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const data = [];
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < max; i++) {
    const r = Math.sqrt(Math.random()) * (radius - 0.3), a = Math.random() * Math.PI * 2;
    data.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.7 + Math.random() * 0.7, rot: Math.random() * Math.PI, lean: (Math.random() - 0.5) * 0.5 });
    mesh.setColorAt(i, c.setHSL(0.2 + Math.random() * 0.12, 0.5, 0.8 + Math.random() * 0.14));
  }
  const place = (hidden) => {
    data.forEach((b, i) => {
      d.position.set(b.x, 0, b.z);
      d.rotation.set(b.lean, b.rot, 0);
      d.scale.setScalar(hidden && hidden(b) ? 0 : b.s);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  place(null);
  return { mesh, uniforms, data, place, setCount(n) { mesh.count = Math.min(max, n); mesh.visible = n > 0; } };
}

// ---------- Soft contact shadows under every critter (one draw call) ----------
export function makeContactShadows(max) {
  const tex = canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.65)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  }, false);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ alphaMap: tex, transparent: true, depthWrite: false, color: '#ffffff', polygonOffset: true, polygonOffsetFactor: -2 });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vColor.r;\ndiffuseColor.rgb = vec3(0.16, 0.1, 0.24);');
  };
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < max; i++) mesh.setColorAt(i, c.setScalar(0));
  mesh.count = 0;
  let n = 0;
  return {
    mesh,
    begin() { n = 0; },
    add(x, y, z, size, strength) {
      if (n >= max || strength <= 0.01) return;
      d.position.set(x, y, z);
      d.scale.set(size, 1, size);
      d.updateMatrix();
      mesh.setMatrixAt(n, d.matrix);
      mesh.setColorAt(n, c.setScalar(strength));
      n++;
    },
    end() {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}

// ---------- Layered cliff rock ----------
export function cliffMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uA = { value: new THREE.Color('#b9a0c9') };
    sh.uniforms.uB = { value: new THREE.Color('#a48bba') };
    sh.uniforms.uC = { value: new THREE.Color('#e0cfe9') };
    sh.uniforms.uD = { value: new THREE.Color('#7f6a9a') };
    sh.vertexShader = 'varying vec3 vWP;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform vec3 uA, uB, uC, uD;\nvarying vec3 vWP;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float yy = vWP.y + sin(vWP.x * 0.31 + vWP.z * 0.23) * 0.7 + sin(vWP.x * 1.1 - vWP.z * 0.8) * 0.18;
      float band = fract(yy * 0.45);
      vec3 rc = mix(uA, uB, smoothstep(0.45, 0.55, band));
      rc = mix(rc, uC, smoothstep(0.9, 0.95, band) * (1.0 - smoothstep(0.95, 1.0, band)));
      rc = mix(rc, uD, smoothstep(-3.0, -18.0, vWP.y) * 0.6);
      diffuseColor.rgb *= rc * (0.92 + 0.08 * sin(vWP.x * 2.7) * sin(vWP.z * 3.1));`);
  };
  m.customProgramCacheKey = () => 'cliff-layers';
  return m;
}
