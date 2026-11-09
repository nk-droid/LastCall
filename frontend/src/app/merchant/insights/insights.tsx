"use client";

// What an owner asks of a week or a month, in six cards: how sales went (and against the period before), how much of
// the menu price came back, what was left at close, sales by day, when shoppers buy, what to list tomorrow, and what
// shoppers wanted but couldn't get. Charts are one series each in the brand green, with a table view and tooltips.

import {
  ArrowDownwardRounded, ArrowForwardRounded, ArrowUpwardRounded, CheckRounded, HourglassEmptyRounded, NotificationsActiveRounded,
} from "@mui/icons-material";
import {
  Box, Link, Stack, Table, TableBody, TableCell, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import { useState, type ReactNode } from "react";

import { useStaff } from "@/components/merchant-shell";
import { ProductImage } from "@/components/product-image";
import { ErrorState, IconBadge, LoadingBlock, PageHeader, StatusChip, brand, surface, tones, type Icon, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { money, plural } from "@/lib/format";
import type { InsightsItem, InsightsSummary } from "@/lib/types";
import { useResource } from "@/lib/use-api";

type Period = "7d" | "30d";
const ITEMS_SHOWN = 6;

const pct = (share: number) => `${Math.round(share * 100)}%`;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => day(iso).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

/** "Nov 2 – 8", or "Oct 10 – Nov 8" across months. */
function range(start: string, end: string): string {
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${fmt(start, { month: "short", day: "numeric" })} – ${fmt(end, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" })}`;
}

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

/** Round axis ticks: about four steps of 1, 2, 2.5 or 5 times a power of ten. */
function scale(max: number, steps = 4): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const raw = max / steps;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

export function Insights() {
  const shopName = useStaff()?.merchant?.name;
  const [period, setPeriod] = useState<Period>("7d");
  const summary = useResource((signal) => api<InsightsSummary>(`/api/merchant/insights/summary?period=${period}`, { signal }), [period], { pollMs: 60_000 });
  const d = summary.data;

  return (
    <Box>
      <PageHeader eyebrow={shopName} title="Insights" />
      {/* One row of controls above everything they scope. */}
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mt: -1.5, mb: 3 }}>
        <ToggleButtonGroup exclusive size="small" value={period} aria-label="Period" onChange={(_, v: Period | null) => v && setPeriod(v)}>
          <ToggleButton value="7d" sx={{ px: 2 }}>Last 7 days</ToggleButton>
          <ToggleButton value="30d" sx={{ px: 2 }}>Last 30 days</ToggleButton>
        </ToggleButtonGroup>
        {d ? (
          <Typography variant="body2" color="text.secondary">
            <Box component="span" sx={{ color: "text.primary", fontWeight: 600 }}>{range(d.start, d.end)}</Box> · compared with {range(d.compare_start, d.compare_end)}
          </Typography>
        ) : null}
        {d?.caution ? <Typography variant="body2" color="text.secondary" sx={{ ml: { md: "auto" } }}>{d.caution}</Typography> : null}
      </Stack>

      {summary.error && !d ? (
        <ErrorState title="Couldn't load insights" message={errorMessage(summary.error)} onRetry={summary.reload} />
      ) : !d ? (
        <LoadingBlock label="Loading insights" slow={summary.slow} variant="cards" count={3} />
      ) : (
        <Stack spacing={2.5} sx={{ opacity: summary.loading ? 0.6 : 1, transition: "opacity 150ms" }}>
          <Headline d={d} />
          <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr", xl: "5fr 4fr 3fr" } }}>
            <SalesByDay d={d} />
            <BusyHours d={d} />
            <MissedDemand d={d} />
          </Box>
          <ListTomorrow d={d} />
        </Stack>
      )}
    </Box>
  );
}

// ----------------------------------------------------------------------------- building blocks

function Card({ title, subtitle, action, children, label }: { title?: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <Box component="section" aria-label={label ?? title} sx={{ ...surface.raised, borderRadius: "16px", p: { xs: 2.5, sm: 3 }, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      {title ? (
        <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h4" component="h2">{title}</Typography>
            {subtitle ? <Typography variant="body2" color="text.secondary">{subtitle}</Typography> : null}
          </Box>
          {action}
        </Stack>
      ) : null}
      {children}
    </Box>
  );
}

/** Signed change against the previous period; colour follows whether that direction is good. */
function Delta({ change, upIsGood, compared }: { change: number; upIsGood: boolean; compared: string }) {
  const up = change > 0;
  const tone: Tone = change === 0 ? "neutral" : up === upIsGood ? "success" : "warning";
  const t = tones[tone];
  const Arrow = up ? ArrowUpwardRounded : ArrowDownwardRounded;
  return (
    <Box component="span" aria-label={`${up ? "Up" : "Down"} ${pct(Math.abs(change))} on ${compared}`}
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.25, px: 1, py: 0.25, borderRadius: 999, bgcolor: t.bg, color: t.fg, fontSize: 13, fontWeight: 700 }}>
      {change !== 0 ? <Arrow aria-hidden sx={{ fontSize: 14 }} /> : null}{pct(Math.abs(change))}
    </Box>
  );
}

function Stat({ label, value, unit, delta, caption, hero }: { label: string; value: string; unit?: string; delta?: ReactNode; caption: ReactNode; hero?: boolean }) {
  return (
    <Box component="section" aria-label={label} sx={{ ...surface.raised, borderRadius: "16px", px: 3, py: 2.5, display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, color: "text.secondary" }}>{label}</Typography>
      <Stack direction="row" spacing={1.25} useFlexGap sx={{ alignItems: "baseline", flexWrap: "wrap", mt: "auto" }}>
        <Typography component="p" sx={{ fontFamily: "var(--font-heading), sans-serif", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, fontSize: hero ? 48 : 32 }}>
          {value}
          {unit ? <Box component="span" sx={{ fontFamily: "inherit", fontSize: 15, fontWeight: 500, color: "text.secondary", letterSpacing: 0, ml: 0.75 }}>{unit}</Box> : null}
        </Typography>
        {delta}
      </Stack>
      <Typography variant="body2" color="text.secondary">{caption}</Typography>
    </Box>
  );
}

type Bar = { key: string; value: number; tip: [string, string]; aria: string; cap?: string; axis?: string | null; strong?: boolean };

/** Columns grown from one baseline: capped width, rounded tops, recessive gridlines, a tooltip per column. */
function BarChart({ bars, top, ticks, tickLabel, height, barWidth, gutter, label, band, reference }: {
  bars: Bar[]; top: number; ticks: number[]; tickLabel: (v: number) => string; height: number; barWidth: number; gutter: number; label: string;
  band?: { from: number; to: number }; reference?: { value: number; label: string };
}) {
  const at = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <Box>
      <Box sx={{ position: "relative", height, ml: `${gutter}px`, mt: 2.5 }} className="tabular">
        {band ? (
          <Box aria-hidden sx={{ position: "absolute", left: `${(band.from / bars.length) * 100}%`, width: `${((band.to - band.from) / bars.length) * 100}%`,
                                 top: -6, bottom: 0, bgcolor: brand.mint, borderRadius: "6px 6px 0 0" }} />
        ) : null}
        {ticks.map((t) => (
          <Box key={t} aria-hidden sx={{ position: "absolute", left: 0, right: 0, bottom: at(t), borderTop: `1px solid ${t === 0 ? brand.lineStrong : brand.line}` }}>
            <Typography component="span" sx={{ position: "absolute", right: "calc(100% + 8px)", top: -9, fontSize: 12, color: "text.secondary", whiteSpace: "nowrap" }}>{tickLabel(t)}</Typography>
          </Box>
        ))}
        {reference && reference.value > 0 ? (
          <Box aria-hidden sx={{ position: "absolute", left: 0, right: 0, bottom: at(reference.value), borderTop: `1px solid ${brand.muted}`, zIndex: 2, pointerEvents: "none" }}>
            <Typography component="span" sx={{ position: "absolute", left: 6, bottom: 3, px: 0.5, bgcolor: brand.paper, fontSize: 12, color: "text.secondary", whiteSpace: "nowrap" }}>
              {reference.label}
            </Typography>
          </Box>
        ) : null}
        <Box role="group" aria-label={label} sx={{ position: "absolute", inset: 0, display: "flex", zIndex: 1 }}>
          {bars.map((b) => (
            <Tooltip key={b.key} placement="top" arrow disableInteractive
              title={<><Box component="span" sx={{ display: "block", fontWeight: 700, fontSize: 14 }}>{b.tip[0]}</Box>{b.tip[1]}</>}>
              <Box tabIndex={0} aria-label={b.aria} sx={{
                flex: "1 1 0", minWidth: 0, height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", outline: "none", borderRadius: "6px",
                "&:focus-visible": { boxShadow: `inset 0 0 0 2px ${brand.leaf}` }, "&:hover .fill, &:focus-visible .fill": { filter: "brightness(1.2)" },
              }}>
                <Box className="fill" sx={{ position: "relative", width: barWidth, maxWidth: "70%", height: at(b.value), minHeight: b.value > 0 ? 2 : 0,
                                            bgcolor: brand.leaf, borderRadius: "4px 4px 0 0", transition: "filter 120ms" }}>
                  {b.cap ? (
                    <Typography component="span" sx={{ position: "absolute", left: "50%", bottom: "calc(100% + 4px)", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 }}>
                      {b.cap}
                    </Typography>
                  ) : null}
                </Box>
              </Box>
            </Tooltip>
          ))}
        </Box>
      </Box>
      <Box aria-hidden sx={{ display: "flex", ml: `${gutter}px`, mt: 1 }}>
        {bars.map((b) => (
          <Typography key={b.key} component="span" sx={{ flex: "1 1 0", minWidth: 0, textAlign: "center", fontSize: 12, whiteSpace: "nowrap", overflow: "visible",
                                                         color: b.strong ? "text.primary" : "text.secondary", fontWeight: b.strong ? 700 : 400 }}>
            {b.axis ?? ""}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

// ----------------------------------------------------------------------------- headline

function Headline({ d }: { d: InsightsSummary }) {
  const h = d.headline;
  const compared = `the previous ${d.days} days`;
  const left = h.left_at_close;
  const leftChange = left && left.prev_units > 0 ? (left.units - left.prev_units) / left.prev_units : null;
  return (
    <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "1fr", md: "1.4fr 1fr 1fr" } }}>
      <Stat hero label="Net sales" value={money(h.net_sales_minor, d.currency)}
        delta={h.change !== null ? <Delta change={h.change} upIsGood compared={compared} /> : null}
        caption={[plural(h.orders, "order"), h.orders ? `${money(h.average_order_minor, d.currency)} average` : null,
                  h.refunded_minor ? `${money(h.refunded_minor, d.currency)} refunded` : null].filter(Boolean).join(" · ")} />
      <Stat label="Value recovered" value={h.recovered !== null ? pct(h.recovered) : "—"} unit={h.recovered !== null ? "of menu price" : undefined}
        caption={h.menu_value_minor ? `Shoppers saved ${money(h.saved_minor, d.currency)}` : "Shows once something sells"} />
      <Stat label="Left at close" value={left ? String(left.units) : "—"} unit={left ? (left.units === 1 ? "item" : "items") : undefined}
        delta={leftChange !== null ? <Delta change={leftChange} upIsGood={false} compared={compared} /> : null}
        caption={left ? `${money(left.menu_value_minor, d.currency)} at menu price` : "Shows for items that repeat daily"} />
    </Box>
  );
}

// ----------------------------------------------------------------------------- sales by day

function SalesByDay({ d }: { d: InsightsSummary }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const rows = d.sales_by_day;
  const best = rows.reduce((a, r) => (r.sales_minor > a.sales_minor ? r : a), rows[0]);
  const { top, ticks } = scale(Math.max(...rows.map((r) => r.sales_minor), d.headline.prev_daily_average_minor) / 100);
  const week = d.days <= 7;
  const bars: Bar[] = rows.map((r, i) => {
    const name = fmt(r.date, { weekday: "short", month: "short", day: "numeric" });
    const value = money(r.sales_minor, d.currency);
    const isBest = r === best && r.sales_minor > 0;
    return {
      key: r.date, value: r.sales_minor / 100, strong: r.today,
      tip: [r.today ? `${value} so far` : value, `${r.today ? "Today" : name} · ${plural(r.orders, "order")}${isBest && !r.today ? " · best day" : ""}`],
      aria: `${r.today ? "Today" : name}: ${value}${r.today ? " so far" : ""} from ${plural(r.orders, "order")}`,
      cap: r.today && r.sales_minor > 0 ? `${value} so far` : isBest ? value : undefined,
      axis: r.today ? "Today" : week ? fmt(r.date, { weekday: "short" })
        : (rows.length - 1 - i) % 5 === 0 ? fmt(r.date, { month: "short", day: "numeric" }) : null,
    };
  });
  return (
    <Card title="Sales by day" subtitle="What shoppers paid each day"
      action={
        <ToggleButtonGroup exclusive size="small" value={view} aria-label="Show sales as" onChange={(_, v: "chart" | "table" | null) => v && setView(v)}>
          <ToggleButton value="chart" sx={{ px: 1.5, py: 0.25 }}>Chart</ToggleButton>
          <ToggleButton value="table" sx={{ px: 1.5, py: 0.25 }}>Table</ToggleButton>
        </ToggleButtonGroup>
      }>
      {view === "chart" ? (
        <BarChart bars={bars} top={top} ticks={ticks} tickLabel={(v) => `$${v.toLocaleString("en-US")}`} height={190} barWidth={week ? 24 : 12} gutter={48}
          label="Sales by day, bar chart. Tab through the days to read each one."
          reference={{ value: d.headline.prev_daily_average_minor / 100, label: `Previous average ${money(d.headline.prev_daily_average_minor, d.currency)}` }} />
      ) : (
        <Box sx={{ maxHeight: 220, overflowY: "auto" }}>
          <Table size="small" className="tabular">
            <caption className="sr-only">Sales by day, {range(d.start, d.end)}</caption>
            <TableHead><TableRow><TableCell>Day</TableCell><TableCell align="right">Sales</TableCell><TableCell align="right">Orders</TableCell></TableRow></TableHead>
            <TableBody>
              {[...rows].reverse().map((r) => (
                <TableRow key={r.date}>
                  <TableCell>{r.today ? "Today, so far" : fmt(r.date, { weekday: "short", month: "short", day: "numeric" })}</TableCell>
                  <TableCell align="right">{money(r.sales_minor, d.currency)}</TableCell>
                  <TableCell align="right">{r.orders}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------- busy hours

function BusyHours({ d }: { d: InsightsSummary }) {
  const hours = d.orders_by_hour;
  const { top, ticks } = scale(Math.max(...hours, 1), 2);
  const busy = d.busiest;
  const bars: Bar[] = hours.map((n, h) => {
    const span = `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`;
    return { key: String(h), value: n, tip: [plural(n, "order"), span], aria: `${span}: ${plural(n, "order")}`, axis: h % 6 === 0 ? hourLabel(h) : null };
  });
  const p = d.pickup;
  return (
    <Card title="Busy hours" subtitle="Orders placed in each hour">
      {busy ? (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", mb: -1.5 }}>
          <Box aria-hidden sx={{ width: 12, height: 12, borderRadius: "3px", bgcolor: brand.mint, border: `1px solid ${tones.success.border}` }} />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>Busiest {busy.label} · {pct(busy.share)} of orders</Typography>
        </Stack>
      ) : null}
      <BarChart bars={bars} top={top} ticks={ticks} tickLabel={(v) => String(v)} height={busy ? 118 : 150} barWidth={10} gutter={28}
        label="Orders by hour, bar chart. Tab through the hours to read each one." band={busy ? { from: busy.start, to: busy.end } : undefined} />
      <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 2, pt: 1.5, borderTop: `1px solid ${brand.line}` }}>
        <Fact label="Slots filled" value={p.slot_fill !== null ? pct(p.slot_fill) : "—"} note={p.slot_fill !== null && p.slot_fill_label ? p.slot_fill_label : undefined} />
        <Fact label="No-shows" value={String(p.no_shows)} />
        <Fact label="Paid to picked up" value={p.median_wait_minutes !== null ? `${p.median_wait_minutes} min` : "—"} note={p.median_wait_minutes !== null ? "median" : undefined} />
      </Box>
    </Card>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: "block" }}>{label}</Typography>
      <Typography component="dd" sx={{ m: 0, fontWeight: 700 }}>
        {value}{note ? <Box component="span" sx={{ fontWeight: 400, color: "text.secondary", fontSize: 13, ml: 0.5 }}>{note}</Box> : null}
      </Typography>
    </Box>
  );
}

// ----------------------------------------------------------------------------- what to list tomorrow

const SUGGESTION: Record<InsightsItem["suggestion"]["kind"], { tone: Tone; icon: Icon }> = {
  more: { tone: "success", icon: ArrowUpwardRounded },
  fewer: { tone: "warning", icon: ArrowDownwardRounded },
  keep: { tone: "neutral", icon: CheckRounded },
  early: { tone: "neutral", icon: HourglassEmptyRounded },
};

function ListTomorrow({ d }: { d: InsightsSummary }) {
  const [all, setAll] = useState(false);
  const items = all ? d.items : d.items.slice(0, ITEMS_SHOWN);
  const h = d.headline;
  return (
    <Box component="section" aria-labelledby="list-tomorrow" sx={{ ...surface.raised, borderRadius: "16px", py: { xs: 2.5, sm: 3 }, minWidth: 0 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", px: { xs: 2.5, sm: 3 }, mb: 1.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="list-tomorrow" variant="h4" component="h2">What to list tomorrow</Typography>
          <Typography variant="body2" color="text.secondary">{d.rule}</Typography>
        </Box>
        {h.listed_units ? (
          <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: "nowrap" }} className="tabular">
            {h.sold_units} of {h.listed_units} sold
          </Typography>
        ) : null}
      </Stack>
      {!d.items.length ? (
        <Typography color="text.secondary" sx={{ px: { xs: 2.5, sm: 3 } }}>No items yet. Add products in Inventory to see them here.</Typography>
      ) : (
        <Box sx={{ overflowX: "auto" }}>
          <Table size="small" className="tabular" sx={{ minWidth: 980, "& th:first-of-type, & td:first-of-type": { pl: { xs: 2.5, sm: 3 } }, "& th:last-of-type, & td:last-of-type": { pr: { xs: 2.5, sm: 3 } } }}>
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell>
                <TableCell sx={{ width: 190 }}>Sold of listed</TableCell>
                <TableCell sx={{ width: 140 }}>Left at close</TableCell>
                <TableCell sx={{ width: 220 }}>Sold out</TableCell>
                <TableCell sx={{ width: 190 }}>Suggestion</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((i) => {
                const s = SUGGESTION[i.suggestion.kind];
                const share = i.listed ? Math.min(1, i.sold / i.listed) : 0;
                return (
                  <TableRow key={i.product_id}>
                    <TableCell>
                      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                        <ProductImage image={i.image} category={i.category} size="sm" sx={{ width: 32, height: 32, borderRadius: "8px", "& svg": { fontSize: 18 } }} />
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{i.name}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                        <Box aria-hidden sx={{ width: 88, height: 8, borderRadius: 999, bgcolor: brand.mintStrong, overflow: "hidden", flexShrink: 0 }}>
                          <Box sx={{ width: pct(share), height: "100%", bgcolor: brand.leaf, borderRadius: 999 }} />
                        </Box>
                        <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>{i.sold} / {i.listed}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {i.left === null ? <Typography variant="body2" color="text.secondary">—</Typography> : (
                        <Typography variant="body2">
                          <Box component="span" sx={{ fontWeight: 600 }}>{i.left}</Box>
                          {i.left ? <Box component="span" sx={{ color: "text.secondary" }}> · on {plural(i.left_days, "day")}</Box> : null}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {i.sold_out_days ? (
                        <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                          <Box component="span" sx={{ fontWeight: 600 }}>{i.sold_out_days} of {i.days} days</Box>
                          {i.sold_out_by ? <Box component="span" sx={{ color: "text.secondary" }}> · by {i.sold_out_by}</Box> : null}
                        </Typography>
                      ) : <Typography variant="body2" color="text.secondary">Never</Typography>}
                    </TableCell>
                    <TableCell><StatusChip tone={s.tone} icon={s.icon} label={i.suggestion.label} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      )}
      {d.items.length > ITEMS_SHOWN ? (
        <Link component="button" type="button" variant="body2" aria-expanded={all} onClick={() => setAll((x) => !x)}
          sx={{ mt: 1.5, ml: { xs: 2.5, sm: 3 }, fontWeight: 600 }}>
          {all ? "Show fewer" : `Show all ${d.items.length} items`}
        </Link>
      ) : null}
    </Box>
  );
}

// ----------------------------------------------------------------------------- missed demand

function MissedDemand({ d }: { d: InsightsSummary }) {
  const m = d.missed;
  return (
    <Card title="Missed demand" subtitle={m.total ? `${plural(m.total, "request")} you couldn't meet` : "Requests you couldn't meet"}>
      {m.requests.length ? (
        <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, borderTop: `1px solid ${brand.line}` }} className="tabular">
          {m.requests.map((r) => (
            <Box component="li" key={r.label} sx={{ display: "flex", alignItems: "baseline", gap: 2, py: 1, borderBottom: `1px solid ${brand.line}` }}>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>{r.label}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>{r.count}</Typography>
            </Box>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">Nothing missed in this period.</Typography>
      )}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
        <IconBadge tone="info" size={36}><NotificationsActiveRounded /></IconBadge>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{plural(m.watching, "person", "people")} watching</Typography>
          <Typography variant="body2" color="text.secondary">
            {m.alerts ? `${plural(m.alerts, "alert")} sent · ${plural(m.alerts_ordered, "order")}` : "No alerts sent in this period"}
          </Typography>
        </Box>
      </Stack>
      <Link href="/merchant/assistant?a=ask" variant="body2" underline="hover" sx={{ mt: "auto", display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 600, alignSelf: "flex-start" }}>
        See what shoppers asked for <ArrowForwardRounded aria-hidden sx={{ fontSize: 16 }} />
      </Link>
    </Card>
  );
}
