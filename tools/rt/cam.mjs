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
  const s = new THREE.Object3D(); (g.scenes[g.scene??0].nodes).forEach(i=>s.add(objs[i]));
  s.updateMatrixWorld(true); return s;
}
const at = (s,n)=>{const m=[];s.traverse(o=>{if(o.name===n)m.push(o)});if(!m[0])return null;
  const v=new THREE.Vector3();m[0].getWorldPosition(v);return v;};

for (const f of ["avatar","avatar-man","avatar-woman"]) {
  const scene = load(`../../extension/public/${f}.glb`);
  const rt = new Retargeter(scene, rigById("makehuman"), false);
  const ax = rt.getAxes();
  const head = at(scene,"head"), waist = at(scene,"spine03") ?? at(scene,"spine01");
  const spineLen = head.distanceTo(waist);
  const top = head.clone().addScaledVector(ax.up, spineLen*0.55);
  const centre = top.clone().add(waist).multiplyScalar(0.5);
  const height = top.distanceTo(waist);
  const fov = THREE.MathUtils.degToRad(35);
  const dist = (height*0.62)/Math.tan(fov/2);
  const cam = centre.clone().addScaledVector(ax.forward, dist);

  // Is the camera on the FACE side? The nose is forward of the neck; use the
  // ear-less rig's best proxy: head bone vs spine, projected on forward.
  const faceDir = head.clone().sub(waist).normalize();
  const camDir = cam.clone().sub(centre).normalize();
  // A signer's hands work in front of the chest, so the camera must be on the
  // same side as +forward. Verify forward is perpendicular-ish to up.
  const perp = Math.abs(ax.forward.dot(ax.up));
  console.log(`${f.padEnd(14)} frame height=${height.toFixed(2)} dist=${dist.toFixed(2)}  ` +
    `up.forward=${perp.toFixed(3)} ${perp<0.05?"ok":"NOT PERPENDICULAR"}  ` +
    `cam=(${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.z.toFixed(2)})`);
}
