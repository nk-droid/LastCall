"use client";

import {
  AddRounded,
  ArrowForwardRounded,
  CheckCircleRounded,
  CreditCardRounded,
  HourglassTopRounded,
  Inventory2Rounded,
  MonitorHeartRounded,
  PauseCircleRounded,
  ReceiptLongRounded,
  RemoveRounded,
  ScheduleRounded,
  ShoppingBagRounded,
  ShoppingCartRounded,
  StorefrontRounded,
  SyncRounded,
  TaskAltRounded,
  TrendingUpRounded,
  TuneRounded,
  WarningAmberRounded,
  WebhookRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Grid, IconButton, LinearProgress, Link, ListItemButton, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { useAnnounce } from "@/components/announcer";
import { CloseoutCard } from "@/components/closeout-plan";
import { SlotsTimeline, TimelineToggle, type TimelineView } from "@/components/pickup-timeline";
import { ProductImage } from "@/components/product-image";
import { FulfillmentPill, PaymentPill } from "@/components/status-pills";
import {
  EmptyState,
  ErrorState,
  FactChip,
  LoadingBlock,
  PageHeader,
  SectionCard,
  StatTile,
  StatusChip,
  brand,
  surface,
  tones,
  type Icon,
  type Tone,
} from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ago, money } from "@/lib/format";
import type { InventoryRow, Overview } from "@/lib/types";
import { useStaff } from "@/components/merchant-shell";
import { useLive } from "@/lib/use-live";
import { useResource } from "@/lib/use-api";

const list = { listStyle: "none", m: 0, p: 0 } as const;

export function Today() {
  const overview = useResource((signal) => api<Overview>("/api/merchant/overview", { signal }), [], { pollMs: 30_000 });
  const shopId = useStaff()?.merchant.id;
  useLive([shopId ? `shop:${shopId}:orders` : null, shopId ? `shop:${shopId}:stock` : null], overview.reload);
  const o = overview.data;
  if (overview.error && !o) {
    return (
      <>
        <PageHeader title="Today" />
        <ErrorState title="Couldn't load today's overview" message={errorMessage(overview.error)} onRetry={overview.reload} />
      </>
    );
  }
  if (!o) {
    return (
      <>
        <PageHeader title="Today" />
        <LoadingBlock label="Loading today's overview" slow={overview.slow} lines={8} />
      </>
    );
  }

  const c = o.counters;
  const availablePct = c.surplus_units ? Math.round((c.available_units / c.surplus_units) * 100) : 0;

  return (
    <>
      <PageHeader
        eyebrow={o.shop.name}
        title="Today"
        chips={
          <>
            <FactChip icon={SyncRounded} label={`Updated ${ago(o.as_of)}`} />
            {o.shop.pickup_paused ? <StatusChip tone="warning" icon={PauseCircleRounded} label="Pickup paused" /> : null}
          </>
        }
        actions={
          <>
            <Button href="/merchant/orders" variant="contained" startIcon={<ReceiptLongRounded />}>
              Open orders
            </Button>
            <Button href="/merchant/inventory" variant="outlined" color="inherit" startIcon={<Inventory2Rounded />}>
              Update stock
            </Button>
          </>
        }
      />

      <Box
        component="section"
        aria-label="Stock counters"
        sx={{
          display: "grid",
          gap: 2,
          mb: 3,
          gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(3, minmax(0, 1fr))", lg: "repeat(5, minmax(0, 1fr))" },
        }}
      >
        <StatTile label="Surplus listed" value={c.surplus_units} icon={<Inventory2Rounded />} caption="units today" sx={{ gridColumn: { xs: "span 2", sm: "auto" } }} />
        <StatTile
          label="Available"
          value={c.available_units}
          icon={<StorefrontRounded />}
          progress={availablePct}
          progressLabel={`${availablePct}% of listed surplus still available`}
          caption={`${availablePct}% of listed`}
          help="Listed minus held, paid and buffer units."
        />
        <StatTile label="On hold" value={c.reserved_units} icon={<ShoppingCartRounded />} tone="info" caption="in active checkouts" />
        <StatTile label="To collect" value={c.committed_units} icon={<ShoppingBagRounded />} tone="neutral" caption="paid, not picked up" />
        <StatTile label="Sold today" value={c.sold_units_today} icon={<TrendingUpRounded />} caption="units in paid orders" />
      </Box>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Stack spacing={3}>
            {/* On small screens the attention list leads; on large screens it heads the side column. */}
            <Box sx={{ display: { xs: "block", lg: "none" } }}>
              <NeedsAttention overview={o} onResolved={overview.reload} />
            </Box>
            <CloseoutCard slots={o.slots} />
            <OrdersCard overview={o} />
            <SlotsCard slots={o.slots} />
            <QuickStock rows={o.top_surplus} onChanged={overview.reload} />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <Stack spacing={3}>
            <Box sx={{ display: { xs: "none", lg: "block" } }}>
              <NeedsAttention overview={o} onResolved={overview.reload} />
            </Box>
            <SystemStatus overview={o} />
          </Stack>
        </Grid>
      </Grid>
    </>
  );
}

