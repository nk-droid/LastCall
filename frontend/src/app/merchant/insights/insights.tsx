"use client";

import {
  AccountBalanceWalletRounded,
  DonutLargeRounded,
  FilterAltRounded,
  LocalOfferRounded,
  PaymentsRounded,
  RecyclingRounded,
  RefreshRounded,
  ReplayRounded,
  ScheduleRounded,
  TrackChangesRounded,
  UpdateRounded,
  VerifiedRounded,
} from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Grid,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { useState, type ReactNode } from "react";

import { useStaff } from "@/components/merchant-shell";
import { EmptyState, ErrorState, FactChip, InfoTip, LoadingBlock, PageHeader, SectionCard, StatTile, brand, surface, type Icon, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ago, money } from "@/lib/format";
import type { Insights as InsightsData, Metric } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const METRICS: { key: string; label: string; kind: "ratio" | "count" | "minutes"; lowerIsBetter?: boolean }[] = [
  { key: "bundle_acceptance", label: "Bundle acceptance", kind: "ratio" },
  { key: "checkout_completion", label: "Checkout completion", kind: "ratio" },
  { key: "substitution_acceptance", label: "Substitution acceptance", kind: "ratio" },
  { key: "pickup_success", label: "Pickup success", kind: "ratio" },
  { key: "reservation_loss", label: "Reservation loss", kind: "ratio", lowerIsBetter: true },
  { key: "inventory_mismatch", label: "Inventory mismatches", kind: "count", lowerIsBetter: true },
  { key: "stockout_frequency", label: "Stockouts", kind: "count" },
  { key: "median_time_to_pickup_minutes", label: "Median time to pickup", kind: "minutes" },
];
const STEP_LABEL: Record<string, string> = {
  intent_submitted: "Described a need",
  bundle_proposed: "Got bundle options",
  bundle_viewed: "Viewed options",
  quote_created: "Chose a bundle",
  reservation_created: "Held items",
  paypal_approved: "Approved in PayPal",
  capture_verified: "Payment verified",
  pickup_completed: "Picked up",
};

function metricValue(metric: Metric | undefined, kind: "ratio" | "count" | "minutes"): string {
  if (!metric || metric.value === null || metric.value === undefined) return "—";
  if (kind === "ratio") return `${Math.round(metric.value * 100)}%`;
  if (kind === "minutes") return `${metric.value} min`;
  return metric.value.toLocaleString("en-US");
}

