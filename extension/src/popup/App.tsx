import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SETTINGS,
  SIGN_LANGUAGES,
  type AvatarContrast,
  type ExtensionMessage,
  type ExtensionSettings,
  type SignLanguage,
} from "../shared/types";
import { Settings } from "./Settings";
import { AvatarPreview, CONTRASTS, POSITIONS, SIZES } from "./shared-controls";

// Wizard order. Language comes FIRST, before permission, because granting
// permission immediately opens the WebSocket — and the connection is tagged
// with whatever language is stored at that moment. Asking afterwards meant a
// fresh install always connected as ASL and had to correct itself a second
// later, so GhSL users saw a brief burst of the wrong dictionary.
//
// Referenced by name everywhere below so the order lives in exactly one place.
// Split finer than it used to be. Permission previously carried the audio-output
// choice as well, and Appearance carried corner, size and contrast together —
// three unrelated decisions in one scroll. One decision per page reads faster
// and makes the progress bar mean something.
const STEP_LANGUAGE = 1;
const STEP_PERMISSION = 2;
const STEP_AUDIO_OUT = 3;
const STEP_PLACEMENT = 4;
const STEP_LOOK = 5;
const STEP_DONE = 6;

const STEP_LABELS = [
  "Sign language",
  "Audio permission",
  "Audio output",
  "Placement",
  "Look",
  "All set",
];
const LAST_INPUT_STEP = STEP_LOOK;
const METER_HEIGHTS = [0.35, 0.6, 0.9, 0.5, 1, 0.75, 0.45, 0.85, 0.6, 0.3, 0.55];
// ── Chrome messaging helpers ──────────────────────────────────────────────────

