"use client";

import {
  ArrowBackRounded,
  ArrowForwardRounded,
  AutoAwesomeRounded,
  CheckRounded,
  ConfirmationNumberRounded,
  EventBusyRounded,
  Inventory2Rounded,
  PauseCircleRounded,
  PaymentsRounded,
  PlaceRounded,
  RemoveShoppingCartRounded,
  RouteRounded,
  ScheduleRounded,
  SearchOffRounded,
  SearchRounded,
  ShoppingBagRounded,
  StorefrontRounded,
  TuneRounded,
  UpdateRounded,
  VerifiedRounded,
} from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControlLabel,
  Grid,
  InputAdornment,
  Link,
  Skeleton,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
  useMediaQuery,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { useAccount } from "@/components/account";
import { ProductImage } from "@/components/product-image";
import { PageShell } from "@/components/site";
import { EmptyState, ErrorState, FilterChip, InfoList, InfoTip, MetaRow, QuantityStepper, SectionCard, SlowNotice, StatusChip, brand, surface } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { flow } from "@/lib/flow";
import { ago, money } from "@/lib/format";
import type { CatalogItem, Controls, Exclusion, MerchantPublic, MyOrdersResponse, Slot } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const EXAMPLES = ["Snacks for 4 people under $18, no nuts", "Breakfast for 2, something sweet", "Bread for a dinner for 6"];
const DIETARY: { key: string; label: string; codes: string[] }[] = [
  { key: "nuts", label: "No nuts", codes: ["tree_nuts", "peanuts"] },
  { key: "dairy", label: "Dairy-free", codes: ["milk"] },
  { key: "gluten", label: "Gluten-free", codes: ["wheat"] },
  { key: "eggs", label: "Egg-free", codes: ["eggs"] },
];
const STEPS = [
  { title: "Describe it", body: "People, budget, dietary needs, pickup time." },
  { title: "Pick a verified bundle", body: "Real stock and prices. You approve any swap." },
  { title: "Pay with PayPal, pick up", body: "Items are held while you pay." },
];

const fieldset = { border: 0, p: 0, m: 0, minWidth: 0 } as const;

