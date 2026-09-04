// Maps clip keypoints onto an avatar's skeleton.
//
// A clip stores POSITIONS — where each of 67 tracked points sat, per frame. A
// rigged model is animated by ROTATING bones. This file describes, for one
// skeleton, which pair of keypoints defines the direction each bone should
// point in. `retarget.ts` turns those directions into rotations.
//
// Adding another avatar
// ---------------------
// Different sources name bones differently (MakeHuman `finger2-1.L`, Mixamo
// `mixamorig:LeftHandIndex1`, AVASAG `Bone_L_Finger1`). Everything that varies
// is data, so a new model needs a new `Rig` entry here and nothing else —
// no changes to the retargeter or the renderer.
//
// Keypoint layout, fixed by the OpenPose converter:
//   0-24   BODY_25 (nose, neck, shoulders, elbows, wrists, hips, …)
//   25-45  left hand,  21 points
//   46-66  right hand, 21 points
//
// Within a hand OpenPose orders points as:
//   0 wrist
//   1-4   thumb   (CMC, MCP, IP, tip)
//   5-8   index   (MCP, PIP, DIP, tip)
//   9-12  middle
//   13-16 ring
//   17-20 pinky

/** One bone, and the two keypoints whose difference gives its direction. */
export interface BoneLink {
  /** Bone name in the glTF skeleton. */
  bone: string;
  /** Keypoint the bone starts at. */
  from: number;
  /** Keypoint it points towards. */
  to: number;
  /**
   * Largest bend this joint may take, in degrees. Omitted means unrestricted.
   *
   * Real finger joints stop at roughly 110 degrees. Measured across 120,000
   * joint-frames of the actual dictionary, 6.4% of solved finger poses exceeded
   * that — tracker noise in a 2D source, which renders as a finger folding
   * backwards through the palm. Clamping is anatomy, not taste.
   */
  limit?: number;
  /**
   * A second keypoint pair fixing this bone's ROLL about its own axis.
   *
   * A single direction cannot say how a bone is rolled — `setFromUnitVectors`
   * returns the shortest arc, whose roll is whatever falls out of the
   * arithmetic. For most bones that is the honest answer, because 2D data
   * carries no twist.
   *
   * The hand is the exception, and it matters more than any other bone: palm
   * orientation is PHONEMIC in sign language. The same handshape and the same
   * location mean different things palm-up and palm-down, so a wrist rolled by
   * accident is not a cosmetic fault, it changes the sign.
   *
   * The data is already there. The 21 hand keypoints give the plane of the
   * hand, so the direction across the knuckles (index base to little base)
   * fixes the roll that the wrist-to-middle-knuckle vector alone leaves free.
   */
  rollFrom?: number;
  rollTo?: number;
  /**
   * Fraction of the solved rotation this bone takes, 0..1. Default 1 (all).
   *
   * A real neck is not one hinge. The cervical spine and the skull share a turn
   * between them, which is why a person's head arrives at an angle rather than
   * swinging to it like a lever. Driving `neck` alone put the whole rotation in
   * one joint, and that is what read as mechanical.
   *
   * Giving the neck part of the turn lets the bone below solve the remainder
   * naturally: each bone is solved against its parent's world rotation, so
   * whatever the neck does not do is exactly what is left for the head. The
   * motion is the same measured motion, distributed the way a neck distributes
   * it — nothing is invented.
   */
  share?: number;
}

/**
 * Landmark bones, by this rig's own naming.
 *
 * `calibrate`, `orientUpright` and `frameCamera` all need to find the same five
 * places on a skeleton: the base of the spine, the neck, the head, and the two
 * shoulders. Those used to be written into each of those functions as MakeHuman
 * names (`spine05`, `upperarm01.L`), which silently meant "MakeHuman or
 * nothing" — a VRM has none of those names, so calibration would fail and, as
 * it does on failure, leave the basis as identity and the camera unframed.
 *
 * Naming them here instead is what lets a second skeleton exist at all.
 */
