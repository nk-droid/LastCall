"use client";

// Today's pickups as one list: each row shows the pickup time, the order, its total, one status and (only if needed)
// one flag. Orders that need a decision sit on top. The selected order opens beside the list on wide screens (in a
// drawer on phones) with its next step first, then items, the customer, and the records behind it.

import {
  AutoAwesomeRounded,
  ChatBubbleOutlineRounded,
  DescriptionRounded,
  ExpandMoreRounded,
  GppMaybeRounded,
  Inventory2Rounded,
  KeyRounded,
  PaymentsRounded,
  ReceiptLongRounded,
  ReplayRounded,
  SearchOffRounded,
  SearchRounded,
  SendRounded,
  ShoppingBagRounded,
  TaskAltRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  FormControlLabel,
  InputAdornment,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useId, useState, type FormEvent, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { Dialog } from "@/components/dialog";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { PaymentPill } from "@/components/status-pills";
import { EmptyState, ErrorState, FilterChip, InfoList, LoadingBlock, PageHeader, StatusChip, brand, surface, tones, type Icon, type Tone } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { dateTimeLabel, money, timeLabel } from "@/lib/format";
import type { OrderDetail, OrderSummary, Slot } from "@/lib/types";
import { useLive } from "@/lib/use-live";
import { useResource } from "@/lib/use-api";

type Queue = { groups: Record<string, OrderSummary[]>; slots: Slot[]; as_of: string };
type Filter = "open" | "pack" | "ready" | "paying" | "done";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "pack", label: "To pack" },
  { key: "ready", label: "Ready" },
  { key: "paying", label: "Paying" },
  { key: "done", label: "Done" },
];
const list = { listStyle: "none", m: 0, p: 0 } as const;
type Badge = { tone: Tone; label: string; icon?: Icon };

/** The one status a row shows, from payment, fulfillment and refund together. */
function statusOf(o: OrderSummary): Badge {
  if (o.refund_status === "COMPLETED") return { tone: "neutral", label: "Refunded", icon: ReplayRounded };
  if (o.refund_status !== "NONE") return { tone: "warning", label: "Refund pending", icon: ReplayRounded };
  if (o.payment_status !== "CAPTURED") return { tone: "warning", label: "Paying" };
  switch (o.fulfillment_status) {
    case "NEW": return { tone: "info", label: "To pack", icon: Inventory2Rounded };
    case "PACKING": return { tone: "info", label: "Packing", icon: Inventory2Rounded };
    case "READY": return { tone: "success", label: "Ready", icon: ShoppingBagRounded };
    case "PICKED_UP": return { tone: "neutral", label: "Picked up", icon: TaskAltRounded };
    case "CANCELLED": return { tone: "neutral", label: "Cancelled" };
    default: return { tone: "neutral", label: o.fulfillment_status.toLowerCase() };
  }
}

/** Something that needs a person, most urgent first; null when the order just needs packing or handing off. */
function flagOf(o: OrderSummary): Badge | null {
  const open = o.payment_status === "CAPTURED" && ["NEW", "PACKING", "READY"].includes(o.fulfillment_status);
  if (o.exception_flags.length) return { tone: "danger", label: "Needs review", icon: GppMaybeRounded };
  if (open && o.pickup_expired) return { tone: "danger", label: "Missed pickup", icon: WarningAmberRounded };
  if (o.cancel_requested) return { tone: "warning", label: "Wants to cancel", icon: ReplayRounded };
  if (o.open_support) return { tone: "info", label: o.open_support === 1 ? "1 new message" : `${o.open_support} new messages`, icon: ChatBubbleOutlineRounded };
  return null;
}

