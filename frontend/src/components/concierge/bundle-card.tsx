"use client";

// One bundle from Ask LastCall: what's in it, why it fits (verified by code), the price, and Hold & pay, which goes
// through the normal quote → review → PayPal flow.

import { AccountBalanceWalletRounded, CheckCircleRounded, GroupsRounded, ScheduleRounded, StorefrontRounded, VerifiedUserRounded } from "@mui/icons-material";
import { Box, Button, Chip, Link, Stack, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PriceTag } from "@/components/commerce";
import { ProductImage } from "@/components/product-image";
import { brand, surface, tones, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { ConciergeCard } from "@/lib/types";

const FIT_ICON: Record<string, Icon> = { party: GroupsRounded, budget: AccountBalanceWalletRounded, exclusions: VerifiedUserRounded, pickup: ScheduleRounded };

/** Hold & pay: quote the bundle (stock and price checked again) and go to the normal review page. */
export function useHold(card: ConciergeCard) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function hold() {
    setBusy(true);
    setError(null);
    try {
      const quote = await api<{ id: string }>("/api/quotes", { body: { proposal_id: card.proposal_id, option_id: card.option_key, pickup_slot_id: card.default_slot_id } });
      router.push(`/review/${quote.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return { busy, error, hold };
}

export function BundleCard({ card, top }: { card: ConciergeCard; top?: boolean }) {
  const { busy, error, hold } = useHold(card);
  const fits = card.fits.filter((f) => f.key !== "savings");
  return (
    <Box component="article" aria-label={`${card.shop.name}: ${card.label}`}
      sx={{ ...surface.raisedSm, ...(top ? { border: `2px solid ${brand.leaf}` } : {}), borderRadius: "16px", p: 2, display: "flex", flexDirection: "column", gap: 1.25, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Link href={`/shops/${card.shop.slug}`} underline="hover" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 700, color: brand.forest, minWidth: 0 }}>
          <StorefrontRounded aria-hidden sx={{ fontSize: 16, color: brand.leaf }} />
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.shop.name}</Box>
        </Link>
        <Chip size="small" label={top ? "Top pick" : card.label}
          sx={{ bgcolor: top ? brand.leaf : tones.success.bg, color: top ? "#fff" : tones.success.fg, fontWeight: 650, flexShrink: 0 }} />
      </Stack>
      <Stack direction="row" spacing={0.75} aria-hidden>
        {card.lines.slice(0, 4).map((line) => <ProductImage key={line.name} image={line.image ?? { url: null, alt: line.name }} size="sm" sx={{ width: 44, height: 44 }} />)}
      </Stack>
      <Typography variant="body2" sx={{ color: brand.forest }}>
        {card.lines.map((line) => `${line.qty} × ${line.name}`).join(", ")}
      </Typography>
      <Stack component="ul" spacing={0.5} aria-label="Why it fits" sx={{ listStyle: "none", m: 0, p: 0 }}>
        {fits.map((fit) => {
          const FitIcon = FIT_ICON[fit.key] ?? CheckCircleRounded;
          return (
            <Stack component="li" key={fit.key} direction="row" spacing={0.75} sx={{ alignItems: "flex-start" }}>
              <FitIcon aria-hidden sx={{ fontSize: 16, color: brand.leaf, mt: "2px" }} />
              <Typography variant="caption" sx={{ color: brand.forest, lineHeight: 1.45 }}>{fit.label}</Typography>
            </Stack>
          );
        })}
      </Stack>
      <Box sx={{ mt: "auto", pt: 0.5 }}>
        <PriceTag price={card.total_minor} reference={card.reference_minor} currency={card.currency} size="sm" />
        {error ? <Typography variant="caption" color="error" role="alert" component="p" sx={{ mt: 0.5 }}>{error}</Typography> : null}
        <Button fullWidth variant={top === false ? "outlined" : "contained"} color={top === false ? "inherit" : "primary"} sx={{ mt: 1 }} loading={busy}
          disabled={!card.default_slot_id} onClick={hold}>
          Hold &amp; pay
        </Button>
      </Box>
    </Box>
  );
}