export interface Landmarks {
  /** Base of the spine / pelvis. Bottom of the "up" measurement. */
  hips: string;
  /** Top of the "up" measurement. */
  neck: string;
  head: string;
  /** Subject's left and right shoulder, which together give handedness. */
  leftArm: string;
  rightArm: string;
  /**
   * Elbow and hand on the subject's left, used to measure how far this avatar
   * can reach.
   *
   * Framing needs reach, not shoulder width. Signing space is bounded by how
   * far a hand travels from the midline, which is half the shoulders plus the
   * arm — and on stylised avatars those two are unrelated. Measured across the
   * twelve shipped rigs, the width the clips actually need varies from 1.9 to
   * 5.9 times the shoulder span (Ferk's shoulders are 0.11 wide against a 0.47
   * arm), so no shoulder-based constant can frame them all. Against
   * `shoulders/2 + arm` the same measurements land between 0.57 and 0.68.
   *
   * Optional: a rig that omits them falls back to a shoulder-span estimate.
   */
  leftElbow?: string;
  leftHand?: string;
}

export interface Rig {
  id: string;
  label: string;
  /** File in the extension's root, published via web_accessible_resources. */
  file: string;
  /**
   * How to load `file`.
   *
   * `vrm` files are glTF underneath, but they must go through VRMLoaderPlugin
   * to get a humanoid — and they are then driven through VRM's *normalized*
   * bones rather than the raw skeleton, which is the entire reason for using
   * the format: bone identity comes from the file, not from a name table.
   */
  format: "gltf" | "vrm";
  links: BoneLink[];
  landmarks: Landmarks;
  /**
   * The direction a bone points, in its own local space — if it is the same for
   * every bone in this rig.
   *
   * MakeHuman's rigs come off the FBX -> Blender -> glTF route with every bone
   * pointing along its own +Y, which is Blender's convention and survives the
   * export. Stating it explicitly keeps those rigs solving exactly as they were
   * verified to.
   *
   * A VRM has no such convention. Its bind pose is a mandated T-pose and its
   * normalized bones rest with identity rotations, so an arm bone points along
   * world ±X and a spine bone along +Y — measured on the shipped avatar:
   *
   *     rightUpperArm      ( 1.00, -0.00, -0.00)   X+
   *     rightIndexProximal ( 1.00, -0.00,  0.00)   X+
   *     spine              ( 0.00,  1.00,  0.07)   Y+
   *
   * Leaving this undefined tells the retargeter to measure each bone's rest
   * direction from the bind pose instead. Solving a VRM with the +Y assumption
   * puts every arm and finger bone 90 degrees out.
   */
  boneAxis?: [number, number, number];
}

// ── Keypoint indices ────────────────────────────────────────────────────────

const NOSE = 0;
const NECK = 1;
const R_SHOULDER = 2;
const R_ELBOW = 3;
const R_WRIST = 4;
const L_SHOULDER = 5;
const L_ELBOW = 6;
const L_WRIST = 7;

const L_HAND = 25;
const R_HAND = 46;

/** Point `n` of the left or right hand. */
const lh = (n: number) => L_HAND + n;
const rh = (n: number) => R_HAND + n;

/**
 * Finger chains as (base, joint1, joint2, tip) offsets into a hand's 21 points.
 * Index 0 (the wrist) anchors the metacarpals.
 */
/** Anatomical ceiling for a finger joint, in degrees. */
const FINGER_LIMIT = 110;

/**
 * Fraction of the measured head movement actually rendered. 0 = a fixed head.
 *
 * The head direction comes from the neck-to-nose vector, and in a 2D source
 * that vector is mostly noise. Measured over 82 clips and 4,490 frames:
 *
 *     head tilt      p05 -10.6 deg, median 0.0, p95 +11.0, sd 7.4
 *     per frame      mean 0.69 deg of change
 *     REVERSALS      48.2% of frames change direction
 *
 * A real head movement — a nod, a headshake, a tilt held through a clause — is
 * sustained. Reversing direction on half of all frames is the signature of
 * tracker jitter, and rendered at full strength it read as a constant wobble
 * that drew the eye away from the hands, which is where the meaning is.
 *
 * Stated honestly, because it is a real loss: head movement in sign language
 * DOES carry grammar — headshake for negation, nod for affirmation, tilt for
 * topics and conditionals. Two things make it unrecoverable here rather than
 * merely noisy. A nod rotates toward and away from the camera, which a 2D
 * source barely records at all; and what does survive is side-tilt, the least
 * grammatically loaded component, buried in 48% reversal noise. Damping
 * discards jitter, not meaning. Recovering the meaning needs 3D source data,
 * not a larger share of this signal.
 *
 * Measured on the rendered skeleton with `node tools/rt/head.mjs`, across all
 * 12 rigs: 0.8 to 1.1 degrees of standard deviation, which is 12-17% of the
 * source's 6.4 — lower than 0.25 alone, because the playback smoothing damps
 * what is left. Reversals fall from 48.2% to under 1% on most rigs.
 *
 * That is present enough that the avatar is not a mannequin and small enough to
 * ignore while reading the hands. Set this to 0 for a completely fixed head.
 */
