"use client";

import {
  AutoAwesomeRounded,
  ChatBubbleOutlineRounded,
  DescriptionRounded,
  EmailRounded,
  ExpandMoreRounded,
  GppMaybeRounded,
  HourglassTopRounded,
  Inventory2Rounded,
  KeyRounded,
  PersonRounded,
  PhoneRounded,
  ReceiptLongRounded,
  ReplayRounded,
  ScheduleRounded,
  SendRounded,
  ShoppingBagRounded,
  SyncRounded,
  TaskAltRounded,
  TimelineRounded,
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
  Card,
  CardActionArea,
  Checkbox,
  Chip,
  FormControlLabel,
  Grid,
  LinearProgress,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { Dialog } from "@/components/dialog";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { FulfillmentPill, PaymentPill, RefundPill } from "@/components/status-pills";
import { ErrorState, FactChip, IconBadge, InfoList, LoadingBlock, PageHeader, StatusChip, brand, surface, shadows, tones, type Icon, type Tone } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ago, dateTimeLabel, money } from "@/lib/format";
import type { OrderDetail, OrderSummary, Slot } from "@/lib/types";
import { useLive } from "@/lib/use-live";
import { useResource } from "@/lib/use-api";

type Queue = { groups: Record<string, OrderSummary[]>; slots: Slot[]; as_of: string };
const COLUMNS: { key: string; label: string; hint: string; icon: Icon; tone: Tone }[] = [
  { key: "awaiting_pickup", label: "Awaiting pickup", hint: "Paid, not started", icon: HourglassTopRounded, tone: "info" },
  { key: "in_progress", label: "In progress", hint: "Packing or ready", icon: Inventory2Rounded, tone: "success" },
  { key: "payment_pending", label: "Payment pending", hint: "Don't pack yet", icon: SyncRounded, tone: "warning" },
  { key: "complete", label: "Complete", hint: "Picked up or cancelled", icon: TaskAltRounded, tone: "neutral" },
];

const list = { listStyle: "none", m: 0, p: 0 } as const;