export function Insights() {
  const shopName = useStaff()?.merchant?.name;
  const [period, setPeriod] = useState<"today" | "7d">("today");
  const insights = useResource((signal) => api<InsightsData>(`/api/merchant/insights?period=${period}`, { signal }), [period], { pollMs: 30_000 });
  const d = insights.data;


  return (
    <Box>
      <PageHeader
        eyebrow={shopName}
        title="Insights"
        subtitle="Live from orders, holds and inventory events."
        chips={
          d ? (
            <>
              <FactChip icon={ScheduleRounded} label={`Computed ${ago(d.computed_at)}`} />
              {d.last_snapshot_at ? <FactChip icon={UpdateRounded} label={`Background aggregate ${ago(d.last_snapshot_at)}`} /> : null}
            </>
          ) : undefined
        }
        actions={
          <>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={period}
              onChange={(_, value: "today" | "7d" | null) => value && setPeriod(value)}
              aria-label="Period"
            >
              <ToggleButton value="today" sx={{ px: 2 }}>
                Today
              </ToggleButton>
              <ToggleButton value="7d" sx={{ px: 2 }}>
                Last 7 days
              </ToggleButton>
            </ToggleButtonGroup>
            <Button variant="outlined" color="inherit" size="small" startIcon={<RefreshRounded />} loading={insights.loading} onClick={insights.reload}>
              Refresh
            </Button>
          </>
        }
      />

      {insights.error && !d ? (
        <ErrorState title="Couldn't load insights" message={errorMessage(insights.error)} onRetry={insights.reload} />
      ) : !d ? (
        <LoadingBlock label="Loading insights" slow={insights.slow} variant="cards" count={3} />
      ) : (
        <Stack spacing={4}>
          {d.caution ? (
            <Alert severity="warning" role="note">
              <AlertTitle>Small sample</AlertTitle>
              {d.caution}
            </Alert>
          ) : null}

          <Box component="section" aria-labelledby="sales-title">
            <SectionTitle id="sales-title" icon={PaymentsRounded}>
              Sales
            </SectionTitle>
            <Grid container spacing={2} columns={{ xs: 2, sm: 3, lg: 5 }}>
              <Grid size={1}>
                <StatTile
                  label="Net sales"
                  value={money(d.money.net_captured_sales_minor, d.currency)}
                  caption="Captured, minus completed refunds"
                  icon={<AccountBalanceWalletRounded />}
                />
              </Grid>
              <Grid size={1}>
                <StatTile label="Gross sales" value={money(d.money.gross_merchandise_value_minor, d.currency)} caption={d.money.gmv_label} icon={<PaymentsRounded />} />
              </Grid>
              <Grid size={1}>
                <StatTile label="Refunded" value={money(d.money.refunded_minor, d.currency)} caption="Confirmed by PayPal" icon={<ReplayRounded />} tone="neutral" />
              </Grid>
              <Grid size={1}>
                <StatTile label="Discounts" value={money(d.money.discounts_given_minor, d.currency)} caption="Regular minus surplus price" icon={<LocalOfferRounded />} tone="neutral" />
              </Grid>
              <Grid size={1}>
                <StatTile label="Captures" value={d.money.completed_captures.toLocaleString("en-US")} caption="Completed, verified with PayPal" icon={<VerifiedRounded />} tone="info" />
              </Grid>
            </Grid>
          </Box>

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 5 }}>
              <Stack spacing={2} sx={{ height: "100%" }}>
                <SectionCard
                  title="Surplus sell-through"
                  icon={<DonutLargeRounded />}
                  action={
                    <InfoTip
                      label="About sell-through"
                      title={`${d.metrics.surplus_sell_through?.definition ?? "Surplus units sold / surplus units listed"}. Remaining = available plus held in checkouts. Listed includes paused listings.`}
                    />
                  }
                >
                  <SellThrough listed={d.units.listed} sold={d.units.sold} remaining={d.units.remaining} />
                </SectionCard>
                <SectionCard title="Estimated waste avoided" icon={<RecyclingRounded />} sx={{ flex: 1 }}>
                  <Typography variant="body2" color="text.secondary">
                    {d.waste_avoided.reason} Unsold units are not counted as &ldquo;waste prevented&rdquo;.
                  </Typography>
                </SectionCard>
              </Stack>
            </Grid>
            <Grid size={{ xs: 12, md: 7 }}>
              <SectionCard
                title="Shopping funnel"
                subtitle="Distinct shopper sessions reaching each step"
                icon={<FilterAltRounded />}
                action={<InfoTip label="About the funnel" title="A small sample shows drop-off, not its cause." />}
                sx={{ height: "100%" }}
              >
                <Funnel steps={d.funnel} />
              </SectionCard>
            </Grid>
          </Grid>

          <Box component="section" aria-labelledby="outcomes-title">
            <SectionTitle id="outcomes-title" icon={TrackChangesRounded}>
              Outcomes
            </SectionTitle>
            <Grid container spacing={2} columns={{ xs: 1, sm: 2, lg: 4 }}>
              {METRICS.map((m) => (
                <Grid key={m.key} size={1}>
                  <OutcomeTile spec={m} metric={d.metrics[m.key]} />
                </Grid>
              ))}
            </Grid>
          </Box>

        </Stack>
      )}
    </Box>
  );
}

function SectionTitle({ id, icon: IconComponent, children }: { id: string; icon: Icon; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
      <IconComponent aria-hidden sx={{ color: brand.leaf, fontSize: 22 }} />
      <Typography id={id} variant="h3" component="h2">
        {children}
      </Typography>
    </Stack>
  );
}

