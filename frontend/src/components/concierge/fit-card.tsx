"use client";

// The answer to an Ask LastCall request: the bundle (photo, price, Hold & pay) beside "How it fits", which puts each
// part of the request next to what this bundle does about it. Every row comes from the bundle engine's own numbers
// and each shop's allergen records, never from the assistant's wording.

import { CheckRounded, RemoveRounded, StorefrontRounded, VerifiedUserRounded } from "@mui/icons-material";
import { Box, Button, Chip, Link, Stack, Typography } from "@mui/material";

import { PriceTag } from "@/components/commerce";
import { ProductImage } from "@/components/product-image";
import { brand, tones } from "@/components/ui";
import { plural } from "@/lib/format";
import type { ConciergeCard } from "@/lib/types";

import { useHold } from "./bundle-card";

export function bundleTitle(card: ConciergeCard): string {
  return card.lines.map((line) => `${line.qty} × ${line.name}`).join(" · ");
}

/** Biggest quantity first, so the bulk of the bundle reads first. */
function byQty(card: ConciergeCard) {
  return [...card.lines].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}

/** "6 × Red bean bun, 1 × BBQ pork bun and 2 more": for one-line rows. */
export function bundleSummary(card: ConciergeCard): string {
  const lines = byQty(card);
  const head = lines.slice(0, 2).map((line) => `${line.qty} × ${line.name}`).join(", ");
  return lines.length > 2 ? `${head} and ${lines.length - 2} more` : head;
}

