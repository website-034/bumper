import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { makeStars } from './characters.js';

// Characters listed in /models/characters.json, keyed by id.
export const MODEL_CHARACTERS = {};

const loader = new GLTFLoader();
const loaded = new Map();
const pending = new Map();

// When a state has no clip, try these instead (then fall back to idle).
const FALLBACKS = {
  walk: ['run'],
  run: ['walk'],
  carry: ['walk', 'run'],
  fall: ['jump'],
  held: ['fall', 'jump'],
  win: ['wave'],
};
const ONE_SHOT = new Set(['punch', 'jump', 'ko', 'throw']);

export async function loadManifest() {
  try {
    const res = await fetch('/models/characters.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const { characters = [], defaults = {} } = await res.json();
    for (const d of characters) {
      if (!d.id || !d.file) continue;
      MODEL_CHARACTERS[d.id] = { label: d.label || d.id, color: d.color || '#cccccc', height: 2.3, rotationY: 0, animations: {}, ...defaults, ...d };
    }
  } catch (err) {
    console.warn('Could not read /models/characters.json', err);
  }
}

export const isModelReady = (id) => loaded.has(id);

export function loadModel(id) {
  if (pending.has(id)) return pending.get(id);
  const def = MODEL_CHARACTERS[id];
  const p = loader.loadAsync(`/models/${def.file}`).then((gltf) => {
    const model = gltf.scene;
    model.rotation.y = THREE.MathUtils.degToRad(def.rotationY);
    model.updateMatrixWorld(true);
    // Normalise every model to the same height, standing on y=0 and centred.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // "fit": "max" sizes by the largest dimension, for long creatures like sharks.
    const measure = def.fit === 'max' ? Math.max(size.x, size.y, size.z) : size.y;
    const scale = def.height / (measure || 1);
    loaded.set(id, {
      model,
      clips: gltf.animations,
      scale,
      offset: new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale),
    });
  }).catch((err) => {
    console.error(`Failed to load model "${def.file}"`, err);
    throw err;
  });
  pending.set(id, p);
  return p;
}

export function buildModelCritter(id) {
  const def = MODEL_CHARACTERS[id];
  const data = loaded.get(id);

  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.add(pivot);
  const holder = new THREE.Group();
  holder.scale.setScalar(data.scale);
  holder.position.copy(data.offset);
  pivot.add(holder);

  const model = cloneSkinned(data.model);
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false;
    }
  });
  holder.add(model);

  const stars = makeStars();
  stars.position.y = def.height + 0.3;
  root.add(stars);

  const mixer = new THREE.AnimationMixer(model);
  if (def.segments) return segmentCritter(def, data, { root, pivot, stars, mixer });
  const actions = {};
  for (const [state, clipName] of Object.entries(def.animations)) {
    const clip = THREE.AnimationClip.findByName(data.clips, clipName);
    if (!clip) {
      console.warn(`Model "${id}": no animation named "${clipName}" (for ${state}). Available:`, data.clips.map((c) => c.name));
      continue;
    }
    const action = mixer.clipAction(clip);
    if (ONE_SHOT.has(state)) {
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
    }
    actions[state] = action;
  }

  let current = null;
  let currentState = null;

  function resolve(state) {
    if (actions[state]) return state;
    for (const f of FALLBACKS[state] || []) if (actions[f]) return f;
    return actions.idle ? 'idle' : null;
  }

  return {
    kind: 'model',
    root,
    pivot,
    stars,
    height: def.height,
    hasKoClip: !!actions.ko,
    animated: Object.keys(actions).length > 0,

    // Switch animation state; `restart` replays one-shots like punch.
    setState(state, { restart = false, timeScale = 1, duration } = {}) {
      const s = resolve(state);
      if (!s) return;
      const next = actions[s];
      const speed = duration ? Math.max(0.5, Math.min(3, next.getClip().duration / duration)) : timeScale;
      if (s === currentState && !restart) {
        next.timeScale = speed;
        return;
      }
      next.reset();
      next.enabled = true;
      next.setEffectiveWeight(1);
      next.timeScale = speed;
      next.play();
      if (current && current !== next) current.crossFadeTo(next, 0.15, false);
      current = next;
      currentState = s;
    },

    update(dt) {
      mixer.update(dt);
    },
  };
}

// Models that bake every move into one track, split by frame ranges
// ("segments": { "walk": [90, 119] }). The track is scrubbed rather than
// split into subclips, which avoids popping at the loop point.
function segmentCritter(def, data, { root, pivot, stars, mixer }) {
  const fps = def.fps || 24;
  const clip = data.clips[0];
  if (clip) mixer.clipAction(clip).play();

  const segOf = (state) => {
    const name = def.animations[state];
    return name && def.segments[name] ? { state, name, range: def.segments[name] } : null;
  };
  const resolve = (state) => {
    const direct = segOf(state);
    if (direct) return direct;
    for (const f of FALLBACKS[state] || []) {
      const s = segOf(f);
      if (s) return s;
    }
    return segOf('idle');
  };

  let seg = null;
  let local = 0;
  let speed = 1;

  return {
    kind: 'model',
    root,
    pivot,
    stars,
    height: def.height,
    hasKoClip: !!segOf('ko'),
    animated: !!clip,

    setState(state, { restart = false, timeScale = 1, duration } = {}) {
      const next = resolve(state);
      if (!next) return;
      const len = (next.range[1] - next.range[0]) / fps;
      speed = duration ? Math.max(0.5, Math.min(3, len / duration)) : timeScale;
      if (seg && next.name === seg.name && next.state === seg.state && !restart) return;
      seg = next;
      local = 0;
    },

    update(dt) {
      if (!clip || !seg) return;
      local += dt * speed;
      const start = seg.range[0] / fps;
      const len = (seg.range[1] - seg.range[0]) / fps;
      const once = ONE_SHOT.has(seg.state);
      mixer.setTime(start + (once ? Math.min(local, len) : local % len));
    },
  };
}
