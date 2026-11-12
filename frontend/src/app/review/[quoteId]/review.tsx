"use client";

import {
  AccountBalanceWalletRounded,
  ArrowBackRounded,
  ArrowForwardRounded,
  AutoAwesomeRounded,
  CheckCircleRounded,
  EastRounded,
  Inventory2Rounded,
  LockRounded,
  ReceiptLongRounded,
  RefreshRounded,
  ScheduleRounded,
  ShoppingBagRounded,
  ShoppingBasketRounded,
  StorefrontRounded,
  SwapHorizRounded,
  SyncRounded,
  TuneRounded,
  VerifiedRounded,
  VerifiedUserRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import { Alert, AlertTitle, Box, Button, Card, CardActionArea, CardContent, CircularProgress, Grid, Stack, TextField, Typography } from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { AllergenTags, PriceBreakdown } from "@/components/commerce";
import { ProductImage } from "@/components/product-image";
import { FlowSteps, PageShell } from "@/components/site";
import { ErrorState, IconBadge, InfoList, LoadingBlock, MetaRow, PageHeader, SectionCard, StatusChip, brand, surface, shadows, tones } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ALLERGEN_LABEL, ago, money, timeLabel } from "@/lib/format";
import type { Offer, Quote, Slot } from "@/lib/types";
import { useLive } from "@/lib/use-live";
import { useResource } from "@/lib/use-api";

const OFFER_KINDS = new Set(["sold_out", "insufficient_stock", "paused", "dietary", "cutoff", "price_changed"]);

function signedMoney(delta: number, currency?: string): string {
  return `${delta <= 0 ? "−" : "+"}${money(Math.abs(delta), currency)}`;
}

