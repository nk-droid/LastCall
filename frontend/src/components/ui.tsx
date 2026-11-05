"use client";

import {
  AddRounded,
  CheckCircleRounded,
  CheckRounded,
  ErrorRounded,
  HourglassTopRounded,
  InfoOutlined,
  InfoRounded,
  RefreshRounded,
  RemoveRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  LinearProgress,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
  type SvgIconProps,
} from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { useId, type ComponentType, type ElementType, type ReactNode, type Ref } from "react";

import { brand, surface, shadows, tones, type Tone } from "@/theme/tokens";

export { brand, surface, shadows, tones, type Tone };

export type Icon = ComponentType<SvgIconProps>;

/** Merge `sx` values (objects, arrays or undefined) into one array MUI accepts. */
export function sxs(...parts: (SxProps<Theme> | undefined | false)[]): SxProps<Theme> {
  return parts.flatMap((p) => (!p ? [] : Array.isArray(p) ? p : [p])) as SxProps<Theme>;
}

const TONE_ICON: Record<Tone, Icon> = {
  success: CheckCircleRounded,
  warning: WarningAmberRounded,
  danger: ErrorRounded,
  neutral: InfoRounded,
  info: InfoRounded,
};

// ----------------------------------------------------------------------------- status

/** Status is always icon + text + color, never color alone. */
export function StatusChip({ tone, label, icon, size = "small", sx }: { tone: Tone; label: ReactNode; icon?: Icon; size?: "small" | "medium"; sx?: SxProps<Theme> }) {
  const t = tones[tone];
  const IconComponent = icon ?? TONE_ICON[tone];
  return (
    <Chip
      size={size}
      icon={<IconComponent />}
      label={label}
      sx={sxs({ bgcolor: t.bg, color: t.fg, "& .MuiChip-icon": { color: t.fg, fontSize: size === "small" ? 16 : 18 } }, sx)}
    />
  );
}

/** A small icon + text fact ("Pickup 5–7 PM"). Neutral and quiet; use StatusChip for state. */
export function FactChip({ icon: IconComponent, label, sx }: { icon?: Icon; label: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      icon={IconComponent ? <IconComponent /> : undefined}
      label={label}
      sx={sxs({ fontWeight: 600, color: brand.forest, "& .MuiChip-icon": { color: brand.leaf, fontSize: 16 } }, sx)}
    />
  );
}

// ----------------------------------------------------------------------------- layout

export function PageHeader({ eyebrow, title, subtitle, actions, chips, titleId, titleRef, variant = "h1" }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  chips?: ReactNode;
  titleId?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  variant?: "h1" | "h2";
}) {
  return (
    <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { md: "flex-end" }, mb: { xs: 2.5, sm: 3.5 } }}>
      <Box sx={{ minWidth: 0 }}>
        {eyebrow ? (
          <Typography variant="overline" component="p" color="text.secondary">
            {eyebrow}
          </Typography>
        ) : null}
        <Typography variant={variant} component="h1" id={titleId} ref={titleRef} tabIndex={titleRef ? -1 : undefined}>
          {title}
        </Typography>
        {subtitle ? (
          <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 680 }}>
            {subtitle}
          </Typography>
        ) : null}
        {chips ? (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1.5 }}>
            {chips}
          </Stack>
        ) : null}
      </Box>
      {actions ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", flexShrink: 0 }}>
          {actions}
        </Stack>
      ) : null}
    </Stack>
  );
}

/** Card with an optional icon + heading row. The heading labels the region. */
export function SectionCard({ title, subtitle, icon, action, children, id, component = "section", headingComponent = "h2", sx, contentSx, headingRef }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  id?: string;
  component?: ElementType;
  headingComponent?: ElementType;
  sx?: SxProps<Theme>;
  contentSx?: SxProps<Theme>;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const headingId = useId();
  return (
    <Card component={component} id={id} aria-labelledby={title ? headingId : undefined} sx={sx}>
      {title ? (
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", px: { xs: 2.5, sm: 3 }, pt: { xs: 2.5, sm: 3 } }}>
          {icon ? <IconBadge>{icon}</IconBadge> : null}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id={headingId} ref={headingRef} tabIndex={headingRef ? -1 : undefined} component={headingComponent} variant="h4">
              {title}
            </Typography>
            {subtitle ? (
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            ) : null}
          </Box>
          {action ? <Box sx={{ flexShrink: 0 }}>{action}</Box> : null}
        </Stack>
      ) : null}
      <Box sx={sxs({ p: { xs: 2.5, sm: 3 } }, contentSx)}>{children}</Box>
    </Card>
  );
}

