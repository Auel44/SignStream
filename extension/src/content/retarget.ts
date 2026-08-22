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

/** Every bone points along its own +Y — see the note above. */
const BONE_AXIS = new THREE.Vector3(0, 1, 0);

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
  bone: THREE.Bone;
  link: BoneLink;
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
  /** Keyed by `boneKey`, not by literal name — see the note there. */
  private readonly bones = new Map<string, THREE.Bone>();
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

  /**
   * @param mirrorX Flip left/right. A camera sees a signer mirrored, so whether
   *   the clip's "left wrist" is the rig's left depends on how the source was
   *   recorded. Exposed rather than assumed.
   */
  constructor(
    root: THREE.Object3D,
    private readonly rig: Rig,
    private readonly mirrorX = false,
  ) {
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(boneKey(o.name), o as THREE.Bone);
    });
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

    // MakeHuman numbers the spine downwards: spine01 is the upper chest and
    // spine05 the pelvis. Measuring "up" from spine01 spans only the chest, and
    // on the shipped rigs that stub of spine leans forward — it put the up axis
    // 17 degrees off vertical, which tilts both the solved pose and the camera.
    const hips = posOf("spine05") ?? posOf("spine04") ?? posOf("spine01");
    const neck = posOf("neck01") ?? posOf("head");
    const left = posOf("upperarm01.L") ?? posOf("clavicle.L");
    const right = posOf("upperarm01.R") ?? posOf("clavicle.R");
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

  private build(): void {
    const found: { bone: THREE.Bone; link: BoneLink }[] = [];
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

    const indexOf = new Map<THREE.Bone, number>();
    found.forEach(({ bone }, i) => indexOf.set(bone, i));

    this.solved = found.map(({ bone, link }) => {
      // Nearest ancestor that we also drive.
      let parent = -1;
      for (let p = bone.parent; p; p = p.parent) {
        const idx = indexOf.get(p as THREE.Bone);
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
        if (indexOf.get(p as THREE.Bone) !== undefined) break;
        gap.premultiply(p.quaternion);
      }
      return { bone, link, parent, bind: bone.quaternion.clone(), gap };
    });

    this.world = this.solved.map(() => new THREE.Quaternion());
  }

  /**
   * Pose the skeleton for one clip frame.
   *
   * `mix` blends towards the solved pose rather than snapping, which smooths
   * 25 fps clips up to display rate and softens the handover between signs.
   */
  apply(frame: SignClipFrame, mix = 1): void {
    const pos = frame.positions;

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

      // Into the parent's space, so the result is a valid local rotation.
      this.inv.copy(parentWorld).invert();
      this.dir.applyQuaternion(this.inv);

      // Shortest arc from the bone's axis to the target — a pure "swing".
      // Deliberately no twist: a direction alone cannot say how a bone is
      // rolled about its own axis, and 2D source data carries no twist at all.
      // Inventing one makes forearms and fingers visibly wrong.
      this.q.setFromUnitVectors(BONE_AXIS, this.dir);

      // Anatomical clamp. The rest pose has each phalanx roughly in line with
      // its parent, so this rotation's magnitude is the joint's bend — and a
      // finger that bends past ~110 degrees has folded through the palm. The
      // cause is tracker noise in 2D source data, not real motion.
      const limit = s.link.limit;
      if (limit !== undefined) {
        const angle = 2 * Math.acos(Math.min(1, Math.abs(this.q.w)));
        const max = (limit * Math.PI) / 180;
        if (angle > max) {
          this.axis.set(this.q.x, this.q.y, this.q.z);
          if (this.axis.lengthSq() > 1e-12) {
            this.axis.normalize();
            this.q.setFromAxisAngle(this.axis, this.q.w < 0 ? -max : max);
          }
        }
      }

      if (mix >= 1) s.bone.quaternion.copy(this.q);
      else s.bone.quaternion.slerp(this.q, mix);

      this.world[i].copy(parentWorld).multiply(s.bone.quaternion);
    }
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
    for (const s of this.solved) s.bone.quaternion.copy(s.bind);
    this.apply(REST, 1);
  }
}
