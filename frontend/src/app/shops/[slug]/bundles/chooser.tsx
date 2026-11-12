"use client";

import {
  AccountBalanceWalletRounded,
  AutoAwesomeRounded,
  BlockRounded,
  CategoryRounded,
  CelebrationRounded,
  CheckCircleRounded,
  EditRounded,
  ExpandMoreRounded,
  GroupsRounded,
  HelpOutlineRounded,
  ManageSearchRounded,
  NoFoodRounded,
  PlaylistRemoveRounded,
  SavingsRounded,
  ScheduleRounded,
  SearchOffRounded,
  ShoppingBagRounded,
  StarRounded,
  TuneRounded,
  VerifiedRounded,
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
  Card,
  CardContent,
  Grid,
  LinearProgress,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { AllergenTags, PriceBreakdown } from "@/components/commerce";
import { ProductImage } from "@/components/product-image";
import { FlowSteps, PageShell } from "@/components/site";
import { EmptyState, ErrorState, FactChip, IconBadge, InfoTip, MetaRow, PageHeader, SlowNotice, StatusChip, brand, surface, tones, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { flow, useFlowSnapshot } from "@/lib/flow";
import { ALLERGEN_LABEL, hhmmLabel, money, timeLabel } from "@/lib/format";
import type { BundleOption, Controls, Intent, ParseResponse, Proposal, Quote } from "@/lib/types";
import { useResource } from "@/lib/use-api";

// Proposals cost a model call; share one in-flight request per intent (StrictMode re-runs effects).
const inflight = new Map<string, { at: number; promise: Promise<Proposal> }>();
function proposeOnce(intentId: string): Promise<Proposal> {
  const hit = inflight.get(intentId);
  if (hit && Date.now() - hit.at < 15_000) return hit.promise;
  const promise = api<Proposal>("/api/bundles/propose", { body: { intent_id: intentId }, timeoutMs: 60_000 });
  inflight.set(intentId, { at: Date.now(), promise });
  promise.catch(() => inflight.delete(intentId));
  return promise;
}

const COMPONENT_LABEL: Record<string, string> = {
  preference_fit: "Matches your preferences",
  variety: "Variety",
  value: "Value vs. regular price",
  surplus_priority: "Helps clear today's surplus",
  portion_fit: "Portion fit",
};

const KIND_ICON: Record<BundleOption["kind"], Icon> = { best_fit: StarRounded, budget_pick: SavingsRounded, most_variety: CategoryRounded };
const FIT_ICON: Record<string, Icon> = { party: GroupsRounded, exclusions: VerifiedUserRounded, budget: AccountBalanceWalletRounded };

function allergenName(code: string): string {
  return ALLERGEN_LABEL[code]?.toLowerCase() ?? code;
}

export function BundleChooser({ slug }: { slug: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const announce = useAnnounce();
  const saved = useFlowSnapshot();
  // A saved request id is only reused at the shop it was made for.
  const intentId = params.get("intent") ?? (saved?.merchant === slug ? saved.intentId : undefined) ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const viewed = useRef<string | null>(null);

  const proposal = useResource(() => proposeOnce(intentId as string), [intentId], { enabled: !!intentId });
  const data = proposal.data;
  const zone = data?.merchant.timezone;
  const retry = () => {
    if (intentId) inflight.delete(intentId);
    proposal.reload();
  };

  // Options always come from the shop the request was made at; keep the URL on that shop.
  const otherShop = data && data.merchant.slug !== slug ? data.merchant.slug : null;
  useEffect(() => {
    if (otherShop && intentId) router.replace(`/shops/${otherShop}/bundles?intent=${intentId}`);
  }, [otherShop, intentId, router]);

  useEffect(() => {
    if (data && data.options.length && viewed.current !== data.proposal_id) {
      viewed.current = data.proposal_id;
      announce(`${data.options.length} bundle options ready.`);
      void api("/api/events", { body: { name: "bundle_viewed", entity_type: "proposal", entity_id: data.proposal_id, merchant: data.merchant.slug } }).catch(() => {});
    } else if (data?.no_match) {
      announce(`No bundle fits: ${data.no_match.headline}`);
    }
  }, [data, announce]);

  async function choose(option: BundleOption, slotId: string | null, customize = false) {
    if (!data) return;
    setBusy(option.id + (customize ? ":c" : ""));
    setActionError(null);
    try {
      const quote = await api<Quote>("/api/quotes", { body: { proposal_id: data.proposal_id, option_id: option.id, pickup_slot_id: slotId } });
      router.push(`/review/${quote.id}${customize ? "?customize=1" : ""}`);
    } catch (err) {
      setActionError(errorMessage(err));
      announce(errorMessage(err), "assertive");
      retry();
    } finally {
      setBusy(null);
    }
  }

  async function applySuggestion(patch: Partial<Controls>) {
    setBusy("suggestion");
    setActionError(null);
    try {
      const saved = flow.get();
      // Start from this shop's saved request, or else from the request these options were built for.
      const base: Controls =
        saved.merchant === slug && saved.controls
          ? saved.controls
          : data
            ? { party_size: data.intent.party_size, budget_minor: data.intent.budget_minor, exclusions: data.intent.exclusions, occasion: data.intent.occasion,
                preferences: data.intent.preferences, pickup_window: data.intent.pickup_window, pickup_date: data.intent.pickup_date }
            : {};
      const controls = { ...base, ...patch };
      const parsed = await api<ParseResponse>("/api/intents/parse", {
        body: { text: saved.merchant === slug ? (saved.text ?? "") : "", controls, use_ai: false, persist: true, merchant: slug },
      });
      flow.set({ merchant: slug, controls, intentId: parsed.intent_id ?? undefined });
      if (parsed.state === "ready" && parsed.intent_id) {
        router.replace(`/shops/${slug}/bundles?intent=${parsed.intent_id}`);
      } else {
        router.push(`/shops/${slug}/build`);
      }
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!intentId && saved !== null) {
    return (
      <PageShell>
        <FlowSteps active={1} />
        <EmptyState
          icon={ManageSearchRounded}
          headingComponent="h1"
          title="Tell us what you need first"
          action={
            <Button href={`/shops/${slug}/build`} variant="contained">
              Describe your occasion
            </Button>
          }
        >
          We couldn&apos;t find your request. It may have expired.
        </EmptyState>
      </PageShell>
    );
  }

  return (
    <PageShell shop={data ? { slug: data.merchant.slug, name: data.merchant.name } : undefined}>
      <FlowSteps active={1} />
      <PageHeader
        eyebrow={data?.merchant.name}
        title="Pick your bundle"
        subtitle={data && data.options.length ? `${data.options.length} options built from today's surplus.` : undefined}
        chips={data ? <RequestChips intent={data.intent} /> : undefined}
        actions={
          <Button href={`/shops/${slug}/build`} variant="outlined" color="inherit" startIcon={<EditRounded />}>
            Edit request
          </Button>
        }
      />

      {actionError ? (
        <Alert severity="error" role="alert" sx={{ mb: 3 }}>
          <AlertTitle>That didn&apos;t work</AlertTitle>
          {actionError}
        </Alert>
      ) : null}

      {proposal.loading && !data ? <ProposalLoading slow={proposal.slow} /> : null}

      {proposal.error && !data ? <ErrorState title="We couldn't build bundles" message={errorMessage(proposal.error)} onRetry={retry} /> : null}

      {data?.no_match ? (
        <Card component="section" aria-labelledby="nomatch-title">
          <CardContent sx={{ p: { xs: 2.5, sm: 3 }, "&:last-child": { pb: { xs: 2.5, sm: 3 } } }}>
            <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
              <IconBadge tone="warning" size={44}>
                <SearchOffRounded />
              </IconBadge>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography id="nomatch-title" variant="h3" component="h2">
                  No bundle fits right now
                </Typography>
                <Stack component="ul" spacing={0.75} sx={{ listStyle: "none", m: 0, mt: 1.5, p: 0 }}>
                  {data.no_match.reasons.map((r) => (
                    <Box component="li" key={r} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                      <WarningAmberRounded aria-hidden sx={{ fontSize: 18, mt: "2px", color: tones.warning.fg }} />
                      <Typography variant="body2">{r}</Typography>
                    </Box>
                  ))}
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                  We never relax a dietary requirement. Adjust your request instead:
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1.5 }}>
                  {data.no_match.suggestions.map((s) => {
                    if (s.action === "browse") {
                      return (
                        <Button key={s.label} href={`/shops/${slug}/browse`} variant="outlined" color="inherit" startIcon={<ShoppingBagRounded />}>
                          {s.label}
                        </Button>
                      );
                    }
                    const patch: Partial<Controls> =
                      s.action === "set_budget"
                        ? { budget_minor: Number(s.value) }
                        : s.action === "set_party_size"
                          ? { party_size: Number(s.value) }
                          : s.action === "set_pickup" && Array.isArray(s.value)
                            ? { pickup_window: [s.value[0], s.value[1]], pickup_date: s.date ?? null }
                            : {};
                    return (
                      <Button key={s.label} variant="outlined" startIcon={<TuneRounded />} loading={busy === "suggestion"} onClick={() => applySuggestion(patch)}>
                        {s.label}
                      </Button>
                    );
                  })}
                </Stack>
              </Box>
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      {data && data.options.length ? (
        <>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", mb: 3 }}>
            <MetaRow items={[`Stock checked ${timeLabel(data.inventory_as_of, zone)}`, data.ai.used ? "Explanations written by AI" : null]} />
            <InfoTip
              label="About these bundles"
              title={
                data.ai.used
                  ? `Prices, stock and allergen facts come from ${data.merchant.name}'s records. Short explanations are written by AI and filtered so they can't make dietary or price claims.`
                  : `Prices, stock and allergen facts come from ${data.merchant.name}'s records.`
              }
            />
          </Stack>
          <Grid container spacing={3}>
            {data.options.map((option) => (
              <Grid key={option.id} size={{ xs: 12, md: 6, lg: 4 }}>
                <BundleCard option={option} budget={data.intent.budget_minor} busy={busy} onChoose={choose} />
              </Grid>
            ))}
          </Grid>
        </>
      ) : null}

      {data && data.excluded.length ? <ExcludedItems excluded={data.excluded} /> : null}
    </PageShell>
  );
}

function ProposalLoading({ slow }: { slow: boolean }) {
  return (
    <Box role="status" aria-live="polite">
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 2.5 }}>
        <AutoAwesomeRounded aria-hidden sx={{ color: brand.leaf, fontSize: 20 }} />
        <Typography sx={{ fontWeight: 650 }}>Building bundles from today&apos;s surplus…</Typography>
      </Stack>
      <Grid container spacing={3}>
        {[0, 1, 2].map((i) => (
          <Grid key={i} size={{ xs: 12, md: 6, lg: 4 }}>
            <Card>
              <CardContent sx={{ p: { xs: 2.5, sm: 3 }, "&:last-child": { pb: { xs: 2.5, sm: 3 } } }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                  <Skeleton variant="circular" width={40} height={40} />
                  <Box sx={{ flex: 1 }}>
                    <Skeleton width="45%" />
                    <Skeleton width="65%" />
                  </Box>
                </Stack>
                <Skeleton variant="rounded" height={36} width="55%" sx={{ mt: 2.5 }} />
                {[0, 1, 2].map((row) => (
                  <Stack key={row} direction="row" spacing={1.5} sx={{ alignItems: "center", mt: 1.5 }}>
                    <Skeleton variant="rounded" width={52} height={44} />
                    <Skeleton sx={{ flex: 1 }} />
                  </Stack>
                ))}
                <Skeleton variant="rounded" height={48} sx={{ mt: 3 }} />
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
      {slow ? <SlowNotice /> : null}
    </Box>
  );
}

/** The request as chips. Text stays lowercase in the DOM ("no tree nuts (strict)"); CSS capitalizes it. */
function RequestChips({ intent }: { intent: Intent }) {
  const chips: { icon: Icon; label: string }[] = [];
  if (intent.party_size) chips.push({ icon: GroupsRounded, label: `${intent.party_size} ${intent.party_size === 1 ? "person" : "people"}` });
  if (intent.occasion) chips.push({ icon: CelebrationRounded, label: intent.occasion });
  if (intent.budget_minor) chips.push({ icon: AccountBalanceWalletRounded, label: `under ${money(intent.budget_minor, intent.currency)}` });
  for (const e of intent.exclusions) {
    chips.push({ icon: NoFoodRounded, label: `no ${allergenName(e.code)} (${e.severity === "preference" ? "preference" : "strict"})` });
  }
  if (intent.pickup_window) chips.push({ icon: ScheduleRounded, label: `pickup ${hhmmLabel(intent.pickup_window[0])}–${hhmmLabel(intent.pickup_window[1])}` });
  return (
    <>
      {chips.map((chip) => (
        <FactChip key={chip.label} icon={chip.icon} label={chip.label} sx={{ "& .MuiChip-label::first-letter": { textTransform: "uppercase" } }} />
      ))}
    </>
  );
}

function BundleCard({ option, budget, busy, onChoose }: {
  option: BundleOption;
  budget: number | null;
  busy: string | null;
  onChoose: (o: BundleOption, slot: string | null, customize?: boolean) => void;
}) {
  const [slotId, setSlotId] = useState(option.default_slot_id);
  const detailsId = useId();
  const sweet = option.lines.filter((l) => l.flavor === "sweet").reduce((n, l) => n + l.qty, 0);
  const savory = option.units - sweet;
  const featured = option.kind === "best_fit";
  const totals = option.totals;
  const currency = totals.currency;
  const percentOff = totals.reference_minor > 0 ? Math.round((totals.discount_minor / totals.reference_minor) * 100) : 0;
  const contains = [...new Set(option.lines.flatMap((l) => l.allergens.contains))];
  const mayContain = [...new Set(option.lines.flatMap((l) => l.allergens.cross_contact))];
  const unverified = option.lines.filter((l) => l.allergens.status !== "verified");
  // One provenance line when every item shares the same verified source; otherwise per item.
  const sources = new Set(option.lines.map((l) => `${l.allergens.status}|${l.allergens.source_label}`));
  const sharedSource = sources.size === 1 && option.lines[0]?.allergens.status === "verified" ? option.lines[0].allergens.source_label : null;
  // Pickup and savings are shown by the pickup picker and the price; budget gets a meter.
  const fits = option.fits.filter((f) => f.key !== "pickup" && f.key !== "savings" && !(f.key === "budget" && budget));
  const KindIcon = KIND_ICON[option.kind] ?? StarRounded;
  const titleId = `${option.id}-title`;

  return (
    <Card component="article" aria-labelledby={titleId} sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 2.75, flex: 1, p: { xs: 2.5, sm: 3 }, "&:last-child": { pb: { xs: 2.5, sm: 3 } } }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <IconBadge tone={featured ? "success" : "neutral"} size={40}>
            <KindIcon />
          </IconBadge>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id={titleId} variant="h4" component="h2">
              {option.label}
            </Typography>
            <MetaRow items={[`${option.units} items`, sweet && savory ? `${sweet} sweet, ${savory} savory` : null]} />
          </Box>
          {option.origin === "ai_candidate" ? <StatusChip tone="info" icon={AutoAwesomeRounded} label="AI pick" /> : null}
        </Stack>

        <Stack direction="row" spacing={1.25} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography variant="h2" component="p" className="tabular">
            {money(totals.total_minor, currency)}
          </Typography>
          {totals.discount_minor > 0 ? (
            <StatusChip tone="success" icon={SavingsRounded} label={`Save ${money(totals.discount_minor, currency)}${percentOff ? ` (${percentOff}%)` : ""}`} />
          ) : null}
        </Stack>

        <Box component="ul" aria-label="Items in this bundle" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 1.25 }}>
          {option.lines.map((line) => (
            <Box component="li" key={line.sku} sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
              <ProductImage image={line.image} size="sm" sx={{ width: 52, height: 44 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 650, lineHeight: 1.35 }}>
                  {line.qty} × {line.name}
                </Typography>
                <MetaRow
                  variant="caption"
                  component="p"
                  sx={{ fontVariantNumeric: "tabular-nums" }}
                  items={[
                    {
                      label: (
                        <span>
                          {money(line.unit_sale_minor)} each{" "}
                          <Box component="s" sx={{ ml: 0.25 }}>
                            <span className="sr-only">regular price </span>
                            {money(line.unit_reference_minor)}
                          </Box>
                        </span>
                      ),
                    },
                    line.stock_limited ? `Last ${line.available} listed today` : null,
                  ]}
                />
              </Box>
              <Typography variant="body2" className="tabular" sx={{ fontWeight: 650 }}>
                {money(line.line_total_minor)}
              </Typography>
            </Box>
          ))}
        </Box>

        <Stack spacing={1.5}>
          {budget ? <BudgetMeter total={totals.total_minor} budget={budget} currency={currency} /> : null}
          {fits.length ? (
            <Stack component="ul" spacing={1} aria-label="Why it fits your request" sx={{ listStyle: "none", m: 0, p: 0 }}>
              {fits.map((fit) => {
                const FitIcon = fit.ok ? (FIT_ICON[fit.key] ?? CheckCircleRounded) : WarningAmberRounded;
                return (
                  <Box component="li" key={fit.key} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                    <FitIcon aria-hidden sx={{ fontSize: 18, mt: "2px", color: fit.ok ? brand.leaf : tones.warning.fg }} />
                    <Typography variant="body2">
                      {fit.label}
                      {fit.source ? (
                        <Box component="span" sx={{ color: "text.secondary", ml: 0.75 }}>
                          <span className="sr-only">, </span>
                          {fit.source}
                        </Box>
                      ) : null}
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          ) : null}
          {contains.length ? (
            <Typography variant="caption" color="text.secondary" component="p">
              <Box component="span" sx={{ fontWeight: 650, color: "text.primary" }}>
                Contains:
              </Box>{" "}
              {contains.map(allergenName).join(", ")}
            </Typography>
          ) : null}
          {mayContain.length ? (
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
              {mayContain.map((code) => (
                <StatusChip key={code} tone="warning" icon={WarningAmberRounded} label={`May contain ${allergenName(code)}`} />
              ))}
            </Stack>
          ) : null}
          {unverified.length ? (
            <Typography variant="caption" component="p" sx={{ display: "flex", gap: 0.5, alignItems: "flex-start", fontWeight: 650, color: tones.warning.fg }}>
              <HelpOutlineRounded aria-hidden sx={{ fontSize: 16, mt: "1px" }} />
              Allergen info not verified: {unverified.map((l) => l.name).join(", ")}
            </Typography>
          ) : null}
        </Stack>

        <Accordion sx={{ "&, &:first-of-type, &:last-of-type": { borderRadius: "16px" } }}>
          <AccordionSummary expandIcon={<ExpandMoreRounded />} id={`${detailsId}-summary`} aria-controls={`${detailsId}-details`} sx={{ minHeight: 48, px: 2 }}>
            <Typography variant="subtitle2" component="span">
              Details
            </Typography>
            <Typography variant="caption" color="text.secondary" component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
              Why these items, allergens and price
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 2 }}>
            <Stack spacing={3}>
              <Box>
                <Typography variant="subtitle2" component="h4" sx={{ mb: 0.75 }}>
                  Why these items
                </Typography>
                <Typography variant="body2">{option.rationale.text}</Typography>
                <MetaRow
                  variant="caption"
                  component="p"
                  sx={{ mt: 0.5 }}
                  items={[option.rationale.source === "ai" ? { label: "Written by AI, checked by LastCall", icon: AutoAwesomeRounded } : null, option.why]}
                />
                <ScoreBreakdown components={option.score.components} />
              </Box>
              <Box>
                <Typography variant="subtitle2" component="h4" sx={{ mb: 1 }}>
                  Allergens by item
                </Typography>
                <Stack component="ul" spacing={1.5} sx={{ listStyle: "none", m: 0, p: 0 }}>
                  {option.lines.map((line) => (
                    <li key={line.sku}>
                      <Typography variant="body2" sx={{ fontWeight: 650, mb: 0.5 }}>
                        {line.name}
                      </Typography>
                      <AllergenTags allergens={line.allergens} compact={!!sharedSource} />
                    </li>
                  ))}
                </Stack>
                {sharedSource ? (
                  <Typography variant="caption" component="p" sx={{ mt: 1.25, display: "flex", gap: 0.5, alignItems: "flex-start", color: brand.leafDark }}>
                    <VerifiedRounded aria-hidden sx={{ fontSize: 15, mt: "1px" }} />
                    {sharedSource}
                  </Typography>
                ) : null}
              </Box>
              <Box>
                <Typography variant="subtitle2" component="h4" sx={{ mb: 1 }}>
                  Price breakdown
                </Typography>
                <PriceBreakdown totals={totals} currency={currency} referenceNote="Regular prices are the shop's own menu prices." />
              </Box>
            </Stack>
          </AccordionDetails>
        </Accordion>

        <Stack spacing={1.25} sx={{ mt: "auto" }}>
          <TextField
            select
            fullWidth
            size="small"
            label="Pickup time"
            value={slotId ?? ""}
            onChange={(e) => setSlotId(e.target.value)}
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          >
            {option.pickup_slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.remaining} left)
              </option>
            ))}
          </TextField>
          <Button
            variant="contained"
            size="large"
            fullWidth
            loading={busy === option.id}
            disabled={!!busy && busy !== option.id}
            onClick={() => onChoose(option, slotId)}
          >
            Choose bundle
          </Button>
          <Button
            variant="text"
            color="inherit"
            size="small"
            fullWidth
            startIcon={<TuneRounded />}
            loading={busy === `${option.id}:c`}
            disabled={!!busy}
            onClick={() => onChoose(option, slotId, true)}
          >
            Customize items
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function BudgetMeter({ total, budget, currency }: { total: number; budget: number; currency?: string }) {
  const over = total > budget;
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center", mb: 0.75 }}>
        <Typography variant="body2" sx={{ fontWeight: 650, display: "flex", alignItems: "center", gap: 0.75 }}>
          <AccountBalanceWalletRounded aria-hidden sx={{ fontSize: 18, color: over ? tones.warning.fg : brand.leaf }} />
          Budget
        </Typography>
        <Typography variant="body2" className="tabular" sx={{ fontWeight: 650 }}>
          {money(total, currency)}{" "}
          <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>
            of {money(budget, currency)}
          </Box>
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, (total / budget) * 100)}
        color={over ? "warning" : "primary"}
        aria-label={`Budget used: ${money(total, currency)} of ${money(budget, currency)}`}
        sx={{ height: 6 }}
      />
    </Box>
  );
}