/** What's in the bundle, one item per row: quantity, then the name. */
function ItemList({ card }: { card: ConciergeCard }) {
  return (
    <Box component="ul" aria-label="What's in it" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 1 }}>
      {byQty(card).map((line) => (
        <Box component="li" key={line.name} sx={{ display: "flex", alignItems: "center", gap: 1.25, minWidth: 0 }}>
          <Box component="span" aria-hidden className="tabular" sx={{
            minWidth: 38, height: 28, px: 0.75, borderRadius: "8px", bgcolor: brand.mint, color: brand.leafDark,
            fontWeight: 800, fontSize: 14, display: "inline-grid", placeItems: "center", flexShrink: 0,
          }}>
            {line.qty}×
          </Box>
          {line.image?.url ? <ProductImage image={line.image} size="sm" sx={{ width: 36, height: 36 }} /> : null}
          <Typography component="span" sx={{ fontSize: 15, lineHeight: 1.35, color: brand.forest, minWidth: 0 }}>
            <span className="sr-only">{line.qty} </span>{line.name}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export function FitCard({ card, leftOut }: { card: ConciergeCard; leftOut?: { names: string[]; count: number } }) {
  const { busy, error, hold } = useHold(card);
  // Replies saved before "How it fits" existed still show their fit lines.
  const checks = card.checks?.length
    ? card.checks
    : card.fits.filter((f) => f.key !== "savings").map((f) => ({ key: f.key, asked: "", answer: f.label, ok: f.ok, strict: f.key === "exclusions" }));
  const met = checks.filter((c) => c.ok).length;
  const title = bundleTitle(card);
  const first = card.lines[0];
  return (
    <Box component="article" aria-label={`${card.shop.name}: ${title}`} sx={{
      bgcolor: "#fff", border: 1, borderColor: brand.line, borderRadius: "20px", overflow: "hidden",
      boxShadow: "0 1px 2px rgba(20, 35, 29, 0.04), 0 12px 32px rgba(20, 35, 29, 0.08)",
      display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1fr) minmax(0, 1.3fr)" },
    }}>
      <Box sx={{ p: { xs: 2.25, sm: 3 }, display: "flex", flexDirection: "column", gap: 1.75, minWidth: 0 }}>
        {first?.image?.url ? <ProductImage image={first.image} sx={{ aspectRatio: "16 / 9" }} /> : null}
        <Box>
          <Link href={`/shops/${card.shop.slug}`} underline="hover" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 650, fontSize: 14, color: brand.muted }}>
            <StorefrontRounded aria-hidden sx={{ fontSize: 16 }} />{card.shop.name}
          </Link>
          <Typography variant="h3" component="h3" sx={{ mt: 0.5 }}>{plural(card.units, "item")}</Typography>
        </Box>
        <ItemList card={card} />
        <PriceTag price={card.total_minor} reference={card.reference_minor} currency={card.currency} />
        <Box sx={{ mt: first?.image?.url ? "auto" : 0.5 }}>
          {error ? <Typography variant="body2" color="error" role="alert" sx={{ mb: 1 }}>{error}</Typography> : null}
          <Button fullWidth variant="contained" size="large" loading={busy} disabled={!card.default_slot_id} onClick={hold} sx={{ minHeight: 50 }}>
            Hold &amp; pay
          </Button>
          {!card.default_slot_id ? <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>No pickup time is left for this one.</Typography> : null}
        </Box>
      </Box>

      <Box sx={{ p: { xs: 2.25, sm: 3 }, bgcolor: "#FBFBF8", borderColor: brand.line, borderStyle: "solid", borderWidth: { xs: "1px 0 0", md: "0 0 0 1px" }, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 750 }}>How it fits</Typography>
          <Chip size="small" label={`${met} of ${checks.length}`}
            sx={{ fontWeight: 700, bgcolor: met === checks.length ? tones.success.bg : brand.sand, color: met === checks.length ? tones.success.fg : brand.muted }} />
        </Stack>
        <Box component="table" sx={{
          width: "100%", borderCollapse: "collapse", mt: 1.25, typography: "body2", fontSize: 15,
          "& th, & td": { textAlign: "left", verticalAlign: "top", py: 1.4 },
          "& thead": { display: { xs: "none", sm: "table-header-group" } },
          "& thead th": { pt: 0, pb: 1, fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: brand.muted },
          "& tbody tr": { borderTop: `1px solid ${brand.line}`, display: { xs: "grid", sm: "table-row" } },
          // On a phone each row stacks: what was asked, then the answer under it.
          "& tbody th": { pb: { xs: 0.25, sm: 1.4 } },
          "& tbody td": { pt: { xs: 0, sm: 1.4 } },
        }}>
          <thead>
            <tr>
              <Box component="th" scope="col" sx={{ pr: 2, width: { sm: "36%" } }}>You asked</Box>
              <th scope="col">This bundle</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const Icon = !c.ok ? RemoveRounded : c.strict ? VerifiedUserRounded : CheckRounded;
              return (
                <tr key={c.key}>
                  <Box component="th" scope="row" sx={{ pr: 2, fontWeight: 650, color: brand.forest }}>
                    {c.asked || "—"}
                    {c.strict ? <Box component="span" sx={{ display: "block", fontSize: 12, fontWeight: 650, color: brand.leafDark }}>Strict</Box> : null}
                  </Box>
                  <td>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", color: c.ok ? brand.forest : brand.muted }}>
                      <Icon aria-hidden sx={{ fontSize: 18, mt: "2px", color: c.ok ? brand.leaf : brand.muted, flexShrink: 0 }} />
                      <span><span className="sr-only">{c.ok ? "Fits: " : "Not quite: "}</span>{c.answer}</span>
                    </Stack>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Box>
        {leftOut?.names.length ? (
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, pt: 1.5, borderTop: `1px solid ${brand.line}`, color: brand.muted, alignItems: "flex-start" }}>
            <VerifiedUserRounded aria-hidden sx={{ fontSize: 16, mt: "2px" }} />
            <Typography variant="caption" sx={{ lineHeight: 1.5 }}>
              Left out at {card.shop.name}: {leftOut.names.slice(0, 3).join(", ")}
              {leftOut.count > Math.min(3, leftOut.names.length) ? ` and ${leftOut.count - Math.min(3, leftOut.names.length)} more` : ""}.
              {" "}Allergen facts come from each shop&apos;s own records.
            </Typography>
          </Stack>
        ) : null}
      </Box>
    </Box>
  );
}
