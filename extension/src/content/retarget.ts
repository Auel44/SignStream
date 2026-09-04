// Turns clip keypoint POSITIONS into skeleton bone ROTATIONS.
//
// The problem
// -----------
// A clip says "the left elbow was at (x, y)". A rigged model has no concept of
// a point in space — it is animated by rotating each bone relative to its
// parent. Every frame we must answer: what rotation makes this bone point from
// its start keypoint towards its end keypoint?
//
// This is NOT inverse kinematics. IK is for when you only know where the hand
// ended up and must infer the whole arm. Here every joint position is known, so
// each bone is solved directly — far cheaper, and there is no solver to
// converge or oscillate.
//
// The maths
// ---------
// Verified against the exported model rather than assumed: every bone's child
// sits at local offset [0, 1, 0], i.e. bones point along their own +Y. That is
// Blender's convention and it survives the glTF export intact.
//
// A bone's quaternion is expressed relative to its parent, so:
//
//     bone.quaternion * (0,1,0)  =  the direction the bone points, in parent space
//
// Therefore, given a target direction in world space:
//
//     targetLocal    = inverse(parentWorldRotation) * targetWorld
//     bone.quaternion = rotationFrom((0,1,0), targetLocal)
//
// Solving parents before children is what makes a chain hang together: rotating
// the upper arm carries the forearm and the whole hand with it.
//
// Why runtime rather than a pre-baked file
// ----------------------------------------
// ~40 bones per frame is a few hundred quaternion operations — negligible
// beside rendering. Baking rotations into clips would roughly double their
// size, force all 3,179 to be regenerated and re-uploaded, and invalidate the
// CDN cache. Same maths, better place for it.

import * as THREE from "three";
import { boneKey, restFrame, type BoneLink, type Rig } from "./rigs";
import type { SignClipFrame } from "../shared/types";

/**
 * Fallback bone axis, used only when a rig states none and none can be measured.
 *
 * The note above holds for the MakeHuman rigs, and they say so explicitly via
 * `Rig.boneAxis`. It is NOT a property of skeletons in general: a VRM's bind
 * pose is a mandated T-pose whose normalized bones rest with identity
 * rotations, so its arm and finger bones point along world ±X. Measured on the
 * shipped VRM, only 1 of 7 sampled bones rested along +Y.
 */
const DEFAULT_BONE_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Shortest keypoint separation, in clip metres, that yields a usable direction.
 *
 * Clips are normalised so shoulder width is 0.4 m, which makes a finger segment
 * roughly 0.03 m. The source is 2D, so a finger pointing towards or away from
 * the camera projects to almost nothing — and normalising an almost-zero vector
 * amplifies tracker noise into an essentially random direction.
 *
 * Measured across 120 clips, this was the source of the implausible poses: 11%
 * of finger rotations exceeded 120 degrees, which no finger does. Below this
 * threshold the direction is not weak evidence, it is no evidence, so the bone
 * holds its previous rotation instead.
 */
const MIN_SEGMENT = 0.012;

/**
 * How far a finger joint may bend the WRONG way, in degrees.
 *
 * Not zero: a real finger hyperextends a little, and forcing an exact floor
 * makes a relaxed hand look locked. Anything past this is tracker noise.
 */
const MAX_HYPEREXTENSION = 8;

/**
 * Off-hinge freedom, in degrees, for the joints that have some.
 *
 * The knuckle (Proximal/Metacarpal) genuinely abducts — fingers spread — so it
 * is a hinge with slack rather than a pure one. The joints beyond it do not:
 * they are pure hinges, and giving them any freedom is what let noise push them
 * sideways.
 *
 * Raised from 18. At 18 the hand rendered as a paddle: measured over 32 clips
 * and all 12 rigs, the mean angle between adjacent fingers' knuckle bones was
 * 14.8 degrees in the source clips but only 6.3 degrees on screen — 57% of the
 * spread a real hand shows was being clamped away. This is the number the user
 * sees as "fingers clamped together".
 *
 * It is safe to raise only because the direction filter now cleans the
 * constraint's input (see Solved.dirFilter); this budget absorbs genuine
 * abduction plus any error in the measured hinge axis, so setting it to bare
 * anatomy would clamp real motion whenever that axis is slightly off.
 *
 * Swept rather than guessed, on the shipped rigs and clips:
 *
 *     25 deg -> 48% of source spread kept, max joint rotation 114 deg
 *     35 deg -> 56%                        119 deg
 *     40 deg -> 59%                        122 deg   <- chosen
 *     45 deg -> 62%                        124 deg
 *     50 deg -> 66%                        178 deg   <- fingers fold backwards
 *
 * There is a cliff between 45 and 50 where the off-axis budget grows large
 * enough to let a joint invert. 40 sits clear of it with margin on every rig.
 * Re-swept after the fingertip axis fix in `axisFor`, which changed the solve;
 * the cliff did not move.
 */
const KNUCKLE_OFF_AXIS = 40;

