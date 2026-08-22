// Option tables and the avatar preview, shared by the setup wizard and the
// settings screen so both stay in lockstep when an option changes.

import type {
  AvatarBackdrop,
  AvatarContrast,
  AvatarPosition,
  AvatarSize,
} from "../shared/types";

export const POSITIONS: { id: AvatarPosition; label: string }[] = [
  { id: "top-left", label: "Top left" },
  { id: "top-right", label: "Top right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "bottom-right", label: "Bottom right" },
];

export const SIZES: { id: AvatarSize; label: string; pct: number }[] = [
  { id: "small", label: "Small", pct: 22 },
  { id: "medium", label: "Medium", pct: 30 },
  { id: "large", label: "Large", pct: 40 },
];

export const CONTRASTS: {
  id: AvatarContrast;
  label: string;
  /** Copy used in the setup wizard. */
  desc: string;
  /** Slightly different copy the settings screen uses. */
  settingsDesc: string;
  a: string;
  b: string;
}[] = [
  {
    id: "standard",
    label: "Standard",
    desc: "Warm neutral background",
    settingsDesc: "Warm neutral tones",
    a: "oklch(0.9 0.02 70)",
    b: "oklch(0.4 0.02 65)",
  },
  {
    id: "high",
    label: "High contrast",
    desc: "Pure black on white for crisp handshapes",
    settingsDesc: "Maximum edge definition on handshapes",
    a: "oklch(1 0 0)",
    b: "oklch(0.15 0 0)",
  },
  {
    id: "inverted",
    label: "Light on dark",
    desc: "Easier in dim rooms and night viewing",
    settingsDesc: "Easier in dim rooms and night viewing",
    a: "oklch(0.2 0.01 60)",
    b: "oklch(0.97 0.005 80)",
  },
];

const BACKDROP_FILL: Record<AvatarBackdrop, { fill: string; ink: string }> = {
  studio: { fill: "oklch(0.88 0.012 78)", ink: "oklch(0.35 0.014 62)" },
  light: { fill: "oklch(0.99 0.003 80)", ink: "oklch(0.3 0.014 62)" },
  dark: { fill: "oklch(0.24 0.012 62)", ink: "oklch(0.95 0.006 80)" },
  none: { fill: "oklch(0.5 0.014 62 / 0.35)", ink: "oklch(0.99 0.005 80)" },
};

export function AvatarPreview({
  size,
  position,
  contrast,
  backdrop = "studio",
  compact = false,
}: {
  size: (typeof SIZES)[number];
  position: (typeof POSITIONS)[number];
  contrast: (typeof CONTRASTS)[number];
  backdrop?: AvatarBackdrop;
  compact?: boolean;
}) {
  const inset = 8;
  const [vertical, horizontal] = position.id.split("-");

  // Light-on-dark contrast flips the studio plate so light handshapes read.
  const invertedStudio = contrast.id === "inverted" && backdrop === "studio";
  const fill = invertedStudio ? "oklch(0.28 0.012 62)" : BACKDROP_FILL[backdrop].fill;
  const ink = invertedStudio ? "oklch(0.95 0.006 80)" : BACKDROP_FILL[backdrop].ink;

  return (
    <div className={`preview${compact ? " is-compact" : ""}`}>
      <div className="preview-label">stream</div>
      <div
        className={`preview-avatar${backdrop === "none" ? " is-plateless" : ""}`}
        style={{
          width: `${size.pct}%`,
          background: fill,
          [vertical === "top" ? "top" : "bottom"]: `${inset}%`,
          [horizontal === "left" ? "left" : "right"]: `${inset / 2}%`,
        }}
      >
        <span style={{ color: ink }}>interpreter</span>
      </div>
    </div>
  );
}
