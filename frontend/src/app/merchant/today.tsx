"use client";

// Today: what a shop needs during the evening sale, on one screen. A headline strip (stock left, sales, time
// left with the close-out plan, and the counter check-in box), the pickup queue grouped by slot, what needs
// someone's attention, and a short stock watch. Every number comes from GET /api/merchant/overview.

import {
  AddRounded,
  ArrowForwardRounded,
  AutoAwesomeRounded,
  CheckCircleRounded,
  ChevronRightRounded,
  CircleRounded,
  PauseCircleRounded,
  PlayCircleRounded,
  RemoveRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Card, Collapse, IconButton, Link, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { CloseoutCard, duration } from "@/components/closeout-plan";
import { Dialog } from "@/components/dialog";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { ErrorState, LoadingBlock, PageHeader, SectionCard, StatusChip, brand, tones, type Tone } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ago, money, plural, timeLabel } from "@/lib/format";
import type { CloseoutPlan, CloseoutState, InventoryRow, OpenOrder, Overview, PickupLookup } from "@/lib/types";
import { useLive } from "@/lib/use-live";
import { useResource, useSecondsUntil, type Resource } from "@/lib/use-api";

const list = { listStyle: "none", m: 0, p: 0 } as const;
const bigNumber = { fontFamily: "var(--font-heading), var(--font-inter), sans-serif", fontSize: 32, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.02em" } as const;

type Match = PickupLookup["matches"][number];
/** The handoff dialog: from a check-in lookup (code known) or from a queue row (staff type the code). */
type HandoffTarget = { code: string | null; matches: Match[] };

export function Today() {
  const overview = useResource((signal) => api<Overview>("/api/merchant/overview", { signal }), [], { pollMs: 30_000 });
  const closeout = useResource((signal) => api<CloseoutState>("/api/merchant/closeout", { signal }), [], { pollMs: 60_000 });
  const staff = useStaff();
  const shopId = staff?.merchant.id;
  useLive([shopId ? `shop:${shopId}:orders` : null, shopId ? `shop:${shopId}:stock` : null], overview.reload);
  const [handoff, setHandoff] = useState<HandoffTarget | null>(null);
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

  const fromRow = (order: OpenOrder) => setHandoff({ code: null, matches: [{ ...order, pickup_locked: false }] });
  return (
    <>
      <PageHeader eyebrow={o.shop.name} title="Today" chips={<HeaderChips o={o} />} actions={<PausePickup o={o} onChanged={overview.reload} />} />
      <Stack spacing={3}>
        <Strip o={o} closeout={closeout} onFound={(found) => setHandoff({ code: found.code, matches: found.matches })} />
        <PlanCard closeout={closeout} />
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
          <Box sx={{ flex: "2.2 1 640px", minWidth: 0 }}>
            <UpcomingPickups o={o} onHandOff={fromRow} onChanged={overview.reload} />
          </Box>
          <Stack spacing={3} sx={{ flex: "1 1 360px", minWidth: 0 }}>
            <NeedsYou o={o} onResolved={overview.reload} />
            <StockWatch rows={o.stock} onChanged={overview.reload} />
          </Stack>
        </Box>
      </Stack>
      <HandoffDialog target={handoff} onClose={() => setHandoff(null)} onDone={overview.reload} />
    </>
  );
}

// ----------------------------------------------------------------------------- header

function HeaderChips({ o }: { o: Overview }) {
  const stale = useSecondsSince(o.as_of) > 120;
  const payouts = o.paypal.payouts.status === "connected";
  return (
    <>
      {stale ? (
        <StatusChip tone="warning" label={`Updated ${ago(o.as_of)}`} />
      ) : (
        <StatusChip tone="success" icon={CircleRounded} label="Live" sx={{ "& .MuiChip-icon": { fontSize: 10 } }} />
      )}
      {o.shop.pickup_paused ? <StatusChip tone="warning" icon={PauseCircleRounded} label="Pickup paused" /> : null}
      {o.paypal.reachable === false ? (
        <StatusChip tone="danger" label="PayPal unreachable" />
      ) : payouts ? (
        <StatusChip tone="neutral" icon={CheckCircleRounded} label="PayPal connected" sx={{ "& .MuiChip-icon": { color: brand.leaf } }} />
      ) : (
        <StatusChip tone="warning" label="PayPal payouts not connected" />
      )}
    </>
  );
}

function PausePickup({ o, onChanged }: { o: Overview; onChanged: () => void }) {
  const staff = useStaff();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!hasRole(staff, "manager")) return null;
  const paused = o.shop.pickup_paused;
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/merchant/shop/pickup-paused", { method: "PUT", body: { paused: !paused } });
      announce(paused ? "Pickup resumed" : "Pickup paused");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack spacing={0.5} sx={{ alignItems: "flex-end" }}>
      <Button variant="outlined" color="inherit" startIcon={paused ? <PlayCircleRounded /> : <PauseCircleRounded />} onClick={toggle} loading={busy}>
        {paused ? "Resume pickup" : "Pause pickup"}
      </Button>
      {error ? <Typography variant="caption" color="error" role="alert">{error}</Typography> : null}
    </Stack>
  );
}

