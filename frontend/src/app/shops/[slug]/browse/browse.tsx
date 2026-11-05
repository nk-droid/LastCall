"use client";

import {
  ArrowBackRounded,
  ArrowForwardRounded,
  FilterAltOffRounded,
  FilterAltRounded,
  HelpOutlineRounded,
  InfoOutlined,
  ScheduleRounded,
  ShoppingBasketRounded,
  VerifiedRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Card, CardContent, Grid, Paper, Stack, TextField, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { AllergenTags, PriceTag } from "@/components/commerce";
import { ProductImage } from "@/components/product-image";
import { PageShell } from "@/components/site";
import { EmptyState, ErrorState, FilterChip, InfoTip, LoadingBlock, PageHeader, QuantityStepper, SectionCard, StatusChip, brand, surface, shadows, tones, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ago, money } from "@/lib/format";
import type { Allergens, CatalogItem, Quote, Slot } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const FILTERS = [
  { key: "nuts", label: "No nuts", codes: ["tree_nuts", "peanuts"] },
  { key: "milk", label: "No dairy", codes: ["milk"] },
  { key: "wheat", label: "No gluten", codes: ["wheat"] },
  { key: "eggs", label: "No eggs", codes: ["eggs"] },
];
const STATUS: Record<string, { tone: Tone; label: (i: CatalogItem) => string }> = {
  available: { tone: "success", label: (i) => `${i.availability.available} left` },
  low: { tone: "warning", label: (i) => `Only ${i.availability.available} left` },
  sold_out: { tone: "neutral", label: () => "Sold out" },
  paused: { tone: "neutral", label: () => "Not listed now" },
  past_cutoff: { tone: "neutral", label: () => "Pickup time passed" },
};

/** Strict filter: only merchant-verified items with no listed allergen or cross-contact pass. */
function passesStrict(item: CatalogItem, codes: string[]): boolean {
  if (!codes.length) return true;
  if (item.allergens.status !== "verified") return false;
  return codes.every((c) => !item.allergens.contains.includes(c) && !item.allergens.cross_contact.includes(c));
}

/** Whether the shop has verified this item's allergen record; who/when is in the tooltip. */
function AllergenSource({ allergens }: { allergens: Allergens }) {
  const verified = allergens.status === "verified";
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{ display: "flex", alignItems: "center", gap: 0.5, fontWeight: 650, color: verified ? brand.leafDark : tones.warning.fg }}
    >
      {verified ? <VerifiedRounded aria-hidden sx={{ fontSize: 16 }} /> : <HelpOutlineRounded aria-hidden sx={{ fontSize: 16 }} />}
      {verified ? "Allergens verified" : "Allergens not verified"}
      <InfoTip label="Allergen record source" title={allergens.source_label} />
    </Typography>
  );
}

type ShopCatalog = { merchant: { slug: string; name: string }; items: CatalogItem[]; as_of: string; reference_price_policy: string };