export function Orders() {
  const params = useSearchParams();
  const router = useRouter();
  const staff = useStaff();
  const zone = staff?.merchant.timezone;
  const queue = useResource((signal) => api<Queue>("/api/merchant/orders", { signal }), [], { pollMs: 30_000 });
  useLive([staff?.merchant.id ? `shop:${staff.merchant.id}:orders` : null], queue.reload);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const wide = useMediaQuery((theme: Theme) => theme.breakpoints.up("lg"), { noSsr: true });
  const openId = params.get("order");
  // Keep the last order rendered while the phone drawer slides closed.
  const [drawerId, setDrawerId] = useState(openId);
  if (openId && openId !== drawerId) setDrawerId(openId);
  const q = queue.data;

  const open = (id: string | null) => router.replace(id ? `/merchant/orders?order=${id}` : "/merchant/orders", { scroll: false });
  const header = <PageHeader eyebrow={staff?.merchant?.name} title="Orders"
    actions={q ? (
      <TextField size="small" placeholder="Search order # or name" value={query} onChange={(e) => setQuery(e.target.value)}
        slotProps={{ htmlInput: { "aria-label": "Search orders" }, input: { startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> } }}
        sx={{ width: { xs: "100%", sm: 320 }, bgcolor: brand.paper }} />
    ) : undefined} />;

  if (queue.error && !q) return <>{header}<ErrorState title="Couldn't load orders" message={errorMessage(queue.error)} onRetry={queue.reload} /></>;
  if (!q) return <>{header}<LoadingBlock label="Loading orders" slow={queue.slow} lines={8} /></>;

  const g = (key: string) => q.groups[key] ?? [];
  const paid = [...g("awaiting_pickup"), ...g("in_progress")];
  const byFilter: Record<Filter, OrderSummary[]> = {
    open: [...paid, ...g("payment_pending")],
    pack: paid.filter((o) => o.fulfillment_status === "NEW" || o.fulfillment_status === "PACKING"),
    ready: paid.filter((o) => o.fulfillment_status === "READY"),
    paying: g("payment_pending"),
    done: g("complete"),
  };
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  const rows = byFilter[filter]
    .filter((o) => !needle || `${o.number} ${o.customer_name ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(!!flagOf(b)) - Number(!!flagOf(a)) || (filter === "done" ? b.pickup_starts_at.localeCompare(a.pickup_starts_at) : a.pickup_starts_at.localeCompare(b.pickup_starts_at)));
  // On a wide screen the panel is never empty: it shows the chosen order, or the first one in the list.
  const selected = openId ?? (wide ? rows[0]?.id ?? null : null);
  const today = new Date().toLocaleDateString("en-US", { timeZone: zone });

  const listCard = (
    <Box component="section" aria-label={`${FILTERS.find((f) => f.key === filter)?.label} orders`} sx={{ ...surface.raised, borderRadius: "16px", overflow: "hidden", minWidth: 0 }}>
      {rows.length ? (
        <Box component="ul" sx={list}>
          {rows.map((o, i) => (
            <li key={o.id}>
              <OrderRow o={o} today={today} zone={zone} active={o.id === selected} last={i === rows.length - 1} onOpen={() => open(o.id)} />
            </li>
          ))}
        </Box>
      ) : (
        <Box sx={{ p: 3 }}>
          <EmptyState icon={SearchOffRounded} title={needle ? "No matching orders" : filter === "done" ? "Nothing finished yet today" : "Nothing here right now"}>
            {needle ? "Try another order number or name." : "New orders show up here as soon as they're placed."}
          </EmptyState>
        </Box>
      )}
    </Box>
  );

  return (
    <>
      {header}
      <Stack direction="row" spacing={1} useFlexGap role="group" aria-label="Show" sx={{ flexWrap: "wrap", mb: 2 }}>
        {FILTERS.map((f) => (
          <FilterChip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}
            label={<>{f.label} <Box component="span" className="tabular" sx={{ ml: 0.5, color: filter === f.key ? "inherit" : "text.secondary", fontWeight: 700 }}>{byFilter[f.key].length}</Box></>} />
        ))}
      </Stack>
      {wide ? (
        <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)", gap: 2.5, alignItems: "start" }}>
          {listCard}
          <Box sx={{ position: "sticky", top: 88, maxHeight: "calc(100dvh - 112px)", overflowY: "auto", ...surface.raised, borderRadius: "16px", p: 3 }}>
            {selected ? <OrderDetailPanel key={selected} orderId={selected} onChanged={queue.reload} />
              : <EmptyState icon={ReceiptLongRounded} title="No order selected">Pick an order to see its next step.</EmptyState>}
          </Box>
        </Box>
      ) : (
        <>
          {listCard}
          <Dialog open={!!openId} onClose={() => open(null)} side title="Order">
            {drawerId ? <OrderDetailPanel key={drawerId} orderId={drawerId} onChanged={queue.reload} /> : null}
          </Dialog>
        </>
      )}
    </>
  );
}

function OrderRow({ o, today, zone, active, last, onOpen }: { o: OrderSummary; today: string; zone?: string; active: boolean; last: boolean; onOpen: () => void }) {
  const status = statusOf(o);
  const flag = flagOf(o);
  const sameDay = new Date(o.pickup_starts_at).toLocaleDateString("en-US", { timeZone: zone }) === today;
  const day = sameDay ? "" : new Date(o.pickup_starts_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone });
  const late = flag?.label === "Missed pickup";
  return (
    <ButtonBase onClick={onOpen} aria-current={active ? "true" : undefined} focusRipple
      sx={{
        width: "100%", textAlign: "left", display: "grid", gridTemplateColumns: { xs: "84px minmax(0, 1fr) auto", sm: "96px minmax(0, 1fr) 72px 160px" },
        columnGap: 2, rowGap: 0.5, alignItems: "center", px: 2.5, py: 1.75, borderBottom: last ? 0 : `1px solid ${brand.line}`,
        borderLeft: `4px solid ${active ? brand.leaf : "transparent"}`, bgcolor: active ? brand.mint : "transparent",
        "&:hover": { bgcolor: active ? brand.mint : brand.cream }, "&.Mui-focusVisible": { outline: `2px solid ${brand.leaf}`, outlineOffset: -2 },
      }}>
      <Box component="span" className="tabular" sx={{ color: late ? brand.danger : "text.primary", whiteSpace: "nowrap" }}>
        {day ? <Typography component="span" variant="caption" sx={{ display: "block", fontWeight: 600, color: "inherit", lineHeight: 1.2 }}>{day}</Typography> : null}
        <Typography component="span" sx={{ fontWeight: 650, color: "inherit" }}>{timeLabel(o.pickup_starts_at, zone)}</Typography>
      </Box>
      <Box component="span" sx={{ minWidth: 0 }}>
        <Typography component="span" sx={{ display: "block", fontWeight: 650 }} className="tabular">#{o.number} · {o.customer_name ?? "Customer"}</Typography>
        <Typography component="span" variant="body2" color="text.secondary">{o.units === 1 ? "1 item" : `${o.units} items`}</Typography>
      </Box>
      <Typography component="span" className="tabular" sx={{ fontWeight: 650, textAlign: "right", display: { xs: "none", sm: "block" } }}>{money(o.amount_minor, o.currency)}</Typography>
      <Stack component="span" spacing={0.5} sx={{ alignItems: "flex-start" }}>
        <StatusChip tone={status.tone} icon={status.icon} label={status.label} />
        {flag ? (
          <Typography component="span" variant="caption" sx={{ fontWeight: 650, color: tones[flag.tone].fg, display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            {flag.icon ? <flag.icon aria-hidden sx={{ fontSize: 14 }} /> : null}{flag.label}
          </Typography>
        ) : null}
      </Stack>
    </ButtonBase>
  );
}

// ----------------------------------------------------------------------------- the selected order

function Section({ title, aside, children, tone }: { title: string; aside?: ReactNode; children: ReactNode; tone?: Tone }) {
  const id = useId();
  return (
    <Box component="section" aria-labelledby={id} sx={tone ? { bgcolor: tones[tone].bg, border: 1, borderColor: tones[tone].border, borderRadius: "14px", p: 2 } : undefined}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", mb: 1 }}>
        <Typography id={id} component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>{title}</Typography>
        {aside ? <Typography component="span" variant="body2" color="text.secondary" className="tabular">{aside}</Typography> : null}
      </Stack>
      {children}
    </Box>
  );
}

function OrderDetailPanel({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const announce = useAnnounce();
  const user = useStaff();
  const zone = user?.merchant.timezone;
  const detail = useResource((signal) => api<OrderDetail>(`/api/merchant/orders/${orderId}`, { signal }), [orderId], { pollMs: 30_000 });
  // Staff follow the shop's order feed; per-order topics are only for the customer who placed it.
  useLive([user?.merchant.id ? `shop:${user.merchant.id}:orders` : null], detail.reload);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [code, setCode] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [declineReason, setDeclineReason] = useState("");
  const codeId = useId();
  const codeHintId = useId();
  const d = detail.data;
  const manager = hasRole(user, "manager");

  async function act(kind: string, path: string, body: unknown, success: string) {
    setBusy(kind);
    setNotice(null);
    try {
      detail.setData(await api<OrderDetail>(path, { body }));
      setNotice({ tone: "success", text: success });
      announce(success);
      onChanged();
      return true;
    } catch (err) {
      const text = errorMessage(err);
      setNotice({ tone: err instanceof ApiError && err.code === "wrong_pickup_code" ? "warning" : "danger", text });
      announce(text, "assertive");
      detail.reload();
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (detail.error && !d) return <ErrorState message={errorMessage(detail.error)} onRetry={detail.reload} />;
  if (!d) return <LoadingBlock label="Loading order" lines={6} />;

  const paid = d.payment_status === "CAPTURED";
  const active = paid && ["NEW", "PACKING", "READY"].includes(d.fulfillment_status);
  const cancelOpen = d.cancel_request?.status === "requested";
  const packed = d.lines.filter((l) => l.packed).length;
  const status = statusOf(d);
  const markReady = () => act("ready", `/api/merchant/orders/${d.id}/fulfillment`, { action: "mark_ready" }, "Marked ready. The customer's pickup pass now shows Ready.");
  const contact = [
    ...(d.customer_contact.email ? [{ label: "Email", value: d.customer_contact.email }] : []),
    ...(d.customer_contact.phone ? [{ label: "Phone", value: d.customer_contact.phone }] : []),
  ];

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h3" component="h2" className="tabular">#{d.number} · {d.customer_contact.name ?? "Customer"}</Typography>
          <Typography variant="body2" color="text.secondary" className="tabular">
            Pickup {d.pickup_label} · {paid ? "paid via PayPal" : "payment not verified"} · {money(d.amount_minor, d.currency)}
          </Typography>
          {d.platform_fee ? (
            <Typography variant="body2" color="text.secondary" className="tabular">
              LastCall fee {money(d.platform_fee.fee_minor, d.platform_fee.currency)} · you keep{" "}
              <Box component="span" sx={{ fontWeight: 700, color: "text.primary" }}>{money(d.platform_fee.net_minor, d.platform_fee.currency)}</Box>
              {d.platform_fee.billed ? " · invoiced" : ""}
            </Typography>
          ) : null}
        </Box>
        <StatusChip tone={status.tone} icon={status.icon} label={status.label} size="medium" />
      </Stack>

      {notice ? (
        <Alert severity={notice.tone === "danger" ? "error" : notice.tone} role={notice.tone === "success" ? "status" : "alert"}>{notice.text}</Alert>
      ) : null}
      {!paid && d.fulfillment_status !== "CANCELLED" ? (
        <Alert severity="warning" role="note">
          <AlertTitle>Payment not verified</AlertTitle>
          Don&apos;t pack or hand off until PayPal confirms the payment. This updates by itself.
        </Alert>
      ) : null}
      {d.exception_flags.length ? (
        <Alert severity="error" role="note">
          <AlertTitle>Needs review</AlertTitle>
          {d.exception_flags.map((f) => f.replaceAll("_", " ")).join(" · ")}
        </Alert>
      ) : null}
      {d.pickup_expired && active ? (
        <Alert severity="warning" role="note">
          <AlertTitle>Missed pickup window</AlertTitle>
          Contact the customer, or cancel with a refund. It won&apos;t be marked collected by itself.
        </Alert>
      ) : null}

      {active ? (
        <Box sx={{ bgcolor: brand.mint, borderRadius: "14px", p: 2 }}>
          {d.fulfillment_status === "READY" ? (
            <Box component="form" onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (await act("handoff", `/api/merchant/orders/${d.id}/handoff`, { pickup_code: code }, `Handed off #${d.number}.`)) setCode("");
            }} sx={{ display: "grid", gap: 1 }}>
              {d.pickup_locked ? <Alert severity="error" role="note">Locked after too many wrong codes. A manager must verify.</Alert> : null}
              {/* Label above, input and button the same height, the attempts line under both on the green. */}
              <Typography component="label" htmlFor={codeId} variant="body2" sx={{ fontWeight: 650, color: brand.leafDark }}>
                Customer&apos;s pickup code
              </Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}>
                <TextField id={codeId} value={code} onChange={(e) => setCode(e.target.value)} placeholder="4-digit code"
                  slotProps={{
                    htmlInput: { inputMode: "numeric", autoComplete: "off", maxLength: 8, className: "tabular", "aria-describedby": codeHintId },
                    input: { sx: { height: 48, bgcolor: brand.paper } },
                  }}
                  sx={{
                    flex: 1, "& input": { textAlign: "center", fontSize: 20, fontWeight: 800, letterSpacing: "0.3em" },
                    "& input::placeholder": { fontSize: 15, fontWeight: 500, letterSpacing: "normal" },
                  }} />
                <Button type="submit" variant="contained" startIcon={<KeyRounded />} loading={busy === "handoff"}
                  disabled={code.replace(/\D/g, "").length < 4 || (d.pickup_locked && !manager)} sx={{ height: 48, px: 2.5, whiteSpace: "nowrap", flexShrink: 0 }}>
                  Verify code &amp; hand off
                </Button>
              </Stack>
              <Typography id={codeHintId} variant="caption" color="text.secondary">
                {d.pickup_locked ? "Manager verification required" : `${5 - d.pickup_attempts} attempts left`}
              </Typography>
            </Box>
          ) : (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} sx={{ alignItems: { sm: "center" } }}>
              <Typography sx={{ flex: 1, fontWeight: 600, color: brand.leafDark }}>
                {d.fulfillment_status === "NEW" ? "Pack the order, then mark it ready." : "Mark it ready when the bag is packed."}
              </Typography>
              {d.fulfillment_status === "NEW" ? (
                <Button variant="outlined" color="inherit" startIcon={<Inventory2Rounded />} loading={busy === "pack"} sx={{ bgcolor: brand.paper }}
                  onClick={() => act("pack", `/api/merchant/orders/${d.id}/fulfillment`, { action: "start_packing" }, "Packing started.")}>
                  Start packing
                </Button>
              ) : null}
              <Button variant="contained" startIcon={<ShoppingBagRounded />} loading={busy === "ready"} onClick={markReady}>Mark ready</Button>
            </Stack>
          )}
        </Box>
      ) : null}

      <Section title="Items" aside={d.lines.length ? (packed === d.lines.length ? "· all packed" : `· ${packed} of ${d.lines.length} packed`) : undefined}>
        <Box component="ul" sx={list}>
          {d.lines.map((line, i) => (
            <Box component="li" key={line.sku} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5, borderBottom: i === d.lines.length - 1 ? 0 : `1px solid ${brand.line}` }}>
              <FormControlLabel sx={{ flex: 1, m: 0 }}
                control={
                  <Checkbox checked={line.packed} disabled={!active || busy === "pack-list"}
                    onChange={(e) => {
                      const packedSkus = d.lines.filter((l) => (l.sku === line.sku ? e.target.checked : l.packed)).map((l) => l.sku);
                      void act("pack-list", `/api/merchant/orders/${d.id}/fulfillment`, { action: "update_packing", packed_skus: packedSkus }, `${line.name} ${e.target.checked ? "packed" : "unpacked"}.`);
                    }} />
                }
                label={<Typography component="span"><span className="tabular">{line.qty} ×</span> {line.name}</Typography>} />
              <Typography variant="body2" color="text.secondary" className="tabular">{money(line.line_total_minor, d.currency)}</Typography>
            </Box>
          ))}
        </Box>
      </Section>

      {cancelOpen ? (
        <Section title="Wants to cancel" tone="warning">
          <Typography variant="body2">
            {d.cancel_request?.reason || "No reason given"} · asked {dateTimeLabel(d.cancel_request?.requested_at, zone)}
          </Typography>
          {manager ? (
            <Stack spacing={1.5} sx={{ mt: 1.5 }}>
              <Button variant="contained" startIcon={<ReplayRounded />} loading={busy === "approve-cancel"} sx={{ alignSelf: "flex-start" }}
                onClick={() => act("approve-cancel", `/api/merchant/orders/${d.id}/refund`, { reason: "Customer cancellation approved", return_to_stock: true }, "Cancellation approved; refund requested with PayPal.")}>
                Approve &amp; refund {money(d.refundable_minor, d.currency)}
              </Button>
              <Box component="form" onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void act("decline", `/api/merchant/orders/${d.id}/cancel-request/decline`, { reason: declineReason }, "Cancellation declined.");
              }} sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "flex-start" }}>
                <TextField label="Decline reason" size="small" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} sx={{ flex: "1 1 200px", bgcolor: brand.paper }} />
                <Button type="submit" variant="outlined" color="inherit" disabled={declineReason.trim().length < 3} loading={busy === "decline"}>Decline</Button>
              </Box>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>A manager needs to review this request.</Typography>
          )}
        </Section>
      ) : null}

      {d.support.length ? (
        <Section title="Messages">
          <Stack spacing={1.5}>
            {d.support.map((s) => (
              // Keyed by draft source so the agent's draft replaces the template when it arrives.
              <SupportReply key={`${s.id}:${s.ai_draft_source}`} message={s} busy={busy === `reply-${s.id}`}
                onSend={(reply) => act(`reply-${s.id}`, `/api/merchant/support/${s.id}/reply`, { reply }, "Reply sent to the customer's pickup pass.")} />
            ))}
          </Stack>
        </Section>
      ) : null}

      {contact.length ? <InfoList items={contact} layout="row" sx={{ "& dd": { overflowWrap: "anywhere" } }} /> : null}

      <Box sx={{ borderTop: `1px solid ${brand.line}`, pt: 1 }}>
        <Accordion disableGutters elevation={0} sx={{ bgcolor: "transparent", border: 0, boxShadow: "none", borderRadius: "0 !important", "&::before": { display: "none" } }}>
          <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
            <Typography component="span" sx={{ fontWeight: 650, color: brand.leafDark }}>History and PayPal records</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0 }}>
            <Records d={d} zone={zone} />
          </AccordionDetails>
        </Accordion>
        {manager && paid && d.refundable_minor > 0 && !cancelOpen ? (
          <Accordion disableGutters elevation={0} sx={{ bgcolor: "transparent", border: 0, boxShadow: "none", borderRadius: "0 !important", "&::before": { display: "none" } }}>
            <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
              <Typography component="span" sx={{ fontWeight: 650, color: tones.danger.fg }}>Refund…</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0 }}>
              <Box component="form" onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void act("refund", `/api/merchant/orders/${d.id}/refund`, { reason: refundReason, return_to_stock: restock }, "Refund requested with PayPal. It shows complete only after PayPal confirms.");
              }} sx={{ display: "grid", gap: 1.5 }}>
                <Typography variant="body2">
                  Refunds the full payment, <strong className="tabular">{money(d.refundable_minor, d.currency)}</strong>, through PayPal.
                </Typography>
                <TextField label="Reason" required fullWidth size="small" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
                {d.fulfillment_status !== "PICKED_UP" ? (
                  <FormControlLabel control={<Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} />} label="Put the items back on sale" />
                ) : null}
                <Button type="submit" variant="contained" color="error" startIcon={<ReplayRounded />} loading={busy === "refund"}
                  disabled={refundReason.trim().length < 3} sx={{ justifySelf: "start" }}>
                  Refund {money(d.refundable_minor, d.currency)}
                </Button>
              </Box>
            </AccordionDetails>
          </Accordion>
        ) : null}
      </Box>
    </Stack>
  );
}