// ----------------------------------------------------------------------------- headline strip

const segment = {
  px: { xs: 2.5, sm: 3 },
  py: 2.25,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  minWidth: 0,
  borderColor: brand.line,
  borderStyle: "solid",
  borderWidth: 0,
  borderBottomWidth: { xs: 1, lg: 0 },
  borderRightWidth: { xs: 0, lg: 1 },
} as const;
const segmentLabel = { fontWeight: 650, color: "text.secondary" } as const;

function Strip({ o, closeout, onFound }: { o: Overview; closeout: Resource<CloseoutState>; onFound: (found: PickupLookup) => void }) {
  const c = o.counters;
  const sold = c.sold_units_today;
  const held = c.reserved_units;
  const day = c.available_units + held + sold;
  return (
    <Card component="section" aria-label="Tonight at a glance" sx={{ display: "flex", flexWrap: "wrap", overflow: "hidden" }}>
      <Box sx={{ ...segment, flex: "1.3 1 300px" }}>
        <Typography variant="body2" sx={segmentLabel}>Left to sell</Typography>
        {day ? (
          <>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "baseline", flexWrap: "wrap" }}>
              <Typography component="p" className="tabular" sx={bigNumber}>{c.available_units}</Typography>
              <Typography color="text.secondary">of {day}</Typography>
              <Stack direction="row" spacing={1.5} sx={{ ml: "auto" }}>
                <Legend color={brand.leaf} label={`${sold} sold`} />
                {held ? <Legend color={brand.warning} label={`${held} on hold`} /> : null}
              </Stack>
            </Stack>
            <SplitBar total={day} parts={[{ value: sold, color: brand.leaf }, { value: held, color: brand.warning }]}
              label={`${sold} sold, ${held} on hold, ${c.available_units} left of ${day}`} />
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Nothing listed yet. <Link href="/merchant/inventory">Update stock</Link>
          </Typography>
        )}
      </Box>
      <Box sx={{ ...segment, flex: "0.8 1 200px" }}>
        <Typography variant="body2" sx={segmentLabel}>Sales today</Typography>
        <Typography component="p" className="tabular" sx={bigNumber}>{money(o.sales.amount_minor, o.sales.currency)}</Typography>
        <Typography variant="body2" color="text.secondary">{plural(o.sales.paid_orders, "paid order")}</Typography>
      </Box>
      <PickupClock closeout={closeout} />
      <CheckIn onFound={onFound} />
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <Typography variant="body2" color="text.secondary" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, whiteSpace: "nowrap" }}>
      <Box component="span" aria-hidden sx={{ width: 10, height: 10, borderRadius: "3px", bgcolor: color }} />
      {label}
    </Typography>
  );
}

function SplitBar({ total, parts, label, height = 10 }: { total: number; parts: { value: number; color: string }[]; label: string; height?: number }) {
  return (
    <Box role="img" aria-label={label} sx={{ display: "flex", gap: "2px", height, borderRadius: 99, overflow: "hidden", bgcolor: brand.line }}>
      {parts.filter((p) => p.value > 0).map((p, i) => (
        <Box key={i} sx={{ width: `${(p.value / Math.max(1, total)) * 100}%`, bgcolor: p.color }} />
      ))}
    </Box>
  );
}

function PickupClock({ closeout }: { closeout: Resource<CloseoutState> }) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = closeout.data;
  const left = useSecondsUntil(s?.schedule.closes_at);
  const planLeft = useSecondsUntil(s?.plan?.expires_at);
  const plan = s?.plan ?? null;
  const waiting = !!plan && (plan.status === "pending" || plan.status === "partly_applied") && !!planLeft;
  const over = !s?.schedule.closes_at || left === 0;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api<CloseoutPlan>("/api/merchant/closeout/run", { body: {}, timeoutMs: 120_000 });
      announce("Close-out plan ready");
      closeout.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const caption = error ?? (busy ? "Checking stock, slots and today's sales…"
    : !s ? "" : waiting ? "A plan is waiting for your OK"
      : !s.schedule.enabled ? "The close-out assistant is off"
        : over ? "Today's pickup is over"
          : s.schedule.runs_at_label ? `Close-out plan drafts on its own at ${s.schedule.runs_at_label}` : "");
  return (
    <Box sx={{ ...segment, flex: "1.3 1 320px" }}>
      <Typography variant="body2" sx={segmentLabel}>{s?.schedule.closes_at_label ? `Pickup closes ${s.schedule.closes_at_label}` : "Pickup closes in"}</Typography>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <Typography component="p" className="tabular" role="timer" sx={bigNumber}
          aria-label={left ? `${duration(left)} until pickup ends at ${s?.schedule.closes_at_label}` : "Pickup has ended"}>
          {!s ? "…" : !s.schedule.closes_at ? "No pickup" : left ? duration(left) : "Closed"}
        </Typography>
        {waiting ? (
          <Button href="#closeout-plan" variant="contained" startIcon={<AutoAwesomeRounded />}>Review plan</Button>
        ) : s?.can_apply && s.schedule.enabled && !over ? (
          <Button variant="contained" onClick={run} loading={busy} startIcon={<AutoAwesomeRounded />}
            sx={{ bgcolor: brand.forest, "&:hover": { bgcolor: brand.forestSoft } }}>
            Plan close-out
          </Button>
        ) : null}
      </Stack>
      {caption ? (
        <Typography variant="body2" color={error ? "error" : "text.secondary"} role={error ? "alert" : busy ? "status" : undefined}>{caption}</Typography>
      ) : null}
    </Box>
  );
}