function OutcomeTile({ spec, metric }: { spec: (typeof METRICS)[number]; metric: Metric | undefined }) {
  const hasValue = !!metric && metric.value !== null && metric.value !== undefined;
  const ratio = spec.kind === "ratio";
  const counted = ratio ? (metric?.denominator ? `${metric.numerator ?? 0} of ${metric.denominator}` : "No data yet") : hasValue ? null : "No data yet";
  const caption = [counted, spec.lowerIsBetter ? "lower is better" : null].filter(Boolean).join(" · ");
  const showMeter = ratio && !spec.lowerIsBetter && hasValue && !!metric?.denominator;
  const tone: Tone = spec.lowerIsBetter ? "neutral" : "success";
  return (
    <StatTile
      label={spec.label}
      value={metricValue(metric, spec.kind)}
      tone={tone}
      progress={showMeter ? Math.round((metric?.value ?? 0) * 100) : undefined}
      progressLabel={showMeter ? `${spec.label}: ${metric?.numerator ?? 0} of ${metric?.denominator ?? 0}` : undefined}
      caption={caption ? caption.charAt(0).toUpperCase() + caption.slice(1) : undefined}
      help={metric?.definition}
    />
  );
}

function SellThrough({ listed, sold, remaining }: { listed: number; sold: number; remaining: number }) {
  const pct = listed ? Math.min(100, Math.round((sold / listed) * 100)) : 0;
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h1" component="p">
          {listed ? `${pct}%` : "—"}
        </Typography>
        <Typography variant="body2" color="text.secondary" className="tabular">
          {sold} of {listed} listed units sold
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={pct}
        aria-label="Surplus sell-through"
        aria-valuetext={`${sold} of ${listed} surplus units sold`}
        sx={{ height: 12 }}
      />
      <Box component="dl" sx={{ m: 0, mt: 0.5, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1.5 }}>
        {(
          [
            ["Listed", listed],
            ["Sold", sold],
            ["Remaining", remaining],
          ] as const
        ).map(([label, value]) => (
          <Box key={label} sx={{ ...surface.inset, p: 1.5, borderRadius: "16px" }}>
            <Typography component="dt" variant="caption" color="text.secondary" sx={{ fontWeight: 650 }}>
              {label}
            </Typography>
            <Typography component="dd" variant="h3" className="tabular" sx={{ m: 0 }}>
              {value}
            </Typography>
          </Box>
        ))}
      </Box>
    </Stack>
  );
}

function Funnel({ steps }: { steps: { step: string; sessions: number; events: number }[] }) {
  const top = Math.max(1, ...steps.map((s) => s.sessions));
  const first = steps[0]?.sessions ?? 0;
  if (!first) {
    return (
      <EmptyState icon={FilterAltRounded} title="No shopper activity yet">
        Sessions appear here as shoppers use the storefront in this period.
      </EmptyState>
    );
  }
  return (
    <Box sx={{ overflowX: "auto", position: "relative" }}>
      <Table size="small" sx={{ "& th, & td": { px: 1, borderBottom: 0 }, "& tbody th, & tbody td": { py: 1 } }}>
        <caption className="sr-only">Sessions reaching each funnel step, with share of sessions that started</caption>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: "70%" }}>Step</TableCell>
            <TableCell align="right">Sessions</TableCell>
            <TableCell align="right">Of start</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {steps.map((s, index) => {
            const width = (s.sessions / top) * 100;
            return (
              <TableRow key={s.step}>
                <TableCell component="th" scope="row">
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    <Box component="span" aria-hidden sx={{ color: "text.secondary", mr: 0.75 }} className="tabular">
                      {index + 1}
                    </Box>
                    {STEP_LABEL[s.step] ?? s.step}
                  </Typography>
                  <Tooltip title={`${s.sessions} sessions · ${s.events} events`} placement="top-start">
                    {/* Bar in a pressed-in track; an empty track means no sessions. */}
                    <Box aria-hidden sx={{ ...surface.insetSm, mt: 0.75, height: 12, p: "2px", display: "flex", borderRadius: "99px" }}>
                      {s.sessions ? <Box sx={{ width: `${Math.max(width, 2)}%`, bgcolor: brand.leaf, borderRadius: "99px" }} /> : null}
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell align="right" className="tabular" sx={{ fontWeight: 700, verticalAlign: "top" }}>
                  {s.sessions}
                </TableCell>
                <TableCell align="right" className="tabular" sx={{ color: "text.secondary", verticalAlign: "top" }}>
                  {Math.round((s.sessions / first) * 100)}%
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}