/**
 * Fastest a finger joint may rotate, in degrees per second.
 *
 * The visible twitch was never mostly direction reversals — those measured only
 * 1.6% once the direction filter was in. It was the SIZE of single-frame steps:
 * across 20 clips, 16.4% of finger frames moved more than 2 degrees, 3.7% moved
 * more than 5, and the worst moved 17.6 degrees in one 60 Hz frame. That is
 * 1,056 deg/s, which no finger does; it reads as a pop.
 *
 * Two things produce those steps and neither is real motion. A keypoint that is
 * untracked in one source frame and tracked in the next makes the interpolated
 * position jump rather than ramp (blending toward an untracked [0,0,0] would
 * drag the joint to the origin, so the tracked side is taken whole). And a
 * segment crossing MIN_SEGMENT flips between held and solved.
 *
 * Measured in CLIP time, not wall time — `apply` is handed the clip-time step,
 * so this bounds motion relative to the recorded performance. A clip played at
 * 2.2x for fingerspelling is allowed to move 2.2x faster; a wall-clock limit
 * would silently undo that speed-up.
 *
 * This is a speed limit, not a smoother: it never changes where a joint is
 * heading, only how fast it may get there. Swept on the shipped clips, and it
 * costs nothing — finger spread stayed at 59% and mean curl at 37.6 degrees at
 * every value tested, down to 150 deg/s, so the poses are still fully reached:
 *
 *     uncapped   max step 17.6 deg/frame,  3.7% of frames over 5 deg
 *     600 deg/s          10.0             3.7%
 *     400 deg/s           6.7             4.0%
 *     300 deg/s           5.0             1.3%   <- chosen
 *     200 deg/s           3.3             0.0%
 *
 * 300 removes the steps that read as a pop while leaving real signing speed
 * untouched, and fingerspelling still gets 660 deg/s of effective headroom.
 * Re-swept after the wrist roll and the arm-chain cap landed: finger spread is
 * 56% at every value from 300 to 700, so the limit still costs nothing, and 300
 * gives the lowest peak joint rotation of the four.
 */
const MAX_FINGER_DEG_PER_S = 300;

/**
 * How far the wrist may roll from its rest orientation, in degrees.
 *
 * Forearm pronation and supination give a real wrist roughly a quarter turn
 * each way from neutral. Past that the hand is not rolling, the solve is.
 */
const MAX_WRIST_ROLL = 100;

/**
 * Fastest any non-finger bone may rotate, in degrees per second of clip time.
 *
 * The finger cap left the arm chain untouched, and that is where the remaining
 * pops were. Measured at 60 Hz over 25 clips, before this existed:
 *
 *     shoulder      max   66 deg/s
 *     upper arm     max  601 deg/s
 *     forearm       max 2107 deg/s   <- not a human movement
 *     hand          max 2172 deg/s   <- not a human movement
 *
 * A forearm or wrist can reach roughly 1000 deg/s in a fast flick and far less
 * in signing, so 900 passes everything real and stops only the steps that come
 * from a keypoint appearing, disappearing, or jumping between source frames.
 */
const MAX_BONE_DEG_PER_S = 900;

/**
 * Fastest the wrist may roll, in degrees per second of clip time.
 *
 * The branch chosen below can still change when the hand passes edge-on and
 * the evidence genuinely flips. Rate-limiting turns that into a fast turn
 * rather than an instant 180 degree snap.
 */
const MAX_ROLL_DEG_PER_S = 360;


/** Neutral standing pose, solved through the normal path. See rigs.restFrame. */
const REST = restFrame();

/**
 * A keypoint of [0,0,0] means "not tracked in this frame" — roughly a quarter
 * of hand points, and both hands in one-handed signs. Such a bone must HOLD its
 * previous rotation; snapping it to rest would fling the fingers straight open
 * several times a second.
 */
function tracked(p: [number, number, number] | undefined): boolean {
  return !!p && (p[0] !== 0 || p[1] !== 0);
}