export function Orders() {
  const params = useSearchParams();
  const router = useRouter();
  const shopName = useStaff()?.merchant?.name;
  const [slot, setSlot] = useState("");
  const queue = useResource((signal) => api<Queue>(`/api/merchant/orders${slot ? `?slot_id=${slot}` : ""}`, { signal }), [slot], { pollMs: 30_000 });
  const shopId = useStaff()?.merchant.id;
  useLive([shopId ? `shop:${shopId}:orders` : null], queue.reload);
  const openId = params.get("order");
  // Keep the last order rendered while the drawer slides closed.
  const [drawerId, setDrawerId] = useState(openId);
  if (openId && openId !== drawerId) setDrawerId(openId);
  const q = queue.data;

  function open(id: string | null) {
    router.replace(id ? `/merchant/orders?order=${id}` : "/merchant/orders", { scroll: false });
  }

  const subtitle = "Hand off only paid orders with a matching pickup code.";
  if (queue.error && !q) {
    return (
      <>
        <PageHeader eyebrow={shopName} title="Pickup orders" subtitle={subtitle} />
        <ErrorState title="Couldn't load orders" message={errorMessage(queue.error)} onRetry={queue.reload} />
      </>
    );
  }
  if (!q) {
    return (
      <>
        <PageHeader eyebrow={shopName} title="Pickup orders" subtitle={subtitle} />
        <LoadingBlock label="Loading orders" slow={queue.slow} lines={8} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={shopName}
        title="Pickup orders"
        subtitle={subtitle}
        chips={<FactChip icon={SyncRounded} label={`Updated ${ago(q.as_of)}`} />}
        actions={
          <TextField
            select
            id="slot-filter"
            label="Pickup slot"
            size="small"
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
            sx={{ width: { xs: "100%", sm: 300 } }}
          >
            <option value="">All slots</option>
            {q.slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.booked}/{s.capacity})
              </option>
            ))}
          </TextField>
        }
      />

      <Grid container spacing={2.5}>
        {COLUMNS.map((col) => {
          const orders = q.groups[col.key] ?? [];
          return (
            <Grid key={col.key} size={{ xs: 12, md: 6, xl: 3 }}>
              {/* Each column is a well pressed into the page; its order cards sit raised inside it. */}
              <Box component="section" aria-labelledby={`col-${col.key}`} sx={{ ...surface.inset, height: "100%", borderRadius: "16px", p: 1.75 }}>
                <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", px: 0.5, pt: 0.25, pb: 2 }}>
                  <IconBadge tone={col.tone} size={32}>
                    <col.icon />
                  </IconBadge>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography id={`col-${col.key}`} component="h2" variant="h5" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
                      {col.label}
                      <Chip component="span" size="small" label={orders.length} className="tabular" sx={{ ...surface.raisedSm, fontWeight: 700, minWidth: 30 }} />
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {col.hint}
                    </Typography>
                  </Box>
                </Stack>
                <Box component="ul" sx={{ ...list, display: "grid", gap: 1.5 }}>
                  {orders.map((o) => (
                    <li key={o.id}>
                      <OrderCard order={o} onOpen={() => open(o.id)} />
                    </li>
                  ))}
                  {!orders.length ? (
                    <Box component="li" sx={{ py: 3, textAlign: "center" }}>
                      <Typography variant="body2" color="text.secondary">
                        No orders
                      </Typography>
                    </Box>
                  ) : null}
                </Box>
              </Box>
            </Grid>
          );
        })}
      </Grid>

      <Dialog open={!!openId} onClose={() => open(null)} side title="Order details">
        {drawerId ? <OrderDrawer key={drawerId} orderId={drawerId} onChanged={queue.reload} /> : null}
      </Dialog>
    </>
  );
}

