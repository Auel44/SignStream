// Three.js signing avatar.
//
// Signs arrive from the backend as ids (`ghsl-hello-v1`). The clip for an id is
// a list of frames, each holding a body-relative position per named joint (see
// dictionary/README.md). This class queues incoming signs and drives the
// skeleton from those keypoints, falling back to a neutral placeholder gesture
// when a clip is unavailable so playback degrades rather than stalls.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AvatarStatus, SignClip } from "../shared/types";
import { Retargeter } from "./retarget";
import { boneKey, rigById, type Rig } from "./rigs";

/**
 * How far behind the audio a sign may be and still be worth showing.
 *
 * Signing is slower than speech: even after trimming, a GhSL sign runs ~2.4 s
 * while speech delivers 2-3 words per second. The avatar therefore cannot show
 * everything, and a queue that simply grows means it is soon describing
 * something said minutes ago — which for a Deaf viewer is worse than showing
 * nothing, because it contradicts what is on screen.
 *
 * So signs expire. Past this age a sign is dropped rather than performed late,
 * which bounds the lag permanently instead of letting it accumulate.
 */
const MAX_SIGN_AGE_MS = 6000;

/**
 * Backlog cap.
 *
 * Generous because the caption path schedules signs *ahead* of playback — a
 * whole video's worth can be queued before it starts. Signs are removed by
 * age, not by position, so the cap is only a memory guard.
 */
const MAX_QUEUE = 256;

/**
 * Cross-fade when handing over from one sign to the next.
 *
 * Cutting straight to the next clip's first frame teleports the hands, which
 * reads worse than the pause it replaces. A short blend approximates what
 * signers actually do — flow one sign into the next — without needing true motion
 * synthesis between arbitrary handshapes.
 */
const BLEND_MS = 140;

// Both constants below are measured, not chosen. Posing the rig through 81,492
// hand-joint samples — every wrist, middle fingertip and thumb tip across a
// 1-in-11 sample of all 3,179 clips — gives the extent signing actually needs:
//
//   lateral from the midline   p95 0.316   p99 0.384   max 0.651
//   height above the waist     p95 0.585   p99 0.630   (the crown is at 0.819)
//   depth below the waist      p5 -0.073   p1 -0.166   min -0.249
//
// Height needs no attention: signing space tops out well under the crown. The
// two that bite are width and, less obviously, how far the hands drop BELOW the
// waist — which is why the frame cannot simply end there.

/**
 * How much wider than the shoulder joints the shot must be.
 *
 * The crop cannot be driven by height alone: at 220x280 the frame is taller
 * than it is wide, so fitting the head-to-waist span exactly would clip a sign
 * that reaches out to the side. 2.1 is the p99 lateral reach over the sample
 * above (0.384 either side of a 0.365 shoulder span), widened slightly to 2.2
 * where the curve is still cheap: measured against joints the clips actually
 * track, that leaves 1.0% of them clipped at the sides, against 1.5% at 2.1 and
 * 0.7% at 2.3. What remains are outliers near the 0.651 maximum — nearly a
 * third beyond p99, and tracker noise rather than real reach. Chasing them
 * would zoom out for every sign.
 *
 * An earlier guess of 1.8 put a fingertip outside the frame on 31% of ASL
 * frames, which is what this replaces.
 */
const SIGNING_WIDTH = 2.2;

/**
 * Air left below the waist, as a fraction of the waist-to-crown span.
 *
 * Not styling: hands drop below the waist bone on about 5% of frames, and at
 * rest they sit near waist height, so a frame ending exactly there slices
 * through them. 0.12 clears the p5 depth with a little room, and leaves 0.3% of
 * tracked joints clipped at the bottom.
 *
 * It deliberately does not stretch to the p1 (-0.166). Widening it to 0.20 only
 * recovers that 0.3%, and these rigs are full-body — `male_casualsuit05Mesh` has
 * trousers — so every extra centimetre below the hips is thigh in shot on every
 * sign. Most of what it would recover is the idle hand of a one-handed sign
 * hanging at the signer's side, which carries no meaning: across the sample,
 * two thirds of all clipped frames involve only a hand the clip does not track.
 */
const WAIST_MARGIN = 0.12;