export function IconBadge({ children, tone = "success", size = 36 }: { children: ReactNode; tone?: Tone; size?: number }) {
  return (
    <Box aria-hidden sx={{ ...surface.raisedSm, display: "grid", placeItems: "center", width: size, height: size, borderRadius: "50%", color: tones[tone].fg, flexShrink: 0, "& svg": { fontSize: size * 0.52 } }}>
      {children}
    </Box>
  );
}

/** A headline number. `progress` (0–100) adds a labelled meter; `help` adds an info tooltip. */
export function StatTile({ label, value, caption, icon, tone = "success", progress, progressLabel, help, sx }: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  progress?: number;
  progressLabel?: string;
  help?: string;
  sx?: SxProps<Theme>;
}) {
  return (
    <Card sx={sxs({ height: "100%" }, sx)}>
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 0.75, height: "100%" }}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 650, display: "flex", alignItems: "center" }}>
            {label}
            {help ? <InfoTip title={help} label={`About ${label.toLowerCase()}`} /> : null}
          </Typography>
          {icon ? <IconBadge tone={tone} size={32}>{icon}</IconBadge> : null}
        </Stack>
        <Typography variant="h2" component="p" className="tabular">
          {value}
        </Typography>
        {progress !== undefined ? (
          <LinearProgress
            variant="determinate"
            value={Math.max(0, Math.min(100, progress))}
            aria-label={progressLabel ?? label}
            color={tone === "warning" ? "warning" : tone === "danger" ? "error" : "primary"}
          />
        ) : null}
        {caption ? (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: "auto", pt: 0.5 }}>
            {caption}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}

export type InfoItem = { label: ReactNode; value: ReactNode; icon?: Icon };

/** Key facts as a definition list. `row` puts the value on the right (receipts, summaries). */
export function InfoList({ items, layout = "stacked", columns = 1, sx }: { items: InfoItem[]; layout?: "stacked" | "row"; columns?: 1 | 2 | 3; sx?: SxProps<Theme> }) {
  return (
    <Box
      component="dl"
      sx={sxs(
        { m: 0, display: "grid", gap: layout === "row" ? 1 : 2, gridTemplateColumns: { xs: "1fr", sm: columns === 1 ? "1fr" : "1fr 1fr", md: `repeat(${columns}, 1fr)` } },
        sx,
      )}
    >
      {items.map((item, index) => (
        <Box key={index} sx={layout === "row" ? { display: "flex", justifyContent: "space-between", gap: 2, alignItems: "baseline" } : undefined}>
          <Typography component="dt" variant={layout === "row" ? "body2" : "caption"} color="text.secondary" sx={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 0.75 }}>
            {item.icon ? <item.icon aria-hidden sx={{ fontSize: 17, color: brand.leaf }} /> : null}
            {item.label}
          </Typography>
          <Typography component="dd" variant="body2" className="tabular" sx={{ m: 0, fontWeight: 650, textAlign: layout === "row" ? "right" : undefined, pl: layout === "stacked" && item.icon ? 3.1 : 0 }}>
            {item.value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export function InfoTip({ title, label = "More info" }: { title: ReactNode; label?: string }) {
  return (
    <Tooltip title={title} describeChild enterTouchDelay={0} leaveTouchDelay={4000}>
      <IconButton size="small" aria-label={label} sx={{ ml: 0.25, p: 0.25, color: "text.secondary", borderRadius: "50%" }}>
        <InfoOutlined sx={{ fontSize: 17 }} />
      </IconButton>
    </Tooltip>
  );
}

// ----------------------------------------------------------------------------- states

export function LoadingBlock({ label, slow, lines = 3, variant = "lines", count = 3 }: { label: string; slow?: boolean; lines?: number; variant?: "lines" | "cards"; count?: number }) {
  return (
    <Box role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {variant === "cards" ? (
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: `repeat(${Math.min(count, 3)}, 1fr)` } }}>
          {Array.from({ length: count }, (_, i) => (
            <Skeleton key={i} variant="rounded" height={220} sx={{ borderRadius: "14px" }} />
          ))}
        </Box>
      ) : (
        <Stack spacing={1.25}>
          {Array.from({ length: lines }, (_, i) => (
            <Skeleton key={i} variant="rounded" height={20} width={i === lines - 1 ? "66%" : "100%"} />
          ))}
        </Stack>
      )}
      {slow ? <SlowNotice /> : null}
    </Box>
  );
}

export function SlowNotice() {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 2, color: "text.secondary" }}>
      <HourglassTopRounded aria-hidden sx={{ fontSize: 18 }} />
      <Typography variant="body2">Still working: this is taking longer than usual.</Typography>
    </Stack>
  );
}