function OrderCard({ order: o, onOpen }: { order: OrderSummary; onOpen: () => void }) {
  return (
    <Card sx={{ boxShadow: shadows.raisedSm, borderRadius: "18px" }}>
      <CardActionArea onClick={onOpen} sx={{ p: 1.75, borderRadius: "18px" }}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <Typography component="span" className="tabular" sx={{ fontWeight: 750, fontSize: "1.02rem" }}>
            #{o.number}
          </Typography>
          <Typography component="span" variant="body2" sx={{ fontWeight: 650, display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            <ScheduleRounded aria-hidden sx={{ fontSize: 16, color: brand.muted }} />
            {o.pickup_label}
          </Typography>
        </Stack>
        <Typography component="span" variant="body2" color="text.secondary" className="tabular" sx={{ display: "block", mt: 0.25 }}>
          {o.customer_name ?? "Customer"} · {o.units} items · {money(o.amount_minor, o.currency)}
        </Typography>
        <Stack component="span" direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", mt: 1.25 }}>
          <PaymentPill status={o.payment_status} />
          <FulfillmentPill status={o.fulfillment_status} />
          <RefundPill status={o.refund_status} />
          {o.cancel_requested ? <StatusChip tone="warning" icon={ReplayRounded} label="Cancel requested" /> : null}
          {o.open_support ? <StatusChip tone="info" icon={ChatBubbleOutlineRounded} label={`${o.open_support} message${o.open_support === 1 ? "" : "s"}`} /> : null}
          {o.pickup_expired ? <StatusChip tone="danger" icon={WarningAmberRounded} label="Missed pickup" /> : null}
          {o.exception_flags.length ? <StatusChip tone="danger" icon={GppMaybeRounded} label="Needs review" /> : null}
        </Stack>
      </CardActionArea>
    </Card>
  );
}

/** Raised section inside the drawer body. A tone tints it (status only), like an Alert. */
function Block({ title, icon, action, tone, children }: { title: string; icon?: ReactNode; action?: ReactNode; tone?: Tone; children: ReactNode }) {
  const id = useId();
  return (
    <Box
      component="section"
      aria-labelledby={id}
      sx={{ ...(tone ? { bgcolor: tones[tone].bg, boxShadow: shadows.insetSm } : surface.raised), borderRadius: "16px", p: 2.25 }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
        {icon ? <Box sx={{ display: "flex", color: tone ? tones[tone].fg : brand.leaf, "& svg": { fontSize: 20 } }}>{icon}</Box> : null}
        <Typography id={id} component="h3" variant="h5" sx={{ flex: 1 }}>
          {title}
        </Typography>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

const FULFILLMENT_STEPS = [
  { status: "NEW", label: "New" },
  { status: "PACKING", label: "Packing" },
  { status: "READY", label: "Ready" },
  { status: "PICKED_UP", label: "Picked up" },
];

function FulfillmentProgress({ status }: { status: string }) {
  const index = FULFILLMENT_STEPS.findIndex((s) => s.status === status);
  if (index < 0) return null;
  const active = status === "PICKED_UP" ? FULFILLMENT_STEPS.length : index;
  return (
    <Stepper activeStep={active} alternativeLabel component="ol" aria-label="Fulfillment progress" sx={{ ...list, mt: 2.5 }}>
      {FULFILLMENT_STEPS.map((step, i) => (
        <Step key={step.status} component="li" aria-current={i === active ? "step" : undefined}>
          <StepLabel>
            {step.label}
            {i < active ? <span className="sr-only"> (done)</span> : null}
          </StepLabel>
        </Step>
      ))}
    </Stepper>
  );
}

function OrderDrawer({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const announce = useAnnounce();
  const user = useStaff();
  const zone = user?.merchant.timezone;
  const detail = useResource((signal) => api<OrderDetail>(`/api/merchant/orders/${orderId}`, { signal }), [orderId], { pollMs: 30_000 });
  useLive([`order:${orderId}`], detail.reload);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [code, setCode] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [declineReason, setDeclineReason] = useState("");
  const codeId = useId();
  const d = detail.data;
  const manager = hasRole(user, "manager");

  async function act(kind: string, path: string, body: unknown, success: string) {
    setBusy(kind);
    setNotice(null);
    try {
      const next = await api<OrderDetail>(path, { body });
      detail.setData(next);
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
  const markReady = () => act("ready", `/api/merchant/orders/${d.id}/fulfillment`, { action: "mark_ready" }, "Marked ready. The customer's pickup pass now shows Ready.");
  const contact = [
    { label: "Pickup", value: d.pickup_label, icon: ScheduleRounded },
    { label: "Items", value: `${d.units}`, icon: ShoppingBagRounded },
    ...(d.customer_contact.email ? [{ label: "Email", value: d.customer_contact.email, icon: EmailRounded }] : []),
    ...(d.customer_contact.phone ? [{ label: "Phone", value: d.customer_contact.phone, icon: PhoneRounded }] : []),
  ];

  return (
    <Stack spacing={2.5}>
      <Box sx={{ ...surface.raised, borderRadius: "16px", p: 2.25 }}>
        <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h2" component="p" className="tabular">
              #{d.number}
            </Typography>
            <Typography sx={{ fontWeight: 650, display: "flex", alignItems: "center", gap: 0.5, mt: 0.25 }}>
              <PersonRounded aria-hidden sx={{ fontSize: 18, color: brand.muted }} />
              {d.customer_contact.name ?? "Customer"}
            </Typography>
          </Box>
          <Typography variant="h3" component="p" className="tabular" sx={{ whiteSpace: "nowrap" }}>
            {money(d.amount_minor, d.currency)}
          </Typography>
        </Stack>
        <Box component="dl" sx={{ m: 0, mt: 2, display: "flex", flexWrap: "wrap", columnGap: 3, rowGap: 1.5 }}>
          <div>
            <Typography component="dt" variant="caption" color="text.secondary" sx={{ fontWeight: 650 }}>
              Payment
            </Typography>
            <Box component="dd" sx={{ m: 0, mt: 0.25 }}>
              <PaymentPill status={d.payment_status} />
            </Box>
          </div>
          <div>
            <Typography component="dt" variant="caption" color="text.secondary" sx={{ fontWeight: 650 }}>
              Fulfillment
            </Typography>
            <Box component="dd" sx={{ m: 0, mt: 0.25 }}>
              <FulfillmentPill status={d.fulfillment_status} />
            </Box>
          </div>
          {d.refund_status !== "NONE" ? (
            <div>
              <Typography component="dt" variant="caption" color="text.secondary" sx={{ fontWeight: 650 }}>
                Refund
              </Typography>
              <Box component="dd" sx={{ m: 0, mt: 0.25 }}>
                <RefundPill status={d.refund_status} />
              </Box>
            </div>
          ) : null}
        </Box>
        {paid ? <FulfillmentProgress status={d.fulfillment_status} /> : null}
        <InfoList items={contact} columns={2} sx={{ mt: 3, "& dd": { overflowWrap: "anywhere" } }} />
      </Box>

      {notice ? (
        <Alert severity={notice.tone === "danger" ? "error" : notice.tone} role={notice.tone === "success" ? "status" : "alert"}>
          {notice.text}
        </Alert>
      ) : null}
      {!paid && d.fulfillment_status !== "CANCELLED" ? (
        <Alert severity="warning" role="note">
          <AlertTitle>Payment not verified</AlertTitle>
          Don&apos;t pack or hand off until PayPal confirms the capture. This updates automatically.
        </Alert>
      ) : null}
      {d.exception_flags.length ? (
        <Alert severity="error" role="note">
          <AlertTitle>Needs review</AlertTitle>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", mt: 0.5 }}>
            {d.exception_flags.map((flag) => (
              <Chip key={flag} size="small" label={flag.replaceAll("_", " ")} />
            ))}
          </Stack>
        </Alert>
      ) : null}
      {d.pickup_expired && active ? (
        <Alert severity="warning" role="note">
          <AlertTitle>Missed pickup window</AlertTitle>
          Extend it, cancel with a refund, or contact the customer. It won&apos;t be marked collected automatically.
        </Alert>
      ) : null}

      {active ? (
        <Block title="Next step" icon={<TaskAltRounded />}>
          {d.fulfillment_status === "NEW" ? (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}>
              <Button
                variant="contained"
                startIcon={<Inventory2Rounded />}
                loading={busy === "pack"}
                onClick={() => act("pack", `/api/merchant/orders/${d.id}/fulfillment`, { action: "start_packing" }, "Packing started.")}
              >
                Start packing
              </Button>
              <Button variant="outlined" color="inherit" startIcon={<ShoppingBagRounded />} loading={busy === "ready"} onClick={markReady}>
                Mark ready
              </Button>
            </Stack>
          ) : null}
          {d.fulfillment_status === "PACKING" ? (
            <Button variant="contained" startIcon={<ShoppingBagRounded />} loading={busy === "ready"} onClick={markReady}>
              Mark ready
            </Button>
          ) : null}
          {d.fulfillment_status === "READY" ? (
            <Box
              component="form"
              onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                if (await act("handoff", `/api/merchant/orders/${d.id}/handoff`, { pickup_code: code }, `Handed off #${d.number}.`)) setCode("");
              }}
              sx={{ ...surface.inset, borderRadius: "18px", p: 2, display: "flex", flexWrap: "wrap", gap: 2, alignItems: "flex-start" }}
            >
              {d.pickup_locked ? (
                <Alert severity="error" role="note" sx={{ width: "100%" }}>
                  Locked after too many wrong codes. A manager must verify.
                </Alert>
              ) : null}
              <TextField
                id={codeId}
                label="Customer's pickup code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                helperText={d.pickup_locked ? "Manager verification required" : `${5 - d.pickup_attempts} attempts left`}
                slotProps={{ htmlInput: { inputMode: "numeric", autoComplete: "off", maxLength: 8, className: "tabular" } }}
                sx={{ width: 230, "& input": { textAlign: "center", fontSize: 26, fontWeight: 800, letterSpacing: "0.3em", py: 1.25 } }}
              />
              <Button
                type="submit"
                variant="contained"
                size="large"
                startIcon={<KeyRounded />}
                loading={busy === "handoff"}
                disabled={code.replace(/\D/g, "").length < 4 || (d.pickup_locked && !manager)}
                sx={{ mt: 0.5 }}
              >
                Verify code &amp; hand off
              </Button>
            </Box>
          ) : null}
        </Block>
      ) : null}

      <Block
        title="Packing checklist"
        icon={<Inventory2Rounded />}
        action={
          <Typography variant="body2" color="text.secondary" className="tabular" sx={{ fontWeight: 650 }}>
            {packed}/{d.lines.length} packed
          </Typography>
        }
      >
        <LinearProgress variant="determinate" value={d.lines.length ? (packed / d.lines.length) * 100 : 0} aria-label={`${packed} of ${d.lines.length} lines packed`} sx={{ mb: 1.5 }} />
        <Box component="ul" sx={{ ...list, display: "grid", gap: 1.25 }}>
          {d.lines.map((line) => (
            <li key={line.sku}>
              {/* Packed lines look pressed in. */}
              <FormControlLabel
                sx={{ ...(line.packed ? { ...surface.pressed, color: brand.leafDark } : surface.raisedSm), m: 0, width: "100%", minHeight: 48, pr: 1.5, borderRadius: "14px" }}
                control={
                  <Checkbox
                    checked={line.packed}
                    disabled={!active || busy === "pack-list"}
                    onChange={(e) => {
                      const packedSkus = d.lines.filter((l) => (l.sku === line.sku ? e.target.checked : l.packed)).map((l) => l.sku);
                      void act("pack-list", `/api/merchant/orders/${d.id}/fulfillment`, { action: "update_packing", packed_skus: packedSkus }, `${line.name} ${e.target.checked ? "packed" : "unpacked"}.`);
                    }}
                  />
                }
                label={
                  <Typography component="span" sx={{ fontWeight: 650 }}>
                    <span className="tabular">{line.qty} ×</span> {line.name}
                  </Typography>
                }
              />
            </li>
          ))}
        </Box>
      </Block>

      {cancelOpen ? (
        <Block title="Cancellation requested" icon={<ReplayRounded />} tone="warning">
          <InfoList
            layout="row"
            items={[
              { label: "Reason", value: d.cancel_request?.reason || "None given" },
              { label: "Requested", value: dateTimeLabel(d.cancel_request?.requested_at, zone) },
            ]}
          />
          {manager ? (
            <Stack spacing={2} sx={{ mt: 2 }}>
              <Button
                variant="contained"
                startIcon={<ReplayRounded />}
                loading={busy === "approve-cancel"}
                onClick={() => act("approve-cancel", `/api/merchant/orders/${d.id}/refund`, { reason: "Customer cancellation approved", return_to_stock: true }, "Cancellation approved; refund requested with PayPal.")}
                sx={{ alignSelf: "flex-start" }}
              >
                Approve &amp; refund {money(d.refundable_minor, d.currency)}
              </Button>
              <Box
                component="form"
                onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  void act("decline", `/api/merchant/orders/${d.id}/cancel-request/decline`, { reason: declineReason }, "Cancellation declined.");
                }}
                sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "flex-start" }}
              >
                <TextField label="Decline reason" size="small" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} sx={{ flex: "1 1 220px" }} />
                <Button type="submit" variant="outlined" color="inherit" disabled={declineReason.trim().length < 3} loading={busy === "decline"}>
                  Decline
                </Button>
              </Box>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              A manager needs to review this request.
            </Typography>
          )}
        </Block>
      ) : null}

      {manager && paid && d.refundable_minor > 0 && !cancelOpen ? (
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <ReplayRounded aria-hidden sx={{ fontSize: 20, color: tones.danger.fg }} />
            <Typography component="span" sx={{ fontWeight: 700 }}>
              Cancel &amp; refund
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box
              component="form"
              onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                void act("refund", `/api/merchant/orders/${d.id}/refund`, { reason: refundReason, return_to_stock: restock }, "Refund requested with PayPal. It shows complete only after PayPal confirms.");
              }}
              sx={{ display: "grid", gap: 2 }}
            >
              <Typography variant="body2">
                Refunds the full captured amount, <strong className="tabular">{money(d.refundable_minor, d.currency)}</strong>, through PayPal.
              </Typography>
              <TextField label="Reason" required fullWidth value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
              {d.fulfillment_status !== "PICKED_UP" ? (
                <FormControlLabel control={<Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} />} label="Return items to sellable stock" />
              ) : null}
              <Button type="submit" variant="contained" color="error" startIcon={<ReplayRounded />} loading={busy === "refund"} disabled={refundReason.trim().length < 3} sx={{ justifySelf: "start" }}>
                Refund {money(d.refundable_minor, d.currency)}
              </Button>
            </Box>
          </AccordionDetails>
        </Accordion>
      ) : null}

      {d.support.length ? (
        <Block title="Customer messages" icon={<ChatBubbleOutlineRounded />}>
          <Stack spacing={1.5}>
            {d.support.map((s) => (
              <SupportReply
                key={s.id}
                message={s}
                onSend={(reply) => act(`reply-${s.id}`, `/api/merchant/support/${s.id}/reply`, { reply }, "Reply sent to the customer's pickup pass.")}
                busy={busy === `reply-${s.id}`}
              />
            ))}
          </Stack>
        </Block>
      ) : null}

      {d.refunds.length ? (
        <Block title="Refunds" icon={<ReplayRounded />}>
          <Box component="ul" sx={{ ...list, display: "grid", gap: 1.25 }}>
            {d.refunds.map((r) => {
              const tone: Tone = r.state === "COMPLETED" ? "success" : r.state === "FAILED" ? "danger" : "warning";
              return (
                <Box component="li" key={r.id} sx={{ ...surface.insetSm, borderRadius: "16px", p: 1.75 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                    <Typography sx={{ fontWeight: 750 }} className="tabular">
                      {money(r.amount_minor, d.currency)}
                    </Typography>
                    <StatusChip tone={tone} icon={ReplayRounded} label={r.state.replaceAll("_", " ").toLowerCase()} sx={{ textTransform: "capitalize" }} />
                  </Stack>
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    {r.reason}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
                    PayPal {r.paypal_refund_id ?? "pending id"}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        </Block>
      ) : null}

      <Box>
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <ReceiptLongRounded aria-hidden sx={{ fontSize: 20, color: brand.leaf }} />
            <Typography component="span" sx={{ fontWeight: 700 }}>
              Payment records
            </Typography>
            <Chip component="span" size="small" label={d.payments.length} className="tabular" sx={{ fontWeight: 700 }} />
          </AccordionSummary>
          <AccordionDetails>
            <Box component="ul" sx={{ ...list, display: "grid", gap: 1.5 }}>
              {d.payments.map((p) => (
                <Box component="li" key={p.id} sx={{ ...surface.insetSm, borderRadius: "16px", p: 1.75 }}>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                    <PaymentPill status={p.state} />
                    <Typography sx={{ fontWeight: 750 }} className="tabular">
                      {money(p.amount_minor, d.currency)}
                    </Typography>
                    <Chip size="small" label={p.environment} />
                  </Stack>
                  <InfoList
                    layout="row"
                    sx={{ mt: 1.25, "& dd": { fontFamily: "monospace", fontWeight: 500, fontSize: "0.78rem", overflowWrap: "anywhere" } }}
                    items={[
                      { label: "PayPal order", value: p.paypal_order_id ?? "—" },
                      { label: "Capture", value: p.capture_id ?? "—" },
                      { label: "Request", value: p.request_id },
                      { label: "Capture request", value: p.capture_request_id ?? "—" },
                      { label: "Reconciled", value: `${p.reconcile_count}×` },
                    ]}
                  />
                </Box>
              ))}
            </Box>
          </AccordionDetails>
        </Accordion>
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <TimelineRounded aria-hidden sx={{ fontSize: 20, color: brand.leaf }} />
            <Typography component="span" sx={{ fontWeight: 700 }}>
              Timeline
            </Typography>
            <Chip component="span" size="small" label={d.timeline.length} className="tabular" sx={{ fontWeight: 700 }} />
          </AccordionSummary>
          <AccordionDetails>
            <Box
              component="ol"
              sx={{ ...list, position: "relative", "&::before": { content: '""', position: "absolute", left: 5, top: 8, bottom: 8, width: 2, bgcolor: brand.line } }}
            >
              {d.timeline.map((t, i) => (
                <Box component="li" key={`${t.at}-${i}`} sx={{ position: "relative", pl: 3, pb: 1.25 }}>
                  <Box aria-hidden sx={{ position: "absolute", left: 1, top: 6, width: 10, height: 10, borderRadius: "50%", bgcolor: brand.leaf, boxShadow: `0 0 0 3px ${surface.base}` }} />
                  <Typography variant="body2" sx={{ fontWeight: 650, "&::first-letter": { textTransform: "uppercase" } }}>
                    {t.action.replaceAll("_", " ")}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {dateTimeLabel(t.at, zone)} · {t.actor}
                  </Typography>
                </Box>
              ))}
            </Box>
          </AccordionDetails>
        </Accordion>
      </Box>
    </Stack>
  );
}

function SupportReply({ message, onSend, busy }: { message: OrderDetail["support"][number]; onSend: (reply: string) => Promise<boolean>; busy: boolean }) {
  const [reply, setReply] = useState(message.staff_reply ?? message.ai_draft);
  return (
    <Box sx={{ ...surface.inset, borderRadius: "18px", p: 1.75 }}>
      <Box sx={{ ...surface.raisedSm, borderRadius: "14px", borderTopLeftRadius: "4px", px: 1.5, py: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
          Customer
        </Typography>
        <Typography variant="body2">{message.message}</Typography>
      </Box>
      {message.status === "replied" ? (
        <Box sx={{ bgcolor: brand.mint, borderRadius: "14px", borderTopRightRadius: "4px", px: 1.5, py: 1, mt: 1.25, ml: 3 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: brand.leafDark }}>
            Replied by {message.replied_by}
          </Typography>
          <Typography variant="body2">{message.staff_reply}</Typography>
        </Box>
      ) : (
        <Box
          component="form"
          onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            void onSend(reply);
          }}
          sx={{ mt: 1.5 }}
        >
          {message.ai_draft_source === "ai" ? (
            <StatusChip tone="info" icon={AutoAwesomeRounded} label="AI draft · review before sending" />
          ) : (
            <StatusChip tone="neutral" icon={DescriptionRounded} label="Template draft" />
          )}
          <TextField
            label="Reply"
            multiline
            minRows={3}
            fullWidth
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            helperText="Drafts can't cancel, refund or change the order."
            sx={{ mt: 1.5 }}
          />
          <Button type="submit" size="small" variant="contained" startIcon={<SendRounded />} loading={busy} disabled={!reply.trim()} sx={{ mt: 1 }}>
            Send reply
          </Button>
        </Box>
      )}
    </Box>
  );
}