/** Caps a long list so the card keeps its height and the list scrolls inside it. Focusable so keyboard users can scroll it too. */
function ScrollArea({ label, maxHeight, children, ref }: { label: string; maxHeight: number; children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return (
    <Box
      ref={ref}
      role="region"
      aria-label={label}
      tabIndex={0}
      sx={{
        maxHeight,
        overflowY: "auto",
        overscrollBehavior: "contain",
        scrollbarWidth: "thin",
        position: "relative",
        // Padding gives the raised tiles room for their shadows, which overflow would otherwise clip.
        p: 0.75,
        m: -0.75,
        borderRadius: "14px",
      }}
    >
      {children}
    </Box>
  );
}

function NeedsAttention({ overview, onResolved }: { overview: Overview; onResolved: () => void }) {
  return (
    <SectionCard title="Needs attention" icon={<WarningAmberRounded />}>
      <ScrollArea label="Items needing attention" maxHeight={440}>
        <Alerts overview={overview} onResolved={onResolved} />
      </ScrollArea>
    </SectionCard>
  );
}

/** "PAYMENT.CAPTURE.COMPLETED" -> "Payment capture completed". */

function OrdersCard({ overview: o }: { overview: Overview }) {
  const stats: { label: string; value: number; icon: Icon; tone: Tone }[] = [
    { label: "Awaiting pickup", value: o.orders.awaiting_pickup, icon: HourglassTopRounded, tone: "info" },
    { label: "Ready", value: o.orders.ready, icon: ShoppingBagRounded, tone: "success" },
    { label: "Payment pending", value: o.orders.payment_pending, icon: SyncRounded, tone: "warning" },
    { label: "Picked up today", value: o.orders.picked_up_today, icon: TaskAltRounded, tone: "neutral" },
  ];
  return (
    <SectionCard
      title="Orders"
      icon={<ReceiptLongRounded />}
      action={
        <Button href="/merchant/orders" size="small" endIcon={<ArrowForwardRounded />}>
          All orders
        </Button>
      }
    >
      <Box component="dl" sx={{ m: 0, display: "grid", gap: 1.5, gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(4, minmax(0, 1fr))" } }}>
        {stats.map((s) => (
          // Value above label (column-reverse keeps dt before dd) so counts line up when a label wraps.
          <Box
            key={s.label}
            sx={{ ...surface.inset, display: "flex", flexDirection: "column-reverse", justifyContent: "flex-end", borderRadius: "16px", px: 1.75, py: 1.5 }}
          >
            <Typography component="dt" variant="caption" sx={{ display: "flex", alignItems: "center", gap: 0.5, fontWeight: 650, color: tones[s.tone].fg }}>
              <s.icon aria-hidden sx={{ fontSize: 16 }} />
              {s.label}
            </Typography>
            <Typography component="dd" variant="h3" className="tabular" sx={{ m: 0, mb: 0.25 }}>
              {s.value}
            </Typography>
          </Box>
        ))}
      </Box>

      <Typography component="h3" variant="subtitle2" color="text.secondary" sx={{ mt: 3, mb: 1.25 }}>
        Recent orders
      </Typography>
      {o.recent_orders.length ? (
        <Box component="ul" sx={{ ...list, display: "grid", gap: 1.25 }}>
          {o.recent_orders.map((order) => (
            <li key={order.id}>
              <ListItemButton href={`/merchant/orders?order=${order.id}`} sx={{ ...surface.raisedSm, borderRadius: "16px", px: 1.75, py: 1.25, gap: 1.5, flexWrap: "wrap" }}>
                <Box sx={{ flex: "1 1 220px", minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 700 }}>
                    #{order.number} · {order.customer_name ?? "Customer"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" className="tabular">
                    {order.pickup_label} · {order.units} items · {money(order.amount_minor, order.currency)}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
                  <PaymentPill status={order.payment_status} />
                  <FulfillmentPill status={order.fulfillment_status} />
                </Stack>
              </ListItemButton>
            </li>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ ...surface.inset, borderRadius: "16px", p: 2.5, textAlign: "center" }}>
          No orders yet today.
        </Typography>
      )}
    </SectionCard>
  );
}

function SlotsCard({ slots }: { slots: Overview["slots"] }) {
  const booked = slots.reduce((n, s) => n + s.booked, 0);
  const capacity = slots.reduce((n, s) => n + s.capacity, 0);
  const [view, setView] = useState<TimelineView>("timeline");
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  // Open on the window that's happening now, not midnight. Once only, so polling never yanks the list.
  useEffect(() => {
    const box = scroller.current;
    if (scrolled.current || !box || !slots.length) return;
    scrolled.current = true;
    const now = Date.now();
    const current = slots.find((s) => Date.parse(s.ends_at) > now);
    const row = current ? box.querySelector<HTMLElement>(`[data-slot="${current.id}"]`) : null;
    if (row) box.scrollTop = row.offsetTop - 6;
  }, [slots, view]);
  return (
    <SectionCard
      title="Pickup window utilization"
      icon={<ScheduleRounded />}
      action={
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
          <TimelineToggle value={view} onChange={setView} />
          <Button href="/merchant/settings?tab=pickup" size="small" variant="outlined" color="inherit" startIcon={<TuneRounded />}>
            Set capacity
          </Button>
        </Stack>
      }
    >
      {slots.length ? (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            <Box component="span" className="tabular" sx={{ fontSize: "1.6rem", fontWeight: 700, color: "text.primary", mr: 0.75 }}>
              {booked}
              <Box component="span" sx={{ fontSize: "1rem", fontWeight: 650, color: "text.secondary" }}>
                {" "}/ {capacity}
              </Box>
            </Box>
            pickup spots booked today
          </Typography>
          {view === "timeline" ? <SlotsTimeline slots={slots} /> : null}
          {view === "list" ? (
            <ScrollArea label="Pickup windows today" maxHeight={340} ref={scroller}>
              <Box component="ul" sx={{ ...list, display: "grid", gap: 2 }}>
                {slots.map((s) => {
                  const pct = s.capacity ? Math.min(100, Math.round((s.booked / s.capacity) * 100)) : 100;
                  const full = pct >= 100;
                  const label = s.label.replace("Today ", "");
                  return (
                    <li key={s.id} data-slot={s.id}>
                      <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center", mb: 0.75 }}>
                        <Typography variant="body2" sx={{ fontWeight: 650 }}>
                          {label}
                        </Typography>
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          {full ? <StatusChip tone="warning" label="Full" /> : null}
                          <Typography variant="body2" color="text.secondary" className="tabular">
                            {s.booked}/{s.capacity} booked
                          </Typography>
                        </Stack>
                      </Stack>
                      <LinearProgress variant="determinate" value={pct} color={full ? "warning" : "primary"} aria-label={`${label}: ${s.booked} of ${s.capacity} booked`} />
                    </li>
                  );
                })}
              </Box>
            </ScrollArea>
          ) : null}
        </>
      ) : (
        <EmptyState icon={ScheduleRounded} title="No pickup windows today" />
      )}
    </SectionCard>
  );
}

function Alerts({ overview, onResolved }: { overview: Overview; onResolved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!overview.alerts.length && !overview.stale_inventory.length) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: brand.leafDark, bgcolor: brand.mint, borderRadius: "16px", px: 1.75, py: 1.5 }}>
        <CheckCircleRounded aria-hidden fontSize="small" />
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          All clear. Nothing needs attention.
        </Typography>
      </Stack>
    );
  }
  // Raised tiles; the chip carries severity (icon + text + colour).
  const item = { ...surface.raisedSm, borderRadius: "18px", p: 1.75 };
  return (
    <Box component="ul" sx={{ ...list, display: "grid", gap: 1.75 }}>
      {overview.alerts.map((a) => {
        const tone: Tone = a.severity === "high" ? "danger" : a.severity === "medium" ? "warning" : "neutral";
        return (
          <Box component="li" key={a.id} sx={item}>
            <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
              <StatusChip tone={tone} label={a.severity === "high" ? "Urgent" : a.severity === "medium" ? "Review" : "FYI"} />
              <Button
                size="small"
                color="inherit"
                aria-label={`Dismiss: ${a.message}`}
                loading={busy === a.id}
                onClick={async () => {
                  setBusy(a.id);
                  await api(`/api/merchant/alerts/${a.id}/resolve`, { body: {} }).catch(() => {});
                  setBusy(null);
                  onResolved();
                }}
                sx={{ color: "text.secondary", minHeight: 32 }}
              >
                Dismiss
              </Button>
            </Stack>
            <Typography variant="body2" sx={{ mt: 1, fontWeight: 600 }}>
              {a.message}
            </Typography>
            {a.entity_type === "order" ? (
              <Link href={`/merchant/orders?order=${a.entity_id}`} variant="body2" sx={{ mt: 0.75, display: "inline-flex", alignItems: "center", gap: 0.25 }}>
                Open order
                <ArrowForwardRounded aria-hidden sx={{ fontSize: 16 }} />
              </Link>
            ) : null}
          </Box>
        );
      })}
      {overview.stale_inventory.length && !overview.alerts.some((a) => a.kind === "stale_inventory") ? (
        <Box component="li" sx={item}>
          <StatusChip tone="warning" icon={Inventory2Rounded} label="Recount stock" />
          <Typography variant="body2" sx={{ mt: 1, fontWeight: 600 }}>
            Not updated recently: {overview.stale_inventory.map((s) => s.name).join(", ")}
          </Typography>
          <Link href="/merchant/inventory" variant="body2" sx={{ mt: 0.75, display: "inline-flex", alignItems: "center", gap: 0.25 }}>
            Update stock
            <ArrowForwardRounded aria-hidden sx={{ fontSize: 16 }} />
          </Link>
        </Box>
      ) : null}
    </Box>
  );
}

