import fs from "node:fs";
import { THREE, Retargeter, rigById } from "./bundle.mjs";
function load(p){const raw=fs.readFileSync(p);const n=raw.readUInt32LE(12);
 const g=JSON.parse(raw.subarray(20,20+n).toString("utf8"));
 const o=g.nodes.map(x=>{const b=new THREE.Bone();b.name=x.name??"";
  if(x.translation)b.position.fromArray(x.translation);
  if(x.rotation)b.quaternion.fromArray(x.rotation);
  if(x.scale)b.scale.fromArray(x.scale);return b;});
 g.nodes.forEach((x,i)=>(x.children??[]).forEach(c=>o[i].add(o[c])));
 const s=new THREE.Object3D();(g.scenes[g.scene??0].nodes).forEach(i=>s.add(o[i]));
 s.updateMatrixWorld(true);return s;}
for (const f of ["avatar","avatar-man","avatar-woman"]) {
  const s = load(`../../extension/public/${f}.glb`);
  const rt = new Retargeter(s, rigById("makehuman"), false);
  const ax = rt.getAxes();
  const at=n=>{const m=[];s.traverse(o=>{if(o.name===n)m.push(o)});const v=new THREE.Vector3();m[0]?.getWorldPosition(v);return m[0]?v:null;};
  const head=at("head"), waist=at("spine05");
  const span = head.distanceTo(waist);
  const top = head.clone().addScaledVector(ax.up, span*0.3);
  const height = top.distanceTo(waist);
  const fov = THREE.MathUtils.degToRad(35);
  const dist = (height*0.62)/Math.tan(fov/2);
  // What vertical band does the camera actually cover at the subject's depth?
  const halfView = Math.tan(fov/2)*dist;
  const centre = top.clone().add(waist).multiplyScalar(0.5);
  const bottomOfView = centre.clone().addScaledVector(ax.up, -halfView);
  const kneeish = waist.clone().addScaledVector(ax.up, -span*0.8); // roughly knees
  const showsLegs = bottomOfView.clone().sub(kneeish).dot(ax.up) < 0;
  console.log(`${f.padEnd(14)} band=${(halfView*2).toFixed(2)} (head+waist span ${height.toFixed(2)})  legs in frame: ${showsLegs ? "YES" : "no"}`);
}