/** Today's close-out plan, shown only while it matters: waiting for a manager, or applied (with its results).
 *  Dismissed and expired plans drop off; the strip's "Plan close-out" asks for a new one. */
function PlanCard({ closeout }: { closeout: Resource<CloseoutState> }) {
  const plan = closeout.data?.plan;
  const left = useSecondsUntil(plan?.expires_at);
  if (!plan || !left || !["pending", "partly_applied", "applied"].includes(plan.status)) return null;
  return (
    <Box id="closeout-plan" sx={{ scrollMarginTop: 96 }}>
      <CloseoutCard state={closeout} showSchedule={false} />
    </Box>
  );
}

// ----------------------------------------------------------------------------- counter check-in

const LOOKUP_TONE: Record<string, Tone> = {
  no_pickup_match: "danger", lookup_locked: "danger", already_picked_up: "info", not_open: "warning", bad_pickup_code: "warning",
};

function CheckIn({ onFound }: { onFound: (found: PickupLookup) => void }) {
  const staff = useStaff();
  const inputId = useId();
  const hintId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: Tone; text: string; locked?: boolean } | null>(null);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const found = await api<PickupLookup>("/api/merchant/pickups/lookup", { body: { code: code.trim() } });
      setCode("");
      onFound(found);
    } catch (err) {
      const kind = err instanceof ApiError ? err.code : "";
      setNotice({ tone: LOOKUP_TONE[kind] ?? "danger", text: errorMessage(err), locked: kind === "lookup_locked" });
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    try {
      await api("/api/merchant/pickups/lookup/unlock", { body: {} });
      setNotice({ tone: "success", text: "Check-in unlocked." });
    } catch (err) {
      setNotice({ tone: "danger", text: errorMessage(err) });
    }
  }

  return (
    <Box component="form" onSubmit={lookup} aria-label="Pickup check-in" noValidate
      sx={{ ...segment, borderBottomWidth: 0, borderRightWidth: 0, flex: "1.3 1 360px", bgcolor: brand.mint }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography component="label" htmlFor={inputId} variant="body2" sx={{ fontWeight: 650, color: brand.leafDark }}>
          Scan pass or enter code
        </Typography>
        <Link href="/merchant/orders" variant="body2" sx={{ fontWeight: 600 }}>Find in orders</Link>
      </Stack>
      <Stack direction="row" spacing={1}>
        <TextField id={inputId} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan or type code" autoComplete="off"
          slotProps={{ htmlInput: { "aria-describedby": hintId, spellCheck: false, autoCapitalize: "characters" } }}
          sx={{
            flex: 1, minWidth: 0, "& .MuiOutlinedInput-root": { bgcolor: "#fff" },
            "& .MuiOutlinedInput-input": { fontSize: 18, fontWeight: 600, letterSpacing: "0.06em", "&::placeholder": { letterSpacing: "normal", fontWeight: 500 } },
          }} />
        <Button type="submit" variant="contained" loading={busy} sx={{ flexShrink: 0, px: 2.5 }}>Look up</Button>
      </Stack>
      <Typography id={hintId} variant="body2" role="status" sx={{ color: notice ? tones[notice.tone].fg : brand.leafDark, fontWeight: notice ? 600 : 400 }}>
        {notice?.text ?? "A scanner fills this in. You confirm before handing off."}
      </Typography>
      {notice?.locked && hasRole(staff, "manager") ? (
        <Button size="small" variant="outlined" color="inherit" onClick={unlock} sx={{ alignSelf: "flex-start", bgcolor: "#fff" }}>Unlock check-in</Button>
      ) : null}
    </Box>
  );
}