export function Review({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const announce = useAnnounce();
  const quote = useResource((signal) => api<Quote>(`/api/quotes/${quoteId}`, { signal }), [quoteId], { pollMs: 5000 });
  const [requestedOffer, setRequestedOffer] = useState<Offer | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const changeRef = useRef<HTMLHeadingElement>(null);
  const requested = useRef<string | null>(null);
  const shownOffer = useRef<string | null>(null);
  const q = quote.data;
  const zone = q?.merchant.timezone;
  // A sale at the counter or another shopper's hold changes this basket's validity: re-check at once.
  useLive([q ? `shop:${q.merchant.id}:stock` : null], quote.reload);
  const reloadQuote = quote.reload;
  const candidate = requestedOffer?.state === "OFFERED" ? requestedOffer : q?.pending_offer ?? null;
  const offer = candidate && candidate.id !== dismissed ? candidate : null;
  const setOffer = setRequestedOffer;
  const shopSlug = q?.merchant.slug ?? null;

  useEffect(() => {
    if (!shopSlug) return;
    api<{ slots: Slot[] }>(`/api/merchants/${shopSlug}/pickup-slots`).then((r) => setSlots(r.slots.filter((s) => s.bookable))).catch(() => {});
  }, [shopSlug]);

  // When a new change proposal appears, announce it and move focus to its summary.
  useEffect(() => {
    if (!offer || shownOffer.current === offer.id) return;
    shownOffer.current = offer.id;
    announce(offer.trigger === "customer_swap" ? "Swap options ready." : "Your bundle changed. Please review the proposed update.", "assertive");
    window.setTimeout(() => changeRef.current?.focus(), 60);
  }, [offer, announce]);

  // React to what the server says about this quote on every poll.
  useEffect(() => {
    if (!q) return;
    if (q.status === "SUPERSEDED" && q.latest_quote_id) {
      router.replace(`/review/${q.latest_quote_id}`);
      return;
    }
    if (q.reservation && (q.reservation.state === "HELD" || q.reservation.state === "PAYMENT_IN_FLIGHT") && !q.reservation.expired) return;
    if (q.pending_offer) return;
    const problems = q.validity?.problems ?? [];
    const signature = problems.map((p) => `${p.kind}:${p.sku}:${p.available}`).join("|");
    if (problems.some((p) => OFFER_KINDS.has(p.kind)) && requested.current !== signature) {
      requested.current = signature;
      api<Offer | { needed: false }>(`/api/bundles/${q.id}/substitute`, { body: {} })
        .then((r) => ("id" in r ? setRequestedOffer(r) : null))
        .catch((err) => setError(errorMessage(err)));
    } else if (problems.length === 1 && problems[0].kind === "expired" && requested.current !== "expired") {
      requested.current = "expired";
      api<Quote>(`/api/quotes/${q.id}/refresh`, { body: {} })
        .then((fresh) => router.replace(`/review/${fresh.id}`))
        .catch(() => reloadQuote());
    }
  }, [q, router, reloadQuote]);

  async function accept() {
    if (!offer) return;
    setBusy("accept");
    setError(null);
    try {
      const fresh = await api<Quote>(`/api/substitutions/${offer.id}/accept`, { body: {} });
      announce("Updated bundle accepted.");
      setOffer(null);
      router.replace(`/review/${fresh.id}`);
    } catch (err) {
      setError(errorMessage(err));
      requested.current = null;
      quote.reload();
    } finally {
      setBusy(null);
    }
  }

  async function swap(replaceSku: string, withSku?: string) {
    if (!q) return;
    setBusy(`swap:${replaceSku}:${withSku ?? ""}`);
    setError(null);
    try {
      const next = await api<Offer | { needed: false }>(`/api/bundles/${q.id}/substitute`, { body: { replace_sku: replaceSku, with_sku: withSku ?? null } });
      if ("id" in next) setOffer(next);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "replacement_not_allowed" ? "Nothing else fits your budget, dietary needs and today's stock for that item." : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function chooseAlternative(addSku: string | null) {
    if (!offer || !q) return;
    const removed = offer.comparison.removed[0]?.sku ?? offer.comparison.changed[0]?.sku;
    if (offer.trigger === "customer_swap" && removed && addSku) return swap(removed, addSku);
    setBusy(`alt:${addSku}`);
    try {
      const next = await api<Offer>(`/api/bundles/${q.id}/substitute`, { body: { with_sku: addSku } });
      setOffer(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function dismissOffer() {
    if (!offer) return;
    const wasSwap = offer.trigger === "customer_swap";
    setDismissed(offer.id);
    setOffer(null);
    try {
      await api(`/api/substitutions/${offer.id}/reject`, { body: {} });
    } catch {
      /* rejecting is best-effort */
    }
    reloadQuote();
    if (!wasSwap) router.push(shopSlug ? `/shops/${shopSlug}/bundles` : "/");
  }

  async function changeSlot(slotId: string) {
    if (!q) return;
    setBusy("slot");
    try {
      const fresh = await api<Quote>(`/api/quotes/${q.id}/slot`, { body: { pickup_slot_id: slotId } });
      announce(`Pickup changed to ${fresh.pickup.label}.`);
      router.replace(`/review/${fresh.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function reserve() {
    if (!q) return;
    setBusy("reserve");
    setError(null);
    try {
      await api(`/api/reservations`, { body: { quote_id: q.id } });
      announce("Items held. Continue to checkout.");
      router.push(`/checkout/${q.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "quote_invalid") {
        const next = (err.details as { offer?: Offer } | undefined)?.offer;
        if (next) setOffer(next);
        else setError(err.message);
        quote.reload();
      } else if (err instanceof ApiError && err.code === "quote_expired") {
        const fresh = await api<Quote>(`/api/quotes/${q.id}/refresh`, { body: {} }).catch(() => null);
        if (fresh) router.replace(`/review/${fresh.id}`);
      } else if (err instanceof ApiError && err.code === "offer_pending") {
        quote.reload();
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }

  if (quote.error && !q) {
    return (
      <PageShell width="narrow">
        <ErrorState title="We couldn't load this bundle" message={errorMessage(quote.error)} onRetry={quote.reload} />
      </PageShell>
    );
  }
  if (!q) {
    return (
      <PageShell width="narrow">
        <FlowSteps active={2} />
        <LoadingBlock label="Loading your bundle" slow={quote.slow} lines={5} />
      </PageShell>
    );
  }

  const valid = q.validity?.valid ?? true;
  const held = q.reservation && q.reservation.state === "HELD" && !q.reservation.expired;
  const customize = params.get("customize") === "1";
  const fittingSlots = slots.filter((s) => q.lines.every((l) => new Date(l.cutoff_at) >= new Date(s.ends_at)));
  const strict = q.intent?.exclusions.filter((e) => e.severity !== "preference") ?? [];
  const editable = !held && q.status === "ACTIVE";
  const units = q.lines.reduce((n, l) => n + l.qty, 0);
  // One provenance line for the whole basket when every item shares it; otherwise per item.
  const sources = new Set(q.lines.map((l) => `${l.allergens.status}|${l.allergens.source_label}`));
  const sharedSource = sources.size === 1 && q.lines[0]?.allergens.status === "verified" ? q.lines[0].allergens.source_label : null;
  const cutoffs = new Set(q.lines.map((l) => l.cutoff_at));
  const sharedCutoff = cutoffs.size === 1 ? q.lines[0]?.cutoff_at ?? null : null;
  const shop = q.merchant;

  return (
    <PageShell shop={{ slug: shop.slug, name: shop.name }}>
      <FlowSteps active={2} />
      <PageHeader
        title="Review your bundle"
        chips={
          <>
            {offer ? (
              <StatusChip tone="warning" label="Change needs your approval" />
            ) : valid ? (
              <StatusChip tone="success" label="Available now" />
            ) : (
              <StatusChip tone="warning" icon={SyncRounded} label="Checking changes" />
            )}
            <MetaRow
              sx={{ alignSelf: "center" }}
              items={[{ label: shop.name, icon: StorefrontRounded }, `Stock checked ${ago(q.validity?.checked_at ?? q.checked_at)}`]}
            />
          </>
        }
        actions={
          <Button href={`/shops/${shop.slug}/bundles`} variant="outlined" color="inherit" startIcon={<ArrowBackRounded />}>
            Other options
          </Button>
        }
      />

      {error ? (
        <Alert severity="error" role="alert" sx={{ mb: 3 }}>
          <AlertTitle>Something needs attention</AlertTitle>
          {error}
        </Alert>
      ) : null}
      {customize && !offer ? (
        <Alert severity="info" icon={<TuneRounded />} sx={{ mb: 3 }}>
          Use <strong>Swap</strong> on any item to see replacements that fit your budget, dietary needs and today&apos;s stock.
        </Alert>
      ) : null}

      {offer ? (
        <ChangeProposal offer={offer} shopSlug={shop.slug} zone={zone} headingRef={changeRef} busy={busy} onAccept={accept} onAlternative={chooseAlternative} onDismiss={dismissOffer} />
      ) : null}

      <Grid container spacing={4}>
        <Grid size={{ xs: 12, md: 7 }}>
          <SectionCard title="Your basket" subtitle={`${units} ${units === 1 ? "item" : "items"}`} icon={<ShoppingBasketRounded />}>
            <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 3 }}>
              {q.lines.map((line) => {
                const problem = q.validity?.problems.find((p) => p.sku === line.sku);
                return (
                  <Box
                    component="li"
                    key={line.sku}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "64px minmax(0, 1fr) auto",
                      gridTemplateRows: { sm: "auto 1fr" },
                      gridTemplateAreas: editable ? { xs: `"img main price" ". action ."`, sm: `"img main price" "img main action"` } : `"img main price"`,
                      columnGap: 2,
                      rowGap: 1.25,
                    }}
                  >
                    <Box sx={{ gridArea: "img" }}>
                      <ProductImage image={line.image} size="sm" />
                    </Box>
                    <Box sx={{ gridArea: "main", minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 650, lineHeight: 1.35 }}>
                        {line.qty} × {line.name}
                      </Typography>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center", mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary" className="tabular">
                          {money(line.unit_sale_minor)} each{" "}
                          <Box component="s" sx={{ ml: 0.25 }}>
                            <span className="sr-only">regular price </span>
                            {money(line.unit_reference_minor)}
                          </Box>
                        </Typography>
                        {sharedCutoff ? null : (
                          <Typography variant="caption" color="text.secondary" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                            <ScheduleRounded aria-hidden sx={{ fontSize: 15, color: brand.leaf }} />
                            Pick up by {timeLabel(line.cutoff_at, zone)}
                          </Typography>
                        )}
                      </Stack>
                      {problem ? (
                        <Box
                          sx={{
                            mt: 1,
                            display: "flex",
                            gap: 0.75,
                            alignItems: "flex-start",
                            borderRadius: "12px",
                            px: 1.5,
                            py: 1,
                            bgcolor: tones.warning.bg,
                            color: tones.warning.fg,
                          }}
                        >
                          <WarningAmberRounded aria-hidden sx={{ fontSize: 18, mt: "1px" }} />
                          <Typography variant="body2" sx={{ fontWeight: 650 }}>
                            {problem.message}
                          </Typography>
                        </Box>
                      ) : null}
                      <Box sx={{ mt: 1.25 }}>
                        <AllergenTags allergens={line.allergens} compact={!!sharedSource} />
                      </Box>
                    </Box>
                    <Typography className="tabular" sx={{ gridArea: "price", fontWeight: 700, textAlign: "right" }}>
                      {money(line.line_total_minor)}
                    </Typography>
                    {editable ? (
                      <Box sx={{ gridArea: "action", justifySelf: { xs: "start", sm: "end" }, alignSelf: "start" }}>
                        <Button
                          variant="outlined"
                          color={customize ? "primary" : "inherit"}
                          size="small"
                          startIcon={<SwapHorizRounded />}
                          loading={busy === `swap:${line.sku}:`}
                          disabled={!!busy}
                          onClick={() => swap(line.sku)}
                          aria-label={`Swap ${line.name}`}
                        >
                          Swap
                        </Button>
                      </Box>
                    ) : null}
                  </Box>
                );
              })}
            </Box>
            {sharedSource ? (
              <Typography variant="caption" component="p" sx={{ mt: 2.5, display: "flex", alignItems: "center", gap: 0.5, color: brand.leafDark }}>
                <VerifiedRounded aria-hidden sx={{ fontSize: 15 }} />
                Allergens: {sharedSource}
              </Typography>
            ) : null}
            {strict.length ? (
              <Alert severity="success" icon={<VerifiedUserRounded />} sx={{ mt: 2.5 }}>
                <AlertTitle>Strict: no {strict.map((e) => ALLERGEN_LABEL[e.code]?.toLowerCase() ?? e.code).join(", ")}</AlertTitle>
                Every item is merchant-verified without them, with no listed cross-contact.
              </Alert>
            ) : null}
          </SectionCard>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <Box sx={{ position: { md: "sticky" }, top: 88 }}>
            <SectionCard title="Summary" icon={<ReceiptLongRounded />}>
              <Typography variant="subtitle2" component="h3" sx={{ display: "flex", alignItems: "center", gap: 0.75, color: "text.secondary" }}>
                <ScheduleRounded aria-hidden sx={{ fontSize: 18 }} />
                Pickup
              </Typography>
              <Typography variant="h4" component="p" sx={{ mt: 0.5 }}>
                {q.pickup.label}
              </Typography>
              {sharedCutoff ? (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.25 }}>
                  Items held for pickup until {timeLabel(sharedCutoff, zone)}
                </Typography>
              ) : null}
              {editable && fittingSlots.length > 1 ? (
                <TextField
                  select
                  fullWidth
                  size="small"
                  id="slot-change"
                  label="Change pickup time"
                  value={q.pickup.id}
                  disabled={busy === "slot"}
                  onChange={(e) => changeSlot(e.target.value)}
                  slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                  sx={{ mt: 2.5 }}
                >
                  {fittingSlots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} ({s.remaining} left)
                    </option>
                  ))}
                </TextField>
              ) : null}

              <Typography variant="subtitle2" component="h3" sx={{ mt: 4, mb: 1, color: "text.secondary" }}>
                Price
              </Typography>
              <PriceBreakdown totals={q.totals} currency={q.currency} referenceNote="Discount = regular menu price minus today's surplus price." />

              <Box sx={{ ...surface.inset, mt: 3, display: "flex", gap: 1.25, alignItems: "flex-start", borderRadius: "16px", p: 2 }}>
                <LockRounded aria-hidden sx={{ fontSize: 18, mt: "2px", color: brand.leaf }} />
                <Typography variant="body2">We hold your items for a few minutes while you pay. No charge until you approve in PayPal.</Typography>
              </Box>
              <Button
                variant="contained"
                size="large"
                fullWidth
                endIcon={<ArrowForwardRounded />}
                loading={busy === "reserve"}
                disabled={!!offer || (!valid && !held) || !!busy}
                onClick={() => (held ? router.push(`/checkout/${q.id}`) : reserve())}
                sx={{ mt: 3 }}
              >
                {held ? "Continue to checkout" : "Hold items & continue"}
              </Button>
              {!valid && !offer ? (
                <Stack role="status" direction="row" spacing={1} sx={{ alignItems: "center", mt: 1.25, color: "text.secondary" }}>
                  <CircularProgress size={14} aria-hidden />
                  <Typography variant="caption">Waiting for an updated proposal…</Typography>
                </Stack>
              ) : null}
            </SectionCard>
          </Box>
        </Grid>
      </Grid>
    </PageShell>
  );
}

