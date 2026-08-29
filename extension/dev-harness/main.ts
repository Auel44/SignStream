// VRM verification harness.
//
// Answers four questions, in order, before any of the extension's own code is
// touched:
//
//   1. Does @pixiv/three-vrm load test.vrm against the three version we ship?
//   2. Does the VRM humanoid actually expose the bones signing needs?
//   3. Can those bones be driven — arm, and crucially fingers?
//   4. Along which axis does each bone rest?
//
// Question 4 is the one that decides how retarget.ts must change. That solver
// assumes every bone points along its own +Y (`BONE_AXIS`), which is true of the
// MakeHuman -> Blender -> glTF rigs we ship. If it is not true of a VRM, the
// solver cannot be pointed at a VRM unchanged, and this page is where we find
// that out rather than discovering it as a wrongly-posed avatar.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const factsEl = document.getElementById("facts") as HTMLDListElement;
const axesEl = document.getElementById("axes") as HTMLDListElement;
const logEl = document.getElementById("log") as HTMLParagraphElement;

function row(target: HTMLDListElement, label: string, value: string, cls = ""): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (cls) dd.className = cls;
  target.append(dt, dd);
}

// ── Scene ──────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.width, canvas.height, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, canvas.width / canvas.height, 0.01, 100);

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 0.85);
key.position.set(2, 4, 3);
scene.add(key);

// ── Load ───────────────────────────────────────────────────────────────────

let vrm: VRM | null = null;

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  "/avatar-vrm1.vrm",
  (gltf) => {
    vrm = gltf.userData.vrm as VRM;

    // Both are pure optimisations, and both are safe on a model we only pose:
    // unused vertices go, and the many small skeletons collapse into one, which
    // is what keeps a 69-node rig cheap to update every frame.
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);

    scene.add(vrm.scene);
    report(vrm);
    frameCamera(vrm);
  },
  undefined,
  (err) => {
    row(factsEl, "load", "FAILED", "bad");
    logEl.textContent = String(err);
  },
);

// ── Report ─────────────────────────────────────────────────────────────────

/** The bones the signing pipeline has to be able to drive. */
const SIGNING_BONES = [
  "hips", "spine", "chest", "neck", "head",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
  "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
] as const;

const FINGER_BONES = (["left", "right"] as const).flatMap((side) =>
  (["Thumb", "Index", "Middle", "Ring", "Little"] as const).flatMap((digit) =>
    (digit === "Thumb"
      ? (["Metacarpal", "Proximal", "Distal"] as const)
      : (["Proximal", "Intermediate", "Distal"] as const)
    ).map((seg) => `${side}${digit}${seg}`),
  ),
);

function bone(v: VRM, name: string): THREE.Object3D | null {
  // Normalized bones, not raw ones: identity rotations at rest and a name that
  // means the same thing on every model. This is the whole argument for VRM.
  return v.humanoid.getNormalizedBoneNode(name as never);
}

function report(v: VRM): void {
  const spec = v.meta.metaVersion === "1" ? "VRM 1.0" : "VRM 0.x";
  row(factsEl, "loaded", "OK", "ok");
  row(factsEl, "spec", spec);
  row(factsEl, "name", (v.meta as { name?: string; title?: string }).name ?? "?");

  const haveSigning = SIGNING_BONES.filter((b) => bone(v, b));
  const missing = SIGNING_BONES.filter((b) => !bone(v, b));
  row(
    factsEl,
    "signing bones",
    `${haveSigning.length}/${SIGNING_BONES.length}${missing.length ? " — missing " + missing.join(", ") : ""}`,
    missing.length ? "bad" : "ok",
  );

  const haveFingers = FINGER_BONES.filter((b) => bone(v, b));
  row(
    factsEl,
    "finger bones",
    `${haveFingers.length}/30`,
    haveFingers.length === 30 ? "ok" : "bad",
  );

  const expr = v.expressionManager?.expressions ?? [];
  row(factsEl, "expressions", String(expr.length));

  measureAxes(v);
}

/**
 * Measure which way each bone points, in its own local space.
 *
 * `retarget.ts` solves `setFromUnitVectors(BONE_AXIS, target)` with BONE_AXIS
 * fixed at (0,1,0). That is only correct if a bone's rest direction — the
 * offset from it to its child — really is +Y in its own frame. Measuring it is
 * the difference between knowing and hoping.
 */
function measureAxes(v: VRM): void {
  const pairs: [string, string][] = [
    ["rightUpperArm", "rightLowerArm"],
    ["rightLowerArm", "rightHand"],
    ["rightIndexProximal", "rightIndexIntermediate"],
    ["spine", "chest"],
  ];

  let allY = true;
  for (const [from, to] of pairs) {
    const a = bone(v, from);
    const b = bone(v, to);
    if (!a || !b) {
      row(axesEl, from, "absent", "bad");
      continue;
    }
    // Child's offset expressed in the parent bone's own space.
    const dir = b.position.clone().normalize();
    const isY = dir.dot(new THREE.Vector3(0, 1, 0)) > 0.95;
    if (!isY) allY = false;
    row(
      axesEl,
      from,
      `(${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)})`,
      isY ? "ok" : "bad",
    );
  }

  logEl.textContent = allY
    ? "All measured bones rest along +Y, so retarget.ts's BONE_AXIS holds."
    : "Bones do NOT rest along +Y. retarget.ts assumes (0,1,0) and must be " +
      "changed to use each bone's measured rest direction before a VRM can be " +
      "driven by clip data.";
}