export function Browse({ slug }: { slug: string }) {
  const router = useRouter();
  const announce = useAnnounce();
  const catalog = useResource((signal) => api<ShopCatalog>(`/api/merchants/${slug}/catalog`, { signal }), [slug], { pollMs: 30_000 });
  const slots = useResource((signal) => api<{ slots: Slot[] }>(`/api/merchants/${slug}/pickup-slots`, { signal }), [slug]);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [filters, setFilters] = useState<string[]>([]);
  const [slotId, setSlotId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = catalog.data?.items ?? [];
  const excludedCodes = FILTERS.filter((f) => filters.includes(f.key)).flatMap((f) => f.codes);
  const visible = items.filter((i) => passesStrict(i, excludedCodes));
  const hidden = items.length - visible.length;
  const lines = Object.entries(basket).filter(([, q]) => q > 0);
  const units = lines.reduce((sum, [, q]) => sum + q, 0);
  const total = lines.reduce((sum, [sku, q]) => sum + q * (items.find((i) => i.sku === sku)?.price.sale_minor ?? 0), 0);
  const bookable = (slots.data?.slots ?? []).filter((s) => s.bookable);
  const cutoffs = lines.map(([sku]) => items.find((i) => i.sku === sku)?.availability.cutoff_at).filter(Boolean) as string[];
  const latestCutoff = cutoffs.length ? cutoffs.reduce((a, b) => (a < b ? a : b)) : null;
  const fitting = bookable.filter((s) => !latestCutoff || new Date(s.ends_at) <= new Date(latestCutoff));
  const chosenSlot = fitting.find((s) => s.id === slotId)?.id ?? fitting[0]?.id ?? "";

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const quote = await api<Quote>("/api/quotes", { body: { lines: lines.map(([sku, qty]) => ({ sku, qty })), pickup_slot_id: chosenSlot, merchant: slug } });
      router.push(`/review/${quote.id}`);
    } catch (err) {
      setError(errorMessage(err));
      announce(errorMessage(err), "assertive");
      catalog.reload();
    } finally {
      setBusy(false);
    }
  }

  const shopName = catalog.data?.merchant.name;
  return (
    <PageShell shop={shopName ? { slug, name: shopName } : undefined}>
      <PageHeader
        eyebrow={shopName}
        title="Available today"
        subtitle="Build your own basket from today's surplus."
        actions={
          <Button href={`/shops/${slug}`} variant="outlined" color="inherit" startIcon={<ArrowBackRounded />}>
            Back to shop
          </Button>
        }
        chips={
          catalog.data ? (
            <Typography variant="body2" color="text.secondary">
              {items.length} items · updated {ago(catalog.data.as_of)}
            </Typography>
          ) : null
        }
      />

      <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle2" sx={{ p: 0, display: "flex", alignItems: "center", gap: 0.75 }}>
          <FilterAltRounded aria-hidden sx={{ fontSize: 19, color: brand.leaf }} />
          Strict dietary filters
        </Typography>
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: "wrap", mt: 1.75 }}>
          {FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              selected={filters.includes(f.key)}
              onClick={() => setFilters((cur) => (cur.includes(f.key) ? cur.filter((x) => x !== f.key) : [...cur, f.key]))}
            />
          ))}
        </Stack>
        {hidden > 0 ? (
          <Alert severity="info" role="status" icon={<FilterAltOffRounded />} sx={{ mt: 2 }}>
            {hidden} {hidden === 1 ? "item is" : "items are"} hidden: they contain it, may contain it, or the shop hasn&apos;t verified their allergen information.
          </Alert>
        ) : null}
      </Box>

      {catalog.error && !catalog.data ? <ErrorState sx={{ mt: 3 }} message={errorMessage(catalog.error)} onRetry={catalog.reload} /> : null}

      <Grid container spacing={4} sx={{ mt: 3 }}>
        <Grid size={{ xs: 12, lg: 8 }} component="section" aria-label="Items">
          {!catalog.data && catalog.loading ? (
            <LoadingBlock label="Loading items" variant="cards" count={4} slow={catalog.slow} />
          ) : visible.length === 0 && catalog.data ? (
            <EmptyState
              title="Nothing matches these filters"
              icon={ShoppingBasketRounded}
              action={
                <Button variant="outlined" color="inherit" startIcon={<FilterAltOffRounded />} onClick={() => setFilters([])}>
                  Clear filters
                </Button>
              }
            >
              No item available now is verified to meet every filter you picked.
            </EmptyState>
          ) : (
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "repeat(3, 1fr)" } }}>
              {visible.map((item) => {
                const status = STATUS[item.availability.status] ?? STATUS.available;
                const max = Math.min(item.availability.available, item.availability.per_order_limit);
                const qty = basket[item.sku] ?? 0;
                const sellable = item.availability.status === "available" || item.availability.status === "low";
                return (
                  <li key={item.sku}>
                    <Card component="article" aria-labelledby={`${item.sku}-name`} sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
                      <Box sx={{ position: "relative", px: 2.5, pt: 2.5 }}>
                        {/* Unavailable items dim only their artwork, so every label keeps full contrast. */}
                        <ProductImage image={item.image} sx={sellable ? undefined : { "& svg, & img": { opacity: 0.5, filter: "grayscale(0.6)" } }} />
                        <StatusChip tone={status.tone} label={status.label(item)} sx={{ position: "absolute", top: 30, left: 30 }} />
                      </Box>
                      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 1.5, flex: 1, p: 2.5, "&:last-child": { pb: 2.5 } }}>
                        <Box>
                          <Typography id={`${item.sku}-name`} component="h2" variant="h5">
                            {item.name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                            {item.description}
                          </Typography>
                        </Box>
                        <PriceTag price={item.price.sale_minor} reference={item.price.reference_minor} size="sm" />
                        <Typography variant="body2" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                          <ScheduleRounded aria-hidden sx={{ fontSize: 17, color: brand.leaf }} />
                          Pick up by {item.availability.cutoff_label}
                        </Typography>
                        <AllergenTags allergens={item.allergens} compact />
                        <AllergenSource allergens={item.allergens} />
                        {sellable ? (
                          // The stepper alone: its number is the basket quantity (green once added).
                          <Box sx={{ mt: "auto", pt: 1, display: "flex", justifyContent: "flex-end", "& input": { color: qty ? brand.leafDark : undefined, fontWeight: qty ? 750 : undefined } }}>
                            <QuantityStepper label={`Quantity of ${item.name}`} compact value={qty} min={0} max={max} onChange={(v) => setBasket((b) => ({ ...b, [item.sku]: v }))} />
                          </Box>
                        ) : null}
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </Box>
          )}
          {catalog.data ? (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 3, display: "flex", gap: 0.75 }}>
              <InfoOutlined aria-hidden sx={{ fontSize: 16, mt: "1px" }} />
              {catalog.data.reference_price_policy}
            </Typography>
          ) : null}
          {lines.length ? (
            <Box sx={{ display: { xs: "block", lg: "none" }, position: "sticky", bottom: 12, mt: 3, zIndex: 5 }}>
              <Paper elevation={0} sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, px: 2.25, py: 1.5, borderRadius: "20px", boxShadow: shadows.floating }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    {units} {units === 1 ? "item" : "items"} · estimated
                  </Typography>
                  <Typography variant="h4" component="p" className="tabular">
                    {money(total)}
                  </Typography>
                </Box>
                <Button href="#basket" variant="contained" endIcon={<ArrowForwardRounded />}>
                  View basket
                </Button>
              </Paper>
            </Box>
          ) : null}
        </Grid>

        <Grid size={{ xs: 12, lg: 4 }} component="aside" aria-label="Basket">
          <Box sx={{ position: { lg: "sticky" }, top: 88 }}>
            <SectionCard
              id="basket"
              sx={{ scrollMarginTop: 88 }}
              title="Your basket"
              icon={<ShoppingBasketRounded />}
              action={
                lines.length ? (
                  <Typography variant="body2" className="tabular" sx={{ fontWeight: 650, color: brand.leafDark }}>
                    {units} {units === 1 ? "item" : "items"}
                  </Typography>
                ) : null
              }
            >
              {lines.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Add items with the + buttons.
                </Typography>
              ) : (
                <>
                  <Stack component="ul" spacing={1.5} sx={{ m: 0, p: 0, listStyle: "none" }}>
                    {lines.map(([sku, q]) => {
                      const item = items.find((i) => i.sku === sku);
                      return (
                        <Stack key={sku} component="li" direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                          {item ? <ProductImage image={item.image} size="sm" sx={{ width: 48, height: 42 }} /> : null}
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant="body2" sx={{ fontWeight: 650 }} noWrap>
                              {item?.name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" className="tabular">
                              {q} × {money(item?.price.sale_minor ?? 0)}
                            </Typography>
                          </Box>
                          <Typography variant="body2" className="tabular" sx={{ fontWeight: 700 }}>
                            {money(q * (item?.price.sale_minor ?? 0))}
                          </Typography>
                        </Stack>
                      );
                    })}
                  </Stack>
                  <Box sx={{ ...surface.inset, borderRadius: "16px", px: 2, py: 1.75, mt: 2.5 }}>
                    <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
                        Estimated total
                      </Typography>
                      <Typography variant="h3" component="p" className="tabular">
                        {money(total)}
                      </Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" component="p">
                      Final total is confirmed on the next step.
                    </Typography>
                  </Box>
                  <Typography component="label" htmlFor="browse-slot" variant="subtitle2" sx={{ display: "block", mt: 3, mb: 0.75 }}>
                    Pickup time
                  </Typography>
                  <TextField
                    id="browse-slot"
                    select
                    fullWidth
                    size="small"
                    value={chosenSlot}
                    onChange={(e) => setSlotId(e.target.value)}
                    slotProps={{ select: { native: true }, input: { sx: { height: 44 } } }}
                  >
                    {fitting.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </TextField>
                  {!fitting.length ? (
                    <Alert severity="warning" sx={{ mt: 1.5 }}>
                      No pickup slot fits every item&apos;s pickup cutoff.
                    </Alert>
                  ) : null}
                </>
              )}
              {error ? (
                <Alert severity="error" role="alert" sx={{ mt: 2 }}>
                  {error}
                </Alert>
              ) : null}
              <Button
                variant="contained"
                size="large"
                fullWidth
                endIcon={<ArrowForwardRounded />}
                disabled={!lines.length || !chosenSlot}
                loading={busy}
                onClick={review}
                sx={{ mt: 3 }}
              >
                Review basket
              </Button>
            </SectionCard>
          </Box>
        </Grid>
      </Grid>
    </PageShell>
  );
}