const HEAD_MOTION = 0.25;

/**
 * The neck/head split, preserved through the damping above.
 *
 * A real neck is not one hinge. The cervical spine and the skull share a turn
 * between them, which is why a person's head arrives at an angle rather than
 * swinging to it like a lever. The neck takes 55% of whatever movement is
 * rendered and the skull resolves the remainder.
 *
 * `head` is solved against `neck`'s world rotation, so its share applies to
 * what the neck did NOT do. Damping the neck alone would achieve nothing — the
 * head would simply absorb the rest. These two solve to exactly HEAD_MOTION of
 * the original turn:
 *
 *     NECK_SHARE + (1 - NECK_SHARE) * HEAD_SHARE  ===  HEAD_MOTION
 */
const NECK_SHARE = 0.55 * HEAD_MOTION;
const HEAD_SHARE = (HEAD_MOTION - NECK_SHARE) / (1 - NECK_SHARE);

const FINGERS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
} as const;



/**
 * VRM 1.0's standard humanoid skeleton.
 *
 * The contrast with `makeHumanLinks` is the argument for the format. There the
 * bone names are a convention of one authoring tool, discovered by reading an
 * export and transcribed by hand — which is why `boneKey` exists, and why 46 of
 * 47 bones once failed to resolve over a dropped separator. Here the names are
 * fixed by the specification, so this same map drives *any* VRM.
 *
 * Two structural differences from MakeHuman, both from the spec:
 *
 *   * There are no metacarpal bones for index/middle/ring/little. The hand
 *     bone covers the palm, so each of those fingers is three bones, not four.
 *   * The thumb is `Metacarpal, Proximal, Distal` — three bones like the rest,
 *     rather than MakeHuman's thumb-off-the-wrist special case.
 *
 * There are also no twist bones, so the note about `upperarm02` does not apply:
 * a VRM arm is one bone per segment, which is exactly what 2D clip data can
 * inform and no more.
 */
function vrmLinks(): BoneLink[] {
  const links: BoneLink[] = [];

  links.push(
    { bone: "neck", from: NECK, to: NOSE, share: NECK_SHARE },
    { bone: "head", from: NECK, to: NOSE, share: HEAD_SHARE },
  );

  for (const side of ["left", "right"] as const) {
    const S = side === "left" ? "left" : "right";
    const shoulder = side === "left" ? L_SHOULDER : R_SHOULDER;
    const elbow = side === "left" ? L_ELBOW : R_ELBOW;
    const wrist = side === "left" ? L_WRIST : R_WRIST;
    const hand = side === "left" ? lh : rh;

    links.push(
      { bone: `${S}Shoulder`, from: NECK, to: shoulder },
      { bone: `${S}UpperArm`, from: shoulder, to: elbow },
      { bone: `${S}LowerArm`, from: elbow, to: wrist },
      // As with MakeHuman: the middle finger's base is the most reliably
      // tracked hand point and sits on the palm's axis. `roll` adds the
      // knuckle line, which is what fixes palm orientation — see BoneLink.roll.
      {
        bone: `${S}Hand`,
        from: wrist,
        to: hand(FINGERS.middle[0]),
        rollFrom: hand(FINGERS.index[0]),
        rollTo: hand(FINGERS.pinky[0]),
      },
    );

    // Thumb — CMC, MCP, IP in OpenPose terms, which map onto VRM's
    // Metacarpal, Proximal, Distal.
    const [t1, t2, t3, t4] = FINGERS.thumb;
    links.push(
      { bone: `${S}ThumbMetacarpal`, from: hand(t1), to: hand(t2), limit: FINGER_LIMIT },
      { bone: `${S}ThumbProximal`, from: hand(t2), to: hand(t3), limit: FINGER_LIMIT },
      { bone: `${S}ThumbDistal`, from: hand(t3), to: hand(t4), limit: FINGER_LIMIT },
    );

    const others = [
      ["Index", FINGERS.index],
      ["Middle", FINGERS.middle],
      ["Ring", FINGERS.ring],
      ["Little", FINGERS.pinky], // VRM calls the pinky "Little"
    ] as const;

    for (const [digit, chain] of others) {
      const [a, b, c, d] = chain;
      links.push(
        { bone: `${S}${digit}Proximal`, from: hand(a), to: hand(b), limit: FINGER_LIMIT },
        { bone: `${S}${digit}Intermediate`, from: hand(b), to: hand(c), limit: FINGER_LIMIT },
        { bone: `${S}${digit}Distal`, from: hand(c), to: hand(d), limit: FINGER_LIMIT },
      );
    }
  }

  return links;
}

