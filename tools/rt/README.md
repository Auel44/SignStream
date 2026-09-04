# tools/rt — offline retargeting checks

Runs the **shipped** `retarget.ts` and `rigs.ts` in Node, against the real
avatar files and real dictionary clips. No browser, no rendering. This is where
the retargeting bugs were caught, because a pose that is 38 degrees wrong looks
plausible on screen and obvious in a number.

## Rebuild the bundle first

`bundle.mjs` is a compiled copy of the extension source. It does not update
itself.

```bash
node tools/rt/build.mjs
```

Do this after any change to `rigs.ts` or `retarget.ts`. **A stale bundle is
worse than no harness**: it keeps reporting OK while testing code that is no
longer shipped. The bundle sat three weeks stale against a rig set that had been
replaced outright — every rig in it had been deleted — and still passed.

## Current

| script | what it does |
| --- | --- |
| `build.mjs` | Rebuilds `bundle.mjs` from `extension/src`. Run this first. |
| `smooth.mjs` | Bone resolution, numerical health, and jerk with/without smoothing, per rig. |
| `fingers.mjs` | Finger spread, curl and direction reversals, per rig. |
| `head.mjs` | How much head movement survives `HEAD_MOTION` damping, per rig. |
| `tabs.mjs` | The overlay only mounts on the tab actually being captured. |
| `vrm.mjs` | Shared: reconstructs a VRM's normalized bone hierarchy. |

```bash
node tools/rt/smooth.mjs                       # all 12 rigs, one clip
node tools/rt/smooth.mjs ferk ghsl/water-v1.json
```

Reads as:

```
rig           bones  missing   jerk raw  jerk smooth  reduction  health
ferk             40        0      1.345        0.124        91%  ok
```

- `missing` must be **0**. A bone the rig map names but the model lacks does not
  fail loudly — that limb simply never moves.
- `reduction` is how much of the frame-to-frame angular-velocity change the
  smoothing removes. ~90% on a word clip.
- `static` instead of a percentage means the clip holds a fixed pose after the
  hand arrives, which is what a fingerspelled letter does. Nothing to smooth is
  not a failure.

## Fingers

```bash
node tools/rt/fingers.mjs            # all rigs, sampled clips
node tools/rt/fingers.mjs ferk       # one rig
```

```
rig           src spread  rendered    kept  mean curl  max curl  reversals
ferk               14.8°      8.8°     59%      37.6°      122°       1.6%
```

Two different complaints need two different numbers, so both are reported:

- **kept** — rendered finger spread as a fraction of the spread the SOURCE clip
  actually contains. The question is not "is it wide" but "did we throw the
  source's spread away". This was 43% before the anatomical clamp was retuned;
  a hand at that level reads as a paddle.
- **max curl** — watch for a jump toward 180°. That is a joint folding
  backwards, and it is how you find the point where relaxing a constraint stops
  buying realism and starts buying impossible poses.
- **reversals** — how often a joint changes direction between frames. Real
  motion rarely reverses; noise reverses constantly. 1.6% is healthy, and the
  raw unsmoothed solve is 62%.

It replays at 60 Hz through the real easing constants, so the numbers describe
what a user sees rather than the raw solve.

## Head

```bash
node tools/rt/head.mjs
```

```
rig            source sd  rendered sd    ratio  mean tilt  reversals
ferk                6.4°         0.9°      15%       1.3°       2.9%
```

The head direction comes from the neck-to-nose vector, and in a 2D source that
is mostly tracker jitter: **48.2% of frames reverse direction**, where real head
motion is sustained across a clause. Rendered at full strength it read as a
constant wobble pulling the eye away from the hands.

`HEAD_MOTION` in `rigs.ts` damps it — 0 gives a completely fixed head. `ratio`
is what survives; it lands below `HEAD_MOTION` because the playback smoothing
damps the remainder. `mean tilt` is a static offset from each rig's own rest
pose, not movement, so it varies by rig and does not matter.

## Stale — do not trust these

Nine scripts predate the move from MakeHuman glTF to VRM. They load `.glb`
files that no longer exist and ask for a `makehuman` rig that was deleted:

`cam.mjs` · `flex.mjs` · `frame.mjs` · `frame2.mjs` · `mirror.mjs` ·
`rest.mjs` · `spine.mjs` · `sweep.mjs` · `test.mjs`

They are kept because the measurements in them documented real findings (finger
flexion limits, the spine chain, camera framing) and the approach is worth
re-reading. But `rigById("makehuman")` silently falls back to the first rig
rather than erroring, so **a stale script can produce a confident, wrong
number**. Port what you need into a fresh script against a `.vrm` instead.

## Driving a VRM the way the browser does

A VRM is posed through its **normalized** bones — a parallel hierarchy
three-vrm builds where every bone rests with identity rotation. Solving the raw
glTF skeleton would measure something the user never sees, so `smooth.mjs`
reconstructs the normalized rig from the file's own humanoid.

One trap worth knowing: **VRM 0.x and 1.0 name the thumb differently.** 0.x uses
Proximal/Intermediate/Distal like every other finger; 1.0 uses
Metacarpal/Proximal/Distal. three-vrm migrates 0.x to 1.0 names on load, so
`rigs.ts` is correct to use the 1.0 names, and any tool reading the file
directly must apply the same rename. Skipping it makes the harness report two
unmapped bones on every rig and blame `rigs.ts`, which is right.