/** Refunds, PayPal payment records and the order's timeline: kept for disputes, folded away day to day. */
function Records({ d, zone }: { d: OrderDetail; zone?: string }) {
  return (
    <Stack spacing={2}>
      {d.refunds.length ? (
        <Box>
          <Typography variant="overline" component="h4" color="text.secondary">Refunds</Typography>
          <Box component="ul" sx={{ ...list, display: "grid", gap: 1 }}>
            {d.refunds.map((r) => (
              <Box component="li" key={r.id} sx={{ ...surface.insetSm, borderRadius: "12px", p: 1.5 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                  <Typography sx={{ fontWeight: 700 }} className="tabular">{money(r.amount_minor, d.currency)}</Typography>
                  <StatusChip tone={r.state === "COMPLETED" ? "success" : r.state === "FAILED" ? "danger" : "warning"} icon={ReplayRounded}
                    label={r.state.replaceAll("_", " ").toLowerCase()} sx={{ textTransform: "capitalize" }} />
                </Stack>
                <Typography variant="body2" sx={{ mt: 0.5 }}>{r.reason}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>PayPal {r.paypal_refund_id ?? "pending id"}</Typography>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}
      <Box>
        <Typography variant="overline" component="h4" color="text.secondary">Payments</Typography>
        <Box component="ul" sx={{ ...list, display: "grid", gap: 1 }}>
          {d.payments.map((p) => (
            <Box component="li" key={p.id} sx={{ ...surface.insetSm, borderRadius: "12px", p: 1.5 }}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <PaymentPill status={p.state} />
                <Typography sx={{ fontWeight: 700 }} className="tabular">{money(p.amount_minor, d.currency)}</Typography>
                <Chip size="small" label={p.environment} />
              </Stack>
              <InfoList layout="row" sx={{ mt: 1, "& dd": { fontFamily: "monospace", fontWeight: 500, fontSize: "0.78rem", overflowWrap: "anywhere" } }}
                items={[
                  { label: "PayPal order", value: p.paypal_order_id ?? "—" },
                  { label: "Capture", value: p.capture_id ?? "—" },
                  { label: "Request", value: p.request_id },
                  { label: "Reconciled", value: `${p.reconcile_count}×` },
                ]} />
            </Box>
          ))}
        </Box>
      </Box>
      <Box>
        <Typography variant="overline" component="h4" color="text.secondary">Timeline</Typography>
        <Box component="ol" sx={{ ...list, position: "relative", "&::before": { content: '""', position: "absolute", left: 5, top: 8, bottom: 8, width: 2, bgcolor: brand.line } }}>
          {d.timeline.map((t, i) => (
            <Box component="li" key={`${t.at}-${i}`} sx={{ position: "relative", pl: 3, pb: 1.25 }}>
              <Box aria-hidden sx={{ position: "absolute", left: 1, top: 6, width: 10, height: 10, borderRadius: "50%", bgcolor: brand.leaf, boxShadow: `0 0 0 3px ${brand.paper}` }} />
              <Typography variant="body2" sx={{ fontWeight: 650, "&::first-letter": { textTransform: "uppercase" } }}>{t.action.replaceAll("_", " ")}</Typography>
              <Typography variant="caption" color="text.secondary">{dateTimeLabel(t.at, zone)} · {t.actor}</Typography>
            </Box>
          ))}
        </Box>
      </Box>
    </Stack>
  );
}

function SupportReply({ message, onSend, busy }: { message: OrderDetail["support"][number]; onSend: (reply: string) => Promise<boolean>; busy: boolean }) {
  const [reply, setReply] = useState(message.staff_reply ?? message.ai_draft);
  return (
    <Box sx={{ ...surface.inset, borderRadius: "16px", p: 1.75 }}>
      <Box sx={{ ...surface.raisedSm, borderRadius: "14px", borderTopLeftRadius: "4px", px: 1.5, py: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>Customer</Typography>
        <Typography variant="body2">{message.message}</Typography>
      </Box>
      {message.status === "replied" ? (
        <Box sx={{ bgcolor: brand.mint, borderRadius: "14px", borderTopRightRadius: "4px", px: 1.5, py: 1, mt: 1.25, ml: 3 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: brand.leafDark }}>Replied by {message.replied_by}</Typography>
          <Typography variant="body2">{message.staff_reply}</Typography>
        </Box>
      ) : (
        <Box component="form" onSubmit={(e: FormEvent) => { e.preventDefault(); void onSend(reply); }} sx={{ mt: 1.5 }}>
          {message.ai_draft_source === "rules" ? (
            <StatusChip tone="neutral" icon={DescriptionRounded} label="Template draft" />
          ) : (
            <StatusChip tone="info" icon={AutoAwesomeRounded} label={message.ai_checks.length ? "AI draft · checked with PayPal" : "AI draft · review before sending"} />
          )}
          {message.ai_checks.length ? (
            <Box component="dl" aria-label="What PayPal reported" sx={{ m: 0, mt: 1.25, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 1.5, rowGap: 0.5 }}>
              {message.ai_checks.map((c) => (
                <Fragment key={c.label}>
                  <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.5, fontWeight: 700 }}>
                    <PaymentsRounded aria-hidden sx={{ fontSize: 15, color: brand.leaf }} />
                    {c.label}
                  </Typography>
                  <Typography component="dd" variant="caption" sx={{ m: 0 }}>{c.value}</Typography>
                </Fragment>
              ))}
            </Box>
          ) : null}
          <TextField label="Reply" multiline minRows={3} fullWidth value={reply} onChange={(e) => setReply(e.target.value)}
            helperText="Drafts can't cancel, refund or change the order." sx={{ mt: 1.5 }} />
          <Button type="submit" size="small" variant="contained" startIcon={<SendRounded />} loading={busy} disabled={!reply.trim()} sx={{ mt: 1 }}>
            Send reply
          </Button>
        </Box>
      )}
    </Box>
  );
}
