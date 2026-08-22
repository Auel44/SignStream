import fs from "node:fs";
import { THREE, Retargeter, rigById } from "./bundle.mjs";

// Rebuild the rig's bone hierarchy from the real .glb, so the Retargeter under
// test sees exactly the skeleton the browser will hand it.
function loadBones(glbPath) {
  const raw = fs.readFileSync(glbPath);
  const jsonLen = raw.readUInt32LE(12);
  const gltf = JSON.parse(raw.subarray(20, 20 + jsonLen).toString("utf8"));
  const nodes = gltf.nodes;
  const objs = nodes.map((n) => {
    const b = new THREE.Bone();
    b.name = n.name ?? "";
    if (n.translation) b.position.fromArray(n.translation);
    if (n.rotation) b.quaternion.fromArray(n.rotation);
    return b;
  });
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => objs[i].add(objs[c])));
  const root = new THREE.Object3D();
  objs.forEach((o, i) => { if (!o.parent) root.add(o); });
  return root;
}

const glb = process.argv[2];
const clipPath = process.argv[3];
const root = loadBones(glb);
const rig = rigById("makehuman");
const rt = new Retargeter(root, rig, false);

console.log(`rig      : ${glb.split(/[\/]/).pop()}`);
console.log(`bones    : ${rt.boneCount} driven, missing ${rt.missingBones.length}`);

const clip = JSON.parse(fs.readFileSync(clipPath, "utf8"));
console.log(`clip     : ${clip.gloss}  ${clip.frames.length} frames`);

// Snapshot a few bones before/after so we can prove they actually moved.
const watch = ["upperarm01.R", "lowerarm01.R", "wrist.R", "finger2-1.R", "finger3-2.R"];
const grab = () => { const m = {}; root.traverse(o => { if (watch.includes(o.name)) m[o.name] = o.quaternion.clone(); }); return m; };
const before = grab();

let nan = 0, nonUnit = 0;
for (const f of clip.frames) {
  rt.apply(f, 1);
  root.traverse((o) => {
    if (!watch.includes(o.name)) return;
    const q = o.quaternion;
    if ([q.x,q.y,q.z,q.w].some(Number.isNaN)) nan++;
    if (Math.abs(q.length() - 1) > 1e-3) nonUnit++;
  });
}
const after = grab();

console.log(`\nNaN quaternions     : ${nan}   ${nan ? "FAIL" : "OK"}`);
console.log(`non-unit quaternions: ${nonUnit}   ${nonUnit ? "FAIL" : "OK"}`);
console.log("\nbone movement (angle from bind pose, degrees):");
let moved = 0;
for (const n of watch) {
  const d = before[n] && after[n] ? THREE.MathUtils.radToDeg(before[n].angleTo(after[n])) : NaN;
  if (d > 1) moved++;
  console.log(`  ${n.padEnd(14)} ${d.toFixed(1).padStart(6)}°  ${d > 1 ? "moved" : "STATIC"}`);
}
console.log(`\n${moved}/${watch.length} watched bones animated`);
