"use client";

import {
  ArrowBackRounded,
  CheckCircleRounded,
  ErrorRounded,
  EventBusyRounded,
  ExpandMoreRounded,
  HourglassDisabledRounded,
  InfoOutlined,
  LocationOnRounded,
  LockClockRounded,
  LockRounded,
  PersonRounded,
  PolicyRounded,
  ReplayRounded,
  ScheduleRounded,
  StorefrontRounded,
  TimerRounded,
  VerifiedUserRounded,
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
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Grid,
  LinearProgress,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { PriceBreakdown } from "@/components/commerce";
import { useConfig } from "@/components/config";
import { useAccount } from "@/components/account";
import { PayPalSmartButtons, PayPalUnavailable, type PayHandlers } from "@/components/paypal";
import { ProductImage } from "@/components/product-image";
import { FlowSteps, PageShell } from "@/components/site";
import { ErrorState, InfoList, InfoTip, LoadingBlock, PageHeader, SectionCard, brand, surface, shadows, tones, type Icon, type Tone } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { orderMemory } from "@/lib/flow";
import { countdown, money } from "@/lib/format";
import type { CheckoutStart, MerchantPublic, OrderView, Quote, QuoteLine } from "@/lib/types";
import { useResource, useSecondsUntil } from "@/lib/use-api";

type PayState = "ready" | "opening" | "approval" | "processing" | "unknown" | "complete" | "failed";

const PAY_STATE_TEXT: Record<PayState, string> = {
  ready: "You're only charged after you approve in PayPal.",
  opening: "Opening PayPal…",
  approval: "Finish the payment in PayPal.",
  processing: "Confirming with PayPal… please don't close this page.",
  unknown: "Confirming the result with PayPal. Please don't pay again.",
  complete: "Payment verified. Opening your pickup pass…",
  failed: "The payment didn't go through. You haven't been charged.",
};

const PAY_STATE_TONE: Record<PayState, Tone> = {
  ready: "neutral",
  opening: "info",
  approval: "info",
  processing: "info",
  unknown: "warning",
  complete: "success",
  failed: "danger",
};

const PAY_STATE_ICON: Record<PayState, Icon> = {
  ready: VerifiedUserRounded,
  opening: VerifiedUserRounded,
  approval: VerifiedUserRounded,
  processing: VerifiedUserRounded,
  unknown: WarningAmberRounded,
  complete: CheckCircleRounded,
  failed: ErrorRounded,
};

export function Checkout({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const config = useConfig();
  const announce = useAnnounce();
  const { account } = useAccount();
  const customer = account?.user ?? null;
  const quote = useResource((signal) => api<Quote>(`/api/quotes/${quoteId}`, { signal }), [quoteId], { pollMs: 10_000 });
  // Policies and pickup details come from the shop this basket belongs to.
  const shopSlug = quote.data?.merchant.slug ?? null;
  const merchant = useResource((signal) => api<MerchantPublic>(`/api/merchants/${shopSlug}`, { signal }), [shopSlug], { enabled: !!shopSlug });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [payState, setPayState] = useState<PayState>("ready");
  const [payMessage, setPayMessage] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const order = useRef<CheckoutStart | null>(null);
  const autoHeld = useRef(false);
  const errorSummary = useRef<HTMLDivElement>(null);
  const acceptErrorId = useId();
  const q = quote.data;
  const m = merchant.data;
  const reservation = q?.reservation ?? null;
  const secondsLeft = useSecondsUntil(reservation?.state === "HELD" ? reservation.expires_at : null);
  const holdExpired = reservation?.state === "HELD" && secondsLeft === 0;
  const busy = payState === "opening" || payState === "approval" || payState === "processing";
  // PayPal may show its card form inline, inside its buttons, so they stay usable while the buyer pays;
  // they lock only while we confirm the capture, once paid, or when there is no hold to pay for.
  const payPalLocked = payState === "processing" || payState === "complete" || payState === "unknown" || holdExpired || holding;

  // The customer profile loads after the page; fill only empty fields, once per profile.
  if (customer && prefilledFor !== customer.id) {
    setPrefilledFor(customer.id);
    if (!name) setName(customer.name);
    if (!email) setEmail(customer.email);
    if (!phone) setPhone(customer.phone);
  }

  // Arriving without a hold (e.g. a refreshed page after it lapsed): try to hold once.
  useEffect(() => {
    if (!q || autoHeld.current) return;
    if (q.status === "SUPERSEDED" && q.latest_quote_id) router.replace(`/review/${q.latest_quote_id}`);
    if (q.order?.payment_status === "CAPTURED") router.replace(`/orders/${q.order.id}`);
    if (!q.reservation && q.status === "ACTIVE") {
      autoHeld.current = true;
      void hold();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function hold() {
    setHolding(true);
    try {
      await api("/api/reservations", { body: { quote_id: quoteId } });
      quote.reload();
      announce("Items held for you.");
    } catch (err) {
      if (err instanceof ApiError && (err.code === "quote_invalid" || err.code === "offer_pending")) router.replace(`/review/${quoteId}`);
      else setPayMessage(errorMessage(err));
    } finally {
      setHolding(false);
    }
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Enter the name for the pickup order.";
    if (!email.trim() && !phone.trim()) next.contact = `Add an email or phone so ${q?.merchant.name ?? "the shop"} can reach you about pickup.`;
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(email.trim())) next.email = "Enter a valid email address.";
    if (phone.trim() && !/^\+?[\d\s().-]{7,20}$/.test(phone.trim())) next.phone = "Enter a valid phone number.";
    if (!accepted) next.accept = "Confirm you've read the pickup, cancellation and refund policy.";
    if (holdExpired) next.hold = "Your hold expired. Hold the items again to continue.";
    setErrors(next);
    if (Object.keys(next).length) {
      announce(`${Object.keys(next).length} ${Object.keys(next).length === 1 ? "problem" : "problems"} to fix before paying.`, "assertive");
      window.setTimeout(() => errorSummary.current?.focus(), 30);
      return false;
    }
    return true;
  }

  const handlers: PayHandlers = {
    validate,
    createOrder: async () => {
      setPayState("opening");
      setPayMessage(null);
      try {
        const started = await api<CheckoutStart>("/api/checkout/paypal/order", {
          body: { quote_id: quoteId, customer: { name: name.trim(), email: email.trim() || null, phone: phone.trim() || null }, accept_policies: accepted, policy_version: q?.policy_version },
        });
        order.current = started;
        orderMemory.remember({ id: started.order_id, number: started.order_number, token: started.access_token, at: new Date().toISOString() });
        setPayState("approval");
        quote.reload();
        return started.paypal_order_id;
      } catch (err) {
        setPayState("ready");
        if (err instanceof ApiError) {
          if (err.code === "validation_error") setErrors(Object.fromEntries(Object.entries(err.fieldErrors()).map(([k, v]) => [k.replace("customer.", "") || "contact", v])));
          if (err.code === "quote_invalid" || err.code === "quote_not_active") {
            router.replace(`/review/${quoteId}`);
          }
          if (err.code === "policy_changed") {
            setAccepted(false);
            merchant.reload();
            quote.reload();
          }
        }
        setPayMessage(errorMessage(err));
        announce(errorMessage(err), "assertive");
        throw err;
      }
    },
    onApprove: async (paypalOrderId) => {
      const started = order.current;
      if (!started) throw new Error("Checkout session lost; please try again.");
      setPayState("processing");
      announce("Approved in PayPal. Confirming payment.");
      try {
        const view = await api<OrderView>("/api/checkout/paypal/capture", {
          body: { order_id: started.order_id, paypal_order_id: paypalOrderId },
          headers: started.access_token ? { "X-Order-Token": started.access_token } : {},
          timeoutMs: 60_000,
        });
        if (view.capture_error?.restart) {
          setPayState("ready");
          setPayMessage(view.capture_error.message);
          announce(view.capture_error.message, "assertive");
          return "restart";
        }
        if (view.payment_status === "CAPTURED") {
          setPayState("complete");
          announce("Payment verified.");
        } else if (view.payment_status === "CAPTURE_FAILED") {
          setPayState("failed");
          setPayMessage(view.capture_error?.message ?? PAY_STATE_TEXT.failed);
          return "done";
        } else {
          setPayState("unknown");
        }
        const tokenQuery = started.access_token ? `?t=${encodeURIComponent(started.access_token)}` : "";
        router.push(`/orders/${started.order_id}${tokenQuery}`);
        return "done";
      } catch (err) {
        if (err instanceof ApiError && err.code === "quote_invalid") {
          setPayState("failed");
          setPayMessage(err.message);
          return "done";
        }
        setPayState("unknown");
        setPayMessage("We couldn't confirm the payment yet. Your order page will update automatically; please don't pay again.");
        router.push(`/orders/${started.order_id}`);
        return "done";
      }
    },
    onCancel: () => {
      setPayState("ready");
      setPayMessage("You closed PayPal before approving. Nothing was charged and your items are still held.");
      announce("Payment cancelled. Nothing was charged.");
    },
    onError: (message) => {
      setPayState("failed");
      setPayMessage(message);
      announce(message, "assertive");
    },
  };

  if (quote.error && !q) {
    return (
      <PageShell width="narrow">
        <ErrorState title="We couldn't load your basket" message={errorMessage(quote.error)} onRetry={quote.reload} />
      </PageShell>
    );
  }
  if (!q) {
    return (
      <PageShell width="narrow">
        <FlowSteps active={3} />
        <LoadingBlock label="Loading checkout" slow={quote.slow} lines={6} />
      </PageShell>
    );
  }

  const inFlight = reservation?.state === "PAYMENT_IN_FLIGHT";
  const errorList = Object.values(errors);
  const emailError = errors.email ?? (errors.contact && !email && !phone ? errors.contact : undefined);
  const statusText = payMessage && (payState === "ready" || payState === "failed") ? payMessage : PAY_STATE_TEXT[payState];
  const statusTone = payState === "ready" && payMessage ? "info" : PAY_STATE_TONE[payState];
  const StatusIcon = payState === "ready" && payMessage ? InfoOutlined : PAY_STATE_ICON[payState];
  const ttl = m?.policies.reservation_ttl_seconds ?? null;
  const total = money(q.totals.total_minor, q.currency);
  const shop = q.merchant;
  const prefilled = !!customer && prefilledFor === customer.id;

  return (
    <PageShell shop={{ slug: shop.slug, name: shop.name }}>
      <FlowSteps active={3} />
      <PageHeader eyebrow={shop.name} title="Checkout" />

      <Box aria-live="polite" sx={{ "&:not(:empty)": { mb: 4 } }}>
        {holding ? (
          <Banner tone="info" icon={<CircularProgress size={20} color="inherit" />} title="Holding your items…" />
        ) : null}
        {reservation?.state === "HELD" && !holdExpired && secondsLeft !== null ? (
          <Banner
            tone={secondsLeft < 120 ? "warning" : "success"}
            icon={<TimerRounded />}
            title="Items held for you"
            aside={<HoldTimer seconds={secondsLeft} tone={secondsLeft < 120 ? "warning" : "success"} />}
            footer={
              ttl ? (
                <LinearProgress
                  variant="determinate"
                  value={Math.max(0, Math.min(100, (secondsLeft / ttl) * 100))}
                  color={secondsLeft < 120 ? "warning" : "primary"}
                  aria-label="Hold time remaining"
                  aria-valuetext={`${countdown(secondsLeft)} left`}
                  sx={{ mt: 2.25 }}
                />
              ) : null
            }
          >
            No one else can buy them until the timer runs out.
          </Banner>
        ) : null}
        {inFlight ? (
          <Banner tone="success" icon={<LockClockRounded />} title="Items held while you pay">
            They stay reserved while PayPal confirms the payment.
          </Banner>
        ) : null}
        {holdExpired ? (
          <Banner
            tone="warning"
            icon={<HourglassDisabledRounded />}
            title="Your hold expired"
            action={
              <Button variant="contained" size="small" startIcon={<ReplayRounded />} loading={holding} onClick={hold}>
                Hold items again
              </Button>
            }
          >
            We released the items. Holding again re-checks stock; you&apos;ll review any change first.
          </Banner>
        ) : null}
      </Box>

      <Grid container spacing={4}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={4}>
            {errorList.length ? (
              <Alert ref={errorSummary} tabIndex={-1} severity="error" role="alert">
                <AlertTitle>Please fix the following</AlertTitle>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {errorList.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </Box>
              </Alert>
            ) : null}

            <SectionCard
              title="Your details"
              subtitle={prefilled ? `Filled in from ${customer.name}'s profile. Only used for this pickup.` : "Only used for this pickup. Add an email or a phone."}
              icon={<PersonRounded />}
            >
              <Grid container spacing={2}>
                <Grid size={12}>
                  <TextField
                    label="Name for the order"
                    required
                    fullWidth
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    error={!!errors.name}
                    helperText={errors.name}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    label="Email"
                    type="email"
                    fullWidth
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    error={!!emailError}
                    helperText={emailError}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    label="Phone"
                    type="tel"
                    fullWidth
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    error={!!errors.phone}
                    helperText={errors.phone}
                  />
                </Grid>
              </Grid>
            </SectionCard>

            <SectionCard title="Pickup" icon={<StorefrontRounded />}>
              <InfoList
                columns={2}
                items={[
                  { label: "When", value: q.pickup.label, icon: ScheduleRounded },
                  {
                    label: "Where",
                    icon: LocationOnRounded,
                    value: (
                      <>
                        {shop.name}, {shop.address}
                      </>
                    ),
                  },
                ]}
              />
              {m ? (
                <Stack direction="row" spacing={1} sx={{ mt: 2.5, color: "text.secondary" }}>
                  <InfoOutlined aria-hidden sx={{ fontSize: 18, mt: "1px" }} />
                  <Typography variant="body2">{m.policies.pickup_instructions}</Typography>
                </Stack>
              ) : null}
            </SectionCard>

            <SectionCard title="Shop terms" subtitle={shop.name} icon={<PolicyRounded />}>
              {m ? (
                <>
                  <Stack spacing={1} sx={{ mb: 2.5 }}>
                    <Fact icon={EventBusyRounded}>Cancellation requests close {m.policies.cancellation_cutoff_minutes} min before pickup</Fact>
                    <Fact icon={StorefrontRounded}>Pickup only · no delivery</Fact>
                  </Stack>
                  <PolicyAccordion title="Cancellation policy" icon={<EventBusyRounded />}>
                    {m.policies.cancellation_policy_text}
                  </PolicyAccordion>
                  <PolicyAccordion title="Refund policy" icon={<ReplayRounded />}>
                    {m.policies.refund_policy_text}
                  </PolicyAccordion>
                  <PolicyAccordion title="Allergen information" icon={<InfoOutlined />}>
                    {m.policies.dietary_disclosure_text}
                  </PolicyAccordion>
                  <Alert severity="warning" role="note" icon={<WarningAmberRounded />} sx={{ mt: 2.5 }}>
                    <AlertTitle>Cross-contact</AlertTitle>
                    {m.policies.cross_contact_text}
                  </Alert>
                </>
              ) : (
                <LoadingBlock label="Loading terms" lines={3} />
              )}
              {/* A raised tile, pressed in once accepted; tinted while it has an error. */}
              <Box sx={{ ...(accepted ? surface.pressed : surface.raisedSm), ...(errors.accept && !accepted ? { bgcolor: tones.danger.bg } : {}), mt: 3, borderRadius: "14px", px: 1.5, py: 0.75 }}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={accepted}
                      onChange={(e) => setAccepted(e.target.checked)}
                      slotProps={{ input: { "aria-invalid": errors.accept ? true : undefined, "aria-describedby": errors.accept ? acceptErrorId : undefined } }}
                    />
                  }
                  label="I've read the pickup, cancellation and refund policy."
                  slotProps={{ typography: { variant: "body2", sx: { fontWeight: 600, color: accepted ? brand.leafDark : brand.forest } } }}
                />
              </Box>
              {errors.accept ? (
                <Typography id={acceptErrorId} variant="body2" sx={{ mt: 1, display: "flex", alignItems: "center", gap: 0.5, color: tones.danger.fg, fontWeight: 600 }}>
                  <ErrorRounded aria-hidden sx={{ fontSize: 18 }} />
                  {errors.accept}
                </Typography>
              ) : null}
            </SectionCard>

            <SectionCard title="Payment" icon={<LockRounded />}>
              <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-end", mb: 2.5 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 650, display: "flex", alignItems: "center" }}>
                    Total to approve in PayPal
                    <InfoTip
                      label="How payment works"
                      title="You approve this exact amount in PayPal. We mark the order paid only after PayPal confirms the capture."
                    />
                  </Typography>
                  <Typography variant="h2" component="p" className="tabular">
                    {total}
                  </Typography>
                </Box>
              </Stack>
              <Stack
                role="status"
                aria-live="polite"
                direction="row"
                spacing={1.25}
                sx={{ alignItems: "flex-start", px: 2, py: 1.5, borderRadius: "14px", bgcolor: tones[statusTone].bg, boxShadow: shadows.insetSm }}
              >
                <Box aria-hidden sx={{ display: "flex", color: tones[statusTone].fg, mt: "1px" }}>
                  {busy ? <CircularProgress size={18} color="inherit" /> : <StatusIcon sx={{ fontSize: 20 }} />}
                </Box>
                <Typography variant="body2" sx={{ fontWeight: 550 }}>
                  {statusText}
                </Typography>
              </Stack>
              <Box sx={{ mt: 2.5 }}>
                {!config ? (
                  <Box role="status">
                    <span className="sr-only">Loading payment options…</span>
                    <Skeleton variant="rounded" height={52} />
                  </Box>
                ) : config.paypal.client_id ? (
                  <PayPalSmartButtons clientId={config.paypal.client_id} currency={q.currency} handlers={handlers} disabled={payPalLocked} />
                ) : (
                  <PayPalUnavailable />
                )}
              </Box>
              {payState === "failed" ? (
                <Button href={`/review/${quoteId}`} variant="outlined" color="inherit" size="small" startIcon={<ArrowBackRounded />} sx={{ mt: 2 }}>
                  Back to review
                </Button>
              ) : null}
            </SectionCard>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <SectionCard title="Order summary" component="aside" sx={{ position: { md: "sticky" }, top: { md: 88 } }}>
            <LineList lines={q.lines} currency={q.currency} />
            <Box sx={{ mt: 3 }}>
              <PriceBreakdown totals={q.totals} currency={q.currency} />
            </Box>
            <Stack spacing={1} sx={{ mt: 2.5 }}>
              <Fact icon={ScheduleRounded}>Pickup {q.pickup.label}</Fact>
              <Fact icon={StorefrontRounded}>Pickup only</Fact>
            </Stack>
          </SectionCard>
        </Grid>
      </Grid>
    </PageShell>
  );
}

/** A quiet icon + text fact (no chip: these are terms, not states). */
function Fact({ icon: FactIcon, children }: { icon: Icon; children: ReactNode }) {
  return (
    <Typography variant="body2" sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
      <FactIcon aria-hidden sx={{ fontSize: 18, mt: "1px", color: brand.leaf }} />
      <span>{children}</span>
    </Typography>
  );
}

/** Tinted status strip used for the hold. Text stays dark; the tone is carried by icon, tint and words. */
function Banner({ tone, icon, title, children, aside, action, footer }: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}) {
  const t = tones[tone];
  return (
    <Box sx={{ bgcolor: t.bg, boxShadow: shadows.insetSm, borderRadius: "18px", p: { xs: 2.25, sm: 2.75 } }}>
      <Stack direction="row" spacing={1.75} sx={{ alignItems: "flex-start" }}>
        <Box aria-hidden sx={{ display: "flex", color: t.fg, mt: "2px", "& svg": { fontSize: 24 } }}>
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" component="p" sx={{ fontWeight: 750, lineHeight: 1.35 }}>
            {title}
          </Typography>
          {children ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              {children}
            </Typography>
          ) : null}
          {action ? <Box sx={{ mt: 1.5 }}>{action}</Box> : null}
        </Box>
        {aside}
      </Stack>
      {footer}
    </Box>
  );
}

/** The ticking hold countdown. role=timer keeps screen readers from announcing every second. */
function HoldTimer({ seconds, tone }: { seconds: number; tone: Tone }) {
  return (
    <Box
      role="timer"
      sx={{ ...surface.insetSm, flexShrink: 0, borderRadius: "999px", px: 1.75, py: 0.75, color: tones[tone].fg, textAlign: "center" }}
    >
      <Typography component="span" className="tabular" sx={{ fontSize: "1.15rem", fontWeight: 800, color: "inherit" }}>
        {countdown(seconds)}
      </Typography>
      <Typography component="span" variant="caption" sx={{ fontWeight: 650, color: "inherit", ml: 0.5 }}>
        left
      </Typography>
    </Box>
  );
}

function PolicyAccordion({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <Accordion sx={{ "&, &:first-of-type, &:last-of-type": { borderRadius: "16px" } }}>
      <AccordionSummary id={`${id}-summary`} aria-controls={`${id}-details`} expandIcon={<ExpandMoreRounded />} sx={{ minHeight: 48 }}>
        <Box component="span" aria-hidden sx={{ display: "flex", color: brand.leaf, "& svg": { fontSize: 20 } }}>
          {icon}
        </Box>
        <Typography component="span" variant="body2" sx={{ fontWeight: 650 }}>
          {title}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="body2" color="text.secondary">
          {children}
        </Typography>
      </AccordionDetails>
    </Accordion>
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