export function ErrorState({ title = "Something went wrong", message, onRetry, sx }: { title?: string; message: ReactNode; onRetry?: () => void; sx?: SxProps<Theme> }) {
  return (
    <Alert severity="error" role="alert" sx={sx}>
      <AlertTitle>{title}</AlertTitle>
      {message}
      {onRetry ? (
        <Box sx={{ mt: 1.5 }}>
          <Button variant="outlined" color="inherit" size="small" startIcon={<RefreshRounded />} onClick={onRetry}>
            Try again
          </Button>
        </Box>
      ) : null}
    </Alert>
  );
}

export function EmptyState({ icon: IconComponent = InfoOutlined, title, children, action, sx, headingComponent = "p" }: {
  icon?: Icon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  sx?: SxProps<Theme>;
  headingComponent?: ElementType;
}) {
  return (
    <Box sx={sxs({ ...surface.inset, borderRadius: "16px", p: { xs: 3, sm: 4.5 }, textAlign: "center" }, sx)}>
      <Box sx={{ ...surface.raisedSm, display: "inline-grid", placeItems: "center", width: 48, height: 48, borderRadius: "50%", color: brand.muted }}>
        <IconComponent aria-hidden />
      </Box>
      <Typography variant="h5" component={headingComponent} sx={{ mt: 1.5 }}>
        {title}
      </Typography>
      {children ? (
        <Typography variant="body2" color="text.secondary" component="div" sx={{ mt: 0.5, mx: "auto", maxWidth: 440 }}>
          {children}
        </Typography>
      ) : null}
      {action ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 2.5, justifyContent: "center", flexWrap: "wrap" }}>
          {action}
        </Stack>
      ) : null}
    </Box>
  );
}

// ----------------------------------------------------------------------------- inputs

/** Toggle filter ("No nuts"). A native button with aria-pressed; selected shows a check. */
export function FilterChip({ selected, onClick, label, icon: IconComponent, disabled, describedBy }: {
  selected: boolean;
  onClick: () => void;
  label: ReactNode;
  icon?: Icon;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <Chip
      component="button"
      type="button"
      clickable
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-describedby={describedBy}
      variant={selected ? "filled" : "outlined"}
      icon={selected ? <CheckRounded /> : IconComponent ? <IconComponent /> : undefined}
      label={label}
      sx={{
        height: 38,
        px: 0.75,
        fontSize: "0.88rem",
        transition: "box-shadow 160ms ease",
        ...(selected
          ? { ...surface.pressed, color: brand.leafDark, "&:hover": { bgcolor: `${surface.base} !important` } }
          : { ...surface.raisedSm, color: brand.forest, "&:hover": { bgcolor: "#ECF1EE !important" } }),
        "& .MuiChip-icon": { color: "inherit", fontSize: 18 },
      }}
    />
  );
}

export function QuantityStepper({ label, value, onChange, min = 0, max = 99, hint, unit, compact }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  hint?: string;
  unit?: string;
  compact?: boolean;
}) {
  const id = useId();
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const control = { ...surface.raisedSm, width: 40, height: 40, borderRadius: "50%", "&.Mui-disabled": { boxShadow: "none" } };
  return (
    <Box>
      <Typography component="label" htmlFor={id} variant="subtitle2" className={compact ? "sr-only" : undefined} sx={{ display: "block", mb: 0.75 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
        <IconButton aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(clamp(value - 1))} sx={control}>
          <RemoveRounded fontSize="small" />
        </IconButton>
        <Box
          component="input"
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(clamp(Number(e.target.value) || min))}
          className="tabular"
          sx={{ ...surface.insetSm, width: 56, height: 40, borderRadius: "12px", border: `1px solid ${surface.edge}`, textAlign: "center", font: "inherit", fontWeight: 700, color: brand.forest }}
        />
        <IconButton aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(clamp(value + 1))} sx={control}>
          <AddRounded fontSize="small" />
        </IconButton>
        {unit ? (
          <Typography variant="body2" color="text.secondary" sx={{ pl: 0.5 }}>
            {unit}
          </Typography>
        ) : null}
      </Stack>
      {hint ? (
        <Typography id={`${id}-hint`} variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}