interface Solved {
  /**
   * Object3D rather than Bone: a VRM is driven through its *normalized* bones,
   * which three-vrm builds as a parallel Object3D hierarchy and copies onto the
   * real skeleton in `vrm.update()`. Only `.quaternion` and `.parent` are ever
   * touched, so the narrower type bought nothing.
   */
  bone: THREE.Object3D;
  link: BoneLink;
  /**
   * The direction this bone points, in its own local space.
   *
   * `apply` rotates this onto the target direction. For MakeHuman rigs it is
   * +Y for every bone; for a VRM it differs per bone and is measured from the
   * bind pose. Getting it wrong does not fail loudly — it silently poses every
   * affected bone at an angle, which reads as a broken avatar.
   */
  axis: THREE.Vector3;
  /** Index into `world` of the nearest DRIVEN ancestor, or -1 if there is none. */
  parent: number;
  /**
   * Rest rotation of the undriven bones between `parent` and this bone.
   *
   * Two cases, and the second one used to be dropped:
   *
   *   * `parent` is -1 — the topmost bone we animate (`clavicle`, `neck01`)
   *     hangs off a chain we leave alone: spine01 through spine05, the armature
   *     root, and the object node carrying the file's axis conversion. Treating
   *     that as identity solved every bone in the wrong frame.
   *   * `parent` is a real bone — MakeHuman interleaves bones we do not drive
   *     between ones we do. `shoulder01` sits between `clavicle` and
   *     `upperarm01`, and `upperarm02`/`lowerarm02` are the twist pairs a 2D
   *     clip cannot inform. They are undriven, not absent: on the shipped rigs
   *     `shoulder01` alone carries a 38.5 degree rest rotation. Skipping them
   *     put the upper arm 38 degrees out, and because the error compounds down
   *     the chain the wrist and fingers inherited all of it — which is what
   *     made the hands look wrung out however the rest pose was written.
   */
  gap: THREE.Quaternion;
  /**
   * Flexion axis for a hinge joint, in the bone's parent space.
   *
   * A finger's middle and end joints are pure hinges: they flex and extend and
   * do nothing else. Solving them as a free swing lets 2D tracker noise rotate
   * them sideways and backwards, which is anatomically impossible and is what
   * reads as twitching — measured at 2.1% of finger frames reversing direction,
   * with 13.1% pinned against the anatomical limit.
   *
   * The axis is measured from the rest pose rather than declared: `restFrame`
   * curls every finger about its natural flexion axis, so the rotation it
   * produces from the bind pose IS that axis. Nothing rig-specific is assumed.
   */
  hinge?: THREE.Vector3;
  /** How far off the hinge this joint may rotate, in radians. 0 = pure hinge. */
  offAxis: number;
  /**
   * Previous frame's target direction for this bone, in clip space.
   *
   * Finger directions are filtered over time BEFORE the anatomical constraint
   * runs, which is the whole point of keeping it here. The old order was
   * noisy direction -> hard clamp -> smooth the result, and a clamp fed noise
   * fires constantly: measured over 32 clips it discarded 57% of the finger
   * spread the source actually contained, so the hand rendered as a paddle.
   *
   * Filtering first means the constraint sees motion rather than jitter, fires
   * rarely, and can then afford to allow the abduction a real hand has.
   *
   * Held in CLIP space deliberately. Parent space rotates as the arm moves, so
   * a filter there would drag every finger toward where it pointed before the
   * hand turned.
   */
  dirFilter?: THREE.Vector3;
  /**
   * Where this bone's roll reference points at REST, in the bone's own space.
   *
   * Measured rather than declared, from the rest pose the rig already defines.
   * The per-frame roll is then "how far has the knuckle line turned about the
   * palm axis since rest", which needs no per-rig constant.
   */
  rollRef?: THREE.Vector3;
  /** Previous frame's chosen roll angle, in radians. Resolves the 2D branch. */
  rollPrev?: number;
  /**
   * The bone's rotation as modelled, kept so `reset` can restore it.
   *
   * Solving replaces this rotation outright (swing-only, see `apply`), so the
   * bind value is the only record of how the artist posed the bone. Resetting
   * to identity instead would collapse the rig into a heap.
   */
  bind: THREE.Quaternion;
}

export class Retargeter {
  /** Bones in parent-before-child order. */
  private solved: Solved[] = [];
  /** World rotation per solved bone, rebuilt each frame. */
  private world: THREE.Quaternion[] = [];
  /** Previous frame's local rotation, for the finger speed limit. */
  private prev: THREE.Quaternion[] = [];
  /** Keyed by `boneKey`, not by literal name — see the note there. */
  private readonly bones = new Map<string, THREE.Object3D>();
  private readonly missing: string[] = [];

  /** Clip space -> rig space, measured from the bind pose. See `calibrate`. */
  private readonly basis = new THREE.Matrix4();
  private calibrated = false;

  // Scratch, reused so the hot loop allocates nothing.
  private readonly dir = new THREE.Vector3();
  private readonly inv = new THREE.Quaternion();
  private readonly q = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  /** Driven ancestor's world rotation combined with `gap`, rebuilt per bone. */
  private readonly parentWorld = new THREE.Quaternion();
  private readonly twist = new THREE.Quaternion();
  private readonly swing = new THREE.Quaternion();
  private readonly scratch = new THREE.Quaternion();
  /** Target of the finger speed limit, kept off `scratch` which it also uses. */
  private readonly capped = new THREE.Quaternion();
  private readonly rollNow = new THREE.Vector3();
  private readonly rollWant = new THREE.Vector3();
  private readonly rollCross = new THREE.Vector3();
  private readonly rollQ = new THREE.Quaternion();
  /** Roll allowance for the current frame, set by `apply` from its dt. */
  private rollStep = 0;


  /**
   * @param mirrorX Flip left/right. A camera sees a signer mirrored, so whether
   *   the clip's "left wrist" is the rig's left depends on how the source was
   *   recorded. Exposed rather than assumed.
   * @param resolve Optional bone lookup, used for VRM.
   *
   *   Scene traversal finds bones by the name the *model* happens to use, which
   *   is the whole problem `boneKey` exists to paper over. A VRM answers the
   *   question properly: `humanoid.getNormalizedBoneNode("leftIndexProximal")`
   *   returns the right node whatever the file calls it. Passing that in means
   *   `vrmLinks` needs no per-model naming knowledge at all.
   */
  constructor(
    root: THREE.Object3D,
    private readonly rig: Rig,
    private readonly mirrorX = false,
    resolve?: (name: string) => THREE.Object3D | null,
  ) {
    if (resolve) {
      // Every name the rig map mentions, plus the landmarks calibration needs.
      const wanted = new Set<string>(this.rig.links.map((l) => l.bone));
      for (const name of Object.values(this.rig.landmarks)) wanted.add(name);
      for (const name of wanted) {
        const node = resolve(name);
        if (node) this.bones.set(boneKey(name), node);
      }
    } else {
      root.traverse((o) => {
        if ((o as THREE.Bone).isBone) this.bones.set(boneKey(o.name), o);
      });
    }
    this.calibrate();
    this.build();
  }

