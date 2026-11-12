"use client";

import { createTheme, type Shadows } from "@mui/material/styles";
import NextLink from "next/link";
import type { ComponentProps } from "react";

import { brand, radius, shadows, surface, tones } from "./tokens";

/** Lets every MUI Button/Link/ListItemButton with an `href` navigate client-side. */
function LinkBehavior(props: ComponentProps<typeof NextLink>) {
  return <NextLink {...props} />;
}

const fontFamily = 'var(--font-inter), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const headingFamily = 'var(--font-heading), var(--font-inter), ui-sans-serif, system-ui, sans-serif';

// Elevation 1-4 is a faint lift (cards); higher levels are floating layers (menus, dialogs).
const elevations = [
  "none",
  shadows.raisedSm,
  shadows.raisedSm,
  shadows.raised,
  shadows.raised,
  ...Array.from({ length: 20 }, () => shadows.floating),
] as Shadows;

const hover = "rgba(20, 35, 29, 0.04)";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: brand.leaf, dark: brand.leafDark, light: brand.leafLight, contrastText: "#FFFFFF" },
    secondary: { main: brand.forest, light: brand.forestSoft, dark: "#0B1511", contrastText: "#FFFFFF" },
    success: { main: brand.leaf, dark: brand.leafDark, light: "#8CC4A6", contrastText: "#FFFFFF" },
    warning: { main: brand.warning, dark: brand.warningText, light: "#E7B48C", contrastText: brand.forest },
    error: { main: brand.danger, dark: "#8C1C13", light: "#E88F87", contrastText: "#FFFFFF" },
    info: { main: brand.info, dark: "#143A5A", light: "#8DB3D6", contrastText: "#FFFFFF" },
    background: { default: brand.cream, paper: brand.paper },
    text: { primary: brand.forest, secondary: brand.muted },
    divider: brand.line,
    action: { hover, selected: "rgba(36, 123, 84, 0.08)" },
  },
  shadows: elevations,
  shape: { borderRadius: radius.control },
  typography: {
    fontFamily,
    fontSize: 15,
    h1: { fontFamily: headingFamily, fontSize: "clamp(1.6rem, 1.2rem + 1.6vw, 2.25rem)", fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.12 },
    h2: { fontFamily: headingFamily, fontSize: "clamp(1.35rem, 1.15rem + 0.8vw, 1.7rem)", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.18 },
    h3: { fontFamily: headingFamily, fontSize: "1.22rem", fontWeight: 650, letterSpacing: "-0.015em", lineHeight: 1.22 },
    h4: { fontSize: "1.06rem", fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.28 },
    h5: { fontSize: "1rem", fontWeight: 650, lineHeight: 1.3 },
    h6: { fontSize: "0.94rem", fontWeight: 650, lineHeight: 1.3 },
    subtitle1: { fontSize: "1rem", fontWeight: 600, lineHeight: 1.45 },
    subtitle2: { fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.4 },
    body1: { fontSize: "0.97rem", lineHeight: 1.6 },
    body2: { fontSize: "0.875rem", lineHeight: 1.55 },
    caption: { fontSize: "0.78rem", lineHeight: 1.45 },
    overline: { fontSize: "0.72rem", fontWeight: 650, letterSpacing: "0.12em", lineHeight: 1.6 },
    button: { textTransform: "none", fontWeight: 600, letterSpacing: 0 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { WebkitTextSizeAdjust: "100%" },
        body: { WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale", backgroundColor: brand.cream },
        "h1, h2, h3, h4": { textWrap: "balance" },
        "::selection": { background: brand.mintStrong },
        ".tabular": { fontVariantNumeric: "tabular-nums" },
        "@media (prefers-reduced-motion: reduce)": { "*, *::before, *::after": { transitionDuration: "0.01ms !important", animationDuration: "0.01ms !important" } },
      },
    },
    MuiButtonBase: { defaultProps: { LinkComponent: LinkBehavior } },
    MuiTypography: {
      // MUI 9 colours Typography only for palette keys ("textSecondary"); the pages use the dotted form, so map it here.
      styleOverrides: {
        root: {
          variants: [
            { props: { color: "text.secondary" }, style: { color: brand.muted } },
            { props: { color: "text.primary" }, style: { color: brand.forest } },
          ],
        },
      },
    },
    MuiLink: {
      defaultProps: { component: LinkBehavior, underline: "always" },
      styleOverrides: { root: { fontWeight: 600, textUnderlineOffset: 3 } },
    },

    // ----------------------------------------------------------------- surfaces
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none", backgroundColor: brand.paper },
        rounded: { borderRadius: radius.card },
        outlined: { border: `1px solid ${brand.line}` },
      },
    },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: { root: { borderRadius: radius.card, border: `1px solid ${brand.line}`, boxShadow: shadows.raised, backgroundColor: brand.paper } },
    },
    MuiCardContent: { styleOverrides: { root: { padding: 20, "&:last-child": { paddingBottom: 20 } } } },
    MuiCardHeader: {
      styleOverrides: {
        root: { padding: "18px 20px 0" },
        title: { fontWeight: 650, fontSize: "1.02rem" },
        subheader: { fontSize: "0.85rem", color: brand.muted },
      },
    },
    MuiCardActionArea: { styleOverrides: { root: { borderRadius: radius.card }, focusHighlight: { opacity: 0 } } },
    MuiAccordion: {
      defaultProps: { disableGutters: true, elevation: 0 },
      styleOverrides: {
        root: {
          borderRadius: radius.card,
          border: `1px solid ${brand.line}`,
          backgroundColor: brand.paper,
          "&::before": { display: "none" },
          "&:not(:last-of-type)": { marginBottom: 12 },
          "&:first-of-type, &:last-of-type": { borderRadius: radius.card },
        },
      },
    },
    MuiAccordionSummary: { styleOverrides: { root: { minHeight: 56, paddingInline: 18 }, content: { alignItems: "center", gap: 10 } } },
    MuiAccordionDetails: { styleOverrides: { root: { paddingInline: 18, paddingBottom: 18 } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 20, boxShadow: shadows.floating } } },
    MuiDrawer: { styleOverrides: { paper: { backgroundColor: brand.paper, border: "none" } } },
    MuiPopover: { styleOverrides: { paper: { borderRadius: 14, boxShadow: shadows.floating, border: `1px solid ${brand.line}` } } },
    MuiMenu: { styleOverrides: { paper: { borderRadius: 14, boxShadow: shadows.floating, border: `1px solid ${brand.line}` } } },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: "inherit" },
      styleOverrides: { root: { backgroundColor: brand.paper, backgroundImage: "none", boxShadow: "none", borderBottom: `1px solid ${brand.line}` } },
    },
    MuiDivider: { styleOverrides: { root: { borderColor: brand.line } } },

    // ----------------------------------------------------------------- controls
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: radius.control,
          minHeight: 44,
          paddingInline: 18,
          whiteSpace: "nowrap",
          transition: "background-color 160ms ease, border-color 160ms ease, color 160ms ease",
        },
        sizeSmall: { minHeight: 34, paddingInline: 12, fontSize: "0.85rem", borderRadius: 8 },
        sizeLarge: { minHeight: 52, paddingInline: 24, fontSize: "1rem" },
        contained: { "&.Mui-disabled": { backgroundColor: brand.sand, color: "rgba(20, 35, 29, 0.42)" } },
        outlined: {
          backgroundColor: brand.paper,
          borderColor: brand.lineStrong,
          "&:hover": { borderColor: brand.forest, backgroundColor: brand.paper },
          "&.Mui-disabled": { borderColor: brand.line, color: "rgba(20, 35, 29, 0.42)" },
        },
        text: { "&:hover": { backgroundColor: hover } },
      },
    },
    MuiIconButton: { styleOverrides: { root: { borderRadius: radius.control, "&:hover": { backgroundColor: hover } } } },
    MuiFab: { styleOverrides: { root: { boxShadow: shadows.floating } } },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: { gap: 8, flexWrap: "wrap" },
        grouped: { border: `1px solid ${brand.lineStrong} !important`, borderRadius: `${radius.control}px !important`, margin: 0 },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 600,
          color: brand.forest,
          borderRadius: radius.control,
          backgroundColor: brand.paper,
          "&:hover": { backgroundColor: brand.sand },
          "&.Mui-selected, &.Mui-selected:hover": { ...surface.pressed, color: brand.leafDark, borderColor: `${brand.leaf} !important` },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, borderRadius: 999 },
        sizeSmall: { height: 26, fontSize: "0.78rem" },
        filled: { backgroundColor: brand.sand },
        outlined: { borderColor: brand.line, backgroundColor: brand.paper },
        icon: { color: "inherit" },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: radius.control,
          backgroundColor: brand.paper,
          "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: brand.forest },
        },
        notchedOutline: { borderColor: surface.edge },
      },
    },
    MuiInputLabel: { styleOverrides: { root: { color: brand.muted } } },
    MuiFormHelperText: { styleOverrides: { root: { marginLeft: 2, fontSize: "0.78rem" } } },
    MuiSwitch: { styleOverrides: { track: { backgroundColor: "#9AA79F", opacity: 1 } } },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: radius.control,
          "&:hover": { backgroundColor: hover },
          "&.Mui-selected, &.Mui-selected:hover": { backgroundColor: brand.mint, color: brand.leafDark },
        },
      },
    },

    // ----------------------------------------------------------------- feedback & data
    MuiAlert: {
      styleOverrides: {
        root: ({ ownerState }) => {
          const tone = ownerState.severity === "error" ? tones.danger : tones[(ownerState.severity ?? "success") as "success" | "warning" | "info"];
          return {
            borderRadius: radius.control,
            alignItems: "flex-start",
            fontSize: "0.9rem",
            ...(ownerState.variant === "standard" || ownerState.variant === undefined
              ? { backgroundColor: tone.bg, color: brand.forest, border: `1px solid ${tone.border}`, "& .MuiAlert-icon": { color: tone.fg } }
              : {}),
          };
        },
        message: { paddingBlock: 8 },
        action: { paddingTop: 2 },
      },
    },
    MuiAlertTitle: { styleOverrides: { root: { fontWeight: 650, marginBottom: 2, marginTop: 0 } } },
    MuiTooltip: {
      defaultProps: { arrow: true },
      styleOverrides: {
        tooltip: { backgroundColor: brand.forest, fontSize: "0.8rem", padding: "8px 10px", borderRadius: 8, maxWidth: 300, lineHeight: 1.45 },
        arrow: { color: brand.forest },
      },
    },
    MuiTabs: { styleOverrides: { indicator: { height: 3, borderRadius: 3 } } },
    MuiTab: { styleOverrides: { root: { textTransform: "none", fontWeight: 600, minHeight: 48, fontSize: "0.92rem" } } },
    MuiLinearProgress: {
      styleOverrides: { root: { height: 8, borderRadius: 999, backgroundColor: brand.sand }, bar: { borderRadius: 999 } },
    },
    MuiTableContainer: { styleOverrides: { root: { backgroundColor: "transparent" } } },
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 650, color: brand.muted, fontSize: "0.76rem", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" },
        root: { borderColor: brand.line },
      },
    },
    MuiDialogTitle: { styleOverrides: { root: { fontWeight: 700, fontSize: "1.15rem" } } },
    MuiSkeleton: { defaultProps: { animation: "wave" }, styleOverrides: { root: { backgroundColor: brand.sand } } },
    MuiStepLabel: { styleOverrides: { label: { fontWeight: 600, "&.Mui-active": { fontWeight: 650 }, "&.Mui-completed": { fontWeight: 600 } } } },
    MuiStepConnector: { styleOverrides: { line: { borderColor: brand.lineStrong } } },
    MuiBadge: { styleOverrides: { badge: { fontWeight: 650 } } },
  },
});