function SystemStatus({ overview: o }: { overview: Overview }) {
  const payouts = o.paypal.payouts;
  const rows: { name: string; icon: Icon; tone: Tone; label: string; detail?: string }[] = [
    {
      name: "PayPal payouts",
      icon: CreditCardRounded,
      tone: payouts.status === "connected" ? "success" : "warning",
      label: payouts.status === "connected" ? "Connected" : "Not connected",
      detail: payouts.status === "connected" ? `Paid into ${payouts.display}` : "Connect your PayPal account in Settings",
    },
    {
      name: "PayPal checkout",
      icon: WebhookRounded,
      tone: o.paypal.reachable === false ? "danger" : o.paypal.reachable ? "success" : "neutral",
      label: o.paypal.reachable === false ? "Unreachable" : o.paypal.reachable ? "Working" : "Not checked yet",
      detail: o.paypal.checked_at ? `Checked ${ago(o.paypal.checked_at)}` : undefined,
    },
  ];
  return (
    <SectionCard title="System status" icon={<MonitorHeartRounded />}>
      <Box component="ul" sx={{ ...list, display: "grid", gap: 2.25 }}>
        {rows.map((r) => (
          <Box component="li" key={r.name} sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
            <r.icon aria-hidden fontSize="small" sx={{ color: brand.muted, mt: 0.25 }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 650 }}>
                {r.name}
              </Typography>
              {r.detail ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
                  {r.detail}
                </Typography>
              ) : null}
            </Box>
            <StatusChip tone={r.tone} label={r.label} />
          </Box>
        ))}
      </Box>
    </SectionCard>
  );
}

