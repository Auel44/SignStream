import fs from "node:fs";
import path from "node:path";
import { THREE, Retargeter, rigById } from "./bundle.mjs";

function loadBones(p) {
  const raw = fs.readFileSync(p); const n = raw.readUInt32LE(12);
  const g = JSON.parse(raw.subarray(20, 20+n).toString("utf8"));
  const o = g.nodes.map(x => { const b = new THREE.Bone(); b.name = x.name ?? "";
    if (x.translation) b.position.fromArray(x.translation);
    if (x.rotation) b.quaternion.fromArray(x.rotation); return b; });
  g.nodes.forEach((x,i)=>(x.children??[]).forEach(c=>o[i].add(o[c])));
  const r = new THREE.Object3D(); o.forEach(b=>{ if(!b.parent) r.add(b); }); return r;
}

const root = loadBones("../../extension/public/avatar.glb");
const rt = new Retargeter(root, rigById("makehuman"), false);
const byName = new Map(); root.traverse(o=>{ if(o.isBone) byName.set(o.name,o); });

// Joint flexion = angle between a bone's world direction and its parent's.
// Anatomically this is ~0-110 deg for finger joints; it cannot exceed ~120.
const chains = [];
for (const side of ["L","R"])
  for (const f of [1,2,3,4,5])
    for (const seg of [2,3]) {
      const child = byName.get(`finger${f}-${seg}.${side}`);
      const parent = byName.get(`finger${f}-${seg-1}.${side}`);
      if (child && parent) chains.push([parent, child, `finger${f}-${seg}`]);
    }

const Y = new THREE.Vector3(0,1,0);
const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Quaternion();
const buckets = {"0-30":0,"30-60":0,"60-90":0,"90-120":0,">120":0};
let samples = 0, sum = 0, worst = 0, worstName = "";

for (const lang of ["ghsl","asl"]) {
  const dir = path.join("../../dictionary", lang);
  for (const f of fs.readdirSync(dir).filter(x=>x.endsWith(".json")).slice(0,60)) {
    const clip = JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
    rt.reset();
    for (const fr of clip.frames) {
      rt.apply(fr,1);
      root.updateMatrixWorld(true);
      for (const [p,c,name] of chains) {
        p.getWorldQuaternion(q); a.copy(Y).applyQuaternion(q);
        c.getWorldQuaternion(q); b.copy(Y).applyQuaternion(q);
        const d = THREE.MathUtils.radToDeg(a.angleTo(b));
        samples++; sum += d;
        if (d > worst) { worst = d; worstName = name; }
        if (d<30) buckets["0-30"]++; else if (d<60) buckets["30-60"]++;
        else if (d<90) buckets["60-90"]++; else if (d<120) buckets["90-120"]++;
        else buckets[">120"]++;
      }
    }
  }
}
const pct = k => (buckets[k]/samples*100).toFixed(1).padStart(5);
console.log(`finger JOINT FLEXION across ${samples.toLocaleString()} joint-frames`);
console.log(`  mean ${(sum/samples).toFixed(0)}°   worst ${worst.toFixed(0)}° (${worstName})`);
console.log(`  0-30:${pct("0-30")}%  30-60:${pct("30-60")}%  60-90:${pct("60-90")}%  90-120:${pct("90-120")}%  >120:${pct(">120")}%`);
console.log(`\n  anatomical limit is ~110-120 deg; ${pct(">120")}% exceed it`);