function ChangeProposal({ offer, shopSlug, zone, headingRef, busy, onAccept, onAlternative, onDismiss }: {
  offer: Offer;
  zone: string | undefined;
  shopSlug: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  busy: string | null;
  onAccept: () => void;
  onAlternative: (sku: string | null) => void;
  onDismiss: () => void;
}) {
  const c = offer.comparison;
  const swap = offer.trigger === "customer_swap";
  const title = swap ? "Swap an item" : offer.trigger === "price_change" ? "A price changed" : "Your bundle needs a change";
  const delta = c.delta_minor ?? 0;
  return (
    <Card component="section" aria-labelledby="change-title" sx={{ mb: 4 }}>
      <CardContent sx={{ p: { xs: 2.5, sm: 3.5 }, "&:last-child": { pb: { xs: 2.5, sm: 3.5 } } }}>
        <Stack direction="row" spacing={1.75} sx={{ alignItems: "flex-start" }}>
          <IconBadge tone={swap ? "success" : "warning"} size={44}>
            {swap ? <SwapHorizRounded /> : <WarningAmberRounded />}
          </IconBadge>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id="change-title" ref={headingRef} tabIndex={-1} variant="h3" component="h2" sx={{ outline: "none" }}>
              {title}
            </Typography>
            {!swap && offer.reasons.length ? (
              <Stack component="ul" spacing={0.5} sx={{ listStyle: "none", m: 0, mt: 0.75, p: 0 }}>
                {offer.reasons.map((r) => (
                  <Typography component="li" key={`${r.kind}-${r.sku}`} variant="body2" sx={{ fontWeight: 650, color: tones.warning.fg }}>
                    {r.message}
                  </Typography>
                ))}
              </Stack>
            ) : null}
          </Box>
        </Stack>

        <Typography sx={{ mt: 2.5 }}>{offer.explanation}</Typography>
        <MetaRow
          variant="caption"
          component="p"
          sx={{ mt: 0.5 }}
          items={[offer.explanation_source === "ai" ? { label: "AI-written explanation", icon: AutoAwesomeRounded } : null, "Replacement chosen by code"]}
        />

        {c.after ? (
          <Grid container spacing={{ xs: 2, sm: 2.5 }} sx={{ mt: 3, alignItems: "stretch" }}>
            <Grid size={{ xs: 12, sm: "grow" }}>
              <ComparePanel label="Before" total={money(c.before.total_minor, c.currency)}>
                {c.before.lines.map((l) => {
                  const gone = c.removed.some((r) => r.sku === l.sku);
                  return (
                    <Typography
                      component="li"
                      variant="body2"
                      key={l.sku}
                      sx={gone ? { color: "text.secondary", textDecoration: "line-through" } : undefined}
                    >
                      {l.qty} × {l.name}
                      {gone ? <span className="sr-only"> (removed)</span> : null}
                    </Typography>
                  );
                })}
              </ComparePanel>
            </Grid>
            <Grid size={{ xs: 12, sm: "auto" }} sx={{ display: { xs: "none", sm: "flex" }, alignItems: "center" }}>
              <EastRounded aria-hidden sx={{ color: brand.muted }} />
            </Grid>
            <Grid size={{ xs: 12, sm: "grow" }}>
              <ComparePanel
                label="Proposed"
                highlight
                total={money(c.after.total_minor, c.currency)}
                delta={<StatusChip tone={delta <= 0 ? "success" : "warning"} label={signedMoney(delta, c.currency)} icon={delta <= 0 ? CheckCircleRounded : WarningAmberRounded} />}
              >
                {c.after.lines.map((l) => {
                  const isNew = c.added.some((a) => a.sku === l.sku);
                  return (
                    <Typography component="li" variant="body2" key={l.sku} sx={{ fontWeight: isNew ? 650 : 400, display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
                      {l.qty} × {l.name}
                      {isNew ? (
                        <Box component="span" sx={{ borderRadius: "999px", bgcolor: brand.mint, color: brand.leafDark, px: 0.875, fontSize: 12, fontWeight: 700, lineHeight: "20px" }}>
                          New
                        </Box>
                      ) : null}
                    </Typography>
                  );
                })}
              </ComparePanel>
            </Grid>
          </Grid>
        ) : null}

        {c.added.length ? (
          <Stack spacing={2} sx={{ mt: 3 }}>
            {c.added.map((a) => (
              <Stack key={a.sku} direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
                <ProductImage image={a.image} size="sm" />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 650 }}>
                    {a.qty} × {a.name}{" "}
                    <Box component="span" className="tabular" sx={{ fontWeight: 400, color: "text.secondary" }}>
                      {money(a.unit_sale_minor)} each
                    </Box>
                  </Typography>
                  <Box sx={{ mt: 0.75 }}>
                    <AllergenTags allergens={a.allergens} />
                  </Box>
                </Box>
              </Stack>
            ))}
          </Stack>
        ) : null}

        <InfoList
          columns={3}
          sx={{ mt: 3 }}
          items={[
            { label: "Pickup", icon: ScheduleRounded, value: c.pickup.unchanged ? `${c.pickup.label} (unchanged)` : c.pickup.label },
            {
              label: "Budget",
              icon: AccountBalanceWalletRounded,
              value: c.budget_minor ? (
                c.within_budget ? (
                  `Within ${money(c.budget_minor, c.currency)}`
                ) : (
                  <Box component="span" sx={{ color: tones.warning.fg }}>
                    Over budget
                  </Box>
                )
              ) : (
                "No limit set"
              ),
            },
            {
              label: "Stock checked",
              icon: Inventory2Rounded,
              value: `${timeLabel(c.inventory_checked_at, zone)}${c.inventory_updated_at ? `, updated ${timeLabel(c.inventory_updated_at, zone)}` : ""}`,
            },
          ]}
        />

        {c.no_replacement ? (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 3.5 }}>
            <Button href={`/shops/${shopSlug}/bundles`} variant="contained" size="large" startIcon={<ArrowBackRounded />}>
              Choose another bundle
            </Button>
            <Button href={`/shops/${shopSlug}/browse`} variant="outlined" color="inherit" size="large" startIcon={<ShoppingBagRounded />}>
              Browse items
            </Button>
          </Stack>
        ) : (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 3.5 }}>
            <Button variant="contained" size="large" startIcon={<CheckCircleRounded />} loading={busy === "accept"} disabled={!!busy} onClick={onAccept}>
              {swap ? "Accept swap" : "Accept updated bundle"}
            </Button>
            <Button variant="outlined" color="inherit" size="large" startIcon={swap ? undefined : <RefreshRounded />} disabled={!!busy} onClick={onDismiss}>
              {swap ? "Keep my bundle" : "Choose another bundle"}
            </Button>
          </Stack>
        )}

        {offer.alternatives.length ? (
          <Box sx={{ mt: 4 }}>
            <Typography variant="subtitle2" component="h3" sx={{ mb: 1.75 }}>
              Other allowed options
            </Typography>
            <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
              {offer.alternatives.map((alt) => (
                <li key={`${alt.kind}-${alt.add_sku}`}>
                  <Card sx={{ height: "100%", boxShadow: shadows.raisedSm, borderRadius: "16px" }}>
                    <CardActionArea disabled={!!busy} onClick={() => onAlternative(alt.add_sku)} sx={{ height: "100%", p: 2, borderRadius: "16px" }}>
                      <Typography component="span" variant="body2" sx={{ display: "block", fontWeight: 650 }}>
                        {alt.kind === "remove" ? "Just remove it" : `${alt.add_qty} × ${alt.add_name}`}
                      </Typography>
                      <MetaRow
                        component="span"
                        sx={{ mt: 0.25, fontVariantNumeric: "tabular-nums" }}
                        items={[
                          `${money(alt.total_minor)} total`,
                          {
                            label: (
                              <Box component="span" sx={{ fontWeight: 650, color: alt.delta_minor <= 0 ? brand.leafDark : tones.warning.fg }}>
                                {signedMoney(alt.delta_minor)}
                              </Box>
                            ),
                          },
                        ]}
                      />
                    </CardActionArea>
                  </Card>
                </li>
              ))}
            </Box>
          </Box>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ComparePanel({ label, total, delta, highlight, children }: { label: string; total: string; delta?: React.ReactNode; highlight?: boolean; children: React.ReactNode }) {
  return (
    <Box sx={{ ...surface.inset, height: "100%", display: "flex", flexDirection: "column", borderRadius: "18px", p: 2.25 }}>
      <Typography variant="overline" component="p" sx={{ color: highlight ? brand.leafDark : "text.secondary", lineHeight: 1.4 }}>
        {label}
      </Typography>
      <Stack component="ul" spacing={0.5} sx={{ listStyle: "none", m: 0, mt: 1, p: 0, flex: 1 }}>
        {children}
      </Stack>
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Typography className="tabular" sx={{ fontWeight: 800 }}>
          {total}
        </Typography>
        {delta}
      </Stack>
    </Box>
  );
}