  /** Bones the rig map names but the model lacks — a mapping bug, not a warning. */
  get missingBones(): string[] {
    return this.missing;
  }

  get boneCount(): number {
    return this.solved.length;
  }

  /**
   * The rig's own up and forward axes, measured from the bind pose.
   *
   * The camera needs the same frame the solver uses: "up the spine" and "the
   * way the face points". Deriving both from the skeleton means framing works
   * for any model without a per-rig constant.
   */
  getAxes(): { up: THREE.Vector3; forward: THREE.Vector3 } | null {
    if (!this.calibrated) return null;
    const e = this.basis.elements;
    return {
      up: new THREE.Vector3(e[4], e[5], e[6]),
      // Clip +z points out of the screen towards the viewer, so in rig space
      // this is the direction the signer faces.
      forward: new THREE.Vector3(e[8], e[9], e[10]),
    };
  }

  /**
   * Work out how clip space maps onto this rig's space.
   *
   * Clips are frontal 2D: +x is the subject's left, +y is up, z is always 0.
   * A rig's bones live in whatever space its authoring tool used — the
   * MakeHuman -> FBX -> Blender -> glTF route here ends up Z-up, so feeding
   * clip directions in raw made "down" mean "backwards" and the arms came out
   * wrong however the rest pose was written.
   *
   * Rather than hard-code a convention per model, measure it from the bind
   * pose. The spine gives up; the line between the shoulders gives left; their
   * cross product gives the third axis. Any rig, from any tool, calibrates
   * itself — and this subsumes the mirror question too, because the shoulder
   * vector carries the handedness.
   */
  private calibrate(): void {
    const posOf = (name: string): THREE.Vector3 | null => {
      const bone = this.bones.get(boneKey(name));
      if (!bone) return null;
      const v = new THREE.Vector3();
      // Bind pose positions: matrices are still untouched at construction.
      bone.updateWorldMatrix(true, false);
      v.setFromMatrixPosition(bone.matrixWorld);
      return v;
    };

    // Landmarks come from the rig, not from this file. MakeHuman numbers the
    // spine downwards — spine01 is the upper chest and spine05 the pelvis — so
    // measuring "up" from spine01 spanned only a forward-leaning stub of chest
    // and put the up axis 17 degrees off vertical, tilting both the solved pose
    // and the camera. Naming the landmark per rig is what stops that knowledge
    // being wired into the solver, where a VRM could never satisfy it.
    const lm = this.rig.landmarks;
    const hips = posOf(lm.hips);
    const neck = posOf(lm.neck) ?? posOf(lm.head);
    const left = posOf(lm.leftArm);
    const right = posOf(lm.rightArm);
    if (!hips || !neck || !left || !right) return; // leave as identity

    const up = neck.clone().sub(hips);
    const sideways = left.clone().sub(right); // +x in clip space is subject's left
    if (up.lengthSq() < 1e-8 || sideways.lengthSq() < 1e-8) return;
    up.normalize();
    // Orthogonalise: the shoulder line is rarely exactly perpendicular to the spine.
    sideways.addScaledVector(up, -sideways.dot(up)).normalize();
    const forward = new THREE.Vector3().crossVectors(sideways, up).normalize();

    // Columns are where clip +x, +y, +z end up in rig space.
    this.basis.makeBasis(sideways, up, forward);
    this.calibrated = true;
  }

  /**
   * The direction `bone` points, in its own local space.
   *
   * A rig that states `boneAxis` is taken at its word — the MakeHuman rigs do,
   * and they were verified against that value. Otherwise it is measured, which
   * is the only option for a VRM.
   *
   * The measurement: a bone's geometry runs from itself to its direct child, and
   * a child's `position` is already expressed in this bone's own space. So the
   * normalised child offset IS the axis. Which child matters where a bone has
   * several — a hand has five — so the chain is followed: the link map already
   * says which joint comes next (`l.from === link.to`), and the direct child on
   * the path to that bone is the one carrying the bone's length.
   */
  private axisFor(bone: THREE.Object3D, link: BoneLink): THREE.Vector3 {
    const stated = this.rig.boneAxis;
    if (stated) return new THREE.Vector3(...stated);

    const nextName = this.rig.links.find((l) => l.from === link.to)?.bone;
    const next = nextName ? this.bones.get(boneKey(nextName)) : undefined;

    let child: THREE.Object3D | null = null;
    if (next) {
      // Climb from the continuation bone until its parent is this bone.
      for (let n: THREE.Object3D | null = next; n; n = n.parent) {
        if (n.parent === bone) {
          child = n;
          break;
        }
      }
    }
    // A tip bone (a distal phalanx) continues nowhere, so fall back to whatever
    // single child it has.
    child ??= bone.children.find((c) => c.position.lengthSq() > 1e-12) ?? null;

    if (child) {
      const axis = child.position.clone();
      if (axis.lengthSq() > 1e-12) return axis.normalize();
    }

    // Leaf bone: take the direction its PARENT points instead.
    //
    // This is the common case, not an edge case. VRM's humanoid defines no
    // fingertip bones, so every Distal phalanx is a leaf on every rig, and
    // falling through to +Y gave all twenty of them an axis 90 degrees from the
    // truth — VRM's normalized finger bones rest along +/-X. Measured on the
    // shipped rigs, every fingertip sat bent about 100 degrees at rest, which
    // is a claw, and solved just as wrongly in motion.
    //
    // `bone.position` is this bone's offset from its parent, which is the
    // direction the parent points. A normalized VRM rests with every bone at
    // identity rotation, so the parent's frame and this bone's frame are
    // aligned and that vector needs no conversion. Anatomically it is also the
    // right answer: a fingertip continues the finger.
    const fromParent = bone.position.clone();
    if (fromParent.lengthSq() > 1e-12) return fromParent.normalize();
    return DEFAULT_BONE_AXIS.clone();
  }