interface PendingSign {
  clip: SignClip;
  /** Media time (seconds) this sign belongs to — the moment it was spoken. */
  mediaTime: number;
  /** Wall-clock arrival, the fallback when no media clock is available. */
  queuedAt: number;
}

interface QueuedSign {
  clip: SignClip;
  /**
   * How far into the clip we are, in clip-milliseconds.
   *
   * Accumulated per frame while the stream is playing rather than derived from
   * wall-clock time. A wall-clock start stamp would keep advancing through a
   * pause, so resuming a paused video would snap the avatar to the end of
   * whatever sign was mid-flight.
   */
  elapsedMs: number;
}

export class Avatar {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  /** Loaded model. Null until the glTF resolves — the loop no-ops until then. */
  private figure: THREE.Object3D | null = null;
  /** Solves bone rotations from clip keypoints. Null until the model loads. */
  private retargeter: Retargeter | null = null;
  /** Set when the model could not be loaded, so the UI can say so. */
  private loadError: string | null = null;
  /** Notified on load failure — the overlay shows it instead of a blank box. */
  private onError: ((message: string) => void) | null = null;
  private rig: Rig;
  private clock = new THREE.Clock();
  private raf = 0;
  private playing = false;

  /** Signs waiting to play, in arrival order. */
  private queue: PendingSign[] = [];
  private current: QueuedSign | null = null;
  /** Reads the host media clock, so staleness is judged against the video. */
  private mediaClock: (() => number) | null = null;
  /** Diagnostics — surfaced in the console so drops are never invisible. */
  private stats = { shown: 0, dropped: 0 };
  /** Sign ids that arrived with no clip behind them. */
  private missingClips = 0;
  /** User's preferred signing pace (Settings slider, 0.7–1.3). */
  private speed = 1;
  /**
   * The host media's playbackRate, tracked separately from the user's setting.
   *
   * These multiply rather than override: at 2x video the signs must also run at
   * 2x or the avatar falls progressively further behind the audio it is
   * interpreting, and a user who prefers slower signing should still get
   * *relatively* slower signing at any video speed.
   */
  private playbackRate = 1;
  /** Remaining ms of the "no clip for this sign" wave. Also frozen when paused. */
  private placeholderMsLeft = 0;
  /** Timestamp of the previous animation frame, for delta timing. */
  private lastTick = 0;
  /**
   * Milliseconds left in the hand-over cross-fade.
   *
   * The stick figure captured joint positions to blend from; the rig does not
   * need that. `Retargeter.apply` takes a mix factor and slerps each bone from
   * wherever it currently is towards the solved pose, so the previous pose is
   * simply whatever the bones already hold.
   */
  private blendMsLeft = 0;
  /**
   * What the shot must contain, in world units, measured from the skeleton.
   *
   * Kept rather than consumed on the spot because the camera distance that
   * satisfies it depends on the canvas aspect, which changes when the overlay
   * is resized. Null until the model loads.
   */
  private framing: {
    up: THREE.Vector3;
    forward: THREE.Vector3;
    /** World position of the waist — the bottom edge of the shot. */
    waist: THREE.Vector3;
    /** Waist to crown. */
    spanY: number;
    /** Width of the signing space, wider than the body itself. */
    spanX: number;
  } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    rigId = "makehuman",
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 1.5, 4.4);
    this.camera.lookAt(0, 1.3, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(2, 4, 3);
    this.scene.add(key);

    this.rig = rigById(rigId);
    void this.loadRig();

    this.resize();
  }

  /**
   * Load the rigged model.
   *
   * Asynchronous and deliberately non-blocking: the render loop simply draws an
   * empty scene until it resolves. Capture, transcription and the sign queue all
   * carry on regardless — a slow model load must never stall the pipeline.
   */
  private async loadRig(): Promise<void> {
    try {
      // Models are exported WITHOUT Draco compression on purpose. Draco is
      // ~3x smaller, but DRACOLoader decodes inside a Web Worker built from a
      // blob: URL, and host-page CSP — YouTube's included — blocks blob:
      // workers. The model then fails to load and the overlay renders empty
      // with no obvious cause. A couple of MB is the better trade.
      const url = chrome.runtime.getURL(this.rig.file);
      const gltf = await new GLTFLoader().loadAsync(url);
      this.figure = gltf.scene;
      this.scene.add(this.figure);

      this.orientUpright(gltf.scene);
      this.retargeter = new Retargeter(this.figure, this.rig);
      const missing = this.retargeter.missingBones;
      if (missing.length) {
        // A silent mismatch here looks like "the avatar ignores my data", so
        // it is reported rather than tolerated.
        console.warn(
          `[SignStream] rig "${this.rig.id}" is missing ${missing.length} mapped bones:`,
          missing.slice(0, 8),
        );
      }
      console.debug(
        `[SignStream] rig loaded: ${this.rig.label}, driving ${this.retargeter.boneCount} bones`,
      );
      this.frameCamera();
    } catch (err) {
      // Surfaced, not swallowed. A failed model load looks exactly like a
      // working extension that never signs, so it must announce itself.
      this.loadError = err instanceof Error ? err.message : String(err);
      console.error(
        `[SignStream] could not load avatar "${this.rig.file}". The overlay will ` +
          "stay empty until this is fixed.",
        err,
      );
      this.onError?.(this.loadError);
    }
  }

  /**
   * Rotate the model so its head is up, whatever axis convention it was saved in.
   *
   * Blender is Z-up and glTF is Y-up, and the conversion can be applied zero,
   * one or two times depending on how a model travelled from its authoring tool
   * — the MakeHuman FBX -> Blender -> glTF path here lands Z-up, so three.js
   * (which assumes Y-up) drew the avatar lying on its back and the camera saw
   * the top of its head.
   *
   * Rather than encode an assumption per model, measure it: the spine runs from
   * the hips to the neck, so whichever world axis that vector points along IS
   * this model's up. One rotation then aligns it to +Y. Any future avatar,
   * exported by any route, corrects itself.
   */
  private orientUpright(scene: THREE.Object3D): void {
    const bone = (name: string): THREE.Object3D | undefined => {
      const matches: THREE.Object3D[] = [];
      const want = boneKey(name);
      scene.traverse((o) => {
        if (boneKey(o.name) === want) matches.push(o);
      });
      return matches[0];
    };
    // spine05 is the base of the spine, spine01 the upper chest — see the note
    // in `Retargeter.calibrate`. Measuring the whole spine rather than its top
    // few centimetres is what makes this vector a reliable "up".
    const hips = bone("spine05") ?? bone("spine01") ?? bone("root");
    const neck = bone("neck01") ?? bone("head");
    if (!hips || !neck) return;

    scene.updateMatrixWorld(true);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    hips.getWorldPosition(a);
    neck.getWorldPosition(b);
    const up = b.sub(a);
    if (up.lengthSq() < 1e-6) return;
    up.normalize();

    const target = new THREE.Vector3(0, 1, 0);
    // Already close enough to upright — leave it alone rather than nudge it.
    if (up.dot(target) > 0.95) return;

    const fix = new THREE.Quaternion().setFromUnitVectors(up, target);
    scene.quaternion.premultiply(fix);
    scene.updateMatrixWorld(true);
    console.debug(
      `[SignStream] model was ${up.z > 0.5 ? "Z" : "non-Y"}-up; rotated upright`,
    );
  }

  /**
   * Measure what the shot has to contain. Done once, when the model loads.
   *
   * Legs carry no linguistic information and the overlay is small, so showing
   * the whole body wastes most of the pixels on trousers. Cropping to the
   * signing space — head, torso, arms, hands — is what makes handshape legible
   * at 220x280.
   *
   * Measured from bones rather than the mesh bounding box: the box includes
   * legs, hair and clothing and would frame the wrong thing.
   *
   * Placing the camera is left to `applyFraming`, because the answer depends on
   * the canvas aspect and so has to be recomputed whenever the overlay resizes.
   */
  private frameCamera(): void {
    if (!this.figure || !this.retargeter) return;
    const axes = this.retargeter.getAxes();
    if (!axes) return;

    const bone = (name: string): THREE.Object3D | undefined => {
      const hits: THREE.Object3D[] = [];
      const want = boneKey(name);
      this.figure!.traverse((o) => {
        if (boneKey(o.name) === want) hits.push(o);
      });
      return hits[0];
    };
    const at = (o: THREE.Object3D): THREE.Vector3 =>
      o.getWorldPosition(new THREE.Vector3());

    this.figure.updateMatrixWorld(true);
    const head = bone("head");
    // MakeHuman's spine is numbered from the top down: spine01 sits at the
    // shoulders, spine05 at the pelvis. The waist is spine05 — measured, not
    // assumed. Cropping at spine03 would cut the hands off, since signing
    // space reaches down to about the navel.
    const waistBone = bone("spine05") ?? bone("spine04") ?? bone("spine01");
    if (!head || !waistBone) return;

    const top = at(head);
    const waist = at(waistBone);

    // The head BONE sits at the base of the skull, so extend upwards to take in
    // the crown plus a little air. Measured against this rig: the head-to-waist
    // span is ~0.61 and the crown sits ~0.18 above the head bone, so 0.3 of the
    // span is about right and scales with any model.
    const spineLen = top.distanceTo(waist);
    top.addScaledVector(axes.up, spineLen * 0.3);

    const armL = bone("upperarm01.L") ?? bone("clavicle.L");
    const armR = bone("upperarm01.R") ?? bone("clavicle.R");
    const shoulders = armL && armR ? at(armL).distanceTo(at(armR)) : spineLen * 0.5;

    this.framing = {
      up: axes.up.clone().normalize(),
      forward: axes.forward.clone().normalize(),
      waist,
      spanY: top.distanceTo(waist),
      spanX: shoulders * SIGNING_WIDTH,
    };
    this.applyFraming();
  }

  /**
   * Place the camera so the measured span fills the canvas.
   *
   * Two things the previous fit got wrong, both visible as legs in the shot:
   *
   *   * It padded the height by 24% and centred on the torso, so an eighth of
   *     the frame sat below the waist bone — thighs, in other words.
   *   * The padding was a stand-in for fitting the width, which depends on the
   *     aspect ratio. Solving width explicitly means the height no longer has
   *     to be loosened to protect it.
   *
   * The bottom edge is anchored at the waist rather than the centre being
   * anchored at the torso, so whatever slack the width fit demands becomes
   * headroom instead of legs.
   */
  private applyFraming(): void {
    const f = this.framing;
    if (!f) return;

    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanX = tanY * this.camera.aspect;
    const distance = Math.max(f.spanY / 2 / tanY, f.spanX / 2 / tanX);

    const halfHeight = distance * tanY;
    const centre = f.waist
      .clone()
      .addScaledVector(f.up, halfHeight - f.spanY * WAIST_MARGIN);

    this.camera.position.copy(centre).addScaledVector(f.forward, distance);
    this.camera.up.copy(f.up);
    this.camera.lookAt(centre);
    this.camera.near = Math.max(0.01, distance * 0.05);
    this.camera.far = distance * 6;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (!this.raf) {
      this.lastTick = 0; // no delta on the first frame after a restart
      this.loop();
    }
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTick = 0;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  /** 0.7–1.3 in the UI; clamped here so a bad value can't freeze playback. */
  setSpeed(speed: number): void {
    this.speed = Math.min(2, Math.max(0.25, speed || 1));
  }

  /** Mirror the host media's rate (0.25x–4x in Chrome's UI). */
  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.min(4, Math.max(0.25, rate || 1));
  }

  /** Effective clip rate: user preference × how fast the stream is running. */
  private get effectiveSpeed(): number {
    return this.speed * this.playbackRate;
  }

  /**
   * Queue a resolved clip. Signs play back-to-back so a sentence reads as one
   * continuous utterance rather than overlapping gestures.
   */
  /** Report model-load failures to the caller (the overlay shows them). */
  setErrorHandler(fn: (message: string) => void): void {
    this.onError = fn;
    if (this.loadError) fn(this.loadError);
  }

  /** Which rig this instance was built for; the content script watches it. */
  get rigId(): string {
    return this.rig.id;
  }

  /** Supplies the host video's current time, used to age signs out. */
  setMediaClock(clock: () => number): void {
    this.mediaClock = clock;
  }

  /**
   * Queue a sign.
   *
   * `mediaTime` is the moment in the video the sign belongs to. Two callers
   * supply it very differently, and the same queue serves both:
   *
   *   * ASR — the words have just been heard, so it is "now" and the sign
   *     plays immediately.
   *   * Captions — the cue's own start time, which may be well ahead of
   *     playback, so the sign waits until the video reaches it.
   */
  enqueueClip(clip: SignClip, mediaTime?: number): void {
    this.queue.push({
      clip,
      mediaTime: mediaTime ?? this.mediaClock?.() ?? 0,
      queuedAt: performance.now(),
    });
    // Keep in media order — captions can arrive out of order, and a scheduled
    // queue only makes sense sorted by when each sign is due.
    this.queue.sort((a, b) => a.mediaTime - b.mediaTime);
    if (this.queue.length > MAX_QUEUE) {
      this.stats.dropped += this.queue.length - MAX_QUEUE;
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }
  }

  /** shown / dropped counts, for the console readout. */
  getStats(): { shown: number; dropped: number } {
    return { ...this.stats };
  }

  /**
   * Health readout for the popup's diagnostics page.
   *
   * Reports the things that separately cause a blank avatar, so the failing one
   * can be named instead of inferred: whether the model loaded, whether the rig
   * map matched the skeleton (`bonesMissing` was 46 of 47 for a long time and
   * nothing said so), and whether incoming signs are finding clips.
   */
  getStatus(): AvatarStatus {
    return {
      rigId: this.rig.id,
      rigLoaded: this.figure !== null,
      rigError: this.loadError,
      bonesDriven: this.retargeter?.boneCount ?? 0,
      bonesMissing: this.retargeter?.missingBones.length ?? 0,
      clipsPlayed: this.stats.shown,
      clipsMissing: this.missingClips,
      playing: this.playing,
      queued: this.queue.length,
    };
  }

  /** Called when a sign id had no clip — keeps the avatar visibly responsive. */
  playPlaceholder(): void {
    this.placeholderMsLeft = 1200;
    this.missingClips += 1;
  }

  /**
   * Drop everything queued and in flight, and return to rest.
   *
   * Called on capture stop, language change, and — most often — whenever the
   * user seeks. Queued signs describe audio from the old playback position, so
   * playing them after a jump would show words that no longer match the stream.
   */
  clearQueue(): void {
    this.queue = [];
    this.current = null;
    this.placeholderMsLeft = 0;
    this.blendMsLeft = 0;
    this.restPose();
  }

  resize(): void {
    const w = this.canvas.clientWidth || 220;
    const h = this.canvas.clientHeight || 280;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // A new aspect changes how much width the frame gives away, so the crop has
    // to be solved again — otherwise a resized overlay drifts back to showing
    // legs, or clips the hands.
    this.applyFraming();
  }

  // ── Animation ─────────────────────────────────────────────────────────────

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);

    const now = performance.now();
    // Clamp the delta: a backgrounded tab throttles rAF, so without this the
    // first frame after refocusing would jump the avatar seconds forward.
    const dt = this.lastTick ? Math.min(now - this.lastTick, 100) : 0;
    this.lastTick = now;

    // Clip time only advances while the media is actually producing audio, so
    // a pause, a seek or a buffer stall holds the pose instead of running on.
    const step = this.playing ? dt * this.effectiveSpeed : 0;

    if (this.blendMsLeft > 0) this.blendMsLeft = Math.max(0, this.blendMsLeft - dt);

    if (this.playing && !this.current) {
      const next = this.takeFreshest();
      if (next) {
        this.blendMsLeft = BLEND_MS;
        this.current = { clip: next, elapsedMs: 0 };
      }
    }

    if (this.current) {
      this.current.elapsedMs += step;
      if (this.current.elapsedMs >= this.current.clip.durationMs) {
        // Go straight into the next sign if one is waiting, instead of
        // returning to rest first. Trimming removed the dead air inside each
        // clip; this removes the pause *between* them, which is what makes a
        // sequence read as one utterance rather than a list of words.
        const next = this.playing ? this.takeFreshest() : null;
        if (next) {
          this.blendMsLeft = BLEND_MS;
          this.current = { clip: next, elapsedMs: 0 };
          this.applyFrame(next, 0);
        } else {
          this.current = null;
          this.restPose();
        }
      } else {
        this.applyFrame(this.current.clip, this.current.elapsedMs);
      }
    } else if (this.placeholderMsLeft > 0) {
      this.placeholderMsLeft -= step;
      this.placeholderPose(this.clock.getElapsedTime());
    } else {
      this.restPose();
    }

    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Take the next sign worth showing, discarding any that have gone stale.
   *
   * Age is measured against the media clock where possible, so it stays
   * correct across pause and seek — a sign queued at 01:12 is 4 s old when the
   * video reaches 01:16, however long the user spent paused in between. Wall
   * clock is the fallback for pages with no readable media element.
   */
  private takeFreshest(): SignClip | null {
    const nowMedia = this.mediaClock?.();
    const nowWall = performance.now();

    while (this.queue.length > 0) {
      const candidate = this.queue[0];
      const ageMs =
        nowMedia !== undefined && candidate.mediaTime > 0
          ? (nowMedia - candidate.mediaTime) * 1000
          : nowWall - candidate.queuedAt;

      // Not due yet. Scheduled from a caption cue that the video has not
      // reached — leave it in place and show nothing rather than signing
      // ahead of the words. The queue is sorted, so nothing behind it is due
      // either.
      if (ageMs < 0) return null;

      this.queue.shift();

      // Too late to be useful: signing it now would contradict what is on
      // screen. Dropping is deliberate — see MAX_SIGN_AGE_MS.
      if (ageMs > MAX_SIGN_AGE_MS) {
        this.stats.dropped += 1;
        continue;
      }

      this.stats.shown += 1;
      return candidate.clip;
    }
    return null;
  }

  /**
   * Pose the rig for a moment in the clip.
   *
   * Interpolates between the two frames bracketing `elapsed` so 25 fps source
   * data plays smoothly at display rate, then hands the blended keypoints to
   * the retargeter, which converts positions into bone rotations.
   */
  private applyFrame(clip: SignClip, elapsed: number): void {
    if (!this.retargeter) return;
    const frames = clip.frames;
    if (frames.length === 0) return;

    let next = frames.findIndex((f) => f.t >= elapsed);
    if (next <= 0) next = 1;
    if (next >= frames.length) next = frames.length - 1;

    const a = frames[next - 1];
    const b = frames[next];
    const span = b.t - a.t;
    const t = span > 0 ? Math.min(1, Math.max(0, (elapsed - a.t) / span)) : 0;

    // Blend the two source frames' keypoints, then solve once. Solving each
    // frame separately and slerping the results would cost twice as much for
    // no visible gain.
    const blended = {
      t: elapsed,
      positions: a.positions.map((pa, i) => {
        const pb = b.positions[i];
        if (!pb) return pa;
        // An untracked point must not be averaged towards the origin — prefer
        // whichever of the pair is real.
        const aOk = pa[0] !== 0 || pa[1] !== 0;
        const bOk = pb[0] !== 0 || pb[1] !== 0;
        if (!aOk) return pb;
        if (!bOk) return pa;
        return [
          pa[0] + (pb[0] - pa[0]) * t,
          pa[1] + (pb[1] - pa[1]) * t,
          pa[2] + (pb[2] - pa[2]) * t,
        ] as [number, number, number];
      }),
    };

    // During a handover, ease into the new sign's pose rather than snapping.
    // Smoothstep, because a linear blend reads as a twitch over 140 ms.
    let mix = 1;
    if (this.blendMsLeft > 0) {
      const u = 1 - this.blendMsLeft / BLEND_MS;
      mix = u * u * (3 - 2 * u);
    }
    this.retargeter.apply(blended, mix);
  }

  /** The pose the model was authored in — used between signs and when idle. */
  private restPose(): void {
    this.retargeter?.reset();
  }

  /**
   * Shown when a sign id arrived with no clip behind it.
   *
   * Deliberately just the rest pose. The stick figure used to wave, but an
   * invented gesture on a human-looking avatar reads as a real sign and would
   * mislead — standing still is honest about having nothing to show.
   */
  private placeholderPose(_t: number): void {
    this.restPose();
  }
}
