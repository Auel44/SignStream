import fs from "node:fs";
import path from "node:path";
import { THREE, Retargeter, rigById } from "./bundle.mjs";

function loadBones(glbPath) {
  const raw = fs.readFileSync(glbPath);
  const jsonLen = raw.readUInt32LE(12);
  const gltf = JSON.parse(raw.subarray(20, 20 + jsonLen).toString("utf8"));
  const objs = gltf.nodes.map((n) => {
    const b = new THREE.Bone();
    b.name = n.name ?? "";
    if (n.translation) b.position.fromArray(n.translation);
    if (n.rotation) b.quaternion.fromArray(n.rotation);
    return b;
  });
  gltf.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => objs[i].add(objs[c])));
  const root = new THREE.Object3D();
  objs.forEach((o) => { if (!o.parent) root.add(o); });
  return root;
}

const rigId = "makehuman";
const root = loadBones("../../extension/public/avatar.glb");
const rt = new Retargeter(root, rigById(rigId), false);

// Bind pose, captured before anything is applied.
const bind = new Map();
root.traverse(o => { if (o.isBone) bind.set(o.name, o.quaternion.clone()); });

const stats = new Map();   // bone family -> max degrees FROM BIND
let nan = 0, frames = 0, clips = 0, undrivenMoved = 0;
const driven = new Set(rigById(rigId).links.map(l => l.bone));

for (const lang of ["ghsl","asl"]) {
  const dir = path.join("../../dictionary", lang);
  for (const f of fs.readdirSync(dir).filter(x=>x.endsWith(".json")).slice(0,60)) {
    const clip = JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
    clips++; rt.reset();
    for (const fr of clip.frames) {
      rt.apply(fr, 1); frames++;
      root.traverse(o => {
        if (!o.isBone) return;
        const q = o.quaternion;
        if ([q.x,q.y,q.z,q.w].some(Number.isNaN)) nan++;
        const d = THREE.MathUtils.radToDeg(bind.get(o.name).angleTo(q));
        if (!driven.has(o.name)) { if (d > 0.5) undrivenMoved++; return; }
        const key = o.name.replace(/\.[LR]$/,"");
        stats.set(key, Math.max(stats.get(key) ?? 0, d));
      });
    }
  }
}

console.log(`clips ${clips}, frames ${frames}, NaN ${nan}`);
console.log(`undriven bones that moved: ${undrivenMoved}  ${undrivenMoved ? "FAIL — solver touched bones it should not" : "OK"}`);
console.log("\nmax displacement FROM BIND, driven bones (deg):");
const rows = [...stats.entries()].sort((a,b)=>b[1]-a[1]);
for (const [k,v] of rows.slice(0,6)) console.log(`  ${k.padEnd(16)} ${v.toFixed(0).padStart(4)}°`);
console.log("  ...");
for (const [k,v] of rows.slice(-3)) console.log(`  ${k.padEnd(16)} ${v.toFixed(0).padStart(4)}°`);
const wild = rows.filter(([,v]) => v > 150);
console.log(`\nbones exceeding 150 deg: ${wild.length}${wild.length ? " -> " + wild.slice(0,5).map(r=>r[0]).join(", ") : ""}`);