  private build(): void {
    const found: { bone: THREE.Object3D; link: BoneLink }[] = [];
    for (const link of this.rig.links) {
      const bone = this.bones.get(boneKey(link.bone));
      if (bone) found.push({ bone, link });
      else this.missing.push(link.bone);
    }

    // Depth-sort so a parent is always solved before its children — the world
    // rotation a child needs is only correct once its parent has been posed.
    const depth = (b: THREE.Object3D): number => {
      let d = 0;
      for (let p = b.parent; p; p = p.parent) d++;
      return d;
    };
    found.sort((a, b) => depth(a.bone) - depth(b.bone));

    const indexOf = new Map<THREE.Object3D, number>();
    found.forEach(({ bone }, i) => indexOf.set(bone, i));

    this.solved = found.map(({ bone, link }) => {
      // Nearest ancestor that we also drive.
      let parent = -1;
      for (let p = bone.parent; p; p = p.parent) {
        const idx = indexOf.get(p);
        if (idx !== undefined) {
          parent = idx;
          break;
        }
      }
      // Rotation of the bones BETWEEN that ancestor and this one, which we do
      // not drive and which therefore keep their rest value forever. Walking up
      // and premultiplying yields them in parent-to-child order; the loop stops
      // at the driven ancestor, or runs to the scene root when there is none —
      // which is the case this used to handle alone.
      const gap = new THREE.Quaternion();
      for (let p = bone.parent; p; p = p.parent) {
        if (indexOf.get(p) !== undefined) break;
        gap.premultiply(p.quaternion);
      }
      return {
        bone,
        link,
        parent,
        bind: bone.quaternion.clone(),
        gap,
        // Measured before anything is posed — `apply` overwrites the very
        // rotations this reads, so it can only be done now.
        axis: this.axisFor(bone, link),
        // The knuckle genuinely abducts, so it is a hinge with slack. Every
        // joint beyond it is a pure hinge. Non-finger bones stay unconstrained.
        offAxis:
          link.limit === undefined
            ? Infinity
            : /Proximal$|Metacarpal$|-1\.[LR]$/.test(link.bone)
              ? (KNUCKLE_OFF_AXIS * Math.PI) / 180
              : 0,
      };
    });

    this.world = this.solved.map(() => new THREE.Quaternion());
    this.prev = this.solved.map((s) => s.bind.clone());
    this.measureHinges();
    this.measureRolls();
  }

  /**
   * Record each finger joint's flexion axis, measured from the rest pose.
   *
   * `restFrame` curls every finger about the axis a real one bends on, so the
   * rotation it produces away from the bind pose points along that axis. Taking
   * it from there means no per-rig table and no assumption about how a
   * particular skeleton is built — a rig whose fingers rest straight simply
   * yields no hinge and keeps the old free-swing behaviour.
   */
  /**
   * Record where each roll-controlled bone's reference direction sits at rest.
   *
   * Taken in the bone's own space, so a frame's roll is measured as a turn away
   * from rest rather than against any absolute direction — the same trick
   * `measureHinges` uses, and for the same reason: nothing rig-specific is
   * assumed and a rig that cannot supply the reference simply keeps the old
   * swing-only behaviour.
   */
  private measureRolls(): void {
    const before = this.solved.map((s) => s.bone.quaternion.clone());
    this.reset();

    const v = new THREE.Vector3();
    const inv = new THREE.Quaternion();
    for (let i = 0; i < this.solved.length; i++) {
      const s = this.solved[i];
      const { rollFrom, rollTo } = s.link;
      if (rollFrom === undefined || rollTo === undefined) continue;
      const a = REST.positions[rollFrom];
      const b = REST.positions[rollTo];
      if (!tracked(a) || !tracked(b)) continue;
      v.set((b[0] - a[0]) * (this.mirrorX ? -1 : 1), b[1] - a[1], b[2] - a[2]);
      if (this.calibrated) v.applyMatrix4(this.basis);
      if (v.lengthSq() < 1e-8) continue;
      v.normalize().applyQuaternion(inv.copy(this.world[i]).invert());
      s.rollRef = v.clone();
    }

    this.solved.forEach((s, i) => s.bone.quaternion.copy(before[i]));
  }

