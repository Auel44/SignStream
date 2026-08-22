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

function run(mirror) {
  const root = loadBones("../../extension/public/avatar.glb");
  const rt = new Retargeter(root, rigById("makehuman"), mirror);
  const bind = new Map(); root.traverse(o=>{ if(o.isBone) bind.set(o.name,o.quaternion.clone()); });
  const driven = new Set(rigById("makehuman").links.map(l=>l.bone));
  const fingers = [...driven].filter(b=>/^finger/.test(b));
  const buckets = {"<45":0,"45-90":0,"90-120":0,"120-150":0,">150":0};
  let samples = 0, sum = 0;
  for (const lang of ["ghsl","asl"]) {
    const dir = path.join("../../dictionary", lang);
    for (const f of fs.readdirSync(dir).filter(x=>x.endsWith(".json")).slice(0,60)) {
      const clip = JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
      rt.reset();
      for (const fr of clip.frames) {
        rt.apply(fr,1);
        root.traverse(o=>{
          if (!o.isBone || !fingers.includes(o.name)) return;
          const d = THREE.MathUtils.radToDeg(bind.get(o.name).angleTo(o.quaternion));
          samples++; sum += d;
          if (d<45) buckets["<45"]++; else if (d<90) buckets["45-90"]++;
          else if (d<120) buckets["90-120"]++; else if (d<150) buckets["120-150"]++;
          else buckets[">150"]++;
        });
      }
    }
  }
  return { buckets, mean: sum/samples, samples };
}

for (const m of [false, true]) {
  const r = run(m);
  const pct = k => (r.buckets[k]/r.samples*100).toFixed(1).padStart(5);
  console.log(`mirrorX=${String(m).padEnd(5)} mean ${r.mean.toFixed(0).padStart(3)}°  |  <45:${pct("<45")}%  45-90:${pct("45-90")}%  90-120:${pct("90-120")}%  120-150:${pct("120-150")}%  >150:${pct(">150")}%`);
}
console.log("\n(finger joints; real fingers bend ~0-100 deg, so mass above 120 deg means the solve is wrong)");