export function Storefront({ slug }: { slug: string }) {
  const router = useRouter();
  const { version } = useAccount();
  const merchant = useResource((signal) => api<MerchantPublic>(`/api/merchants/${slug}`, { signal }), [slug]);
  const slots = useResource((signal) => api<{ slots: Slot[] }>(`/api/merchants/${slug}/pickup-slots`, { signal }), [slug]);
  // An unfinished pickup at this shop (signed-in customer, or this browser's guest session).
  const mine = useResource((signal) => api<MyOrdersResponse>("/api/me/orders", { signal }), [version]);
  const [text, setText] = useState("");
  const [people, setPeople] = useState(4);
  const [peopleSet, setPeopleSet] = useState(false); // the typed request decides until the shopper changes it here
  const phone = useMediaQuery((theme: Theme) => theme.breakpoints.down("sm"), { noSsr: true });
  const [moreDetails, setMoreDetails] = useState(false);
  const showDetails = !phone || moreDetails;
  const [useBudget, setUseBudget] = useState(false);
  const [budget, setBudget] = useState(18);
  const [dietary, setDietary] = useState<string[]>([]);
  const [slotId, setSlotId] = useState<string>("any");
  const inputId = useId();

  const m = merchant.data;
  const bookable = (slots.data?.slots ?? []).filter((s) => s.bookable);
  const returning = mine.data?.orders.find((o) => o.active && o.merchant.slug === slug) ?? null;
  const notFound = merchant.error instanceof ApiError && merchant.error.status === 404;

  function start() {
    const exclusions: Exclusion[] = DIETARY.filter((d) => dietary.includes(d.key)).flatMap((d) => d.codes.map((code) => ({ code, severity: "needs_confirmation" as const })));
    const slot = bookable.find((s) => s.id === slotId);
    const controls: Controls = {
      party_size: peopleSet ? people : null,
      budget_minor: useBudget ? budget * 100 : null,
      exclusions,
      pickup_window: slot ? [slot.start_local, slot.end_local] : null,
      pickup_date: slot ? slot.date_local : null,
    };
    flow.set({ merchant: slug, text, controls, intentId: undefined });
    router.push(`/shops/${slug}/build?start=1`);
  }

  if (notFound) {
    return (
      <PageShell width="narrow">
        <EmptyState
          icon={SearchOffRounded}
          headingComponent="h1"
          title="We couldn't find that shop"
          action={
            <Button href="/" variant="contained" startIcon={<ArrowBackRounded />}>
              All shops
            </Button>
          }
        >
          The link may be out of date, or the shop is no longer listed.
        </EmptyState>
      </PageShell>
    );
  }

  return (
    <PageShell shop={m ? { slug, name: m.name } : undefined}>
      {returning ? (
        <Alert severity="success" role="status" icon={<ConfirmationNumberRounded />} sx={{ mb: 3 }}>
          <AlertTitle>Your order {returning.number}</AlertTitle>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" } }}>
            <MetaRow
              color="inherit"
              items={[returning.status.title, { label: `Pickup ${returning.pickup.date_label}, ${returning.pickup.label}`, icon: ScheduleRounded }]}
            />
            <Button href={`/orders/${returning.id}`} size="small" variant="outlined" color="inherit" endIcon={<ArrowForwardRounded />} sx={{ alignSelf: "flex-start" }}>
              View pickup pass
            </Button>
          </Stack>
        </Alert>
      ) : null}

      <Grid container spacing={{ xs: 3, lg: 5 }}>
        <Grid size={{ xs: 12, lg: 7 }} component="section" aria-labelledby="hero-title" sx={{ minWidth: 0 }}>
          <Button href="/" size="small" color="inherit" startIcon={<ArrowBackRounded />} sx={{ color: "text.secondary", ml: -1, mb: 1, minHeight: 32 }}>
            All shops
          </Button>
          {m ? (
            <MetaRow sx={{ fontWeight: 600 }} items={[{ label: m.category, icon: StorefrontRounded }, { label: m.address.city, icon: PlaceRounded }]} />
          ) : (
            <Skeleton variant="rounded" width={180} height={22} sx={{ borderRadius: "999px" }} />
          )}
          <Typography id="hero-title" variant="h1" sx={{ mt: 1 }}>
            {m ? m.name : merchant.error ? "Shop" : <Skeleton width="70%" />}
          </Typography>
          {m || !merchant.error ? (
            <Typography color="text.secondary" sx={{ mt: 1, fontSize: "1.05rem", maxWidth: 560 }}>
              {m ? `${m.tagline}. Today's surplus, below menu price.` : <Skeleton width="85%" />}
            </Typography>
          ) : null}
          <PickupStatus merchant={m} loading={merchant.loading} slow={merchant.slow} />
          {m ? <TodaysSurplus slug={slug} /> : null}
          {merchant.error ? <ErrorState sx={{ mt: 2.5 }} title="Couldn't load this shop" message={errorMessage(merchant.error)} onRetry={merchant.reload} /> : null}

          <Card sx={{ mt: 3.5 }}>
            <CardContent sx={{ p: { xs: "20px", sm: "30px" }, "&:last-child": { pb: { xs: "20px", sm: "30px" } } }}>
              <Box component="form" aria-labelledby={`${inputId}-label`} onSubmit={(e: React.FormEvent) => { e.preventDefault(); start(); }}>
                <Typography id={`${inputId}-label`} component="label" htmlFor={inputId} variant="h3" sx={{ display: "block", mb: 1.25 }}>
                  What are you shopping for?
                </Typography>
                <TextField
                    id={inputId}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="e.g. snacks for 4, under $18, no nuts"
                    fullWidth
                    slotProps={{
                      htmlInput: { maxLength: 600 },
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">
                            <SearchRounded aria-hidden sx={{ color: "text.secondary" }} />
                          </InputAdornment>
                        ),
                        sx: { fontSize: "1.02rem", minHeight: 52 },
                      },
                    }}
                  />
                <Stack direction="row" spacing={1.25} useFlexGap role="group" aria-label="Example requests" sx={{ flexWrap: "wrap", mt: 2 }}>
                  {EXAMPLES.map((example) => (
                    <Chip
                      key={example}
                      component="button"
                      type="button"
                      clickable
                      label={example}
                      onClick={() => setText(example)}
                      sx={{ ...surface.raisedSm, color: brand.forest, fontWeight: 550, height: 32, "&:hover": { bgcolor: "#ECF1EE !important" } }}
                    />
                  ))}
                </Stack>

                {showDetails ? <Divider sx={{ my: 3.5 }} /> : (
                  <Button type="button" color="inherit" startIcon={<TuneRounded />} onClick={() => setMoreDetails(true)} sx={{ mt: 1.5, ml: -1 }}>
                    Add people, budget or allergies
                  </Button>
                )}

                {showDetails ? (
                <Grid container spacing={3}>
                  <Grid size={{ xs: 12, sm: 5 }}>
                    <QuantityStepper label="People" value={people} onChange={(v) => { setPeople(v); setPeopleSet(true); }} min={1} max={40}
                      hint={peopleSet ? undefined : "Or say it in your request"} />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 7 }}>
                    <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 0.25 }}>
                      <Typography id={`${inputId}-budget`} variant="subtitle2">
                        Budget
                      </Typography>
                      <FormControlLabel
                        control={<Switch size="small" checked={useBudget} onChange={(e) => setUseBudget(e.target.checked)} />}
                        label="Set a maximum"
                        slotProps={{ typography: { variant: "body2" } }}
                        sx={{ mr: 0 }}
                      />
                    </Stack>
                    <Stack direction="row" spacing={2} sx={{ alignItems: "center", pl: 1 }}>
                      <Slider
                        aria-labelledby={`${inputId}-budget`}
                        value={budget}
                        min={5}
                        max={60}
                        step={1}
                        disabled={!useBudget}
                        onChange={(_, value) => setBudget(value as number)}
                        getAriaValueText={(value) => (useBudget ? `${money(value * 100)} maximum` : "No budget limit")}
                      />
                      <Typography component="output" className="tabular" sx={{ minWidth: 60, textAlign: "right", fontWeight: 750, fontSize: "1.05rem" }}>
                        {useBudget ? money(budget * 100) : "Any"}
                      </Typography>
                    </Stack>
                  </Grid>

                  <Grid size={12}>
                    <Box component="fieldset" sx={fieldset}>
                      <Typography component="legend" variant="subtitle2" sx={{ p: 0, display: "flex", alignItems: "center" }}>
                        Dietary needs
                        <InfoTip label="About dietary needs" title="Before showing bundles we ask whether each one is a strict allergy." />
                      </Typography>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
                        {DIETARY.map((d) => (
                          <FilterChip
                            key={d.key}
                            label={d.label}
                            selected={dietary.includes(d.key)}
                            onClick={() => setDietary((cur) => (cur.includes(d.key) ? cur.filter((x) => x !== d.key) : [...cur, d.key]))}
                          />
                        ))}
                      </Stack>
                    </Box>
                  </Grid>

                  <Grid size={12}>
                    <Typography component="label" htmlFor={`${inputId}-slot`} variant="subtitle2" sx={{ display: "block", mb: 0.75 }}>
                      Pickup window
                    </Typography>
                    <TextField
                      id={`${inputId}-slot`}
                      select
                      fullWidth
                      value={slotId}
                      onChange={(e) => setSlotId(e.target.value)}
                      helperText={slots.data && bookable.length === 0 ? "No pickup slots are open right now." : undefined}
                      slotProps={{ select: { native: true } }}
                    >
                      <option value="any">Any available time</option>
                      {bookable.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label} ({s.remaining} {s.remaining === 1 ? "spot" : "spots"} left)
                        </option>
                      ))}
                    </TextField>
                  </Grid>
                </Grid>
                ) : null}

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: showDetails ? 3.5 : 2.5 }}>
                  <Button type="submit" variant="contained" size="large" startIcon={<AutoAwesomeRounded />} sx={{ flex: { sm: 1 } }}>
                    Build my bundle
                  </Button>
                  <Button href={`/shops/${slug}/browse`} variant="outlined" color="inherit" size="large" startIcon={<ShoppingBagRounded />}>
                    See available items
                  </Button>
                </Stack>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }} component="aside" aria-label="About this shop">
          <Stack spacing={3}>
            <MerchantTrust merchant={m} slug={slug} />
            <SectionCard title="How it works" icon={<RouteRounded />}>
              <Stack component="ol" spacing={2} sx={{ m: 0, p: 0, listStyle: "none" }}>
                {STEPS.map((step, index) => (
                  <Stack key={step.title} component="li" direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
                    <Box
                      aria-hidden
                      sx={{ ...surface.raisedSm, display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: "50%", color: brand.leafDark, fontSize: 13, fontWeight: 700, flexShrink: 0 }}
                    >
                      {index + 1}
                    </Box>
                    <Box>
                      <Typography variant="subtitle2">{step.title}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {step.body}
                      </Typography>
                    </Box>
                  </Stack>
                ))}
              </Stack>
            </SectionCard>
          </Stack>
        </Grid>
      </Grid>
    </PageShell>
  );
}

