// On-page overlay container for the signing avatar + transcript caption.
// Lives in a shadow root so the host page's CSS can't interfere with it.
//
// Surviving a hostile player (YouTube in particular)
// --------------------------------------------------
// A naive fixed-position div appended to <body> breaks in five separate ways
// inside YouTube's fullscreen player. Each is handled below:
//
//  1. Fullscreen paints ONE subtree. Anything outside the fullscreen element is
//     not rendered at all — z-index cannot save it. We re-parent into it.
//  2. `position: fixed` is not viewport-relative inside a transformed ancestor.
//     If any ancestor has transform / filter / perspective / will-change /
//     contain, a fixed child is positioned against THAT box instead. YouTube's
//     player subtree uses transforms, so a fixed overlay lands in the wrong
//     place. Fixed by making the host a full-bleed `inset: 0` layer, which is
//     correct whether `fixed` resolves to the viewport or to the player.
//  3. The host element itself is styled by page CSS. The shadow root protects
//     our internals, but not the host, and YouTube ships broad descendant
//     selectors. Every host declaration is therefore `!important`.
//  4. A solid overlay swallows player clicks — click-to-pause and
//     double-click-to-fullscreen stop working. `pointer-events: none`.
//  5. YouTube re-renders the player subtree on SPA navigation and on entering
//     or leaving fullscreen, detaching foreign children. A MutationObserver
//     re-attaches us.

import type { ExtensionSettings } from "../shared/types";

const SIZES: Record<ExtensionSettings["avatarSize"], { w: number; h: number }> = {
  small: { w: 160, h: 200 },
  medium: { w: 220, h: 280 },
  large: { w: 300, h: 360 },
};

/**
 * Reference viewport height the pixel sizes above were designed against. In
 * fullscreen the avatar is scaled by how much taller the viewport has become,
 * so a signer that read comfortably in a windowed player stays the same
 * relative size on a 4K screen instead of shrinking to a thumbnail.
 */
const REFERENCE_VIEWPORT_H = 720;
const MAX_FULLSCREEN_SCALE = 2.5;

/**
 * Vertical room left for the player's control bar in fullscreen, so a
 * bottom-anchored avatar does not sit on top of the scrubber. YouTube's
 * fullscreen chrome is roughly this tall; the bar auto-hides, but the avatar
 * must not cover it when it is up.
 */
const FULLSCREEN_CONTROLS_CLEARANCE = 72;

/** Movement below this is treated as a click, not the start of a drag. */
const DRAG_THRESHOLD_PX = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Layer styles for the host. Applied with !important — see note 3 above. */
const HOST_STYLE: Record<string, string> = {
  position: "fixed",
  inset: "0",
  width: "auto",
  height: "auto",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  display: "block",
  "pointer-events": "none",
  "z-index": "2147483647",
  transform: "none",
  contain: "none",
};

export class Overlay {
  private host: HTMLDivElement;
  private container: HTMLDivElement;
  private caption: HTMLDivElement;
  private error: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private mounted = false;
  /** Last settings applied, so we can re-apply on a viewport change. */
  private settings: ExtensionSettings | null = null;
  /** Notifies the avatar that its canvas changed size. */
  private onResize: (() => void) | null = null;
  /** Persists a new free position after the user drags the avatar. */
  private onMove: ((pos: { x: number; y: number }) => void) | null = null;

