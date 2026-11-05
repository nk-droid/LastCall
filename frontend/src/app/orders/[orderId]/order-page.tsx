"use client";

import {
  ArrowBackRounded,
  BlockRounded,
  CheckCircleRounded,
  ErrorRounded,
  EventBusyRounded,
  ExpandMoreRounded,
  HistoryRounded,
  HourglassTopRounded,
  InfoOutlined,
  LocationOnRounded,
  MailRounded,
  OpenInNewRounded,
  PaymentsRounded,
  PhoneRounded,
  QrCode2Rounded,
  ReceiptLongRounded,
  ReplayRounded,
  ScheduleRounded,
  SendRounded,
  ShoppingBagRounded,
  SupportAgentRounded,
  TaskAltRounded,
  TimerOffRounded,
  VerifiedRounded,
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
  CardContent,
  CircularProgress,
  Grid,
  LinearProgress,
  Link,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { PriceBreakdown } from "@/components/commerce";
import { ProductImage } from "@/components/product-image";
import { PageShell } from "@/components/site";
import { FulfillmentPill, RefundPill } from "@/components/status-pills";
import { ErrorState, InfoList, LoadingBlock, SectionCard, StatusChip, brand, surface, shadows, tones, type Icon, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { orderMemory, useRememberedOrders } from "@/lib/flow";
import { PAYMENT_STATUS_LABEL, dateTimeLabel, money } from "@/lib/format";
import type { OrderView, QuoteLine } from "@/lib/types";
import { useLive } from "@/lib/use-live";
import { useResource } from "@/lib/use-api";

const PENDING_PAYMENT = ["CAPTURE_REQUESTED", "OUTCOME_UNKNOWN", "CAPTURE_PENDING"];
const PENDING_REFUND = ["REQUESTED", "PENDING", "OUTCOME_UNKNOWN"];
const REFUND_LABEL: Record<string, string> = {
  REQUESTED: "Refund requested",
  PENDING: "Refund pending at PayPal",
  OUTCOME_UNKNOWN: "Confirming refund with PayPal",
  COMPLETED: "Refunded (PayPal confirmed)",
  FAILED: "Refund failed; the shop will follow up",
};

const STATUS_ICON: Record<string, Icon> = {
  confirmed: CheckCircleRounded,
  ready: ShoppingBagRounded,
  picked_up: TaskAltRounded,
  awaiting_payment: HourglassTopRounded,
  payment_failed: ErrorRounded,
  expired: TimerOffRounded,
  cancelled: BlockRounded,
  refund_pending: ReplayRounded,
  refunded: ReplayRounded,
};

const PROGRESS = ["Paid", "Packing", "Ready", "Picked up"] as const;

/** Where the order is in Paid → Packing → Ready → Picked up (null when it left that path). */
function progressOf(o: OrderView): { active: number; note?: string } | null {
  if (o.fulfillment_status === "CANCELLED" || ["CAPTURE_FAILED", "EXPIRED"].includes(o.payment_status)) return null;
  if (o.payment_status !== "CAPTURED") return PENDING_PAYMENT.includes(o.payment_status) ? { active: 0, note: "Confirming" } : null;
  if (o.fulfillment_status === "PICKED_UP") return { active: 4 };
  if (o.fulfillment_status === "READY") return { active: 3, note: "Waiting for you" };
  return { active: 1, note: o.fulfillment_status === "PACKING" ? "In progress" : "Up next" };
}

export function OrderPage({ orderId }: { orderId: string }) {
  const params = useSearchParams();
  const announce = useAnnounce();
  const remembered = useRememberedOrders();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const lastStatus = useRef<string | null>(null);

  // The link token (from the confirmation URL or this device's memory) lets the order open anywhere.
  const token = params.get("t") ?? remembered?.find((r) => r.id === orderId)?.token ?? null;
  const headers = token ? { "X-Order-Token": token } : undefined;
  const order = useResource(
    (signal) => api<OrderView>(`/api/orders/${orderId}${token ? `?t=${encodeURIComponent(token)}` : ""}`, { signal }),
    [orderId, token],
    {
      enabled: remembered !== null,
      pollMs: (data) =>
        data && (PENDING_PAYMENT.includes(data.payment_status) || PENDING_REFUND.includes(data.refund_status)) ? 3000 : 15000,
    },
  );
  const o = order.data;
  const zone = o?.merchant.timezone;
  // Payment, packing, ready and refund changes show up the moment staff or PayPal make them.
  useLive([remembered !== null ? `order:${orderId}` : null], order.reload, token);

  useEffect(() => {
    if (!o) return;
    orderMemory.remember({ id: o.id, number: o.number, token, at: o.created_at });
    if (o.status.key !== lastStatus.current) {
      if (lastStatus.current) announce(`${o.status.title}. ${o.status.detail}`);
      lastStatus.current = o.status.key;
    }
  }, [o, token, announce]);

  async function act(kind: "cancel-request" | "cancel" | "support") {
    setBusy(kind);
    setNotice(null);
    try {
      const body = kind === "cancel-request" ? { reason } : kind === "support" ? { message, topic: "general" } : {};
      const view = await api<OrderView>(`/api/orders/${orderId}/${kind}`, { body, headers });
      order.setData(view);
      const shopName = view.merchant.name;
      const text =
        kind === "support" ? `Message sent. ${shopName} will reply here.` : kind === "cancel" ? "Order cancelled. You were not charged." : `Cancellation requested. ${shopName} will review it.`;
      setNotice({ tone: "success", text });
      announce(text);
      if (kind === "support") setMessage("");
    } catch (err) {
      setNotice({ tone: "danger", text: errorMessage(err) });
      announce(errorMessage(err), "assertive");
    } finally {
      setBusy(null);
    }
  }

  if (order.error && !o) {
    return (
      <PageShell width="narrow">
        <ErrorState title="We couldn't load this order" message={`${errorMessage(order.error)} On another device? Open the link from your confirmation.`} onRetry={order.reload} />
      </PageShell>
    );
  }
  if (!o) {
    return (
      <PageShell width="narrow">
        <LoadingBlock label="Loading your order" slow={order.slow} lines={6} />
      </PageShell>
    );
  }

  const tone: Tone = o.status.tone;
  const t = tones[tone];
  const StatusIcon = STATUS_ICON[o.status.key] ?? (tone === "danger" ? ErrorRounded : tone === "success" ? CheckCircleRounded : InfoOutlined);
  const paid = o.payment_status === "CAPTURED";
  const pending = PENDING_PAYMENT.includes(o.payment_status);
  const showPass = paid && ["NEW", "PACKING", "READY"].includes(o.fulfillment_status);
  const progress = progressOf(o);
  const request = o.cancellation.request;
  const finished = !request && (o.fulfillment_status === "PICKED_UP" || o.fulfillment_status === "CANCELLED");
  const shop = o.merchant;

  return (
    <PageShell shop={{ slug: shop.slug, name: shop.name }}>
      <Card sx={{ mb: 4 }}>
        <CardContent sx={{ p: { xs: 2.5, sm: 4 }, "&:last-child": { pb: { xs: 2.5, sm: 4 } } }}>
          <Stack direction="row" spacing={{ xs: 1.75, sm: 3 }} sx={{ alignItems: { xs: "flex-start", sm: "center" } }}>
            <Box
              aria-hidden
              sx={{ ...surface.raisedSm, display: "grid", placeItems: "center", width: { xs: 48, sm: 68 }, height: { xs: 48, sm: 68 }, mt: { xs: 0.25, sm: 0 }, borderRadius: "50%", color: t.fg, flexShrink: 0 }}
            >
              {pending ? <CircularProgress size={26} color="inherit" /> : <StatusIcon sx={{ fontSize: { xs: 26, sm: 36 } }} />}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box role="status" aria-live="polite">
                <Typography variant="h1">{o.status.title}</Typography>
                <Typography color="text.secondary" sx={{ mt: 0.75 }}>
                  {o.status.detail}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center", mt: 2 }}>
                <Typography variant="body2" color="text.secondary">
                  {shop.name} · Order {o.number} · {o.pickup.date_label}, {o.pickup.label}
                </Typography>
                <RefundPill status={o.refund_status} />
              </Stack>
            </Box>
          </Stack>
          {pending ? (
            <Box sx={{ mt: 3 }}>
              <LinearProgress aria-label="Checking payment status with PayPal" color="warning" />
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
                Your items stay reserved. This page updates on its own.
              </Typography>
            </Box>
          ) : null}
          {progress ? <OrderProgress active={progress.active} note={progress.note} /> : null}
        </CardContent>
      </Card>

      {notice ? (
        <Alert severity={notice.tone === "danger" ? "error" : "success"} role={notice.tone === "danger" ? "alert" : "status"} sx={{ mb: 4 }}>
          {notice.text}
        </Alert>
      ) : null}
      {o.pickup.expired && paid && o.fulfillment_status !== "PICKED_UP" ? (
        <Alert severity="warning" role="note" sx={{ mb: 4 }}>
          <AlertTitle>Your pickup window has passed</AlertTitle>
          {shop.name} will contact you about next steps. We never mark an order collected unless it was handed over.
        </Alert>
      ) : null}

      <Grid container spacing={4}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={4}>
            {showPass ? (
              <SectionCard title="Pickup pass" icon={<QrCode2Rounded />} action={<FulfillmentPill status={o.fulfillment_status} />}>
                <Box sx={{ textAlign: "center" }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
                    Show this code at the counter
                  </Typography>
                  <Box
                    role="img"
                    aria-label={`Pickup code ${o.pickup.code?.split("").join(" ") ?? ""}`}
                    sx={{ display: "flex", justifyContent: "center", gap: { xs: 1.25, sm: 1.75 }, mt: 2 }}
                  >
                    {(o.pickup.code ?? "—").split("").map((digit, index) => (
                      <Box
                        key={index}
                        className="tabular"
                        sx={{
                          display: "grid",
                          placeItems: "center",
                          width: { xs: 54, sm: 64 },
                          height: { xs: 66, sm: 76 },
                          ...surface.inset,
                          borderRadius: "16px",
                          fontSize: { xs: 38, sm: 46 },
                          fontWeight: 800,
                          lineHeight: 1,
                        }}
                      >
                        {digit}
                      </Box>
                    ))}
                  </Box>
                  {o.pickup.qr_svg ? (
                    <Box
                      aria-hidden
                      sx={{ width: 152, mx: "auto", mt: 3, p: 1.25, bgcolor: "#FFFFFF", borderRadius: "16px", boxShadow: shadows.raisedSm, "& svg": { display: "block", width: "100%", height: "auto" } }}
                      dangerouslySetInnerHTML={{ __html: o.pickup.qr_svg }}
                    />
                  ) : null}
                  <Box sx={{ mt: 2.5 }}>
                    <StatusChip tone="success" icon={VerifiedRounded} label="Paid · verified with PayPal" />
                  </Box>
                </Box>
                <InfoList
                  sx={{ mt: 4 }}
                  columns={2}
                  items={[
                    { label: "Pickup", value: `${o.pickup.date_label}, ${o.pickup.label}`, icon: ScheduleRounded },
                    {
                      label: "Where",
                      icon: LocationOnRounded,
                      value: (
                        <>
                          {o.merchant.name}, {o.pickup.address}
                          <br />
                          <Link component="a" href={o.pickup.directions_url} target="_blank" rel="noreferrer" sx={{ display: "inline-flex", alignItems: "center", gap: 0.25 }}>
                            Directions
                            <OpenInNewRounded aria-hidden sx={{ fontSize: 14 }} />
                            <span className="sr-only"> (opens in a new tab)</span>
                          </Link>
                        </>
                      ),
                    },
                    { label: "What to bring", value: <Plain>{o.pickup.what_to_bring}</Plain>, icon: ShoppingBagRounded },
                    { label: "How it works", value: <Plain>{o.pickup.instructions}</Plain>, icon: InfoOutlined },
                  ]}
                />
              </SectionCard>
            ) : null}

            <SectionCard title="Items" icon={<ShoppingBagRounded />}>
              <LineList lines={o.lines} currency={o.currency} />
              {o.totals ? (
                <Box sx={{ mt: 3 }}>
                  <PriceBreakdown totals={o.totals} currency={o.currency} />
                </Box>
              ) : null}
              <Box sx={{ mt: 2.5 }}>
                {paid ? (
                  <StatusChip tone="success" icon={PaymentsRounded} label={`${money(o.amount_minor, o.currency)} charged via PayPal`} />
                ) : (
                  <StatusChip tone="neutral" icon={HourglassTopRounded} label={`${money(o.amount_minor, o.currency)} · not yet charged`} />
                )}
              </Box>
              <ReceiptDetails>
                <InfoList
                  layout="row"
                  items={[
                    { label: "Order", value: o.number },
                    { label: "Payment", value: PAYMENT_STATUS_LABEL[o.payment_status] ?? o.payment_status },
                    { label: "Provider", value: "PayPal" },
                    { label: "PayPal order", value: <Mono>{o.payment.paypal_order_id ?? "—"}</Mono> },
                    { label: "Capture", value: <Mono>{o.payment.capture_id ?? "—"}</Mono> },
                    { label: "Paid at", value: dateTimeLabel(o.payment.captured_at, zone) },
                  ]}
                />
              </ReceiptDetails>
            </SectionCard>

            {o.refunds.length ? (
              <SectionCard title="Refunds" icon={<ReplayRounded />}>
                <Stack component="ul" spacing={1.25} sx={{ listStyle: "none", m: 0, p: 0 }}>
                  {o.refunds.map((r) => (
                    <Stack component="li" key={r.id} direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                      <StatusChip
                        tone={r.state === "COMPLETED" ? "success" : r.state === "FAILED" ? "danger" : "warning"}
                        icon={r.state === "COMPLETED" ? CheckCircleRounded : r.state === "FAILED" ? ErrorRounded : HourglassTopRounded}
                        label={REFUND_LABEL[r.state] ?? r.state}
                      />
                      <Typography className="tabular" sx={{ fontWeight: 700 }}>
                        {money(r.amount_minor, r.currency)}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </SectionCard>
            ) : null}
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <Stack spacing={4}>
            <SectionCard title="Help" icon={<SupportAgentRounded />} subtitle="Questions about pickup or your items?">
              {o.merchant.phone || o.merchant.email ? (
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                  {o.merchant.phone ? (
                    <Button component="a" href={`tel:${o.merchant.phone}`} variant="outlined" color="inherit" size="small" startIcon={<PhoneRounded />} sx={contactButton}>
                      {o.merchant.phone}
                    </Button>
                  ) : null}
                  {o.merchant.email ? (
                    <Button component="a" href={`mailto:${o.merchant.email}`} variant="outlined" color="inherit" size="small" startIcon={<MailRounded />} sx={contactButton}>
                      {o.merchant.email}
                    </Button>
                  ) : null}
                </Stack>
              ) : null}

              {o.support.length ? (
                <Stack component="ul" spacing={2} sx={{ listStyle: "none", m: 0, p: 0, mt: 2.5 }}>
                  {o.support.map((s) => (
                    <li key={s.id}>
                      <Bubble who="You">{s.message}</Bubble>
                      {s.staff_reply ? (
                        <Bubble who={o.merchant.name} reply>
                          {s.staff_reply}
                        </Bubble>
                      ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.75 }}>
                          <ScheduleRounded aria-hidden sx={{ fontSize: 15 }} />
                          Waiting for {shop.name} to reply
                        </Typography>
                      )}
                    </li>
                  ))}
                </Stack>
              ) : null}

              <Box
                component="form"
                sx={{ mt: 2.5 }}
                onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  if (message.trim()) void act("support");
                }}
              >
                <TextField
                  label={`Message ${shop.name}`}
                  multiline
                  minRows={3}
                  fullWidth
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Questions about pickup, items or your order"
                  slotProps={{ htmlInput: { maxLength: 1000 } }}
                />
                <Button type="submit" variant="contained" startIcon={<SendRounded />} loading={busy === "support"} disabled={!message.trim()} sx={{ mt: 2 }}>
                  Send message
                </Button>
              </Box>
            </SectionCard>

            <SectionCard title="Cancellation" icon={<EventBusyRounded />}>
              {finished ? null : (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {o.cancellation.policy_text}
                </Typography>
              )}
              {request ? (
                <Box>
                  <StatusChip
                    tone={request.status === "declined" ? "danger" : request.status === "approved" ? "success" : "warning"}
                    icon={request.status === "declined" ? BlockRounded : request.status === "approved" ? CheckCircleRounded : HourglassTopRounded}
                    label={request.status === "requested" ? "Requested · awaiting the shop" : request.status === "approved" ? "Cancellation approved" : "Cancellation declined"}
                  />
                  {request.decision_reason ? (
                    <Typography variant="body2" sx={{ mt: 1.5 }}>
                      <strong>Reason:</strong> {request.decision_reason}
                    </Typography>
                  ) : null}
                  {request.status !== "declined" ? (
                    <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                      A refund shows as complete only after PayPal confirms it.
                    </Typography>
                  ) : null}
                </Box>
              ) : o.cancellation.can_request ? (
                <Box
                  component="form"
                  onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    void act("cancel-request");
                  }}
                >
                  <Typography variant="body2" sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
                    <ScheduleRounded aria-hidden sx={{ fontSize: 18, mt: "1px", color: brand.leaf }} />
                    Requests close {o.cancellation.allowed_until_label} on pickup day
                  </Typography>
                  <TextField
                    label="Reason (optional)"
                    fullWidth
                    size="small"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    slotProps={{ htmlInput: { maxLength: 300 } }}
                    sx={{ mt: 2.5 }}
                  />
                  <Button type="submit" variant="outlined" color="error" startIcon={<EventBusyRounded />} loading={busy === "cancel-request"} sx={{ mt: 2 }}>
                    Request cancellation
                  </Button>
                </Box>
              ) : o.cancellation.can_cancel_unpaid ? (
                <Button variant="outlined" color="error" startIcon={<BlockRounded />} loading={busy === "cancel"} onClick={() => act("cancel")}>
                  Cancel this unpaid order
                </Button>
              ) : (
                <Typography variant="body2" sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, fontWeight: 600 }}>
                  <WarningAmberRounded aria-hidden sx={{ fontSize: 19, color: tones.warning.fg }} />
                  {o.fulfillment_status === "PICKED_UP" || o.fulfillment_status === "CANCELLED"
                    ? "This order can no longer be cancelled."
                    : `Online cancellation closed at ${o.cancellation.allowed_until_label}. Please contact ${shop.name}.`}
                </Typography>
              )}
            </SectionCard>

            {o.timeline.length ? (
              <SectionCard title="Activity" icon={<HistoryRounded />}>
                <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0 }}>
                  {o.timeline.map((event, index) => {
                    const last = index === o.timeline.length - 1;
                    return (
                      <Box component="li" key={`${event.action}-${event.at}`} sx={{ display: "flex", gap: 1.5 }}>
                        <Box aria-hidden sx={{ display: "flex", flexDirection: "column", alignItems: "center", width: 12, flexShrink: 0 }}>
                          <Box sx={{ width: 10, height: 10, mt: 0.75, borderRadius: 99, bgcolor: last ? brand.leaf : brand.lineStrong }} />
                          {!last ? <Box sx={{ flex: 1, width: 2, my: 0.5, bgcolor: brand.line }} /> : null}
                        </Box>
                        <Box sx={{ pb: last ? 0 : 1.5, minWidth: 0 }}>
                          <Typography variant="body2" sx={{ fontWeight: 650 }}>
                            {event.label}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {dateTimeLabel(event.at, zone)}
                          </Typography>
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              </SectionCard>
            ) : null}
          </Stack>
        </Grid>
      </Grid>

      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 5, flexWrap: "wrap" }}>
        <Button href={`/shops/${shop.slug}`} color="inherit" startIcon={<ArrowBackRounded />}>
          Back to {shop.name}
        </Button>
        <Button href="/orders" color="inherit" startIcon={<ReceiptLongRounded />}>
          My orders
        </Button>
      </Stack>
    </PageShell>
  );
}