/** VRM landmark names. Fixed by the specification, so true of every VRM. */
const VRM_LANDMARKS: Landmarks = {
  hips: "hips",
  neck: "neck",
  head: "head",
  leftArm: "leftUpperArm",
  rightArm: "rightUpperArm",
  leftElbow: "leftLowerArm",
  leftHand: "leftHand",
};

// The four MakeHuman rigs share the "Default simplified" skeleton — same 137
// bones, same `finger1-1.L` naming — so they all reuse one map. A model built
// elsewhere (Mixamo's `mixamorig:LeftHandIndex1`, say) needs its own links
// function and nothing more; the retargeter and renderer are unchanged.
//
// All twelve shipped avatars are CC0 VRM models by Polygonal Mind, from their
// 100 Avatars project. VRM is what makes this list pure data: the file declares
// its own humanoid, so `vrmLinks()` drives every one of them and adding an
// avatar needs no bone table at all.
//
// Verified by `node tools/rt/smooth.mjs` before landing: 40/40 mapped bones
// resolve on each rig with none missing, no NaN or non-unit quaternions across
// a full clip, and the playback smoothing removes ~90% of frame-to-frame jerk.
//
// (An earlier iteration built .glb rigs from MakeHuman FBX exports through
// Blender. That pipeline is retired -- those rigs no longer ship.)
//
// `label` is what the settings picker shows. They are placeholders — naming a
// signer is a decision for whoever owns the project, not the converter.
export const RIGS: Rig[] = [
  // All rigs are VRM, all by Polygonal Mind, all CC0 with commercial use
  // permitted — verified from each file's own VRM metadata, not assumed.
  //
  // Every one was checked before being listed here: it loads through
  // VRMLoaderPlugin, exposes a humanoid, and resolves all 39 bones the map
  // drives. They are VRM 0.x, which three-vrm normalises to the 1.0 humanoid,
  // so nothing below has to care about the version.
  //
  // Deliberately no `boneAxis` on any of them — a VRM's bones do not share one
  // local axis and must be measured from the bind pose. See the field's note.
  //
  // Known gap, unchanged from the first VRM: these expression sets are visemes
  // and emotions with no brow control, so ASL question marking is not reachable
  // on any of them. Non-manual markers need an avatar with brow blendshapes.
  {
    id: "vrm1",
    label: "Aurora",
    file: "avatar-vrm1.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "coolalien",
    label: "Cool Alien",
    file: "CoolAlien.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "coolbanana",
    label: "Cool Banana",
    file: "CoolBanana.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "crimsom",
    label: "Crimsom",
    file: "Crimsom.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "eggboy",
    label: "Egg Boy",
    file: "EggBOY.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "erika",
    label: "Erika",
    file: "Erika.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "ferk",
    label: "Ferk",
    file: "Ferk.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "horrornurse",
    label: "Horror Nurse",
    file: "HorrorNurse.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "jennifer",
    label: "Jennifer",
    file: "Jennifer.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "pumpkin",
    label: "Pumpkin",
    file: "Pumpkin.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "skull",
    label: "Skull",
    file: "Skull.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
  {
    id: "zombie",
    label: "Zombie",
    file: "Zombie.vrm",
    format: "vrm",
    links: vrmLinks(),
    landmarks: VRM_LANDMARKS,
  },
];

// ── Rest pose ───────────────────────────────────────────────────────────────

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** `a` plus `k` times `b`. */
const step = (a: V3, b: V3, k: number): V3 => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
];
/** Unit `a` tilted `deg` degrees towards unit `b`. */
const lean = (a: V3, b: V3, deg: number): V3 => {
  const r = (deg * Math.PI) / 180;
  return norm(step(scale(a, Math.cos(r)), b, Math.sin(r)));
};

