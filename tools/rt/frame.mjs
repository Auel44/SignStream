import fs from "node:fs";
import { THREE } from "./bundle.mjs";
const raw = fs.readFileSync("../../extension/public/avatar.glb");
const n = raw.readUInt32LE(12);
const g = JSON.parse(raw.subarray(20, 20+n).toString("utf8"));
const nodes = g.nodes.map(x => ({ name: x.name ?? "", t: x.translation ?? [0,0,0], q: x.rotation, kids: x.children ?? [] }));
const world = new Map();
function walk(i, pq, pp) {
  const nd = nodes[i];
  const q = nd.q ? new THREE.Quaternion().fromArray(nd.q) : new THREE.Quaternion();
  const wq = pq.clone().multiply(q);
  const wp = pp.clone().add(new THREE.Vector3().fromArray(nd.t).applyQuaternion(pq));
  world.set(nd.name, wp.clone());
  nd.kids.forEach(c => walk(c, wq, wp));
}
const roots = new Set(nodes.map((_,i)=>i));
nodes.forEach(nd => nd.kids.forEach(c => roots.delete(c)));
roots.forEach(i => walk(i, new THREE.Quaternion(), new THREE.Vector3()));
for (const b of ["root","spine01","neck01","head","upperarm01.L","wrist.L","wrist.R"]) {
  const p = world.get(b);
  if (p) console.log(`  ${b.padEnd(14)} x=${p.x.toFixed(3)} y=${p.y.toFixed(3)} z=${p.z.toFixed(3)}`);
}
const ys = [...world.values()].map(p=>p.y);
console.log(`\nskeleton y: ${Math.min(...ys).toFixed(2)} .. ${Math.max(...ys).toFixed(2)}`);
