import fs from "node:fs";
import { THREE, Retargeter, rigById } from "./bundle.mjs";
const raw = fs.readFileSync("../../extension/public/avatar.glb");
const n = raw.readUInt32LE(12);
const g = JSON.parse(raw.subarray(20, 20+n).toString("utf8"));
const objs = g.nodes.map(x => { const o = new THREE.Bone(); o.name = x.name ?? "";
  if (x.translation) o.position.fromArray(x.translation);
  if (x.rotation) o.quaternion.fromArray(x.rotation);
  if (x.scale) o.scale.fromArray(x.scale); return o; });
g.nodes.forEach((x,i)=>(x.children??[]).forEach(c=>objs[i].add(objs[c])));
const s = new THREE.Object3D(); (g.scenes[g.scene??0].nodes).forEach(i=>s.add(objs[i]));
s.updateMatrixWorld(true);
const rt = new Retargeter(s, rigById("makehuman"), false);
const ax = rt.getAxes();
const at = n2 => { const m=[]; s.traverse(o=>{if(o.name===n2)m.push(o)}); if(!m[0])return null;
  const v=new THREE.Vector3(); m[0].getWorldPosition(v); return v; };
const head = at("head");
console.log("height along the rig's own up axis, relative to head (0 = head bone):");
for (const b of ["head","neck01","spine01","spine02","spine03","spine04","spine05","root","wrist.L"]) {
  const p = at(b); if (!p) continue;
  console.log(`  ${b.padEnd(9)} ${p.clone().sub(head).dot(ax.up).toFixed(3)}`);
}