  private measureHinges(): void {
    const before = this.solved.map((s) => s.bone.quaternion.clone());
    this.reset();

    const delta = new THREE.Quaternion();
    for (const s of this.solved) {
      if (s.link.limit === undefined) continue;
      delta.copy(s.bind).invert().multiply(s.bone.quaternion);
      const axis = new THREE.Vector3(delta.x, delta.y, delta.z);
      // A rest curl too small to point anywhere leaves the joint unconstrained
      // rather than pinned to a guessed axis.
      if (axis.lengthSq() > 1e-8) s.hinge = axis.normalize();
    }

    this.solved.forEach((s, i) => s.bone.quaternion.copy(before[i]));
  }

  /**
   * Pose the skeleton for one clip frame.
   *
   * `mix` blends towards the solved pose rather than snapping, which smooths
   * 25 fps clips up to display rate and softens the handover between signs.
   *
   * `fingerMix` is the same thing for the finger joints, which need a great
   * deal more of it. Measured over 30 clips sampled at display rate, with no
   * smoothing at all: an arm bone moves 1.45 degrees per frame and its speed
   * changes by 0.96 between frames, while a finger joint moves 5.17 and its
   * speed changes by 5.30 — as much as the motion itself. A signal whose
   * frame-to-frame acceleration equals its velocity is not carrying motion, it
   * is carrying noise, and 2D tracking of a foreshortened finger is exactly
   * where that noise comes from. Filtering both at one rate would either leave
   * the fingers buzzing or turn the arms to treacle.
   *
   * Defaults to `mix`, so `reset` and any caller wanting a hard snap gets one.
   */
  apply(frame: SignClipFrame, mix = 1, fingerMix = mix, dtMs = 0): void {
    const pos = frame.positions;
    // Frames-per-second independent: the cap is a speed, so it has to be
    // converted with the real elapsed time. dtMs = 0 means "no cap", which
    // keeps `reset` and the offline harnesses solving exactly as before.
    const maxStep = dtMs > 0 ? (MAX_FINGER_DEG_PER_S * Math.PI * dtMs) / 180000 : 0;
    const maxBoneStep = dtMs > 0 ? (MAX_BONE_DEG_PER_S * Math.PI * dtMs) / 180000 : 0;
    this.rollStep = dtMs > 0 ? (MAX_ROLL_DEG_PER_S * Math.PI * dtMs) / 180000 : 0;

    for (let i = 0; i < this.solved.length; i++) {
      const s = this.solved[i];
      // The driven ancestor's world rotation, then the undriven bones hanging
      // below it. Both halves are needed or the bone solves in the wrong frame.
      const parentWorld =
        s.parent >= 0
          ? this.parentWorld.copy(this.world[s.parent]).multiply(s.gap)
          : s.gap;

      const a = pos[s.link.from];
      const b = pos[s.link.to];

      if (!tracked(a) || !tracked(b)) {
        // Hold the existing rotation, but still publish this bone's world
        // rotation so its children solve against the right frame.
        this.world[i].copy(parentWorld).multiply(s.bone.quaternion);
        continue;
      }

      this.dir.set(
        (b[0] - a[0]) * (this.mirrorX ? -1 : 1),
        b[1] - a[1],
        b[2] - a[2],
      );
      // Too short to trust — see MIN_SEGMENT. Hold, do not guess.
      if (this.dir.lengthSq() < MIN_SEGMENT * MIN_SEGMENT) {
        this.world[i].copy(parentWorld).multiply(s.bone.quaternion);
        continue;
      }
      // Clip space -> rig space before anything else.
      if (this.calibrated) this.dir.applyMatrix4(this.basis);
      this.dir.normalize();

      // Smooth a finger's target direction across frames, in clip space, before
      // anything constrains it. See Solved.dirFilter for why this comes first.
      if (s.link.limit !== undefined && fingerMix < 1) {
        if (s.dirFilter) {
          s.dirFilter.lerp(this.dir, fingerMix);
          if (s.dirFilter.lengthSq() > 1e-8) {
            s.dirFilter.normalize();
            this.dir.copy(s.dirFilter);
          } else {
            // The filter passed through the origin, which only happens when the
            // direction reversed outright. Restart from the new direction
            // rather than normalising a zero vector.
            s.dirFilter.copy(this.dir);
          }
        } else {
          s.dirFilter = this.dir.clone();
        }
      }

      // Into the parent's space, so the result is a valid local rotation.
      this.inv.copy(parentWorld).invert();
      this.dir.applyQuaternion(this.inv);

      // Shortest arc from the bone's own rest axis to the target — a pure
      // "swing". Deliberately no twist: a direction alone cannot say how a bone
      // is rolled about its own axis, and 2D source data carries no twist at
      // all. Inventing one makes forearms and fingers visibly wrong.
      this.q.setFromUnitVectors(s.axis, this.dir);

      // Add the roll the swing could not know about. Only for a bone that
      // states a reference pair — for everything else a direction genuinely
      // carries no twist and inventing one makes forearms visibly wrong.
      if (s.rollRef) this.applyRoll(s, pos);

      // Constrain a finger joint to the way a finger actually moves.
      //
      // This replaced a plain magnitude clamp, which limited how far a joint
      // bent but not which way. Free swing plus 2D tracker noise put fingers
      // sideways and backwards through the palm, and the clamp then stopped
      // them dead against a wall: measured over 34 clips, 2.1% of finger frames
      // reversed direction and 13.1% sat pinned at the limit. A hard stop hit
      // once every eight frames is not a safeguard, it is the twitch.
      if (s.link.limit !== undefined) this.constrainJoint(s);

      // Take only this bone's share of the turn, leaving the rest for the bone
      // below it to solve against. See BoneLink.share.
      const share = s.link.share;
      if (share !== undefined && share < 1) {
        this.scratch.identity().slerp(this.q, share);
        this.q.copy(this.scratch);
      }

      // Finger joints are exactly the bones carrying an anatomical limit, so
      // that flag already tells the two classes apart.
      //
      // Both filters are kept, and they do different jobs. The direction filter
      // above cleans the constraint's INPUT, so it stops eating real spread;
      // this one cleans its OUTPUT, since a clamp can still step discontinuously
      // when it engages. Measured over 32 clips: input filter alone left 8.3% of
      // finger frames reversing direction, output alone 5.4%, both 1.6%.
      // Verified with `node tools/rt/fingers.mjs`.
      const isFinger = s.link.limit !== undefined;
      const m = isFinger ? fingerMix : mix;
      if (m >= 1) s.bone.quaternion.copy(this.q);
      else s.bone.quaternion.slerp(this.q, m);

      // Hold every joint to a speed it can actually reach. Applied last, on the
      // rotation that is about to be shown, so it catches a step no matter
      // which stage produced it.
      const cap = isFinger ? maxStep : maxBoneStep;
      if (cap > 0) {
        this.scratch.copy(this.prev[i]).invert().multiply(s.bone.quaternion);
        const step = 2 * Math.acos(Math.min(1, Math.abs(this.scratch.w)));
        if (step > cap) {
          // Rotate only as far along the same arc as the limit allows: the
          // destination is unchanged, only the approach is slowed.
          //
          // The target is the SMOOTHED rotation just written, not the raw
          // solve in `this.q`. Measuring the step against one arc and then
          // travelling along the other overshoots it — done that way the cap
          // made the worst single-frame jump worse, 17.6 degrees to 95.
          this.capped.copy(s.bone.quaternion);
          s.bone.quaternion.copy(this.prev[i]).slerp(this.capped, cap / step);
        }
      }
      this.prev[i].copy(s.bone.quaternion);


      this.world[i].copy(parentWorld).multiply(s.bone.quaternion);
    }
  }