/**
 * Bend of each phalanx relative to the one before it, in degrees.
 *
 * Small and increasing towards the tip, which is how a hand hangs when nothing
 * is asked of it. Fingers straight is a soldier standing to attention; fully
 * folded is a fist. Neither is a signer waiting for the next word.
 */
const REST_CURL = [15, 45, 65];
/** Palm and phalanx lengths, in clip units (shoulder width = 0.4). */
const PALM = 0.075;
const PHALANX = [0.034, 0.024, 0.018];
const THUMB_SEG = [0.032, 0.024, 0.02];

/**
 * A neutral standing pose, expressed as clip keypoints.
 *
 * The rigs are modelled in a T-pose — arms straight out sideways — because that
 * is the standard bind pose for skinning. But T-pose is not a resting pose: an
 * avatar idling with its arms out looks like it is permanently mid-jumping-jack.
 *
 * Rather than author per-rig bone rotations, this describes the rest pose in the
 * SAME coordinate space as the dictionary clips and lets the ordinary solver
 * turn it into rotations. One definition therefore serves every rig, present and
 * future, and it can never disagree with how real clips are interpreted.
 *
 * Values follow the measured convention of the real data: neck at the origin,
 * the subject's right at negative x, up at positive y, +z towards the viewer,
 * shoulders ~0.2 either side.
 *
 * The arms are not straight. An earlier version hung them dead vertical with
 * the fingers pointing at the floor, which reads as a mannequin — real elbows
 * carry a bend even at rest, and a signer waits with the hands forward, around
 * waist height, ready to come up into signing space. Posing them that way also
 * keeps the hands inside the head-to-waist crop, which straight arms did not.
 */
export function restFrame(): { t: number; positions: V3[] } {
  const p: V3[] = Array.from({ length: 67 }, () => [0, 0, 0] as V3);

  p[NOSE] = [0, 0.2, 0];
  p[NECK] = [0, 0, 0];

  for (const side of ["L", "R"] as const) {
    const sx = side === "L" ? 1 : -1;
    const base = side === "L" ? L_HAND : R_HAND;

    // Upper arm hangs almost vertically; the forearm comes up, inwards and
    // forwards, leaving a ~68 degree bend at the elbow. That is the posture a
    // signer waits in — hands loosely in front of the body, a short move from
    // signing space — and, unlike arms at the sides, it puts them where the
    // camera is actually looking.
    const shoulder: V3 = [0.2 * sx, -0.02, 0];
    const elbow: V3 = [0.225 * sx, -0.3, 0.02];
    const wrist: V3 = [0.13 * sx, -0.38, 0.21];

    p[side === "L" ? L_SHOULDER : R_SHOULDER] = shoulder;
    p[side === "L" ? L_ELBOW : R_ELBOW] = elbow;
    p[side === "L" ? L_WRIST : R_WRIST] = wrist;
    p[base] = wrist;

    // A frame for the hand, built from the arm so it needs no constants of its
    // own: the palm carries on along the forearm, the fingers fold towards the
    // body (`curl`), and `across` runs over the knuckles towards the pinky.
    const forearm = norm(sub(wrist, elbow));
    const inwards = norm([-0.35 * sx, 0, -0.94]);
    // Orthogonalise so tilting towards it is a bend and nothing else — a curl
    // axis with any forearm component in it would stretch the finger instead.
    const curl = norm(step(inwards, forearm, -dot(inwards, forearm)));
    const across = scale(norm(cross(forearm, curl)), sx);

    const spread = [-0.021, -0.007, 0.007, 0.021]; // index .. pinky
    const chains = [FINGERS.index, FINGERS.middle, FINGERS.ring, FINGERS.pinky];
    chains.forEach((chain, f) => {
      let pt = step(step(wrist, forearm, PALM), across, spread[f]);
      p[base + chain[0]] = pt;
      for (let seg = 0; seg < 3; seg++) {
        pt = step(pt, lean(forearm, curl, REST_CURL[seg]), PHALANX[seg]);
        p[base + chain[seg + 1]] = pt;
      }
    });

    // Thumb: it sits on the forward edge of the hand — the palm faces the body
    // at rest — angled across towards the index and barely bent. Curling it
    // like a finger closes the hand into a fist, which is a handshape, not a
    // rest.
    const thumbDir = norm(step(step(scale(forearm, 0.86), curl, -0.28), across, -0.36));
    let tp = step(step(step(wrist, forearm, 0.025), curl, -0.03), across, -0.03);
    p[base + FINGERS.thumb[0]] = tp;
    FINGERS.thumb.slice(1).forEach((idx, seg) => {
      tp = step(tp, lean(thumbDir, curl, seg * 9), THUMB_SEG[seg]);
      p[base + idx] = tp;
    });
  }

  return { t: 0, positions: p };
}