function HandoffDialog({ target, onClose, onDone }: { target: HandoffTarget | null; onClose: () => void; onDone: () => void }) {
  const staff = useStaff();
  const announce = useAnnounce();
  const codeId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fresh state for each new target (a new scan or another row's Hand off).
  const [shown, setShown] = useState(target);
  if (target !== shown) {
    setShown(target);
    setChosen(null);
    setCode("");
    setError(null);
  }
  const matches = target?.matches ?? [];
  const order = matches.length === 1 ? matches[0] : matches.find((m) => m.id === chosen) ?? null;
  const fromScan = !!target?.code;
  const packing = order ? order.fulfillment_status !== "READY" : false;
  const locked = !!order?.pickup_locked && !hasRole(staff, "manager");

  async function handOff(e: FormEvent) {
    e.preventDefault();
    if (!order) return;
    const pickupCode = target?.code ?? code.trim();
    if (!pickupCode) {
      setError("Enter the code from the customer's pickup pass.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/merchant/orders/${order.id}/handoff`, { body: { pickup_code: pickupCode, mark_ready: packing } });
      announce(`Handed off #${order.number}.`);
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const title = !order ? `${matches.length} open orders use this code` : fromScan ? `Code matches #${order.number}` : `Hand off #${order.number}`;
  return (
    <Dialog open={!!target} onClose={onClose} title={title}
      description={!order ? "Ask for the customer's name, then choose." : undefined}
      actions={order ? (
        <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
          <Button color="inherit" onClick={matches.length > 1 ? () => setChosen(null) : onClose}>{fromScan ? "Not this customer" : "Cancel"}</Button>
          <Button type="submit" form={`${codeId}-form`} variant="contained" loading={busy} disabled={locked}>
            {packing ? "Mark ready & hand off" : "Hand off"}
          </Button>
        </Stack>
      ) : undefined}>
      {!order ? (
        <Box component="ul" sx={{ ...list, display: "grid", gap: 1.25 }}>
          {matches.map((m) => (
            <li key={m.id}>
              <Button fullWidth variant="outlined" color="inherit" onClick={() => setChosen(m.id)}
                sx={{ justifyContent: "space-between", textAlign: "left", py: 1.5, px: 2, bgcolor: "#fff", gap: 2 }}>
                <Box>
                  <Typography sx={{ fontWeight: 700 }}>{m.customer_name ?? "Customer"}</Typography>
                  <Typography variant="body2" color="text.secondary">#{m.number} · {m.pickup_label} · {plural(m.units, "item")}</Typography>
                </Box>
                <OrderStatus order={m} />
              </Button>
            </li>
          ))}
        </Box>
      ) : (
        <Box component="form" id={`${codeId}-form`} onSubmit={handOff} noValidate>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <Box>
                <Typography variant="h3" component="p">{order.customer_name ?? "Customer"}</Typography>
                <Typography variant="body2" color="text.secondary">{order.pickup_label} · paid via PayPal</Typography>
              </Box>
              <OrderStatus order={order} />
            </Stack>
            <Box component="ul" sx={{ ...list, bgcolor: brand.cream, border: 1, borderColor: brand.line, borderRadius: "12px", px: 2, py: 1.5, display: "grid", gap: 0.5 }}>
              {order.lines.map((l, i) => (
                <Box component="li" key={i} sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
                  <span>{l.qty} × {l.name}</span>
                  <span className="tabular">{money(l.line_total_minor, order.currency)}</span>
                </Box>
              ))}
              <Box component="li" sx={{ display: "flex", justifyContent: "space-between", gap: 2, mt: 0.5, pt: 0.75, borderTop: 1, borderColor: brand.line, fontWeight: 700 }}>
                <span>Total</span>
                <span className="tabular">{money(order.amount_minor, order.currency)}</span>
              </Box>
            </Box>
            {packing ? <Alert severity="warning">Not marked ready yet. Pack the bag, then hand it off in one step.</Alert> : null}
            {locked ? <Alert severity="error">Too many wrong codes on this order. A manager must verify this pickup.</Alert> : null}
            {!target?.code ? (
              <TextField label="Customer's pickup code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off"
                slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 12 } }} />
            ) : null}
            {error ? <Alert severity="error" role="alert">{error}</Alert> : null}
          </Stack>
        </Box>
      )}
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- pickup queue

type Group = { key: string; startsAt: string; endsAt: string | null; orders: OpenOrder[]; booked: number | null; capacity: number | null };

function groupBySlot(o: Overview): Group[] {
  const slots = new Map(o.slots.map((s) => [s.id, s]));
  const groups = new Map<string, Group>();
  for (const order of o.open_orders) {
    const key = `${order.pickup_starts_at}|${order.pickup_slot_id}`;
    const slot = slots.get(order.pickup_slot_id);
    if (!groups.has(key)) {
      groups.set(key, { key, startsAt: order.pickup_starts_at, endsAt: slot?.ends_at ?? null, orders: [], booked: slot?.booked ?? null, capacity: slot?.capacity ?? null });
    }
    groups.get(key)!.orders.push(order);
  }
  return [...groups.values()].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

const isPaid = (order: OpenOrder) => order.payment_status === "CAPTURED";

function UpcomingPickups({ o, onHandOff, onChanged }: { o: Overview; onHandOff: (order: OpenOrder) => void; onChanged: () => void }) {
  const groups = useMemo(() => groupBySlot(o), [o]);
  // One slot open at a time; the soonest starts open. `null` means the person closed them all.
  const [openKey, setOpenKey] = useState<string | null | undefined>(undefined);
  const active = openKey === null ? null : groups.find((g) => g.key === openKey)?.key ?? groups[0]?.key ?? null;
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const ready = o.open_orders.filter((x) => isPaid(x) && x.fulfillment_status === "READY").length;
  const toPack = o.open_orders.filter((x) => isPaid(x) && x.fulfillment_status !== "READY").length;
  const paying = o.open_orders.filter((x) => !isPaid(x)).length;

  return (
    <SectionCard title="Upcoming pickups" contentSx={{ pt: 1.5 }}
      action={
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {ready ? <StatusChip tone="success" label={`${ready} ready`} /> : null}
          {toPack ? <StatusChip tone="info" label={`${toPack} to pack`} /> : null}
          {paying ? <StatusChip tone="warning" label={`${paying} paying`} /> : null}
          <Button href="/merchant/orders" size="small" endIcon={<ArrowForwardRounded />}>All orders</Button>
        </Stack>
      }>
      {error ? <Alert severity="error" role="alert" onClose={() => setError(null)} sx={{ mb: 2 }}>{error}</Alert> : null}
      {groups.length ? (
        <>
          <Box aria-hidden sx={{ display: { xs: "none", md: "grid" }, gridTemplateColumns: COLUMNS, gap: 1.5, pb: 0.5, px: 0.5 }}>
            {["Order", "Items", "Total", "Status"].map((h, i) => (
              <Typography key={h} variant="overline" color="text.secondary"
                sx={{ lineHeight: 2, textAlign: h === "Total" ? "right" : "left", visibility: i === 0 || active ? "visible" : "hidden" }}>{h}</Typography>
            ))}
          </Box>
          <Stack spacing={0.75}>
            {groups.map((g) => (
              <SlotGroup key={g.key} group={g} now={now} open={g.key === active} timeZone={o.shop.timezone}
                onToggle={() => setOpenKey(g.key === active ? null : g.key)} onHandOff={onHandOff} onChanged={onChanged} onError={setError} />
            ))}
          </Stack>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ bgcolor: brand.cream, border: 1, borderColor: brand.line, borderRadius: "14px", p: 2.5, textAlign: "center" }}>
          No pickups waiting right now.
        </Typography>
      )}
      <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "center", mt: 2, pt: 1.5, borderTop: 1, borderColor: brand.line }}>
        <Typography variant="body2" color="text.secondary">
          <Box component="span" className="tabular" sx={{ fontWeight: 700, color: "text.primary" }}>{o.orders.picked_up_today}</Box> picked up earlier today
        </Typography>
        <Link href="/merchant/orders" variant="body2" sx={{ fontWeight: 600 }}>Show</Link>
      </Stack>
    </SectionCard>
  );
}

