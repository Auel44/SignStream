// How much does the avatar's head actually move?
//
//   node tools/rt/head.mjs [rig]
//
// The head direction comes from the neck-to-nose vector, which in a 2D source
// is largely tracker jitter rather than deliberate movement — measured at 48%
// direction reversals, where real head motion is sustained. `HEAD_MOTION` in
// rigs.ts damps it. This measures what survives, on the rendered skeleton
// rather than in the arithmetic.
//
// SOURCE is the tilt present in the clips; RENDERED is what the avatar does.
// The ratio should match HEAD_MOTION.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THREE, Retargeter, RIGS, rigById } from "./bundle.mjs";
import { readGlb, normalizedRig } from "./vrm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const NOSE = 0, NECK = 1;

const SMOOTHING_MS = 70, DISPLAY_HZ = 60;
const DT = 1000 / DISPLAY_HZ;
const MIX = 1 - Math.exp(-DT / SMOOTHING_MS);
const FINGER_MIX = 1 - Math.exp(-DT / 150);

const clips = (() => {
  const out = [];
  for (const lang of ["ghsl", "asl"]) {
    const dir = path.join(ROOT, "dictionary", lang);
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (let i = 0; i < all.length; i += Math.floor(all.length / 20)) out.push(path.join(dir, all[i]));
  }
  return out;
})();

const stats = (a) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return { mean: m, sd: Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) };
};

function run(rig) {
  const { root, objs } = normalizedRig(readGlb(path.join(ROOT, "extension/public", rig.file)));
  const rt = new Retargeter(root, rig, false, (n) => objs.get(n) ?? null);
  const head = objs.get("head"), neck = objs.get("neck");

  const src = [], got = [];
  let rev = 0, steps = 0;
  for (const cp of clips) {
    const clip = JSON.parse(fs.readFileSync(cp, "utf8"));
    rt.reset();
    let prevAng = null, prevD = null;
    for (const fr of clip.frames) {
      const n = fr.positions[NECK], nose = fr.positions[NOSE];
      const ok = (p) => p && (p[0] !== 0 || p[1] !== 0);
      if (!ok(n) || !ok(nose)) continue;
      src.push((Math.atan2(nose[0] - n[0], nose[1] - n[1]) * 180) / Math.PI);

      rt.apply(fr, MIX, FINGER_MIX);
      root.updateMatrixWorld(true);
      // Total rotation of the skull away from rest, through the neck.
      const q = new THREE.Quaternion();
      if (neck) q.copy(neck.quaternion);
      if (head) q.multiply(head.quaternion);
      const deg = (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;
      got.push(deg);
      if (prevAng !== null) {
        const d = deg - prevAng;
        if (prevD !== null && Math.abs(d) > 0.05 && Math.abs(prevD) > 0.05) {
          steps++;
          if (Math.sign(d) !== Math.sign(prevD)) rev++;
        }
        prevD = d;
      }
      prevAng = deg;
    }
  }
  const S = stats(src), G = stats(got);
  return { srcSd: S.sd, gotSd: G.sd, gotMean: G.mean, rev: steps ? (100 * rev) / steps : 0 };
}

console.log(`clips ${clips.length}\n`);
console.log("rig".padEnd(13) + "source sd".padStart(11) + "rendered sd".padStart(13) +
            "ratio".padStart(9) + "mean tilt".padStart(11) + "reversals".padStart(11));
console.log("-".repeat(68));
for (const rig of (process.argv[2] ? [rigById(process.argv[2])] : RIGS)) {
  const r = run(rig);
  console.log(
    rig.id.padEnd(13) +
    (r.srcSd.toFixed(1) + "°").padStart(11) +
    (r.gotSd.toFixed(1) + "°").padStart(13) +
    ((100 * r.gotSd / r.srcSd).toFixed(0) + "%").padStart(9) +
    (r.gotMean.toFixed(1) + "°").padStart(11) +
    (r.rev.toFixed(1) + "%").padStart(11)
  );
}