// ── Depth for flat clips ────────────────────────────────────────────────────

/**
 * Where the arm sits, front to back, for a clip that has no depth at all.
 *
 * Every clip in the dictionary declares `"source": "openpose-2d"` and carries
 * `z = 0` on every keypoint — not "at the body plane" but *unrecorded*. Solving
 * them as written puts the whole arm in the signer's own coronal plane, so the
 * hands end up inside the torso and render behind the chest. Measured on a real
 * clip against the shipped VRM: the rest pose puts the hands 0.226 in front of
 * the hips, a real clip puts them at -0.002.
 *
 * Depth cannot be recovered from a frontal projection, so it is supplied. These
 * are the same values `restFrame` already uses for a signer waiting to sign, so
 * a clip now begins roughly where rest leaves off instead of collapsing
 * backwards into the body the moment one starts.
 *
 * The ramp matters more than the magnitude. The solver reads *differences*
 * between keypoints, so pushing every point forward by the same amount would
 * change nothing at all — it is the shoulder-to-elbow-to-wrist gradient that
 * swings the arm out of the body plane.
 *
 * This is a substitute for depth, not depth. It cannot distinguish a sign that
 * moves toward the chest from one that moves across it, which is a real
 * phonemic contrast in ASL. Only 3D source data fixes that.
 */
const SIGNING_DEPTH = { elbow: 0.06, wrist: 0.2 };

/**
 * Give a flat clip frame a plausible front-to-back profile.
 *
 * Applied to clip data only. `restFrame` already carries depth and must not be
 * offset twice.
 */
export function addSigningDepth(frame: {
  t: number;
  positions: V3[];
}): { t: number; positions: V3[] } {
  const p = frame.positions.map((q) => [q[0], q[1], q[2]] as V3);

  // Only touch points the tracker actually saw. An untracked point is [0,0,0],
  // and `tracked()` in the retargeter recognises it by x and y alone — so
  // writing a z onto one would leave it untracked but no longer obviously so.
  const put = (i: number, z: number): void => {
    if (p[i] && (p[i][0] !== 0 || p[i][1] !== 0)) p[i][2] = z;
  };

  put(L_ELBOW, SIGNING_DEPTH.elbow);
  put(R_ELBOW, SIGNING_DEPTH.elbow);
  put(L_WRIST, SIGNING_DEPTH.wrist);
  put(R_WRIST, SIGNING_DEPTH.wrist);

  // The whole hand travels with the wrist. Giving the 21 hand points a depth
  // *gradient* instead would tip every finger forward regardless of the
  // handshape, which is worse than leaving the hand plane parallel to the body.
  for (let i = 0; i < 21; i++) {
    put(L_HAND + i, SIGNING_DEPTH.wrist);
    put(R_HAND + i, SIGNING_DEPTH.wrist);
  }

  return { t: frame.t, positions: p };
}

export function rigById(id: string): Rig {
  return RIGS.find((r) => r.id === id) ?? RIGS[0];
}

/**
 * Normalise a bone name so the maps above match a model however it was exported.
 *
 * MakeHuman names the left forearm `lowerarm01.L`, and that is what the links
 * here say. The glTF in `public/` calls it `lowerarm01L` — the separator is
 * dropped somewhere on the FBX -> Blender -> glTF route, and Blender's own
 * `.001` de-duplication suffixes mean the punctuation was never dependable
 * anyway.
 *
 * That mismatch silently cost 46 of the 47 mapped bones: only `neck01`, the one
 * name with no side suffix, ever resolved. The avatar therefore stood in its
 * bind pose with the arms out, and calibration — which looks up `upperarm01.L`
 * — failed too, so the camera never framed anything either. Both looked like
 * rendering bugs and neither was.
 *
 * Comparing on a key rather than the literal name fixes it for every model at
 * once, in whichever convention it happens to use. Verified collision-free
 * across all 126 bones of the shipped rigs.
 */
export function boneKey(name: string): string {
  return name.replace(/[._\s]/g, "").toLowerCase();
}