  /**
   * Rotate `this.q` about the bone's own axis so the roll reference lines up.
   *
   * `this.dir` is the target direction in parent space and `this.inv` the
   * inverse of the parent's world rotation, both already set by `apply`.
   *
   * Falls through silently whenever the reference keypoints are untracked or
   * too close together, leaving the swing-only rotation. That is the right
   * failure: an unknown roll should stay at whatever the previous frame had
   * rather than snap to a guess, and the hand keypoints are missing about a
   * fifth of the time.
   */
  private applyRoll(s: Solved, pos: SignClipFrame["positions"]): void {
    const a = pos[s.link.rollFrom!];
    const b = pos[s.link.rollTo!];
    if (!tracked(a) || !tracked(b)) return;

    this.rollWant.set(
      (b[0] - a[0]) * (this.mirrorX ? -1 : 1),
      b[1] - a[1],
      b[2] - a[2],
    );
    if (this.rollWant.lengthSq() < MIN_SEGMENT * MIN_SEGMENT) return;
    if (this.calibrated) this.rollWant.applyMatrix4(this.basis);
    this.rollWant.normalize().applyQuaternion(this.inv);

    // Where the rest reference ends up once the swing is applied.
    this.rollNow.copy(s.rollRef!).applyQuaternion(this.q);

    // Only the component around the bone's axis is a roll; the rest is the
    // swing that has already been solved.
    this.rollNow.addScaledVector(this.dir, -this.rollNow.dot(this.dir));
    this.rollWant.addScaledVector(this.dir, -this.rollWant.dot(this.dir));
    if (this.rollNow.lengthSq() < 1e-6 || this.rollWant.lengthSq() < 1e-6) return;
    this.rollNow.normalize();
    this.rollWant.normalize();

    const cos = Math.min(1, Math.max(-1, this.rollNow.dot(this.rollWant)));
    this.rollCross.crossVectors(this.rollNow, this.rollWant);
    let angle = this.rollCross.dot(this.dir) < 0 ? -Math.acos(cos) : Math.acos(cos);

    // Resolve the two-branch ambiguity by continuity.
    //
    // A 2D source cannot tell a palm facing the camera from one facing away:
    // the two project to mirror images, so the knuckle line's direction flips
    // sign. Measured across 2,267 frames of the real dictionary, the angle
    // between the palm axis and the knuckle line is plainly bimodal — one
    // cluster near +110 degrees and another near -140, about half a turn
    // apart. Solved literally, the wrist snaps 180 degrees whenever the
    // projection crosses over, which is worse than the arbitrary-but-steady
    // roll this replaces.
    //
    // Both branches fit the evidence equally well, so the one nearer to where
    // the wrist already is wins. That cannot recover which way the palm truly
    // faces — only 3D data can — but it makes the roll continuous and makes it
    // track the hand's turning, instead of flickering between two readings.
    const prev = s.rollPrev ?? 0;
    const alt = angle > 0 ? angle - Math.PI : angle + Math.PI;
    if (Math.abs(alt - prev) < Math.abs(angle - prev)) angle = alt;

    // A wrist has a limited roll, and rolls at a finite speed.
    const limit = (MAX_WRIST_ROLL * Math.PI) / 180;
    angle = Math.min(limit, Math.max(-limit, angle));
    if (this.rollStep > 0) {
      const d = angle - prev;
      if (Math.abs(d) > this.rollStep) angle = prev + Math.sign(d) * this.rollStep;
    }
    s.rollPrev = angle;

    this.rollQ.setFromAxisAngle(this.dir, angle);
    this.q.premultiply(this.rollQ);
  }

