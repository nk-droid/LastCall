// LastCall design tokens (product spec §05): calm, warm local-commerce. Cream page, white surfaces
// with strong 1px borders and very limited shadow, a single leaf-green accent, and status shown by
// colour + text + icon, never colour alone. Plain values, so the MUI theme and server components
// (metadata, viewport) can share them.

export const brand = {
  forest: "#14231D", // text and dark surfaces
  forestSoft: "#24362D",
  leaf: "#247B54", // accent; 5.2:1 on white, 4.9:1 on cream
  leafDark: "#1B5E40",
  leafLight: "#4E9C76",
  mint: "#E9F4ED",
  mintStrong: "#D4EADC",
  cream: "#F8F7F2", // page background
  paper: "#FFFFFF", // surfaces
  sand: "#F1F2ED", // quiet fills
  muted: "#52645B", // secondary text, 5.9:1 on cream
  line: "#E1E5DE", // borders and separators
  lineStrong: "#C9D1C8",
  warning: "#C87537",
  warningText: "#8F4A1A",
  warningBg: "#FBF0E6",
  danger: "#B42318",
  dangerBg: "#FBEAE7",
  info: "#1D4F7A",
  infoBg: "#E9F1F8",
  paypal: "#FFC439",
} as const;

export type Tone = "success" | "warning" | "danger" | "neutral" | "info";

/** Status colours. Every fg/bg pair is at least 4.5:1, and status is never colour alone. */
export const tones: Record<Tone, { bg: string; fg: string; border: string }> = {
  success: { bg: brand.mint, fg: brand.leafDark, border: "#BFDDCB" },
  warning: { bg: brand.warningBg, fg: brand.warningText, border: "#EFD3BB" },
  danger: { bg: brand.dangerBg, fg: brand.danger, border: "#F1C7C1" },
  neutral: { bg: brand.sand, fg: brand.forest, border: brand.line },
  info: { bg: brand.infoBg, fg: brand.info, border: "#C8DAEA" },
};

export const radius = { control: 10, card: 16 } as const;

/** Shadows are used sparingly: a faint lift for cards, real depth only for floating layers. */
export const shadows = {
  raised: "0 1px 2px rgba(20, 35, 29, 0.05), 0 4px 14px rgba(20, 35, 29, 0.04)",
  raisedSm: "0 1px 2px rgba(20, 35, 29, 0.06)",
  inset: "none",
  insetSm: "none",
  floating: "0 18px 48px rgba(20, 35, 29, 0.16), 0 2px 6px rgba(20, 35, 29, 0.06)",
} as const;

/** sx-ready surfaces: spread into `sx`, e.g. `sx={{ ...surface.inset, p: 2 }}`. */
export const surface = {
  base: brand.cream,
  /** A card on the page. */
  raised: { bgcolor: brand.paper, border: `1px solid ${brand.line}`, boxShadow: shadows.raised },
  /** A small bordered control, tile or chip. */
  raisedSm: { bgcolor: brand.paper, border: `1px solid ${brand.line}`, boxShadow: "none" },
  /** A quiet well inside a card: grouped content, image frames. */
  inset: { bgcolor: brand.cream, border: `1px solid ${brand.line}`, boxShadow: "none" },
  insetSm: { bgcolor: brand.sand, border: `1px solid ${brand.line}`, boxShadow: "none" },
  /** Selected / active state. */
  pressed: { bgcolor: brand.mint, border: `1px solid ${brand.leaf}`, boxShadow: "none" },
  /** Content grouped by spacing alone. */
  flat: { bgcolor: "transparent", boxShadow: "none", border: "none" },
  /** Separators between rows. */
  hairline: brand.line,
  /** Edge of text inputs: 3.1:1 against white, so fields stay identifiable (WCAG 1.4.11). */
  edge: "#8A968F",
} as const;

export const cardShadow = shadows.raised;
