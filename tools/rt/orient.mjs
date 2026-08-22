import fs from "node:fs";
import { THREE } from "./bundle.mjs";
// Build the glTF node graph with three.js and let IT compute world matrices.
export function measure(path) {
  const raw = fs.readFileSync(path);
  const n = raw.readUInt32LE(12);
  const g = JSON.parse(raw.subarray(20, 20+n).toString("utf8"));
  const objs = g.nodes.map(x => {
    const o = new THREE.Object3D(); o.name = x.name ?? "";
    if (x.translation) o.position.fromArray(x.translation);
    if (x.rotation) o.quaternion.fromArray(x.rotation);
    if (x.scale) o.scale.fromArray(x.scale);
    return o;
  });
  g.nodes.forEach((x,i)=>(x.children??[]).forEach(c=>objs[i].add(objs[c])));
  const scene = new THREE.Scene();
  (g.scenes[g.scene ?? 0].nodes).forEach(i => scene.add(objs[i]));
  scene.updateMatrixWorld(true);
  const at = (name) => { const o = objs.find(o=>o.name===name); if(!o) return null;
    const v = new THREE.Vector3(); o.getWorldPosition(v); return v; };
  return { head: at("head"), root: at("root"), wristL: at("wrist.L"), spine: at("spine01") };
}
const m = measure(process.argv[2]);
for (const [k,v] of Object.entries(m)) if (v) console.log(`  ${k.padEnd(8)} x=${v.x.toFixed(2)} y=${v.y.toFixed(2)} z=${v.z.toFixed(2)}`);
const up = m.head.y > m.root.y ? "Y-up (head above root) OK" : "WRONG: head is not above root";
console.log(`  -> ${up}`);
