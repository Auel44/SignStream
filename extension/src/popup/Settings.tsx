// Settings, as a menu of short pages rather than one long scroll.
//
// It used to stack eight sections into a single column, so changing the signing
// speed meant scrolling past the language picker, the placement grid and the
// backdrop swatches. Each is now its own page, reached from a menu.
//
// The menu drills down rather than sitting in a sidebar. A sidebar was tried and
// does not survive 400px: a nav column wide enough to read leaves too little for
// the option rows, sliders and swatches, which need the full width.

import { useEffect, useRef, useState } from "react";
import {
  SIGN_LANGUAGES,
  type AvatarBackdrop,
  type AvatarContrast,
  type Diagnostics as DiagnosticsData,
  type ExtensionMessage,
  type ExtensionSettings,
  type SignLanguage,
} from "../shared/types";
import { AvatarPreview, CONTRASTS, POSITIONS, SIZES } from "./shared-controls";
import { RIGS } from "../content/rigs";

const MINI_METER_HEIGHTS = [0.5, 0.9, 0.65, 1, 0.55];

const BACKDROPS: { id: AvatarBackdrop; label: string; fill: string }[] = [
  { id: "studio", label: "Studio", fill: "oklch(0.88 0.012 78)" },
  { id: "light", label: "Plain white", fill: "oklch(0.99 0.003 80)" },
  { id: "dark", label: "Plain dark", fill: "oklch(0.24 0.012 62)" },
  { id: "none", label: "None", fill: "transparent" },
];

type PageId =
  | "audio"
  | "language"
  | "signer"
  | "placement"
  | "look"
  | "playback"
  | "status"
  | "privacy";

const PAGES: { id: PageId; label: string; blurb: string }[] = [
  { id: "audio", label: "Audio", blurb: "Where the sound comes from and where it goes." },
  { id: "language", label: "Sign language", blurb: "Which language the interpreter signs." },
  { id: "signer", label: "Signer", blurb: "Who does the signing." },
  { id: "placement", label: "Placement", blurb: "Where the interpreter sits on the video." },
  { id: "look", label: "Look", blurb: "Backdrop and contrast, for legible handshapes." },
  { id: "playback", label: "Playback", blurb: "Signing pace and captions." },
  { id: "status", label: "Status", blurb: "What each stage of the pipeline is doing." },
  { id: "privacy", label: "Privacy", blurb: "What is sent, kept, and reset." },
];

export interface SettingsProps {
  settings: ExtensionSettings;
  connected: boolean;
  /** Persists a patch; every control calls this so changes apply immediately. */
  onUpdate: (patch: Partial<ExtensionSettings>) => void | Promise<void>;
  onToggleAudio: () => void;
  onBackToSetup: () => void;
  onClose: () => void;
}