  private dragging = false;
  /**
   * Whether this gesture has actually moved the avatar.
   *
   * A plain click must not reposition anything: before the first move the
   * container is still anchored by `right`/`bottom`, so reading `style.left`
   * yields "" and would persist (0, 0) — teleporting the avatar to the corner
   * opposite the one the user chose.
   */
  private moved = false;
  /** Grab point within the avatar, so it doesn't jump to the cursor on grab. */
  private grabX = 0;
  private grabY = 0;
  private startX = 0;
  private startY = 0;
  private listening = false;
  /** Watches the current parent so we can re-attach if the page detaches us. */
  private observer: MutationObserver | null = null;
  /** Backstop for the case the observer cannot see. See `startHealthCheck`. */
  private healthTimer: number | undefined;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "signstream-overlay-host";
    this.applyHostStyle();
    const root = this.host.attachShadow({ mode: "open" });

    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      // Absolute within the host layer, NOT fixed — the host already spans the
      // correct box, and absolute positioning is immune to the transformed
      // ancestors that make `fixed` misbehave inside video players.
      position: "absolute",
      display: "none",
      borderRadius: "12px",
      overflow: "hidden",
      background: "rgba(22, 56, 77, 0.92)",
      boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
      fontFamily: "system-ui, sans-serif",
      // Only this small box takes pointer events — the host layer stays
      // `pointer-events: none`, so clicks anywhere else still reach the player.
      // The avatar itself must be interactive to be draggable.
      pointerEvents: "auto",
      cursor: "grab",
      // Stop a touch-drag on the avatar from scrolling the page instead.
      touchAction: "none",
      userSelect: "none",
    });

    this.container.addEventListener("pointerdown", this.onPointerDown);
    this.container.addEventListener("pointermove", this.onPointerMove);
    this.container.addEventListener("pointerup", this.onPointerUp);
    this.container.addEventListener("pointercancel", this.onPointerUp);

    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { display: "block", width: "100%" });

    this.caption = document.createElement("div");
    Object.assign(this.caption.style, {
      color: "#fff",
      fontSize: "12px",
      lineHeight: "1.3",
      padding: "6px 8px",
      minHeight: "16px",
      background: "rgba(0,0,0,0.25)",
    });

    this.error = document.createElement("div");
    Object.assign(this.error.style, {
      display: "none",
      color: "#fff",
      background: "rgba(150,30,30,0.92)",
      fontSize: "11px",
      lineHeight: "1.35",
      padding: "8px 10px",
    });

    this.container.appendChild(this.canvas);
    this.container.appendChild(this.error);
    this.container.appendChild(this.caption);
    root.appendChild(this.container);
  }

  mount(
    settings: ExtensionSettings,
    onResize?: () => void,
    onMove?: (pos: { x: number; y: number }) => void,
  ): void {
    this.onResize = onResize ?? null;
    this.onMove = onMove ?? null;
    this.mounted = true;
    // Always re-parent, not just on first mount: capture can be restarted long
    // after a hide, by which time the page may have replaced the element we
    // were living in. `reparent` is a no-op when we are already in place.
    this.reparent();
    if (!this.listening) {
      // Both spellings: Chrome fires the standard event, but some players
      // (and older WebKit builds) still emit only the prefixed one.
      document.addEventListener("fullscreenchange", this.onViewportChange);
      document.addEventListener("webkitfullscreenchange", this.onViewportChange);
      window.addEventListener("resize", this.onViewportChange);
      this.listening = true;
    }
    this.startHealthCheck();
    this.applySettings(settings);
    this.container.style.display = "block";
  }

  /**
   * Re-attach if the overlay ends up detached in a way the observer misses.
   *
   * The observer watches our parent's child list, which catches "the page
   * removed our host". It cannot catch "the page removed our *parent*, with us
   * inside it" — that detaches the host without mutating the parent, and
   * YouTube does exactly this when it rebuilds the player on SPA navigation.
   *
   * The alternative is a subtree observer on the document, which on a page as
   * busy as YouTube fires thousands of times a minute. A two-second liveness
   * poll of a single boolean is cheaper by orders of magnitude, and a two
   * second gap is invisible next to the pipeline's own latency.
   */
  private startHealthCheck(): void {
    if (this.healthTimer !== undefined) return;
    this.healthTimer = window.setInterval(() => {
      if (this.mounted && !this.host.isConnected) this.reparent();
    }, 2000);
  }

  unmount(): void {
    this.mounted = false;
    this.container.style.display = "none";
    this.setCaption("");
    // Detach from the page, not just hide. Disconnecting the audio should
    // leave no trace of the interpreter in the host document — a hidden host
    // still sits in YouTube's player subtree, still gets re-parented by our
    // own observer, and still shows up to anything walking the DOM.
    this.host.remove();
    if (this.listening) {
      document.removeEventListener("fullscreenchange", this.onViewportChange);
      document.removeEventListener("webkitfullscreenchange", this.onViewportChange);
      window.removeEventListener("resize", this.onViewportChange);
      this.listening = false;
    }
    this.observer?.disconnect();
    this.observer = null;
    window.clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.onResize = null;
    this.onMove = null;
    this.dragging = false;
  }

  // ── Dragging ───────────────────────────────────────────────────────────────

  /** The box the avatar is positioned within — the viewport, or the fullscreen player. */
  private layerRect(): { width: number; height: number; left: number; top: number } {
    const r = this.host.getBoundingClientRect();
    // Before first layout the host can measure zero; the viewport is the right
    // answer in that case because the host is an `inset: 0` layer.
    return r.width && r.height
      ? r
      : { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 };
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return; // left button / primary touch only
    const box = this.container.getBoundingClientRect();
    this.grabX = e.clientX - box.left;
    this.grabY = e.clientY - box.top;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.dragging = true;
    this.moved = false;
    this.container.setPointerCapture(e.pointerId);
    this.container.style.cursor = "grabbing";
    // Keep the gesture to ourselves: on a video player a stray mousedown
    // toggles play/pause or starts a scrub.
    e.preventDefault();
    e.stopPropagation();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;

    // Ignore sub-threshold jitter so a click with a shaky hand is still a
    // click, not a 2px reposition.
    if (!this.moved) {
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      this.moved = true;
    }

    const layer = this.layerRect();
    const w = this.container.offsetWidth;
    const h = this.container.offsetHeight;
    // Clamp to the layer so the avatar can never be dragged out of sight.
    const x = clamp(e.clientX - layer.left - this.grabX, 0, Math.max(0, layer.width - w));
    const y = clamp(e.clientY - layer.top - this.grabY, 0, Math.max(0, layer.height - h));
    this.place(x, y);
    e.preventDefault();
    e.stopPropagation();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.container.hasPointerCapture(e.pointerId)) {
      this.container.releasePointerCapture(e.pointerId);
    }
    this.container.style.cursor = "grab";
    if (!this.moved) return; // a click, not a drag — leave the position alone

    // Persist as a fraction of the free space, so the placement survives a
    // resize, a fullscreen transition, and a different-sized screen.
    const layer = this.layerRect();
    const freeW = Math.max(1, layer.width - this.container.offsetWidth);
    const freeH = Math.max(1, layer.height - this.container.offsetHeight);
    const x = parseFloat(this.container.style.left) || 0;
    const y = parseFloat(this.container.style.top) || 0;
    this.onMove?.({ x: clamp(x / freeW, 0, 1), y: clamp(y / freeH, 0, 1) });
  };

  /** Position the avatar by its top-left, clearing the corner anchors. */
  private place(x: number, y: number): void {
    this.container.style.left = `${Math.round(x)}px`;
    this.container.style.top = `${Math.round(y)}px`;
    this.container.style.right = "";
    this.container.style.bottom = "";
  }

  setCaption(text: string): void {
    this.caption.textContent = text;
  }

  /**
   * Show a problem in place of the avatar.
   *
   * An empty overlay is indistinguishable from "nothing is being said", so a
   * model that fails to load has to say so on screen rather than only in a
   * console the user will never open.
   */
  setError(message: string | null): void {
    if (!message) {
      this.error.style.display = "none";
      return;
    }
    this.error.textContent = `Avatar unavailable — ${message}`;
    this.error.style.display = "block";
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  /**
   * Re-assert the host's own styles.
   *
   * Called on every re-parent because the host sits in the page's DOM, outside
   * our shadow root, where the page's stylesheets apply to it. YouTube styles
   * `#movie_player > div` broadly enough to move or hide an unknown child, so
   * every declaration wins with `!important` rather than trusting specificity.
   */
  private applyHostStyle(): void {
    this.host.style.cssText = Object.entries(HOST_STYLE)
      .map(([k, v]) => `${k}: ${v} !important`)
      .join("; ");
  }

  private fullscreenElement(): Element | null {
    return (
      document.fullscreenElement ??
      (document as Document & { webkitFullscreenElement?: Element })
        .webkitFullscreenElement ??
      null
    );
  }

  /**
   * Move the overlay into whatever element is currently fullscreen.
   *
   * When an element goes fullscreen the browser renders only that element's
   * subtree — anything else in the document, including an overlay appended to
   * <body>, is simply not painted. Re-parenting into it is the only way the
   * avatar survives the transition, which is exactly when a Deaf viewer most
   * needs it.
   */
  private reparent(): void {
    let parent: Element = document.body;
    const fs = this.fullscreenElement();

    if (fs) {
      // A <video>/<audio> element renders no children — its child nodes are
      // fallback content — so a site that fullscreens the media element
      // directly cannot host an overlay at all. Use its parent so we stay in a
      // sane place, and accept that we will not be painted until it exits.
      // YouTube fullscreens its player <div>, so this path is a safety net for
      // other sites rather than the common case.
      parent = fs instanceof HTMLMediaElement ? (fs.parentElement ?? document.body) : fs;
    }

    if (this.host.parentNode !== parent) {
      parent.appendChild(this.host);
      this.applyHostStyle(); // a new parent means new inherited/page rules
      this.watch(parent);
    }
  }

  /**
   * Re-attach if the page tears the host out.
   *
   * YouTube rebuilds the player subtree on SPA navigation and around
   * fullscreen transitions, discarding children it does not know about. A
   * childList observer on the current parent is enough to notice and undo it,
   * and is far cheaper than observing the whole document on a page this busy.
   */
  private watch(parent: Element): void {
    this.observer?.disconnect();
    this.observer = new MutationObserver(() => {
      if (this.mounted && !this.host.isConnected) this.reparent();
    });
    this.observer.observe(parent, { childList: true });
  }

  private onViewportChange = (): void => {
    this.reparent();
    if (this.settings) this.applySettings(this.settings);
    // The canvas backing store must be rebuilt at the new CSS size or the
    // avatar renders blurry (or stretched) after the transition.
    this.onResize?.();
  };

  /** How much to enlarge the avatar for the current viewport. 1 when windowed. */
  private scale(): number {
    if (!this.fullscreenElement()) return 1;
    const factor = window.innerHeight / REFERENCE_VIEWPORT_H;
    return Math.min(MAX_FULLSCREEN_SCALE, Math.max(1, factor));
  }

  applySettings(settings: ExtensionSettings): void {
    this.settings = settings;
    const scale = this.scale();
    const fullscreen = this.fullscreenElement() !== null;
    const { w, h } = SIZES[settings.avatarSize];
    this.container.style.width = `${Math.round(w * scale)}px`;
    this.canvas.style.height = `${Math.round(h * scale)}px`;

    // A dragged position wins over the corner picker. Don't fight the user for
    // control of the box while they are actually dragging it.
    if (!this.dragging) {
      const custom = settings.avatarCustomPosition;
      if (custom) {
        // Re-derive pixels from the stored fractions against the CURRENT layer,
        // which is what keeps a dragged avatar in the same relative spot after
        // a resize or a jump to fullscreen.
        const layer = this.layerRect();
        const w = this.container.offsetWidth || Math.round(SIZES[settings.avatarSize].w * scale);
        const h = this.container.offsetHeight || Math.round(SIZES[settings.avatarSize].h * scale);
        this.place(
          clamp(custom.x, 0, 1) * Math.max(0, layer.width - w),
          clamp(custom.y, 0, 1) * Math.max(0, layer.height - h),
        );
      } else {
        // Anchor to whichever corner the user picked. Clearing the opposite
        // edges matters — leaving both `top` and `bottom` set would stretch the
        // box. The margin scales too, so the avatar isn't pinned to the very
        // edge of a large screen; a bottom anchor additionally clears the
        // player controls.
        const margin = Math.round(16 * scale);
        const bottomMargin =
          margin + (fullscreen ? Math.round(FULLSCREEN_CONTROLS_CLEARANCE * scale) : 0);
        const [vertical, horizontal] = settings.avatarPosition.split("-");
        this.container.style.top = vertical === "top" ? `${margin}px` : "";
        this.container.style.bottom = vertical === "bottom" ? `${bottomMargin}px` : "";
        this.container.style.left = horizontal === "left" ? `${margin}px` : "";
        this.container.style.right = horizontal === "right" ? `${margin}px` : "";
      }
    }

    // Plain backdrop behind the signer so handshapes stay legible over busy
    // video. `none` drops the plate entirely and draws straight over the frame.
    const plate: Record<ExtensionSettings["avatarBackdrop"], string> = {
      studio: "rgba(22, 56, 77, 0.92)",
      light: "#f7f5f0",
      dark: "#14181d",
      none: "transparent",
    };
    // `inverted` contrast flips the studio plate dark so light handshapes read.
    const isLightPlate =
      settings.avatarBackdrop === "light" && settings.avatarContrast !== "inverted";

    this.container.style.background = plate[settings.avatarBackdrop];
    this.container.style.backdropFilter = settings.dimBackground ? "brightness(0.75)" : "";
    this.caption.style.fontSize = `${Math.round(12 * scale)}px`;
    this.caption.style.color = isLightPlate ? "#16384d" : "#fff";
    this.caption.style.textShadow =
      settings.avatarBackdrop === "none" ? "0 1px 3px rgba(0,0,0,0.9)" : "";

    this.caption.style.display = settings.showTranscript ? "block" : "none";
  }
}