function QuickStock({ rows, onChanged }: { rows: InventoryRow[]; onChanged: () => void }) {
  const announce = useAnnounce();
  const [local, setLocal] = useState<Record<string, InventoryRow>>({});
  const [error, setError] = useState<string | null>(null);
  const view = rows.map((r) => (local[r.product_id] && local[r.product_id].version >= r.version ? local[r.product_id] : r));

  async function adjust(row: InventoryRow, delta: number) {
    setError(null);
    const optimistic = { ...row, surplus: row.surplus + delta, available: Math.max(0, row.available + delta) };
    setLocal((l) => ({ ...l, [row.product_id]: optimistic }));
    try {
      const res = await api<{ row: InventoryRow }>("/api/merchant/inventory", {
        body: { product_id: row.product_id, action: "adjust", delta, expected_version: row.version, reason: "Quick adjust from Today" },
      });
      setLocal((l) => ({ ...l, [row.product_id]: res.row }));
      announce(`${row.name}: surplus now ${res.row.surplus}.`);
      onChanged();
    } catch (err) {
      setLocal((l) => {
        const next = { ...l };
        delete next[row.product_id];
        return next;
      });
      const msg = err instanceof ApiError && err.code === "version_conflict" ? `${row.name} changed elsewhere; showing the latest count.` : errorMessage(err);
      setError(msg);
      announce(msg, "assertive");
      onChanged();
    }
  }

  const stepButton = { ...surface.raisedSm, width: 40, height: 40, borderRadius: "50%", "&.Mui-disabled": { boxShadow: "none" } };

  return (
    <SectionCard
      title="Top surplus"
      icon={<Inventory2Rounded />}
      action={
        <Button href="/merchant/inventory" size="small" endIcon={<ArrowForwardRounded />}>
          All inventory
        </Button>
      }
    >
      {error ? (
        <Alert severity="error" role="alert" sx={{ mb: 2 }}>
          {error}
        </Alert>
      ) : null}
      {view.length ? (
        <Box component="ul" sx={{ ...list, display: "grid", gap: 2.5 }}>
          {view.map((r) => {
            const held = r.reserved + r.committed;
            return (
              <Box component="li" key={r.product_id} sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
                <ProductImage image={r.image} size="sm" />
                <Box sx={{ flex: "1 1 180px", minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 700 }}>{r.name}</Typography>
                  <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", mt: 0.5 }}>
                    <StatusChip tone={r.available ? "success" : "neutral"} label={`${r.available} available`} />
                    {held ? <StatusChip tone="info" icon={ShoppingCartRounded} label={`${held} held or paid`} /> : null}
                  </Stack>
                </Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", ml: "auto" }}>
                  <IconButton aria-label={`Remove one ${r.name} from surplus`} disabled={r.surplus - held <= 0} onClick={() => adjust(r, -1)} sx={stepButton}>
                    <RemoveRounded fontSize="small" />
                  </IconButton>
                  <Box sx={{ minWidth: 52, textAlign: "center" }}>
                    <Typography variant="h4" component="p" className="tabular" sx={{ lineHeight: 1.1 }}>
                      {r.surplus}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      listed
                    </Typography>
                  </Box>
                  <IconButton aria-label={`Add one ${r.name} to surplus`} onClick={() => adjust(r, 1)} sx={stepButton}>
                    <AddRounded fontSize="small" />
                  </IconButton>
                </Stack>
              </Box>
            );
          })}
        </Box>
      ) : (
        <EmptyState icon={Inventory2Rounded} title="No surplus listed" />
      )}
    </SectionCard>
  );
}