function PickupStatus({ merchant, loading, slow }: { merchant: MerchantPublic | null; loading: boolean; slow: boolean }) {
  if (!merchant) {
    return loading ? (
      <Box role="status" aria-label="Loading pickup status" sx={{ mt: 2.5 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Skeleton variant="rounded" width={210} height={32} sx={{ borderRadius: "999px" }} />
          <Skeleton width={180} />
        </Stack>
        {slow ? <SlowNotice /> : null}
      </Box>
    ) : null;
  }
  const p = merchant.pickup;
  if (p.state === "paused") {
    return (
      <Alert severity="warning" role="status" icon={<PauseCircleRounded />} sx={{ mt: 2.5 }}>
        <AlertTitle>Pickup is paused right now</AlertTitle>
        Please check back later.
      </Alert>
    );
  }
  if (p.state === "unavailable") {
    return (
      <Alert severity="warning" role="status" icon={<EventBusyRounded />} sx={{ mt: 2.5 }}>
        <AlertTitle>No pickup times available</AlertTitle>
        There are no open pickup slots at the moment.
      </Alert>
    );
  }
  if (p.state === "no_surplus") {
    return (
      <Alert severity="info" role="status" icon={<RemoveShoppingCartRounded />} sx={{ mt: 2.5 }}>
        <AlertTitle>Nothing left today</AlertTitle>
        {merchant.name} lists its leftovers each afternoon.
      </Alert>
    );
  }
  if (p.state === "closed_for_today") {
    return (
      <Alert severity="warning" role="status" icon={<ScheduleRounded />} sx={{ mt: 2.5 }}>
        <AlertTitle>Today&apos;s pickup has closed</AlertTitle>
        Next pickup: {p.next_slot?.label}. You can still order for that time.
      </Alert>
    );
  }
  return (
    <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center", mt: 2.5 }}>
      <StatusChip tone="success" size="medium" icon={ScheduleRounded} label={`Pickup today ${p.today_window?.label ?? ""}`} sx={{ fontSize: "0.9rem" }} />
      <MetaRow
        sx={{ fontVariantNumeric: "tabular-nums" }}
        items={[
          { label: `${merchant.surplus.items_available} items`, icon: Inventory2Rounded },
          `${merchant.surplus.units_available} left`,
          { label: `Updated ${ago(merchant.surplus.as_of)}`, icon: UpdateRounded },
        ]}
      />
    </Stack>
  );
}

function MerchantTrust({ merchant, slug }: { merchant: MerchantPublic | null; slug: string }) {
  if (!merchant) {
    return (
      <Card>
        <CardContent>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <Skeleton variant="rounded" width={36} height={36} />
            <Box sx={{ flex: 1 }}>
              <Skeleton variant="text" width="60%" />
              <Skeleton variant="text" width="80%" />
            </Box>
          </Stack>
          <Skeleton variant="rounded" height={120} sx={{ mt: 2 }} />
        </CardContent>
      </Card>
    );
  }
  const verification = merchant.verification;
  return (
    <SectionCard title="About the shop" icon={<StorefrontRounded />}>
      <InfoList
        items={[
          {
            icon: PlaceRounded,
            label: "Address",
            value: (
              <>
                {merchant.address.one_line}
              </>
            ),
          },
          { icon: ScheduleRounded, label: "Open today", value: merchant.hours_today ? `${merchant.hours_today.open}–${merchant.hours_today.close}` : "Closed today" },
          { icon: ShoppingBagRounded, label: "Surplus pickup", value: merchant.pickup.today_window?.label ?? "Not today" },
          { icon: PaymentsRounded, label: "Payment", value: "PayPal (you approve the total first)" },
        ]}
        columns={2}
      />
      {verification?.checks?.length ? (
        <Box sx={{ ...surface.inset, mt: 2.5, borderRadius: "18px", p: 2.25 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }} useFlexGap>
            <Typography variant="subtitle2" sx={{ display: "flex", alignItems: "center", gap: 0.75, color: brand.leafDark }}>
              <VerifiedRounded aria-hidden sx={{ fontSize: 19 }} />
              Verified merchant
            </Typography>
            <Typography variant="caption" color="text.secondary">
              by {verification.verified_by}
            </Typography>
          </Stack>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, mt: 1, p: 0, listStyle: "none" }}>
            {verification.checks.map((check) => (
              <Typography key={check} component="li" variant="body2" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <CheckRounded aria-hidden sx={{ fontSize: 17, color: brand.leaf }} />
                {check}
              </Typography>
            ))}
          </Stack>
        </Box>
      ) : null}
      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", mt: 2.5 }}>
        <Link href={`/shops/${slug}/policies#pickup`} variant="body2">
          How pickup works
        </Link>
        <Link href={`/shops/${slug}/policies#allergens`} variant="body2">
          Allergen disclosure
        </Link>
        <Link href={`/shops/${slug}/policies#cancellation`} variant="body2">
          Cancellation &amp; refunds
        </Link>
      </Stack>
    </SectionCard>
  );
}

