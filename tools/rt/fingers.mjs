// Do the fingers actually move, and do they spread?
//
//   node tools/rt/fingers.mjs [rig] [clip]
//
// "Clamped together" and "twitching" are different failures and need different
// measurements, so this reports both:
//
//   SPREAD    the angle between adjacent fingers' knuckle bones. Compared
//             against the same angle measured in the SOURCE clip, so the
//             question is not "is it wide" but "did we throw the source's
//             spread away". A rendered spread far below the source's is the
//             hand closing into a paddle.
//   CURL      how far each joint flexes. A hand that never curls reads as flat.
//   REVERSALS how often a joint changes direction between frames — the
//             signature of noise being solved rather than motion.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THREE, Retargeter, RIGS, rigById } from "./bundle.mjs";
import { readGlb, normalizedRig } from "./vrm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");

const DIGITS = ["Index", "Middle", "Ring", "Little"];

// Mirrors avatar.ts, so the numbers describe what a user actually sees rather
// than the raw solve. Measuring at mix=1 exaggerates every fault the smoothing
// exists to hide.
const SMOOTHING_MS = 70;
const FINGER_SMOOTHING_MS = 150;
const DISPLAY_HZ = 60;
const DT = 1000 / DISPLAY_HZ;
const MIX = 1 - Math.exp(-DT / SMOOTHING_MS);
const FINGER_MIX = 1 - Math.exp(-DT / FINGER_SMOOTHING_MS);
const WARMUP_MS = 3 * FINGER_SMOOTHING_MS;

function sampleAt(clip, ms) {
  const f = clip.frames;
  if (ms <= f[0].t) return f[0];
  if (ms >= f[f.length - 1].t) return f[f.length - 1];
  let i = 0;
  while (i < f.length - 2 && f[i + 1].t <= ms) i++;
  const a = f[i], b = f[i + 1], span = b.t - a.t;
  if (span <= 0) return a;
  const u = (ms - a.t) / span;
  const ok = (p) => p[0] !== 0 || p[1] !== 0;
  return {
    t: ms,
    positions: a.positions.map((p, k) => {
      const q = b.positions[k];
      if (!ok(p)) return q;
      if (!ok(q)) return p;
      return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
    }),
  };
}

function clipSpread(frame, rig, side) {
  // Angle between adjacent fingers' proximal segments, straight from the clip.
  const out = [];
  for (let i = 0; i < DIGITS.length - 1; i++) {
    const a = rig.links.find((l) => l.bone === `${side}${DIGITS[i]}Proximal`);
    const b = rig.links.find((l) => l.bone === `${side}${DIGITS[i + 1]}Proximal`);
    if (!a || !b) continue;
    const v = (l) => {
      const p = frame.positions[l.from], q = frame.positions[l.to];
      const ok = (x) => x && (x[0] !== 0 || x[1] !== 0);
      if (!ok(p) || !ok(q)) return null;
      const d = new THREE.Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      return d.lengthSq() > 1e-8 ? d.normalize() : null;
    };
    const va = v(a), vb = v(b);
    if (va && vb) out.push(THREE.MathUtils.radToDeg(va.angleTo(vb)));
  }
  return out;
}