const contactButton = { maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "left" };

/** Paid → Packing → Ready → Picked up, with completed steps announced as done. */
function OrderProgress({ active, note }: { active: number; note?: string }) {
  return (
    <Box sx={{ mt: 4 }}>
      <Stepper activeStep={active} alternativeLabel component="ol" aria-label="Order progress" sx={{ m: 0, p: 0, listStyle: "none" }}>
        {PROGRESS.map((label, index) => (
          <Step key={label} component="li" aria-current={index === active ? "step" : undefined}>
            <StepLabel
              optional={
                index === active && note ? (
                  <Typography variant="caption" color="text.secondary" component="span" sx={{ display: "block", textAlign: "center" }}>
                    {note}
                  </Typography>
                ) : undefined
              }
            >
              {label}
              {index < active ? <span className="sr-only"> (done)</span> : null}
            </StepLabel>
          </Step>
        ))}
      </Stepper>
    </Box>
  );
}

function ReceiptDetails({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <Accordion sx={{ mt: 3, "&, &:first-of-type, &:last-of-type": { borderRadius: "16px" } }}>
      <AccordionSummary id={`${id}-summary`} aria-controls={`${id}-details`} expandIcon={<ExpandMoreRounded />} sx={{ minHeight: 48 }}>
        <ReceiptLongRounded aria-hidden sx={{ fontSize: 20, color: brand.leaf }} />
        <Typography component="span" variant="body2" sx={{ fontWeight: 650 }}>
          Receipt details
        </Typography>
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  );
}