function ScoreBreakdown({ components }: { components: BundleOption["score"]["components"] }) {
  return (
    <Box sx={{ mt: 1.75 }}>
      <Box component="ul" aria-label="Score breakdown" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 1.25 }}>
        {Object.entries(components).map(([name, c]) => {
          const label = COMPONENT_LABEL[name] ?? name;
          return (
            <li key={name}>
              <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between" }}>
                <Typography variant="caption" sx={{ fontWeight: 650 }}>
                  {label}
                </Typography>
                <Typography variant="caption" color="text.secondary" className="tabular">
                  {Math.round(c.score * 100)}% (weight {Math.round(c.weight * 100)}%)
                </Typography>
              </Stack>
              <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, c.score * 100))} aria-label={`${label} score`} sx={{ height: 5, my: 0.5 }} />
              <Typography variant="caption" color="text.secondary" component="p">
                {c.detail}
              </Typography>
            </li>
          );
        })}
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.25 }}>
        Ranked by this recorded score, never a hidden AI confidence. The lowest-priced option is always shown.
      </Typography>
    </Box>
  );
}

function ExcludedItems({ excluded }: { excluded: Proposal["excluded"] }) {
  const id = useId();
  return (
    <Accordion sx={{ mt: 5 }} slotProps={{ heading: { component: "h2" } }}>
      <AccordionSummary expandIcon={<ExpandMoreRounded />} id={`${id}-summary`} aria-controls={`${id}-details`}>
        <Box component="span" aria-hidden sx={{ ...surface.raisedSm, display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: "50%", color: brand.forest, flexShrink: 0 }}>
          <PlaylistRemoveRounded sx={{ fontSize: 18 }} />
        </Box>
        <Box component="span">
          <Typography variant="subtitle1" component="span" sx={{ fontWeight: 700, display: "block" }}>
            Not included ({excluded.length})
          </Typography>
          <Typography variant="caption" color="text.secondary" component="span" sx={{ display: "block" }}>
            Left out on purpose. We never force a match.
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 2.25 }}>
          {excluded.map((e) => (
            <Box component="li" key={e.sku} sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: { xs: 0.5, sm: 2 } }}>
              <Typography variant="body2" sx={{ fontWeight: 650, flexBasis: { sm: 240 }, flexShrink: 0 }}>
                {e.name}
              </Typography>
              <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                {e.reasons.map((reason) => (
                  <Typography key={reason} variant="body2" color="text.secondary" sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
                    <BlockRounded aria-hidden sx={{ fontSize: 16, mt: "3px" }} />
                    {reason}
                  </Typography>
                ))}
              </Stack>
            </Box>
          ))}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}