function renderedSpread(objs, side) {
  const out = [];
  const dir = (name) => {
    const o = objs.get(`${side}${name}Proximal`);
    if (!o) return null;
    const child = o.children[0];
    if (!child) return null;
    const a = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const b = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
    const d = b.sub(a);
    return d.lengthSq() > 1e-10 ? d.normalize() : null;
  };
  for (let i = 0; i < DIGITS.length - 1; i++) {
    const va = dir(DIGITS[i]), vb = dir(DIGITS[i + 1]);
    if (va && vb) out.push(THREE.MathUtils.radToDeg(va.angleTo(vb)));
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function analyse(rig, clipPaths) {
  const { root, objs } = normalizedRig(readGlb(path.join(ROOT, "extension/public", rig.file)));
  const rt = new Retargeter(root, rig, false, (n) => objs.get(n) ?? null);

  const src = [], got = [], curls = [];
  let reversals = 0, steps = 0;
  const prevAngle = new Map(), prevDelta = new Map();
  const fingerLinks = rig.links.filter((l) => l.limit !== undefined);

  for (const cp of clipPaths) {
    const clip = JSON.parse(fs.readFileSync(cp, "utf8"));
    rt.reset();
    prevAngle.clear(); prevDelta.clear();
    for (let ms = 0; ms <= clip.durationMs; ms += DT) {
      const fr = sampleAt(clip, ms);
      rt.apply(fr, MIX, FINGER_MIX, DT);
      root.updateMatrixWorld(true);
      if (ms < WARMUP_MS) continue;
      for (const side of ["left", "right"]) {
        const s = clipSpread(fr, rig, side);
        if (s.length) { src.push(mean(s)); got.push(mean(renderedSpread(objs, side))); }
      }
      for (const l of fingerLinks) {
        const o = objs.get(l.bone);
        if (!o) continue;
        const ang = 2 * Math.acos(Math.min(1, Math.abs(o.quaternion.w)));
        const deg = THREE.MathUtils.radToDeg(ang);
        curls.push(deg);
        const p = prevAngle.get(l.bone);
        if (p !== undefined) {
          const d = deg - p;
          const pd = prevDelta.get(l.bone);
          if (pd !== undefined && Math.abs(d) > 0.5 && Math.abs(pd) > 0.5) {
            steps++;
            if (Math.sign(d) !== Math.sign(pd)) reversals++;
          }
          prevDelta.set(l.bone, d);
        }
        prevAngle.set(l.bone, deg);
      }
    }
  }
  return {
    srcSpread: mean(src), gotSpread: mean(got),
    curl: mean(curls), curlMax: Math.max(...curls),
    reversalPct: steps ? (100 * reversals) / steps : 0,
  };
}

/**
 * Joint flexion of the resting hand, in degrees.
 *
 * Worth its own check because a rest pose fault is invisible in the motion
 * numbers and highly visible on screen: 21% of finger keypoints are untracked
 * in any given frame, and an untracked joint HOLDS, so the rest pose is what a
 * fifth of the hand shows at any moment.
 *
 * It caught a real one. Every Distal phalanx sat at ~107 degrees -- a claw --
 * because VRM's humanoid defines no fingertip bones, so `axisFor` fell through
 * to its +Y default on a leaf while VRM finger bones rest along +/-X.
 */
function restPose(rig) {
  const { root, objs } = normalizedRig(readGlb(path.join(ROOT, "extension/public", rig.file)));
  const rt = new Retargeter(root, rig, false, (n) => objs.get(n) ?? null);
  rt.reset();
  const out = [];
  for (const j of ["Proximal", "Intermediate", "Distal"]) {
    const vals = DIGITS.map((d) => {
      const o = objs.get(`left${d}${j}`);
      return o ? (2 * Math.acos(Math.min(1, Math.abs(o.quaternion.w))) * 180) / Math.PI : NaN;
    }).filter((x) => !Number.isNaN(x));
    out.push(mean(vals));
  }
  return out;
}

const argRig = process.argv[2];
const argClip = process.argv[3];
const clips = argClip
  ? [path.join(ROOT, "dictionary", argClip)]
  : (() => {
      const out = [];
      for (const lang of ["ghsl", "asl"]) {
        const dir = path.join(ROOT, "dictionary", lang);
        const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        for (let i = 0; i < all.length; i += Math.floor(all.length / 15)) out.push(path.join(dir, all[i]));
      }
      return out;
    })();

console.log(`clips: ${clips.length}`);
console.log(
  "rig".padEnd(13) + "src spread".padStart(11) + "rendered".padStart(10) +
  "kept".padStart(8) + "mean curl".padStart(11) + "max curl".padStart(10) + "reversals".padStart(11)
);
console.log("-".repeat(74));
const rests = [];
for (const rig of (argRig ? [rigById(argRig)] : RIGS)) {
  rests.push([rig.id, restPose(rig)]);
  const r = analyse(rig, clips);
  const kept = r.srcSpread > 0 ? (100 * r.gotSpread) / r.srcSpread : 0;
  console.log(
    rig.id.padEnd(13) +
    (r.srcSpread.toFixed(1) + "°").padStart(11) +
    (r.gotSpread.toFixed(1) + "°").padStart(10) +
    (kept.toFixed(0) + "%").padStart(8) +
    (r.curl.toFixed(1) + "°").padStart(11) +
    (r.curlMax.toFixed(0) + "°").padStart(10) +
    (r.reversalPct.toFixed(1) + "%").padStart(11)
  );
}

console.log("");
console.log("rest pose, mean flexion per joint (a relaxed hand cascades gently):");
console.log("rig".padEnd(13) + "knuckle".padStart(9) + "middle".padStart(9) + "tip".padStart(9) + "   verdict");
for (const [id, r] of rests) {
  // Any joint past ~60 degrees at rest is a clenched hand, not a resting one.
  const bad = r.some((x) => x > 60);
  console.log(
    id.padEnd(13) +
    r.map((x) => (x.toFixed(0) + "°").padStart(9)).join("") +
    (bad ? "   FAIL: clenched at rest" : "   ok")
  );
}