function sendMessage(message: ExtensionMessage): Promise<ExtensionMessage> {
  return chrome.runtime.sendMessage(message);
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * Dismiss ourselves, whichever surface we are on.
 *
 * First-run onboarding opens in a real tab, because an extension cannot open
 * its own popup programmatically — and `window.close()` is not reliably
 * permitted for an ordinary tab. `chrome.tabs.getCurrent()` resolves to a tab
 * only when we ARE one (it is undefined inside a popup), which makes it the
 * cleanest way to tell the two apart.
 */
async function closeSelf(): Promise<void> {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  else window.close();
}

// ── Component ─────────────────────────────────────────────────────────────────

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [inSettings, setInSettings] = useState(false);
  /** Set only when the user explicitly declines — capture-off alone isn't a denial. */
  const [denied, setDenied] = useState(false);
  const [captureActive, setCaptureActive] = useState(false);
  const [captureError, setCaptureError] = useState<string | undefined>();

  // Load persisted settings + live capture state, then subscribe to updates.
  useEffect(() => {
    let cancelled = false;

    sendMessage({ type: "GET_SETTINGS" }).then((res) => {
      if (cancelled || res.type !== "SETTINGS") return;
      setSettings(res.settings);
      // Someone who has finished the wizard lands straight in the settings view.
      if (res.settings.onboarded) setInSettings(true);
      setLoading(false);
    });

    sendMessage({ type: "GET_CAPTURE_STATE" }).then((res) => {
      if (!cancelled && res.type === "CAPTURE_STATE") setCaptureActive(res.active);
    });

    const onMessage = (msg: ExtensionMessage) => {
      if (msg.type === "CAPTURE_STATE") {
        setCaptureActive(msg.active);
        setCaptureError(msg.error);
        if (msg.active) setDenied(false);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  const update = useCallback(async (patch: Partial<ExtensionSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch })); // optimistic
    const res = await sendMessage({ type: "SAVE_SETTINGS", patch });
    if (res.type === "SETTINGS") setSettings(res.settings);
  }, []);

  const startCapture = useCallback(async () => {
    setCaptureError(undefined);
    setDenied(false);
    const tabId = await activeTabId();
    if (tabId === undefined) {
      setCaptureError("No active tab to capture.");
      return;
    }
    await update({ enabled: true });
    await sendMessage({ type: "START_CAPTURE", tabId });
  }, [update]);

  const stopCapture = useCallback(async () => {
    await update({ enabled: false });
    await sendMessage({ type: "STOP_CAPTURE" });
  }, [update]);

  // ── Derived view state ──────────────────────────────────────────────────────

  const granted = captureActive;
  const language = useMemo(
    () => SIGN_LANGUAGES.find((l) => l.value === settings.language) ?? SIGN_LANGUAGES[0],
    [settings.language],
  );
  const size = useMemo(
    () => SIZES.find((s) => s.id === settings.avatarSize) ?? SIZES[1],
    [settings.avatarSize],
  );
  const position = useMemo(
    () => POSITIONS.find((p) => p.id === settings.avatarPosition) ?? POSITIONS[3],
    [settings.avatarPosition],
  );
  const contrast = useMemo(
    () => CONTRASTS.find((c) => c.id === settings.avatarContrast) ?? CONTRASTS[0],
    [settings.avatarContrast],
  );

  const banner = granted
    ? {
        cls: "is-granted",
        title: "Audio connected",
        body: "Audio is transcribed in the cloud in transit only — never stored.",
      }
    : denied
      ? {
          cls: "is-denied",
          title: "Permission not granted",
          body: "Without audio we cannot sign the stream. You can allow it whenever you are ready.",
        }
      : {
          cls: "",
          title: "Tab audio permission",
          body: "Your browser will ask you to confirm. Pick the tab that is playing.",
        };

  const primaryDisabled =
    (step === STEP_LANGUAGE && !settings.languageChosen) ||
    (step === STEP_PERMISSION && !granted);
  const primaryLabel =
    step === LAST_INPUT_STEP
      ? "Finish setup"
      : step === STEP_DONE
        ? "Start signing"
        : "Continue";

  async function onPrimary() {
    if (step === STEP_DONE) {
      // `enabled` is the master switch auto-start consults. Finishing the
      // wizard is an explicit "yes, sign for me", so record it here rather
      // than relying on the permission step having set it as a side effect.
      await update({ onboarded: true, enabled: true });
      await closeSelf();
      return;
    }
    setStep((s) => Math.min(STEP_DONE, s + 1));
  }

  if (loading) return <div className="panel" style={{ height: 200 }} />;

  if (inSettings) {
    return (
      <Settings
        settings={settings}
        connected={granted}
        onUpdate={update}
        onToggleAudio={granted ? stopCapture : startCapture}
        onBackToSetup={() => {
          setInSettings(false);
          setStep(STEP_LANGUAGE);
        }}
        onClose={() => void closeSelf()}
      />
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="panel">
      {/* Panel chrome */}
      <div className="chrome">
        <div className="brand">
          <div className="brand-mark">
            <span />
          </div>
          <div className="brand-name">Signstream</div>
        </div>
        <div className="chrome-actions">
          <button
            type="button"
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => setInSettings(true)}
          >
            <div className="gear" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Close"
            aria-label="Close"
            onClick={() => void closeSelf()}
          >
            ×
          </button>
        </div>
      </div>

      <div className="progress">
        <div className="progress-track">
          {STEP_LABELS.map((_, i) => (
            <div key={i} className={`progress-bar${i + 1 <= step ? " is-done" : ""}`} />
          ))}
        </div>
        <div className="progress-meta">
          <div className="progress-step">{STEP_LABELS[step - 1]}</div>
          <div className="progress-count">
            {step === STEP_DONE ? "done" : `${step} / ${LAST_INPUT_STEP}`}
          </div>
        </div>
      </div>

      <div className="body wizard-body">
        {/* ── permission (step 2) ─────────────────────────────────────────── */}
        {step === STEP_PERMISSION && (
          <div className="step">
            <h1 className="title">Let&rsquo;s listen in together</h1>
            <p className="lede">
              To sign what&rsquo;s playing, Signstream captures this tab&rsquo;s audio from your
              computer and sends it to our cloud for transcription. Audio is never stored on our
              servers.
            </p>

            <div className="meter-card">
              <div className="meter" aria-hidden="true">
                {METER_HEIGHTS.map((h, i) => (
                  <div
                    key={i}
                    className={`meter-bar${granted ? " is-live" : ""}`}
                    style={
                      granted
                        ? {
                            height: `${Math.round(h * 46)}px`,
                            animationDuration: `${0.7 + (i % 4) * 0.18}s`,
                            animationDelay: `${i * 0.06}s`,
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
              <div className={`meter-caption${granted ? " is-live" : ""}`}>
                {granted
                  ? "listening to tab audio"
                  : denied
                    ? "audio muted"
                    : "waiting for permission"}
              </div>
            </div>

            <div className={`banner ${banner.cls}`}>
              <div className="banner-head">
                <div className="banner-icon">
                  <span />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="banner-title">{banner.title}</div>
                  <div className="banner-body">{banner.body}</div>
                </div>
              </div>
              {!granted && (
                <div className="banner-actions">
                  <button type="button" className="btn btn-grow" onClick={() => setDenied(true)}>
                    Maybe later
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-grow-wide"
                    onClick={startCapture}
                  >
                    Allow audio access
                  </button>
                </div>
              )}
              {captureError && <div className="error-note">{captureError}</div>}
            </div>
          </div>
        )}

        {/* ── audio output (step 3) ───────────────────────────────────────── */}
        {step === STEP_AUDIO_OUT && (
          <div className="step">
            <h1 className="title">Should the room still hear it?</h1>
            <p className="lede">
              Capturing a tab takes its audio out of the normal output, so it only reaches the
              speakers if we pass it back. Either way the same audio is transcribed.
            </p>

            <div className="rows" role="radiogroup" aria-label="Audio output">
              {[
                {
                  value: true,
                  title: "Play the audio too",
                  sub: "Everyone in the room still hears the video.",
                },
                {
                  value: false,
                  title: "Sign only — keep it silent",
                  sub: "Audio is used for signing and never reaches the speakers.",
                },
              ].map((opt) => (
                <label
                  key={String(opt.value)}
                  className={`row${settings.audioPassthrough === opt.value ? " is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="audioout"
                    checked={settings.audioPassthrough === opt.value}
                    onChange={() => update({ audioPassthrough: opt.value })}
                  />
                  <div className="row-main">
                    <div className="row-title">{opt.title}</div>
                    <div className="row-sub">{opt.sub}</div>
                  </div>
                  <div className="row-dot" />
                </label>
              ))}
            </div>
          </div>
        )}

        {/* ── language (step 1) ───────────────────────────────────────────── */}
        {step === STEP_LANGUAGE && (
          <div className="step">
            <h1 className="title">Which sign language?</h1>
            <p className="lede">
              Pick the one you&rsquo;re most comfortable reading. You can switch any time.
            </p>

            <div className="rows" role="radiogroup" aria-label="Sign language">
              {SIGN_LANGUAGES.map((lang) => {
                // Nothing is preselected until the user picks: `language` always
                // holds a usable fallback, but showing it as chosen would let a
                // fast Continue silently commit someone to the wrong language.
                const selected = settings.languageChosen && lang.value === settings.language;
                return (
                  <label key={lang.value} className={`row${selected ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="signlang"
                      value={lang.value}
                      checked={selected}
                      onChange={(e) =>
                        update({
                          language: e.target.value as SignLanguage,
                          languageChosen: true,
                        })
                      }
                    />
                    <div className={`row-abbr${lang.value.length > 3 ? " is-long" : ""}`}>
                      {lang.value}
                    </div>
                    <div className="row-main">
                      <div className="row-title">{lang.label}</div>
                      <div className="row-sub">{lang.region}</div>
                    </div>
                    <div className="row-dot" />
                  </label>
                );
              })}
            </div>

            <div className="note">
              <div className="note-rule" />
              <div className="note-text">
                {settings.languageChosen
                  ? `We currently sign ${language.value} at conversational pace. Regional variants are on the way.`
                  : "Choose a language to continue — everything after this is tuned to it."}
              </div>
            </div>
          </div>
        )}

        {/* ── placement (step 4) ──────────────────────────────────────────── */}
        {step === STEP_PLACEMENT && (
          <div className="step">
            <h1 className="title">Where should the interpreter sit?</h1>
            <p className="lede">
              Pick a corner and a size. You can also drag the interpreter anywhere on the video
              later.
            </p>

            <AvatarPreview size={size} position={position} contrast={contrast} />
            <div className="preview-summary">
              {size.label.toLowerCase()} · {position.label.toLowerCase()}
            </div>

            <div className="section-label">Position</div>
            <div className="chip-grid">
              {POSITIONS.map((pos) => (
                <button
                  key={pos.id}
                  type="button"
                  className={`chip${pos.id === settings.avatarPosition ? " is-selected" : ""}`}
                  aria-pressed={pos.id === settings.avatarPosition}
                  onClick={() => update({ avatarPosition: pos.id, /* a corner pick overrides a previous drag, otherwise the button would appear to do nothing */ avatarCustomPosition: null })}
                >
                  {pos.label}
                </button>
              ))}
            </div>

            <div className="section-label">Size</div>
            <div className="chip-row">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`chip${s.id === settings.avatarSize ? " is-selected" : ""}`}
                  aria-pressed={s.id === settings.avatarSize}
                  onClick={() => update({ avatarSize: s.id })}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── look (step 5) ───────────────────────────────────────────────── */}
        {step === STEP_LOOK && (
          <div className="step">
            <h1 className="title">How should it read?</h1>
            <p className="lede">
              The signer sits on a plain backdrop so handshapes stay legible over busy video.
              Pick whichever is easiest on your eyes.
            </p>

            <AvatarPreview size={size} position={position} contrast={contrast} />

            <div className="section-label">Contrast</div>
            <div className="rows" role="radiogroup" aria-label="Contrast">
              {CONTRASTS.map((opt) => {
                const selected = opt.id === settings.avatarContrast;
                return (
                  <label key={opt.id} className={`row${selected ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="contrast"
                      value={opt.id}
                      checked={selected}
                      onChange={(e) =>
                        update({ avatarContrast: e.target.value as AvatarContrast })
                      }
                    />
                    <div
                      className="row-swatch"
                      style={{
                        background: `linear-gradient(135deg, ${opt.a} 0 50%, ${opt.b} 50% 100%)`,
                      }}
                    />
                    <div className="row-main">
                      <div className="row-title">{opt.label}</div>
                      <div className="row-sub">{opt.desc}</div>
                    </div>
                    <div className="row-dot" />
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* ── done (step 6) ───────────────────────────────────────────────── */}
        {step === STEP_DONE && (
          <div className="step">
            <div className="done-mark">
              <span />
            </div>
            <h1 className="title">Ready when you are</h1>
            <p className="lede">
              Press play on the stream and your interpreter appears. Everything below can be changed
              in settings later.
            </p>

            <div className="summary">
              {[
                ["Sign language", language.label],
                ["Audio source", "This browser tab"],
                ["Audio retention", "Never stored"],
                ["Interpreter", `${size.label}, ${position.label.toLowerCase()}`],
                ["Contrast", contrast.label],
              ].map(([label, value]) => (
                <div key={label} className="summary-row">
                  <div className="summary-label">{label}</div>
                  <div className="summary-value">{value}</div>
                </div>
              ))}
            </div>

            <button type="button" className="link-btn" onClick={() => setInSettings(true)}>
              Open settings
            </button>
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="footer">
        {step > STEP_LANGUAGE && step < STEP_DONE && (
          <button
            type="button"
            className="btn btn-back"
            onClick={() => setStep((s) => Math.max(STEP_LANGUAGE, s - 1))}
          >
            Back
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={primaryDisabled}
          onClick={onPrimary}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
