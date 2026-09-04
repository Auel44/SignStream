// Measure how smoothly a rig signs a real clip — offline, no browser.
//
//   node tools/rt/smooth.mjs                       # every rig, one clip
//   node tools/rt/smooth.mjs ferk ghsl/b-v1.json   # one rig, one clip
//
// What this checks, and why each part earns its place
// ---------------------------------------------------
//   1. Bone resolution. A rig whose map names a bone the model lacks does not
//      fail loudly — that limb simply never moves. `rigs.ts` records a case
//      where 46 of 47 bones silently failed to resolve over a dropped
//      separator, so this is the first thing to assert.
//   2. Numerical health. A NaN or non-unit quaternion anywhere collapses the
//      pose for every frame after it.
//   3. Jerk. Smoothness is not a feeling here, it is the frame-to-frame change
//      in angular velocity. We replay the clip at display rate exactly as
//      `avatar.ts` does — interpolating source frames, then easing with the
//      same frame-rate-independent constants — and report jerk with the
//      smoothing on and off. Off is the control: if the two are equal the
//      smoothing is not reaching the bones.
//
// Driving VRM the way the browser does
// ------------------------------------
// In the extension a VRM is posed through its NORMALIZED bones — a parallel
// hierarchy three-vrm builds where every bone rests with identity rotation.
// Solving the raw glTF skeleton instead would be measuring something the user
// never sees, so the normalized rig is reconstructed here from the file's own
// humanoid, which is the one thing a VRM guarantees.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THREE, Retargeter, RIGS, rigById } from "./bundle.mjs";
import { readGlb, normalizedRig } from "./vrm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const PUBLIC = path.join(ROOT, "extension/public");
const DICT = path.join(ROOT, "dictionary");

// Kept in step with avatar.ts. If they drift, this harness measures a rig the
// user is not watching.
const SMOOTHING_MS = 70;
const FINGER_SMOOTHING_MS = 150;
const DISPLAY_HZ = 60;

//: Replay time excluded from the jerk statistic while the filter settles.
//: Three time constants of the slower (finger) filter, after which an
//: exponential is within 5% of its target.
const WARMUP_MS = 3 * FINGER_SMOOTHING_MS;

// ── Clip replay ──────────────────────────────────────────────────────────────

/** Linear blend of two clip frames, as avatar.ts does before solving once. */
function blendFrames(a, b, u) {
  return {
    t: a.t + (b.t - a.t) * u,
    positions: a.positions.map((p, i) => {
      const q = b.positions[i];
      // An untracked point is [0,0,0]; blending toward it would drag the joint
      // to the origin, so hold the tracked side instead.
      const aOk = p[0] !== 0 || p[1] !== 0;
      const bOk = q[0] !== 0 || q[1] !== 0;
      if (!aOk) return q;
      if (!bOk) return p;
      return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
    }),
  };
}

function sampleAt(clip, ms) {
  const frames = clip.frames;
  if (ms <= frames[0].t) return frames[0];
  const last = frames[frames.length - 1];
  if (ms >= last.t) return last;
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].t <= ms) i++;
  const a = frames[i];
  const b = frames[i + 1];
  const span = b.t - a.t;
  return span > 0 ? blendFrames(a, b, (ms - a.t) / span) : a;
}

/**
 * Replay one clip and return jerk in degrees per frame squared.
 *
 * Jerk, not speed: a fast sign is not a rough one. What reads as juddering is
 * the angular velocity changing abruptly between frames, so that is what is
 * measured.
 */