function Plain({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ fontWeight: 400 }}>
      {children}
    </Box>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.78rem", fontWeight: 500, overflowWrap: "anywhere" }}>
      {children}
    </Box>
  );
}

function Bubble({ who, reply, children }: { who: string; reply?: boolean; children: ReactNode }) {
  return (
    <Box sx={{ ...surface.inset, mt: reply ? 1.25 : 0, ml: reply ? 3 : 0, px: 2, py: 1.5, borderRadius: "16px" }}>
      <Typography variant="caption" sx={{ fontWeight: 700, display: "block", color: reply ? brand.leafDark : brand.forest }}>
        {who}
      </Typography>
      <Typography variant="body2">{children}</Typography>
    </Box>
  );
}

function LineList({ lines, currency }: { lines: QuoteLine[]; currency: string }) {
  return (
    <Stack component="ul" spacing={2} sx={{ listStyle: "none", m: 0, p: 0 }}>
      {lines.map((line) => (
        <Stack component="li" key={line.sku} direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Box sx={{ position: "relative", flexShrink: 0 }}>
            <ProductImage image={line.image} size="sm" />
            <Box
              aria-hidden
              sx={{ ...surface.raisedSm, position: "absolute", top: -8, right: -8, minWidth: 24, height: 24, px: 0.5, borderRadius: "999px", color: brand.forest, fontSize: 12, fontWeight: 800, display: "grid", placeItems: "center" }}
            >
              {line.qty}
            </Box>
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 650 }}>
              {line.name}
            </Typography>
            <Typography variant="caption" color="text.secondary" className="tabular">
              {line.qty} × {money(line.unit_sale_minor, currency)}
            </Typography>
          </Box>
          <Typography variant="body2" className="tabular" sx={{ fontWeight: 650 }}>
            {money(line.line_total_minor, currency)}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
