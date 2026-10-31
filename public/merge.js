import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const plainRender = THREE.Object3D.prototype.onBeforeRender;

// Sibling meshes that share a material and never move on their own are baked into one mesh, so
// e.g. a boxing glove's laces, cuff and rim cost one draw call instead of eight. Anything code holds on to
// (`keep`, objects referenced from any userData) or that carries its own state stays separate.
export function mergeRigidParts(root, keep = new Set()) {
  root.traverse((o) => {
    for (const v of Object.values(o.userData)) {
      if (v?.isObject3D) keep.add(v);
      else if (Array.isArray(v)) v.forEach((x) => x?.isObject3D && keep.add(x));
    }
  });
  const parents = [];
  root.traverse((o) => { if (o.children.length > 1 && o.userData.fur === undefined) parents.push(o); });
  for (const p of parents) {
    const byMat = new Map();
    for (const c of p.children) {
      if (!c.isMesh || c.isInstancedMesh || c.isSkinnedMesh || c.children.length || !c.visible || keep.has(c)) continue;
      if (Object.keys(c.userData).length || c.onBeforeRender !== plainRender || c.morphTargetInfluences) continue;
      if (Array.isArray(c.material) || c.geometry.isInstancedBufferGeometry || c.geometry.morphAttributes.position) continue;
      const k = `${c.material.uuid}|${c.castShadow}|${c.receiveShadow}|${c.layers.mask}|${c.renderOrder}|${c.frustumCulled}`;
      if (!byMat.has(k)) byMat.set(k, []);
      byMat.get(k).push(c);
    }
    for (const list of byMat.values()) if (list.length > 1) mergeList(p, list);
  }
}

function mergeList(parent, list) {
  const names = Object.keys(list[0].geometry.attributes).sort().join();
  if (list.some((c) => Object.keys(c.geometry.attributes).sort().join() !== names)) return;
  const indexed = list.every((c) => c.geometry.index);
  const geos = list.map((c) => {
    c.updateMatrix();
    let g = indexed ? c.geometry.clone() : c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
    g.applyMatrix4(c.matrix);
    // A mirrored part would come out inside-out once its transform is baked in.
    if (c.matrix.determinant() < 0) flipWinding(g);
    for (const n of Object.keys(g.morphAttributes)) delete g.morphAttributes[n];
    g.clearGroups();
    return g;
  });
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) return;
  merged.computeBoundingSphere();
  const first = list[0];
  const m = new THREE.Mesh(merged, first.material);
  m.castShadow = first.castShadow;
  m.receiveShadow = first.receiveShadow;
  m.layers.mask = first.layers.mask;
  m.renderOrder = first.renderOrder;
  m.frustumCulled = first.frustumCulled;
  for (const c of list) parent.remove(c);
  parent.add(m);
}

function flipWinding(g) {
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    return;
  }
  for (const attr of Object.values(g.attributes)) {
    const a = attr.array, n = attr.itemSize;
    for (let v = 0; v < attr.count; v += 3) {
      for (let j = 0; j < n; j++) {
        const i1 = (v + 1) * n + j, i2 = (v + 2) * n + j, t = a[i1];
        a[i1] = a[i2]; a[i2] = t;
      }
    }
  }
}