function replay(rt, objs, clip, watch, smoothed) {
  const dt = 1000 / DISPLAY_HZ;
  const ease = (tau) => 1 - Math.exp(-dt / tau);
  const mix = smoothed ? ease(SMOOTHING_MS) : 1;
  const fingerMix = smoothed ? ease(FINGER_SMOOTHING_MS) : 1;

  const prev = new Map();
  const vel = new Map();
  let jerkSum = 0;
  let jerkN = 0;
  let jerkMax = 0;
  let nan = 0;
  let nonUnit = 0;

  rt.reset();
  for (let ms = 0; ms <= clip.durationMs; ms += dt) {
    // dt is passed so the joint speed limits are active, as they are in the
    // extension. Measuring without them would describe a build nobody runs.
    rt.apply(sampleAt(clip, ms), mix, fingerMix, dt);
    // Skip the settling transient. `reset()` parks the rig in its neutral pose,
    // so the first sample is a step from rest to wherever the sign starts. The
    // raw path pays that in a single frame; the smoothed path spreads it over
    // ~3 tau by design. Counting it would score the smoothing as worse for
    // doing exactly what it exists to do — and in the extension this moment is
    // not raw either, it is the BLEND_MS hand-over from the previous sign.
    const settling = ms < WARMUP_MS;
    for (const name of watch) {
      const o = objs.get(name);
      if (!o) continue;
      const q = o.quaternion;
      if ([q.x, q.y, q.z, q.w].some(Number.isNaN)) { nan++; continue; }
      if (Math.abs(q.length() - 1) > 1e-3) nonUnit++;
      const p = prev.get(name);
      if (p) {
        const v = THREE.MathUtils.radToDeg(p.angleTo(q));
        const pv = vel.get(name);
        if (pv !== undefined && !settling) {
          const j = Math.abs(v - pv);
          jerkSum += j;
          jerkN++;
          if (j > jerkMax) jerkMax = j;
        }
        vel.set(name, v);
      }
      prev.set(name, q.clone());
    }
  }
  return {
    meanJerk: jerkN ? jerkSum / jerkN : 0,
    maxJerk: jerkMax,
    nan,
    nonUnit,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const argRig = process.argv[2];
const argClip = process.argv[3] ?? "ghsl/water-v1.json";
const clip = JSON.parse(fs.readFileSync(path.join(DICT, argClip), "utf8"));
const rigs = argRig ? [rigById(argRig)] : RIGS;

console.log(`clip: ${argClip}  gloss=${clip.gloss}  ${clip.frames.length} frames  ${clip.durationMs}ms`);
console.log(`replayed at ${DISPLAY_HZ}Hz, smoothing ${SMOOTHING_MS}ms / fingers ${FINGER_SMOOTHING_MS}ms\n`);
console.log(
  "rig".padEnd(13) + "bones".padStart(6) + "missing".padStart(9) +
  "jerk raw".padStart(11) + "jerk smooth".padStart(13) + "reduction".padStart(11) + "  health"
);
console.log("-".repeat(78));

let failures = 0;
for (const rig of rigs) {
  const file = path.join(PUBLIC, rig.file);
  if (!fs.existsSync(file)) {
    console.log(`${rig.id.padEnd(13)}  MODEL FILE MISSING: ${rig.file}`);
    failures++;
    continue;
  }
  let line;
  try {
    const { root, objs } = normalizedRig(readGlb(file));
    const rt = new Retargeter(root, rig, false, (name) => objs.get(name) ?? null);
    const watch = rig.links.map((l) => l.bone).filter((n) => objs.has(n));
    const raw = replay(rt, objs, clip, watch, false);
    const smooth = replay(rt, objs, clip, watch, true);
    const cut = raw.meanJerk > 0 ? (1 - smooth.meanJerk / raw.meanJerk) * 100 : 0;

    const bad = [];
    if (rt.missingBones.length) bad.push(`${rt.missingBones.length} unmapped`);
    if (smooth.nan) bad.push(`${smooth.nan} NaN`);
    if (smooth.nonUnit) bad.push(`${smooth.nonUnit} non-unit`);
    // Only judge the smoothing when there is motion to smooth. Most letters
    // are a static handshape held after the hand arrives, so past the warm-up
    // their raw jerk is ~0 and the ratio is meaningless — flagging that scored
    // a correctly-held `K` as broken.
    const STATIC = 0.05;
    const staticClip = raw.meanJerk < STATIC;
    if (!staticClip && cut < 20) bad.push("smoothing ineffective");
    if (bad.length) failures++;

    line =
      rig.id.padEnd(13) +
      String(rt.boneCount).padStart(6) +
      String(rt.missingBones.length).padStart(9) +
      raw.meanJerk.toFixed(3).padStart(11) +
      smooth.meanJerk.toFixed(3).padStart(13) +
      (staticClip ? "static" : cut.toFixed(0) + "%").padStart(11) +
      "  " + (bad.length ? "FAIL: " + bad.join(", ") : "ok");
  } catch (e) {
    failures++;
    line = `${rig.id.padEnd(13)}  ERROR: ${e.message}`;
  }
  console.log(line);
}

console.log("-".repeat(78));
console.log(failures ? `${failures} rig(s) need attention` : `all ${rigs.length} rigs ok`);
process.exit(failures ? 1 : 0);