/** Today's surplus as photos, so a shop's page leads with its food. Each card opens the full list, where items go in a basket. */
function TodaysSurplus({ slug }: { slug: string }) {
  const headingId = useId();
  const catalog = useResource((signal) => api<{ items: CatalogItem[] }>(`/api/merchants/${slug}/catalog`, { signal }), [slug], { pollMs: 60_000 });
  const items = (catalog.data?.items ?? [])
    .filter((i) => i.availability.status === "available" || i.availability.status === "low")
    .sort((a, b) => b.price.discount_pct - a.price.discount_pct);
  if (catalog.error || (catalog.data && !items.length)) return null; // the pickup status above already says why
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ mt: 3, minWidth: 0, maxWidth: "100%" }}>
      <Stack direction="row" sx={{ alignItems: "baseline", justifyContent: "space-between", mb: 1.25 }}>
        <Typography id={headingId} variant="h4" component="h2">Today&apos;s surplus</Typography>
        {items.length ? (
          <Link href={`/shops/${slug}/browse`} variant="body2" sx={{ fontWeight: 650, display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            See all {items.length} <ArrowForwardRounded aria-hidden sx={{ fontSize: 16 }} />
          </Link>
        ) : null}
      </Stack>
      {/* position: relative keeps the visually hidden price labels inside the scrolling row (they would widen the page). */}
      <Box component="ul" sx={{ position: "relative", listStyle: "none", m: 0, p: 0, pb: 1, display: "flex", gap: 1.5, overflowX: "auto", scrollSnapType: "x mandatory",
        mx: { xs: -2, sm: 0 }, px: { xs: 2, sm: 0 }, scrollPaddingInline: { xs: 16, sm: 0 } }}>
        {catalog.data ? items.slice(0, 8).map((i) => (
          <Box component="li" key={i.product_id} sx={{ flex: "0 0 148px", scrollSnapAlign: "start" }}>
            <Link href={`/shops/${slug}/browse`} underline="none" color="inherit" sx={{ display: "block", borderRadius: "12px" }}>
              <ProductImage image={i.image} size="sm" sx={{ width: 148, height: 111 }} />
              <Typography variant="body2" sx={{ fontWeight: 650, mt: 0.75, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {i.name}
              </Typography>
              <Typography variant="body2" className="tabular">
                <Box component="span" sx={{ fontWeight: 750 }}>{money(i.price.sale_minor, i.price.currency)}</Box>{" "}
                {i.price.discount_pct > 0 ? (
                  <Box component="span" sx={{ color: "text.secondary", textDecoration: "line-through" }}>
                    <span className="sr-only">regular price </span>{money(i.price.reference_minor, i.price.currency)}
                  </Box>
                ) : null}
              </Typography>
              <Typography variant="caption" color={i.availability.status === "low" ? "warning.main" : "text.secondary"} sx={{ fontWeight: i.availability.status === "low" ? 650 : 400 }}>
                {i.availability.status === "low" ? `Only ${i.availability.available} left` : `${i.availability.available} left`}
              </Typography>
            </Link>
          </Box>
        )) : [0, 1, 2, 3].map((k) => (
          <Box component="li" key={k} sx={{ flex: "0 0 148px" }} aria-hidden>
            <Skeleton variant="rounded" width={148} height={111} sx={{ borderRadius: "10px" }} />
            <Skeleton width="85%" />
            <Skeleton width="50%" />
          </Box>
        ))}
      </Box>
    </Box>
  );
}