  /**
   * Reduce a solved rotation to one the joint can physically make.
   *
   * Decomposes the swing about the measured flexion axis (a swing-twist split),
   * keeps the flexion, and allows only as much off-axis rotation as that joint
   * really has — none beyond the knuckle. The flexion itself is held between a
   * little hyperextension and the anatomical limit.
   *
   * The result is that noise perpendicular to the hinge, which is most of it in
   * a 2D source, stops reaching the pose at all rather than being bent into an
   * impossible shape and then clipped.
   */
  private constrainJoint(s: Solved): void {
    const limit = ((s.link.limit ?? 110) * Math.PI) / 180;
    const floor = -(MAX_HYPEREXTENSION * Math.PI) / 180;
    const h = s.hinge;

    if (!h) {
      // No measured hinge: fall back to limiting magnitude only.
      const angle = 2 * Math.acos(Math.min(1, Math.abs(this.q.w)));
      if (angle > limit) {
        this.axis.set(this.q.x, this.q.y, this.q.z);
        if (this.axis.lengthSq() > 1e-12) {
          this.axis.normalize();
          this.q.setFromAxisAngle(this.axis, this.q.w < 0 ? -limit : limit);
        }
      }
      return;
    }

    // Swing-twist split: the part of `q` that turns about `h` is the flexion.
    const proj = this.q.x * h.x + this.q.y * h.y + this.q.z * h.z;
    this.twist.set(h.x * proj, h.y * proj, h.z * proj, this.q.w);
    const len = Math.hypot(this.twist.x, this.twist.y, this.twist.z, this.twist.w);
    if (len < 1e-12) this.twist.identity();
    else this.twist.set(this.twist.x / len, this.twist.y / len, this.twist.z / len, this.twist.w / len);

    // Signed flexion angle: the twist's vector part lies along h, so its
    // component there is sin(angle/2) with the sign of the bend.
    const sinHalf = this.twist.x * h.x + this.twist.y * h.y + this.twist.z * h.z;
    const angle = 2 * Math.atan2(sinHalf, this.twist.w);
    this.twist.setFromAxisAngle(h, Math.min(limit, Math.max(floor, angle)));

    if (s.offAxis <= 0) {
      this.q.copy(this.twist);
      return;
    }

    // Whatever is left after the flexion is the sideways part. The knuckle
    // keeps a limited amount of it so fingers can still spread.
    this.swing.copy(this.q).multiply(this.scratch.copy(this.twist).invert());
    const off = 2 * Math.acos(Math.min(1, Math.abs(this.swing.w)));
    if (off > s.offAxis) {
      this.axis.set(this.swing.x, this.swing.y, this.swing.z);
      if (this.axis.lengthSq() > 1e-12) {
        this.axis.normalize();
        this.swing.setFromAxisAngle(this.axis, this.swing.w < 0 ? -s.offAxis : s.offAxis);
      }
    }
    this.q.copy(this.swing).multiply(this.twist);
  }

  /**
   * Return to a neutral standing pose — arms down, not the T-pose.
   *
   * Resetting to the bind pose was wrong: rigs are modelled with arms straight
   * out for skinning, so an idle avatar stood with its arms permanently
   * outstretched. Solving a synthetic rest frame instead reuses the normal path,
   * so "resting" is expressed in the same terms as every real sign.
   */
  reset(): void {
    // Drop the direction filters: a new sign starts from the rest pose, and a
    // filter carried over would ease every finger out of the previous sign's
    // handshape instead of into this one's.
    for (const s of this.solved) {
      s.dirFilter = undefined;
      s.rollPrev = undefined;
    }
    // Same reasoning for the speed limit's history: a new sign starts from
    // rest, and limiting it against the previous sign's last pose would drag
    // the first frames of every sign.
    this.solved.forEach((s, i) => this.prev[i]?.copy(s.bind));
    for (const s of this.solved) s.bone.quaternion.copy(s.bind);
    this.apply(REST, 1);
  }
}