export function Settings({
  settings,
  connected,
  onUpdate,
  onToggleAudio,
  onBackToSetup,
  onClose,
}: SettingsProps) {
  /** Null shows the menu; a page id shows that page. */
  const [page, setPage] = useState<PageId | null>(null);
  // Changes persist on every interaction; the pill exists to make that visible
  // (the design's "Synced" resting state, "Saved" right after a change).
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  function update(patch: Partial<ExtensionSettings>) {
    void onUpdate(patch);
    setJustSaved(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setJustSaved(false), 2200);
  }

  function resetAll() {
    // Deliberately does NOT reset `language`. Everything here is a display
    // preference that can be safely restored to a house default; the sign
    // language is not — it is the user's own language, chosen explicitly
    // during onboarding, and silently reverting it to ASL would leave someone
    // watching a language they may not read.
    update({
      avatarSize: "medium",
      avatarPosition: "bottom-right",
      avatarCustomPosition: null, // also discard any dragged placement
      avatarContrast: "standard",
      avatarBackdrop: "studio",
      signingSpeed: 1.2,
      autoStart: true,
      audioPassthrough: true,
      dimBackground: false,
      showTranscript: true,
    });
  }

  const language =
    SIGN_LANGUAGES.find((l) => l.value === settings.language) ?? SIGN_LANGUAGES[0];
  const size = SIZES.find((s) => s.id === settings.avatarSize) ?? SIZES[1];
  const position = POSITIONS.find((p) => p.id === settings.avatarPosition) ?? POSITIONS[3];
  const contrast = CONTRASTS.find((c) => c.id === settings.avatarContrast) ?? CONTRASTS[0];

  const speedLabel =
    settings.signingSpeed < 0.9
      ? `${settings.signingSpeed.toFixed(1)}× slower`
      : settings.signingSpeed > 1.05
        ? `${settings.signingSpeed.toFixed(1)}× faster`
        : "Normal pace";

  const current = PAGES.find((p) => p.id === page) ?? null;

  return (
    <div className="panel">
      <div className="chrome settings-chrome">
        <div className="brand">
          <button
            type="button"
            className="icon-btn"
            // The back arrow steps out of a page first, and only leaves settings
            // from the menu — otherwise it would skip two levels at once.
            title={current ? "Back to settings" : "Back to setup"}
            aria-label={current ? "Back to settings" : "Back to setup"}
            onClick={() => (current ? setPage(null) : onBackToSetup())}
          >
            ‹
          </button>
          <div className="brand-name">
            {current ? `Settings · ${current.label}` : "Signstream · settings"}
          </div>
        </div>
        <div className={`saved-pill${justSaved ? " is-saved" : ""}`} aria-live="polite">
          {justSaved ? "Saved" : "Synced"}
        </div>
      </div>

      {!current && (
        <nav className="settings-menu" aria-label="Settings sections">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className="menu-item"
              onClick={() => setPage(p.id)}
            >
              <div className="menu-main">
                <div className="menu-label">{p.label}</div>
                <div className="menu-blurb">{p.blurb}</div>
              </div>
              <div className="menu-chevron" aria-hidden="true">
                ›
              </div>
            </button>
          ))}
        </nav>
      )}

      {current && (
        <div className="settings-page">
          <div className="page-head">
            <p className="lede lede-sm">{current.blurb}</p>
          </div>

          {page === "audio" && (
            <>
              <div className={`audio-card${connected ? " is-live" : ""}`}>
                <div className="mini-meter" aria-hidden="true">
                  {MINI_METER_HEIGHTS.map((h, i) => (
                    <div
                      key={i}
                      className={`meter-bar${connected ? " is-live" : ""}`}
                      style={
                        connected
                          ? {
                              height: `${Math.round(h * 22)}px`,
                              animationDuration: `${0.7 + (i % 3) * 0.2}s`,
                              animationDelay: `${i * 0.08}s`,
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
                <div className="audio-card-main">
                  <div className="audio-card-title">
                    {connected ? "This tab’s audio" : "Audio disconnected"}
                  </div>
                  <div className="audio-card-body">
                    {connected
                      ? "Streaming to the cloud for live transcription."
                      : "Reconnect to resume signing."}
                  </div>
                </div>
                <button type="button" className="audio-btn" onClick={onToggleAudio}>
                  {connected ? "Disconnect" : "Connect"}
                </button>
              </div>

              <Toggles
                settings={settings}
                update={update}
                ids={["autoStart", "audioPassthrough"]}
              />
            </>
          )}

          {page === "language" && (
            <div className="rows" role="radiogroup" aria-label="Sign language">
              {SIGN_LANGUAGES.map((lang) => {
                const selected = lang.value === settings.language;
                return (
                  <label key={lang.value} className={`row${selected ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="setlang"
                      value={lang.value}
                      checked={selected}
                      onChange={(e) =>
                        update({
                          language: e.target.value as SignLanguage,
                          // Changing it here is just as explicit as choosing it
                          // in the wizard, so the flag stays set either way.
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
          )}

          {page === "signer" && (
            <div className="rows" role="radiogroup" aria-label="Avatar model">
              {RIGS.map((rig) => {
                const selected = rig.id === settings.avatarModel;
                return (
                  <label key={rig.id} className={`row${selected ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="avatarmodel"
                      value={rig.id}
                      checked={selected}
                      onChange={() => update({ avatarModel: rig.id })}
                    />
                    <div className="row-main">
                      <div className="row-title">{rig.label}</div>
                      <div className="row-sub">{rig.links.length} tracked joints</div>
                    </div>
                    <div className="row-dot" />
                  </label>
                );
              })}
            </div>
          )}

          {page === "placement" && (
            <>
              <AvatarPreview
                size={size}
                position={position}
                contrast={contrast}
                backdrop={settings.avatarBackdrop}
                compact
              />
              <div className="section-label">Corner</div>
              <div className="chip-grid chip-grid-tight">
                {POSITIONS.map((pos) => (
                  <button
                    key={pos.id}
                    type="button"
                    className={`chip is-compact${
                      pos.id === settings.avatarPosition ? " is-selected" : ""
                    }`}
                    aria-pressed={pos.id === settings.avatarPosition}
                    onClick={() =>
                      update({
                        avatarPosition: pos.id,
                        // A corner pick overrides a previous drag, otherwise the
                        // button would appear to do nothing.
                        avatarCustomPosition: null,
                      })
                    }
                  >
                    {pos.label}
                  </button>
                ))}
              </div>
              <div className="section-label">Size</div>
              <div className="chip-row chip-row-tight">
                {SIZES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`chip is-compact${
                      s.id === settings.avatarSize ? " is-selected" : ""
                    }`}
                    aria-pressed={s.id === settings.avatarSize}
                    onClick={() => update({ avatarSize: s.id })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="note note-tight">
                <div className="note-rule" />
                <div className="note-text">
                  You can also drag the interpreter straight to where you want it on the video.
                </div>
              </div>
            </>
          )}

          {page === "look" && (
            <>
              <div className="section-label">Backdrop</div>
              <div className="backdrop-grid">
                {BACKDROPS.map((bd) => (
                  <button
                    key={bd.id}
                    type="button"
                    title={bd.label}
                    aria-pressed={bd.id === settings.avatarBackdrop}
                    className={`backdrop${
                      bd.id === settings.avatarBackdrop ? " is-selected" : ""
                    }`}
                    onClick={() => update({ avatarBackdrop: bd.id })}
                  >
                    <div
                      className={`backdrop-swatch${bd.id === "none" ? " is-none" : ""}`}
                      style={bd.id === "none" ? undefined : { background: bd.fill }}
                    />
                    <div className="backdrop-label">{bd.label}</div>
                  </button>
                ))}
              </div>

              <div className="section-label">Contrast</div>
              <div className="rows" role="radiogroup" aria-label="Contrast">
                {CONTRASTS.map((opt) => {
                  const selected = opt.id === settings.avatarContrast;
                  return (
                    <label
                      key={opt.id}
                      className={`row is-tight${selected ? " is-selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="setcontrast"
                        value={opt.id}
                        checked={selected}
                        onChange={(e) =>
                          update({ avatarContrast: e.target.value as AvatarContrast })
                        }
                      />
                      <div
                        className="row-swatch is-sm"
                        style={{
                          background: `linear-gradient(135deg, ${opt.a} 0 50%, ${opt.b} 50% 100%)`,
                        }}
                      />
                      <div className="row-main">
                        <div className="row-title">{opt.label}</div>
                        <div className="row-sub">{opt.settingsDesc}</div>
                      </div>
                      <div className="row-dot" />
                    </label>
                  );
                })}
              </div>

              <Toggles settings={settings} update={update} ids={["dimBackground"]} />
            </>
          )}

          {page === "playback" && (
            <>
              <div className="group-head">
                <div className="group-label group-label-inline">Signing speed</div>
                <div className="group-value">{speedLabel}</div>
              </div>
              <input
                className="slider"
                type="range"
                min={0.7}
                max={1.3}
                step={0.1}
                value={settings.signingSpeed}
                aria-label="Signing speed"
                onChange={(e) => update({ signingSpeed: parseFloat(e.target.value) })}
              />
              <div className="note note-tight">
                <div className="note-rule" />
                <div className="note-text">
                  Clips are recorded as isolated citation forms, performed slowly and clearly.
                  Connected signing runs quicker, so the default sits slightly above 1×.
                </div>
              </div>
              <Toggles settings={settings} update={update} ids={["showTranscript"]} />
            </>
          )}

          {page === "status" && <StatusPage connected={connected} />}

          {page === "privacy" && (
            <>
              <div className="privacy">
                {[
                  ["Audio capture", "On your computer"],
                  ["Transcription", "Cloud, in transit only"],
                  ["Audio retention", "Never stored"],
                  ["Active language", language.value],
                ].map(([label, value]) => (
                  <div key={label} className="privacy-row">
                    <div className="privacy-label">{label}</div>
                    <div className="privacy-value">{value}</div>
                  </div>
                ))}
              </div>
              <div className="note note-tight">
                <div className="note-rule" />
                <div className="note-text">
                  Resetting restores display defaults only. Your sign language is left alone —
                  it is your language, not a preference.
                </div>
              </div>
              <button type="button" className="btn-danger" onClick={resetAll}>
                Reset to defaults
              </button>
            </>
          )}
        </div>
      )}

      <div className="footer">
        <button
          type="button"
          className="btn btn-back"
          onClick={() => (current ? setPage(null) : onBackToSetup())}
        >
          {current ? "Back" : "Setup"}
        </button>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

const TOGGLE_DEFS: Record<string, { label: string; desc: string }> = {
  autoStart: {
    label: "Start automatically",
    desc: "Begin signing as soon as audio is detected on a stream.",
  },
  audioPassthrough: {
    label: "Play audio through speakers",
    desc: "Off: the audio is used for signing only and the tab stays silent.",
  },
  dimBackground: {
    label: "Dim video behind avatar",
    desc: "Soften the frame directly behind the signer.",
  },
  showTranscript: {
    label: "Show text captions too",
    desc: "Display the transcript line under the interpreter.",
  },
};

function Toggles({
  settings,
  update,
  ids,
}: {
  settings: ExtensionSettings;
  update: (patch: Partial<ExtensionSettings>) => void;
  ids: (keyof ExtensionSettings)[];
}) {
  return (
    <div className="toggle-group">
      {ids.map((id) => {
        const def = TOGGLE_DEFS[id as string];
        const on = Boolean(settings[id]);
        return (
          <div key={id as string} className="toggle-row">
            <div className="toggle-main">
              <div className="toggle-label">{def.label}</div>
              <div className="toggle-desc">{def.desc}</div>
            </div>
            <button
              type="button"
              className={`toggle${on ? " is-on" : ""}`}
              role="switch"
              aria-checked={on}
              aria-label={def.label}
              onClick={() => update({ [id]: !on } as Partial<ExtensionSettings>)}
            >
              <span />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Live pipeline readout.
 *
 * A silent avatar has half a dozen indistinguishable causes, and every one of
 * them used to present as an empty rectangle. This walks the stages in order so
 * the first one showing nothing is the one at fault.
 */
function StatusPage({ connected }: { connected: boolean }) {
  const [data, setData] = useState<DiagnosticsData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      chrome.runtime
        .sendMessage({ type: "GET_DIAGNOSTICS" } satisfies ExtensionMessage)
        .then((res: ExtensionMessage | undefined) => {
          if (!cancelled && res?.type === "DIAGNOSTICS") setData(res.diagnostics);
        })
        .catch(() => {
          /* worker asleep — the next tick will get it */
        });
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!data) return <div className="status-empty">Reading pipeline…</div>;

  const a = data.avatar;
  // Ordered as the audio actually flows. The first bad row is the culprit.
  const stages: { label: string; ok: boolean; value: string }[] = [
    {
      label: "1 · Capture",
      ok: data.captureActive,
      value: data.captureActive ? `${data.audioFrames} frames` : "not capturing",
    },
    {
      label: "2 · Cloud",
      ok: data.cloudConnected,
      value: data.cloudConnected ? `${data.audioSent} frames sent` : "disconnected",
    },
    {
      label: "3 · Transcript",
      ok: data.transcripts > 0,
      value: data.transcripts > 0 ? `${data.transcripts} final` : "nothing yet",
    },
    {
      label: "4 · Signs matched",
      ok: data.signIds > 0,
      value: data.signIds > 0 ? `${data.signIds} ids` : "no words matched",
    },
    {
      label: "5 · Overlay",
      ok: a !== null,
      value: a ? "mounted" : "not on this tab",
    },
    {
      label: "6 · Model",
      ok: Boolean(a?.rigLoaded),
      value: a?.rigError ? "failed" : a?.rigLoaded ? a.rigId : "loading…",
    },
    {
      label: "7 · Skeleton",
      // A rig map that matches nothing is the failure that cost the most time:
      // it renders a motionless avatar and says nothing anywhere.
      ok: Boolean(a && a.bonesDriven > 0 && a.bonesMissing === 0),
      value: a ? `${a.bonesDriven} driven, ${a.bonesMissing} missing` : "—",
    },
    {
      label: "8 · Clips",
      ok: Boolean(a && a.clipsPlayed > 0),
      value: a ? `${a.clipsPlayed} played, ${a.clipsMissing} missing` : "—",
    },
  ];

  return (
    <>
      <div className="status-list">
        {stages.map((s) => (
          <div key={s.label} className="status-row">
            <span className={`status-dot${s.ok ? " is-ok" : ""}`} />
            <div className="status-label">{s.label}</div>
            <div className="status-value">{s.value}</div>
          </div>
        ))}
      </div>

      {data.captureError && <div className="error-note">{data.captureError}</div>}
      {a?.rigError && <div className="error-note">Model: {a.rigError}</div>}

      <div className="status-meta">
        <div>
          <span className="status-meta-key">level</span> {data.lastRms.toFixed(3)}
          {data.captureActive && data.lastRms < 0.001 && " — silence"}
        </div>
        <div>
          <span className="status-meta-key">last sign</span> {data.lastSignId || "—"}
        </div>
        <div className="status-transcript">
          <span className="status-meta-key">last words</span> {data.lastTranscript || "—"}
        </div>
      </div>

      {!connected && (
        <div className="note note-tight">
          <div className="note-rule" />
          <div className="note-text">
            Audio is disconnected, so every stage below capture will stay empty. Connect it on
            the Audio page.
          </div>
        </div>
      )}
    </>
  );
}