const COLUMNS = "136px minmax(0, 1fr) 72px 150px 124px";

function SlotGroup({ group: g, now, open, timeZone, onToggle, onHandOff, onChanged, onError }: {
  group: Group; now: number; open: boolean; timeZone: string; onToggle: () => void;
  onHandOff: (order: OpenOrder) => void; onChanged: () => void; onError: (message: string) => void;
}) {
  const panelId = useId();
  const start = Date.parse(g.startsAt);
  const end = g.endsAt ? Date.parse(g.endsAt) : start + 15 * 60_000;
  const when = start > now ? `in ${duration((start - now) / 1000)}` : end > now ? "now" : `${duration((now - end) / 1000)} late`;
  const ready = g.orders.filter((x) => isPaid(x) && x.fulfillment_status === "READY").length;
  const toPack = g.orders.filter((x) => isPaid(x) && x.fulfillment_status !== "READY").length;
  const paying = g.orders.filter((x) => !isPaid(x)).length;
  const time = timeLabel(g.startsAt, timeZone);
  return (
    <Box>
      <Typography component="h3" sx={{ m: 0 }}>
        <Box component="button" type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle}
          sx={{
            width: "100%", display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", minHeight: 48, px: 1.5, py: 1, border: 0,
            borderRadius: "10px", bgcolor: open ? brand.mint : brand.cream, color: brand.forest, font: "inherit", textAlign: "left", cursor: "pointer",
            "&:hover": { bgcolor: open ? brand.mint : brand.sand }, "&:focus-visible": { outline: `2px solid ${brand.leaf}`, outlineOffset: 2 },
          }}>
          <ChevronRightRounded aria-hidden sx={{ transition: "transform 150ms", transform: open ? "rotate(90deg)" : "none" }} />
          <Box component="span" sx={{ fontWeight: 700 }}>{time}</Box>
          <Box component="span" sx={{ color: end <= now ? tones.danger.fg : "text.secondary", fontWeight: end <= now ? 600 : 400 }}>
            {when} · {plural(g.orders.length, "order")}
          </Box>
          {ready ? <StatusChip tone="success" label={`${ready} ready`} /> : null}
          {toPack ? <StatusChip tone="info" label={`${toPack} to pack`} /> : null}
          {paying ? <StatusChip tone="warning" label={`${paying} paying`} /> : null}
          {g.capacity ? <Capacity booked={g.booked ?? 0} capacity={g.capacity} /> : null}
        </Box>
      </Typography>
      <Collapse in={open} unmountOnExit>
        <Box id={panelId} component="ul" aria-label={`${time} pickups`} sx={{ ...list, px: 0.5 }}>
          {g.orders.map((order) => (
            <OrderRow key={order.id} order={order} now={now} onHandOff={onHandOff} onChanged={onChanged} onError={onError} />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}

function Capacity({ booked, capacity }: { booked: number; capacity: number }) {
  return (
    <Box component="span" sx={{ ml: "auto", display: "inline-flex", alignItems: "center", gap: 1, color: "text.secondary", fontSize: 13 }}>
      <Box component="span" aria-hidden sx={{ display: { xs: "none", sm: "inline-flex" }, gap: "3px" }}>
        {Array.from({ length: Math.min(capacity, 12) }, (_, i) => (
          <Box key={i} component="span" sx={{ width: 10, height: 6, borderRadius: "2px", bgcolor: i < booked ? brand.leaf : brand.line }} />
        ))}
      </Box>
      {booked} of {capacity} booked
    </Box>
  );
}

function OrderStatus({ order, now }: { order: OpenOrder | Match; now?: number }) {
  if (order.payment_status !== "CAPTURED") {
    const hold = "hold_expires_at" in order && order.hold_expires_at && now ? Math.max(0, Math.ceil((Date.parse(order.hold_expires_at) - now) / 60_000)) : null;
    return <StatusChip tone="warning" label={hold !== null ? `Paying · ${hold} min left` : "Paying"} />;
  }
  if (order.fulfillment_status === "READY") return <StatusChip tone="success" label="Ready" />;
  return <StatusChip tone="info" label={order.fulfillment_status === "PACKING" ? "Packing" : "To pack"} />;
}

function OrderRow({ order, now, onHandOff, onChanged, onError }: {
  order: OpenOrder; now: number; onHandOff: (order: OpenOrder) => void; onChanged: () => void; onError: (message: string) => void;
}) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  async function markReady() {
    setBusy(true);
    try {
      await api(`/api/merchant/orders/${order.id}/fulfillment`, { body: { action: "mark_ready" } });
      announce(`#${order.number} is ready. The customer was told.`);
      onChanged();
    } catch (err) {
      onError(`#${order.number}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }
  const items = order.lines.map((l) => `${l.qty} × ${l.name}`).join(", ");
  return (
    <Box component="li" sx={{
      display: "grid", gap: 1.5, alignItems: "center", py: 1.25, borderBottom: 1, borderColor: brand.line,
      gridTemplateColumns: { xs: "minmax(0, 1fr) auto", md: COLUMNS },
      gridTemplateAreas: { xs: '"order action" "items items" "status total"', md: '"order items total status action"' },
    }}>
      <Box sx={{ gridArea: "order", minWidth: 0 }}>
        <Typography sx={{ fontWeight: 700 }}>#{order.number}</Typography>
        <Typography variant="body2" color="text.secondary" noWrap>{order.customer_name ?? "Customer"}</Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ gridArea: "items", minWidth: 0 }}>{items}</Typography>
      <Typography className="tabular" sx={{ gridArea: "total", fontWeight: 600, textAlign: "right" }}>{money(order.amount_minor, order.currency)}</Typography>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ gridArea: "status", flexWrap: "wrap" }}>
        <OrderStatus order={order} now={now} />
        {order.cancel_requested ? <StatusChip tone="warning" label="Cancel requested" /> : null}
      </Stack>
      <Box sx={{ gridArea: "action", justifySelf: "end" }}>
        {!isPaid(order) ? (
          <Button href={`/merchant/orders?order=${order.id}`} sx={{ minWidth: 120 }}>Open</Button>
        ) : order.fulfillment_status === "READY" ? (
          <Button variant="outlined" color="inherit" onClick={() => onHandOff(order)} sx={{ minWidth: 120 }}>Hand off</Button>
        ) : (
          <Button variant="contained" onClick={markReady} loading={busy} sx={{ minWidth: 120 }}>Mark ready</Button>
        )}
      </Box>
    </Box>
  );
}

// ----------------------------------------------------------------------------- needs you

const KIND_LABEL: Record<string, string> = {
  missed_pickup: "Pickup", cancellation_request: "Cancel", support_request: "Message", refund_failed: "Refund", refund_mismatch: "Refund",
  external_refund: "Refund", past_cutoff: "Stock", closeout_ready: "Close-out",
};
// Shown elsewhere on the page: stale counts are grouped into one recount row, low stock lives in Stock watch,
// and per-item cutoff alerts are grouped into one row.
const FOLDED = new Set(["stale_inventory", "low_stock", "past_cutoff"]);

type Need = { key: string; tone: Tone; label: string; title: ReactNode; detail?: ReactNode; action?: ReactNode; onDismiss?: () => Promise<void> };

/** "A, B, C and 6 more": a long list of item names never takes over the card. */
function names(list: string[]): string {
  return list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

function NeedsYou({ o, onResolved }: { o: Overview; onResolved: () => void }) {
  const needs: Need[] = [];
  if (o.stale_inventory.length) {
    const oldest = o.stale_inventory.reduce((a, b) => (Date.parse(a.updated_at) < Date.parse(b.updated_at) ? a : b));
    needs.push({
      key: "stale", tone: "warning", label: "Stock", title: `Recount ${plural(o.stale_inventory.length, "item")}`,
      detail: `${names(o.stale_inventory.map((s) => s.name))} · last counted ${ago(oldest.updated_at)}`,
      action: <Button href="/merchant/inventory" size="small" variant="outlined" color="inherit">Recount</Button>,
    });
  }
  const cutoff = o.alerts.filter((a) => a.kind === "past_cutoff");
  if (cutoff.length) {
    const byId = new Map(o.stock.map((r) => [r.product_id, r.name]));
    const items = cutoff.map((a) => byId.get(a.entity_id) ?? a.message.split(":")[0]);
    needs.push({
      key: "cutoff", tone: "neutral", label: "Stock",
      title: cutoff.length === 1 ? `${items[0]} is past its pickup cutoff with stock left` : `${cutoff.length} items past their pickup cutoff with stock left`,
      detail: cutoff.length > 1 ? `${names(items)}. Update or remove the listings.` : "Update or remove the listing.",
      action: <Button href="/merchant/inventory" size="small" variant="outlined" color="inherit">Update</Button>,
      onDismiss: async () => {
        await Promise.all(cutoff.map((a) => api(`/api/merchant/alerts/${a.id}/resolve`, { body: {} })));
        onResolved();
      },
    });
  }
  if (o.paypal.reachable === false) {
    needs.push({ key: "paypal", tone: "danger", label: "Payments", title: "PayPal checkout isn't reachable",
      detail: o.paypal.checked_at ? `Checked ${ago(o.paypal.checked_at)}. New checkouts may fail.` : "New checkouts may fail." });
  }
  if (o.paypal.payouts.status !== "connected") {
    needs.push({ key: "payouts", tone: "warning", label: "Payouts", title: "Connect PayPal to get paid",
      action: <Button href="/merchant/settings?tab=payouts" size="small" variant="outlined" color="inherit">Connect</Button> });
  }
  for (const a of o.alerts) {
    if (FOLDED.has(a.kind)) continue;
    needs.push({
      key: a.id, tone: a.severity === "high" ? "danger" : a.severity === "medium" ? "warning" : "neutral", label: KIND_LABEL[a.kind] ?? "Review",
      title: a.message,
      action: a.entity_type === "order" ? <Button href={`/merchant/orders?order=${a.entity_id}`} size="small" variant="outlined" color="inherit">Open</Button> : undefined,
      onDismiss: async () => {
        await api(`/api/merchant/alerts/${a.id}/resolve`, { body: {} });
        onResolved();
      },
    });
  }
  return (
    <SectionCard title="Needs you" contentSx={{ pt: 1.5 }}
      action={needs.length ? <StatusChip tone={needs.some((n) => n.tone === "danger") ? "danger" : "warning"} label={needs.length} /> : null}>
      {needs.length ? (
        <Box component="ul" sx={{ ...list }}>
          {needs.map((n, i) => <NeedRow key={n.key} need={n} last={i === needs.length - 1} />)}
        </Box>
      ) : (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: brand.leafDark, bgcolor: brand.mint, borderRadius: "14px", px: 1.75, py: 1.5 }}>
          <CheckCircleRounded aria-hidden fontSize="small" />
          <Typography variant="body2" sx={{ fontWeight: 650 }}>All clear. Nothing needs you right now.</Typography>
        </Stack>
      )}
    </SectionCard>
  );
}

function NeedRow({ need: n, last }: { need: Need; last: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Box component="li" sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1.5, py: 1.25, borderBottom: last ? 0 : 1, borderColor: brand.line }}>
      <StatusChip tone={n.tone} label={n.label} sx={{ flexShrink: 0, mt: 0.25 }} />
      <Box sx={{ flex: "1 1 160px", minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 650 }}>{n.title}</Typography>
        {n.detail ? <Typography variant="body2" color="text.secondary">{n.detail}</Typography> : null}
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: "center", ml: "auto" }}>
        {n.action}
        {n.onDismiss ? (
          <Button size="small" color="inherit" loading={busy} sx={{ color: "text.secondary" }}
            onClick={async () => {
              setBusy(true);
              await n.onDismiss!().catch(() => {});
              setBusy(false);
            }}>
            Dismiss
          </Button>
        ) : null}
      </Stack>
    </Box>
  );
}

// ----------------------------------------------------------------------------- stock watch

type StockRow = Overview["stock"][number];

function sellThrough(r: StockRow): number {
  const offered = r.sold_today + r.available + r.reserved;
  return offered ? r.sold_today / offered : 1;
}

function StockWatch({ rows, onChanged }: { rows: StockRow[]; onChanged: () => void }) {
  const announce = useAnnounce();
  const [local, setLocal] = useState<Record<string, StockRow>>({});
  const [error, setError] = useState<string | null>(null);
  const view = rows.map((r) => (local[r.product_id] && local[r.product_id].version >= r.version ? local[r.product_id] : r));
  const anySold = view.some((r) => r.sold_today > 0);
  const offered = (r: StockRow) => r.surplus > 0 || r.sold_today > 0;
  const low = view.filter((r) => offered(r) && (r.availability_status === "low" || r.availability_status === "sold_out"))
    .sort((a, b) => a.available - b.available).slice(0, 3);
  const rest = view.filter((r) => r.available > 0 && !low.includes(r));
  const slow = (anySold ? [...rest].sort((a, b) => sellThrough(a) - sellThrough(b) || b.available - a.available) : [...rest].sort((a, b) => b.available - a.available)).slice(0, 3);

  async function adjust(row: StockRow, delta: number) {
    setError(null);
    setLocal((l) => ({ ...l, [row.product_id]: { ...row, surplus: row.surplus + delta, available: Math.max(0, row.available + delta) } }));
    try {
      const res = await api<{ row: InventoryRow }>("/api/merchant/inventory", {
        body: { product_id: row.product_id, action: "adjust", delta, expected_version: row.version, reason: "Quick adjust from Today" },
      });
      setLocal((l) => ({ ...l, [row.product_id]: { ...res.row, sold_today: row.sold_today } }));
      announce(`${row.name}: ${res.row.surplus} listed.`);
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

  const section = (title: string, items: StockRow[]) => (items.length ? (
    <Box>
      <Typography variant="overline" component="h3" color="text.secondary" sx={{ display: "block", mt: 1 }}>{title}</Typography>
      <Box component="ul" sx={{ ...list }}>
        {items.map((r) => {
          const held = r.reserved + r.committed;
          const pct = Math.round(sellThrough(r) * 100);
          return (
            <Box component="li" key={r.product_id} sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1, borderTop: 1, borderColor: brand.line }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 650 }}>{r.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {r.available ? `${r.available} left` : "Sold out"}{anySold ? ` · ${pct}% sold` : ""}
                </Typography>
              </Box>
              <Stack direction="row" sx={{ alignItems: "center", border: 1, borderColor: brand.lineStrong, borderRadius: "10px", flexShrink: 0 }}>
                <IconButton aria-label={`List one fewer ${r.name}`} disabled={r.surplus - held <= 0} onClick={() => adjust(r, -1)} sx={{ borderRadius: "9px 0 0 9px", width: 44, height: 40 }}>
                  <RemoveRounded fontSize="small" />
                </IconButton>
                <Typography className="tabular" aria-label={`${r.surplus} listed`} sx={{ minWidth: 32, textAlign: "center", fontWeight: 650 }}>{r.surplus}</Typography>
                <IconButton aria-label={`List one more ${r.name}`} onClick={() => adjust(r, 1)} sx={{ borderRadius: "0 9px 9px 0", width: 44, height: 40 }}>
                  <AddRounded fontSize="small" />
                </IconButton>
              </Stack>
            </Box>
          );
        })}
      </Box>
    </Box>
  ) : null);

  return (
    <SectionCard title="Stock watch" contentSx={{ pt: 0.5 }}
      action={<Button href="/merchant/inventory" size="small" endIcon={<ArrowForwardRounded />}>{`All ${rows.length} items`}</Button>}>
      {error ? <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>{error}</Alert> : null}
      {low.length || slow.length ? (
        <>
          {section("Running low", low)}
          {section(anySold ? "Selling slowest" : "Most left", slow)}
        </>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>Nothing listed yet.</Typography>
      )}
    </SectionCard>
  );
}

// ----------------------------------------------------------------------------- time

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function useSecondsSince(iso: string): number {
  const now = useNow(15_000);
  return Math.max(0, (now - Date.parse(iso)) / 1000);
}
