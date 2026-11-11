"use client";

import { HelpOutlineRounded, LocalOfferRounded, VerifiedRounded, WarningAmberRounded } from "@mui/icons-material";
import { Box, Stack, Typography } from "@mui/material";

import { ALLERGEN_LABEL, money } from "@/lib/format";
import type { Allergens, Totals } from "@/lib/types";
import { brand, tones } from "@/theme/tokens";

import { StatusChip } from "./ui";

function allergen(code: string): string {
  return ALLERGEN_LABEL[code]?.toLowerCase() ?? code;
}

/** "eggs, milk and wheat (gluten)" */
function listed(codes: string[]): string {
  const names = codes.map(allergen);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

/** Merchant-supplied allergen facts with their provenance: one "Contains" line and one "May contain" line,
 *  so a basket stays readable on a phone. Uncertain data is shown as uncertain. */
export function AllergenTags({ allergens, compact }: { allergens: Allergens; compact?: boolean }) {
  const verified = allergens.status === "verified";
  return (
    <Stack spacing={0.5}>
      {allergens.contains.length ? (
        <Typography variant="body2" color="text.secondary">
          <Box component="span" sx={{ fontWeight: 650, color: "text.primary" }}>Contains</Box> {listed(allergens.contains)}
        </Typography>
      ) : verified ? (
        <Typography variant="body2" color="text.secondary">No listed allergens</Typography>
      ) : null}
      {allergens.cross_contact.length ? (
        <Typography variant="body2" sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, color: tones.warning.fg, fontWeight: 600 }}>
          <WarningAmberRounded aria-hidden sx={{ fontSize: 16, mt: "2px", flexShrink: 0 }} />
          <span>May contain {listed(allergens.cross_contact)}</span>
        </Typography>
      ) : null}
      {!compact ? (
        <Typography
          variant="caption"
          sx={{ display: "flex", alignItems: "center", gap: 0.5, fontWeight: verified ? 500 : 650, color: verified ? brand.leafDark : tones.warning.fg }}
        >
          {verified ? <VerifiedRounded aria-hidden sx={{ fontSize: 15 }} /> : <HelpOutlineRounded aria-hidden sx={{ fontSize: 15 }} />}
          {allergens.source_label}
        </Typography>
      ) : null}
    </Stack>
  );
}

/** Sale price with the regular price struck through and the saving as a chip. */
export function PriceTag({ price, reference, currency = "USD", size = "md" }: { price: number; reference?: number | null; currency?: string; size?: "sm" | "md" | "lg" }) {
  const saving = reference && reference > price ? Math.round((1 - price / reference) * 100) : 0;
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
      <Typography component="span" variant={size === "lg" ? "h2" : size === "md" ? "h4" : "subtitle1"} className="tabular" sx={{ fontWeight: 800 }}>
        {money(price, currency)}
      </Typography>
      {saving > 0 ? (
        <>
          <Typography component="span" variant="body2" color="text.secondary" className="tabular" sx={{ textDecoration: "line-through" }}>
            <span className="sr-only">Regular price </span>
            {money(reference, currency)}
          </Typography>
          <StatusChip tone="success" icon={LocalOfferRounded} label={`${saving}% off`} />
        </>
      ) : null}
    </Stack>
  );
}

function Row({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  // A <dl> may only contain dt/dd groups, so the total's rule is a border, not a Divider.
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 2,
        py: strong ? 0 : 0.4,
        ...(strong ? { borderTop: `1px solid ${brand.line}`, mt: 1.25, pt: 1.25 } : {}),
      }}
    >
      <Typography component="dt" variant={strong ? "subtitle1" : "body2"} sx={{ fontWeight: strong ? 750 : 500, color: strong ? "text.primary" : accent ? brand.leafDark : "text.secondary" }}>
        {label}
      </Typography>
      <Typography component="dd" variant={strong ? "h4" : "body2"} className="tabular" sx={{ m: 0, fontWeight: strong ? 800 : 600, color: accent ? brand.leafDark : "text.primary" }}>
        {value}
      </Typography>
    </Box>
  );
}

export function PriceBreakdown({ totals, currency = "USD", referenceNote }: { totals: Totals; currency?: string; referenceNote?: string }) {
  return (
    <Box>
      <Box component="dl" sx={{ m: 0 }}>
        <Row label="Regular price" value={money(totals.reference_minor, currency)} />
        <Row label="Surplus discount" value={`−${money(totals.discount_minor, currency)}`} accent />
        <Row label="Tax" value={money(totals.tax_minor, currency)} />
        <Row label="Fees" value={totals.fees_minor ? money(totals.fees_minor, currency) : "None"} />
        <Row label="Total" value={money(totals.total_minor, currency)} strong />
      </Box>
      {referenceNote ? (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {referenceNote}
        </Typography>
      ) : null}
    </Box>
  );
}
