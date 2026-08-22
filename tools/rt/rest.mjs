import fs from "node:fs";
import { THREE, Retargeter, rigById } from "./bundle.mjs";
function load(p) {
  const raw = fs.readFileSync(p); const n = raw.readUInt32LE(12);
  const g = JSON.parse(raw.subarray(20, 20+n).toString("utf8"));
  const objs = g.nodes.map(x => { const o = new THREE.Bone(); o.name = x.name ?? "";
    if (x.translation) o.position.fromArray(x.translation);
    if (x.rotation) o.quaternion.fromArray(x.rotation);
    if (x.scale) o.scale.fromArray(x.scale); return o; });
  g.nodes.forEach((x,i)=>(x.children??[]).forEach(c=>objs[i].add(objs[c])));
  const scene = new THREE.Object3D();
  (g.scenes[g.scene ?? 0].nodes).forEach(i => scene.add(objs[i]));
  scene.updateMatrixWorld(true);
  return scene;
}
const at = (scene, n) => { const m=[]; scene.traverse(o=>{ if(o.name===n) m.push(o); });
  if (!m[0]) return null; const v=new THREE.Vector3(); m[0].getWorldPosition(v); return v; };

for (const f of ["avatar","avatar-man","avatar-woman"]) {
  const scene = load(`../../extension/public/${f}.glb`);
  const rt = new Retargeter(scene, rigById("makehuman"), false);
  // Measure along the model's OWN up axis (spine), not world Y.
  const hips0 = at(scene,"spine01"), neck0 = at(scene,"neck01");
  const up = neck0.clone().sub(hips0).normalize();
  const side = at(scene,"upperarm01.L").clone().sub(at(scene,"upperarm01.R")).normalize();

  rt.reset();
  scene.updateMatrixWorld(true);
  const neck = at(scene,"neck01"), wl = at(scene,"wrist.L"), wr = at(scene,"wrist.R");
  const drop = neck.clone().sub(wl).dot(up);           // + means wrist BELOW neck
  const span = Math.abs(wl.clone().sub(wr).dot(side)); // lateral separation
  console.log(`${f.padEnd(14)} wrist below neck: ${drop.toFixed(2)}  lateral span: ${span.toFixed(2)}  ` +
    `${drop > 0.25 ? "ARMS DOWN ok" : "arms not down"}  ${span < 0.75 ? "not splayed ok" : "SPLAYED"}`);
}
