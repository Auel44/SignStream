// Loading a VRM the way the browser does, for the Node harnesses.
//
// The extension poses a VRM through its NORMALIZED bones — a parallel hierarchy
// three-vrm builds where every bone rests with identity rotation. Solving the
// raw glTF skeleton would measure something the user never sees, so the
// normalized rig is reconstructed here from the file's own humanoid.

import fs from "node:fs";
import { THREE } from "./bundle.mjs";


export function readGlb(file) {
  const raw = fs.readFileSync(file);
  if (raw.toString("utf8", 0, 4) !== "glTF") throw new Error(`not a GLB: ${file}`);
  const jsonLen = raw.readUInt32LE(12);
  return JSON.parse(raw.subarray(20, 20 + jsonLen).toString("utf8"));
}

/**
 * VRM 0.x renamed the thumb when 1.0 landed, and three-vrm migrates on load.
 *
 * 0.x calls the thumb's three bones Proximal/Intermediate/Distal like every
 * other finger; 1.0 calls them Metacarpal/Proximal/Distal, which is the
 * anatomically correct naming — the thumb has a metacarpal that moves, and the
 * other fingers do not. Copied from three-vrm's own `thumbBoneNameMap`
 * (VRMHumanoidLoaderPlugin), because the harness must see the same names the
 * browser does.
 *
 * Getting this wrong does not look like a bug, it looks like a finding: the
 * first run of this file reported two unmapped bones on all twelve rigs and
 * blamed rigs.ts, when rigs.ts was right and the harness was reading raw file
 * names three-vrm had already renamed.
 */
const THUMB_0X_TO_10 = {
  leftThumbProximal: "leftThumbMetacarpal",
  leftThumbIntermediate: "leftThumbProximal",
  rightThumbProximal: "rightThumbMetacarpal",
  rightThumbIntermediate: "rightThumbProximal",
};

/** humanoid bone name → glTF node index, in VRM 1.0 naming for both versions. */
export function humanBones(gltf) {
  const ext = gltf.extensions ?? {};
  const v1 = ext.VRMC_vrm?.humanoid?.humanBones;
  if (v1) {
    return Object.fromEntries(Object.entries(v1).map(([name, b]) => [name, b.node]));
  }
  const v0 = ext.VRM?.humanoid?.humanBones;
  if (Array.isArray(v0)) {
    return Object.fromEntries(
      v0
        .filter((b) => b.bone != null)
        .map((b) => [THUMB_0X_TO_10[b.bone] ?? b.bone, b.node]),
    );
  }
  throw new Error("no VRM humanoid in file");
}

/** World-space rest position of every glTF node. */
export function worldPositions(gltf) {
  const nodes = gltf.nodes ?? [];
  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));

  const local = nodes.map((n) => {
    const m = new THREE.Matrix4();
    if (n.matrix) return m.fromArray(n.matrix);
    const t = new THREE.Vector3().fromArray(n.translation ?? [0, 0, 0]);
    const q = new THREE.Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]);
    const s = new THREE.Vector3().fromArray(n.scale ?? [1, 1, 1]);
    return m.compose(t, q, s);
  });

  const world = new Array(nodes.length);
  const resolve = (i) => {
    if (world[i]) return world[i];
    const p = parentOf.get(i);
    world[i] = p === undefined ? local[i].clone() : resolve(p).clone().multiply(local[i]);
    return world[i];
  };
  return nodes.map((_, i) => new THREE.Vector3().setFromMatrixPosition(resolve(i)));
}

/**
 * Rebuild three-vrm's normalized hierarchy.
 *
 * Each humanoid bone becomes an Object3D named by its humanoid name, parented
 * to its nearest humanoid ancestor, offset by the rest distance between them,
 * and — the part that matters — resting with identity rotation. That identity
 * rest is what makes a VRM's bone axes differ per bone, which is exactly why
 * `Rig.boneAxis` is left undefined for these rigs.
 */
export function normalizedRig(gltf) {
  const bones = humanBones(gltf);
  const pos = worldPositions(gltf);
  const nodes = gltf.nodes ?? [];

  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));

  const nodeToHuman = new Map();
  for (const [name, idx] of Object.entries(bones)) nodeToHuman.set(idx, name);

  const objs = new Map();
  for (const name of Object.keys(bones)) {
    const o = new THREE.Bone();
    o.name = name;
    objs.set(name, o);
  }

  const root = new THREE.Object3D();
  for (const [name, idx] of Object.entries(bones)) {
    // Nearest ancestor that is itself a humanoid bone.
    let p = parentOf.get(idx);
    while (p !== undefined && !nodeToHuman.has(p)) p = parentOf.get(p);
    const child = objs.get(name);
    if (p === undefined) {
      child.position.copy(pos[idx]);
      root.add(child);
    } else {
      child.position.copy(pos[idx]).sub(pos[p]);
      objs.get(nodeToHuman.get(p)).add(child);
    }
  }
  root.updateMatrixWorld(true);
  return { root, objs };
}