// ── Framing: head to waist, as the extension crops ─────────────────────────

function frameCamera(v: VRM): void {
  const hips = bone(v, "hips");
  const head = bone(v, "head");
  const armL = bone(v, "leftUpperArm");
  const armR = bone(v, "rightUpperArm");
  if (!hips || !head || !armL || !armR) return;

  v.scene.updateMatrixWorld(true);
  const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
  const waist = at(hips);
  const top = at(head);

  // Which way does the model face? Measured, not assumed — the first version of
  // this file assumed +Z and showed the avatar's back, because this VRM is 0.x
  // and 0.x models face -Z. Deriving it from the skeleton is right for either
  // version, and for any model however it was exported:
  //
  //   up      = hips -> head
  //   left    = right shoulder -> left shoulder   (the subject's own left)
  //   forward = left x up
  //
  // The same three lines as Retargeter.calibrate(), for the same reason.
  const up = top.clone().sub(waist).normalize();
  const left = at(armL).sub(at(armR));
  left.addScaledVector(up, -left.dot(up)).normalize(); // orthogonalise
  const forward = new THREE.Vector3().crossVectors(left, up).normalize();

  // The head bone sits at the base of the skull; extend to take in the crown.
  const span = top.distanceTo(waist);
  top.addScaledVector(up, span * 0.3);

  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanX = tanY * camera.aspect;
  const spanY = top.distanceTo(waist);
  const spanX = spanY * 0.75; // signing space is wider than the torso
  const distance = Math.max(spanY / 2 / tanY, spanX / 2 / tanX);

  const centre = waist
    .clone()
    .addScaledVector(up, distance * tanY - spanY * 0.12);

  camera.position.copy(centre).addScaledVector(forward, distance);
  camera.up.copy(up);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();

  row(factsEl, "faces", forward.z < -0.5 ? "-Z (VRM 0.x)" : forward.z > 0.5 ? "+Z (VRM 1.0)" : "sideways");
}

// ── Drive ──────────────────────────────────────────────────────────────────

const modes = { wave: false, fingers: false, blink: false };

function toggle(id: string, kmodes: keyof typeof modes): void {
  const btn = document.getElementById(id) as HTMLButtonElement;
  btn.addEventListener("click", () => {
    modes[kmodes] = !modes[kmodes];
    btn.setAttribute("aria-pressed", String(modes[kmodes]));
  });
}
toggle("btn-wave", "wave");
toggle("btn-fingers", "fingers");
toggle("btn-blink", "blink");

(document.getElementById("btn-rest") as HTMLButtonElement).addEventListener("click", () => {
  for (const k of Object.keys(modes) as (keyof typeof modes)[]) {
    modes[k] = false;
    document.querySelector(`#btn-${k}`)?.setAttribute("aria-pressed", "false");
  }
});

const clock = new THREE.Clock();

function tick(): void {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  if (vrm) {
    const set = (name: string, x: number, y: number, z: number): void => {
      const b = bone(vrm!, name);
      if (b) b.rotation.set(x, y, z);
    };

    // Rest: arms down at the sides. A VRM's bind pose is a T-pose, so without
    // this the avatar stands with its arms straight out — the exact symptom the
    // shipped rigs had before restFrame() existed.
    set("rightUpperArm", 0, 0, -1.25);
    set("leftUpperArm", 0, 0, 1.25);
    set("rightLowerArm", 0, 0, 0);
    set("leftLowerArm", 0, 0, 0);

    if (modes.wave) {
      // Lift the right arm into signing space and bend the elbow. Slow, so the
      // question "is the skeleton actually being driven" has an obvious answer.
      const s = (Math.sin(t * 1.5) + 1) / 2;
      set("rightUpperArm", 0, 0, -1.25 + s * 0.9);
      set("rightLowerArm", 0, -s * 1.3, -0.4);
    }

    if (modes.fingers) {
      // Curl every joint of every finger. If this moves, all 30 finger bones
      // are addressable by name and handshape is achievable.
      const curl = ((Math.sin(t * 2) + 1) / 2) * 1.4;
      for (const side of ["left", "right"] as const) {
        for (const digit of ["Index", "Middle", "Ring", "Little"] as const) {
          for (const seg of ["Proximal", "Intermediate", "Distal"] as const) {
            const b = bone(vrm, `${side}${digit}${seg}`);
            // Fingers curl about Z on a VRM, mirrored between hands.
            if (b) b.rotation.z = side === "left" ? -curl : curl;
          }
        }
      }
    }

    if (modes.blink && vrm.expressionManager) {
      vrm.expressionManager.setValue("blink", (Math.sin(t * 3) + 1) / 2);
    } else if (vrm.expressionManager) {
      vrm.expressionManager.setValue("blink", 0);
    }

    // Pushes the normalized pose onto the real bones, and runs expressions and
    // spring bones. Omit it and nothing above has any visible effect.
    vrm.update(dt);
  }

  renderer.render(scene, camera);
}
tick();
