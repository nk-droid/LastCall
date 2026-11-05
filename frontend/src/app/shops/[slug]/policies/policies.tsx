"use client";

import {
  ArrowBackRounded,
  AutoAwesomeRounded,
  BlockRounded,
  CheckCircleRounded,
  EventBusyRounded,
  HealthAndSafetyRounded,
  LocalOfferRounded,
  Inventory2Rounded,
  ShoppingBagRounded,
  StorefrontRounded,
  TimerRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Grid, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

import { useConfig } from "@/components/config";
import { PageShell } from "@/components/site";
import { ErrorState, InfoList, LoadingBlock, PageHeader, SectionCard, StatTile, brand, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { MerchantPublic } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const SECTIONS = [
  { id: "pickup", label: "Pickup" },
  { id: "allergens", label: "Allergens" },
  { id: "cancellation", label: "Cancellation" },
  { id: "prices", label: "Prices" },
  { id: "ai", label: "AI & data" },
];

/** Plain promises as a quiet icon list (no chips: they aren't statuses). */
function Promises({ items }: { items: { icon: Icon; label: string }[] }) {
  return (
    <Stack component="ul" direction="row" spacing={2.5} useFlexGap sx={{ flexWrap: "wrap", m: 0, mt: 2.5, p: 0, listStyle: "none" }}>
      {items.map(({ icon: ItemIcon, label }) => (
        <Typography key={label} component="li" variant="body2" sx={{ display: "flex", alignItems: "center", gap: 0.75, fontWeight: 600 }}>
          <ItemIcon aria-hidden sx={{ fontSize: 18, color: brand.leaf }} />
          {label}
        </Typography>
      ))}
    </Stack>
  );
}

function Body({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body1" sx={{ "& + &": { mt: 1.25 } }}>
      {children}
    </Typography>
  );
}

export function Policies({ slug }: { slug: string }) {
  const config = useConfig();
  const merchant = useResource((signal) => api<MerchantPublic>(`/api/merchants/${slug}`, { signal }), [slug]);
  const m = merchant.data;
  return (
    <PageShell width="narrow" shop={m ? { slug, name: m.name } : undefined}>
      <PageHeader
        eyebrow={m?.name}
        title="Policies & disclosures"
        subtitle="How pickup, allergens, refunds and prices work at this shop."
        actions={
          <Button href={`/shops/${slug}`} variant="outlined" color="inherit" startIcon={<ArrowBackRounded />}>
            Back to shop
          </Button>
        }
      />
      {merchant.error && !m ? <ErrorState message={errorMessage(merchant.error)} onRetry={merchant.reload} /> : null}
      {!m && !merchant.error ? <LoadingBlock label="Loading policies" lines={6} /> : null}
      {m ? (
        <Stack spacing={4}>
          <Box component="nav" aria-label="On this page">
            <Stack component="ul" direction="row" spacing={1.25} useFlexGap sx={{ m: 0, p: 0, listStyle: "none", flexWrap: "wrap" }}>
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <Button href={`#${s.id}`} size="small" variant="outlined" color="inherit" sx={{ borderRadius: "999px" }}>
                    {s.label}
                  </Button>
                </li>
              ))}
            </Stack>
          </Box>

          <Grid container spacing={{ xs: 2, sm: 3 }}>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatTile label="Items held" value={`${Math.round(m.policies.reservation_ttl_seconds / 60)} min`} caption="while you check out" icon={<TimerRounded />} />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatTile label="Order limit" value={`${m.policies.max_units_per_order}`} caption="items per order" icon={<Inventory2Rounded />} />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatTile label="Cancel up to" value={`${m.policies.cancellation_cutoff_minutes} min`} caption="before your pickup window" icon={<EventBusyRounded />} />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatTile label="Fulfilment" value="Pickup" caption="no delivery" icon={<ShoppingBagRounded />} />
            </Grid>
          </Grid>

          <SectionCard id="pickup" title="How pickup works" icon={<StorefrontRounded />}>
            <Body>{m.policies.pickup_instructions}</Body>
            <InfoList sx={{ mt: 2.5 }} items={[{ icon: ShoppingBagRounded, label: "What to bring", value: m.policies.what_to_bring }]} />
          </SectionCard>

          <SectionCard id="allergens" title="Allergens & dietary info" icon={<HealthAndSafetyRounded />}>
            <Body>{m.policies.dietary_disclosure_text}</Body>
            <Alert severity="warning" icon={<WarningAmberRounded />} sx={{ mt: 2 }}>
              {m.policies.cross_contact_text}
            </Alert>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Each item shows {m.name}&apos;s own allergen record and whether it has been verified.
            </Typography>
          </SectionCard>

          <SectionCard id="cancellation" title="Cancellation & refunds" icon={<EventBusyRounded />}>
            <Body>{m.policies.cancellation_policy_text}</Body>
            <Body>{m.policies.refund_policy_text}</Body>
          </SectionCard>

          <SectionCard id="prices" title="Prices & savings" icon={<LocalOfferRounded />}>
            <Body>{m.policies.reference_price_policy_text}</Body>
            <Promises
              items={[
                { icon: CheckCircleRounded, label: "Real stock counts" },
                { icon: BlockRounded, label: "No fake scarcity" },
                { icon: BlockRounded, label: "No hidden fees" },
              ]}
            />
          </SectionCard>

          <SectionCard id="ai" title="AI assistance & your data" icon={<AutoAwesomeRounded />}>
            <Body>
              {config?.ai.enabled
                ? "Your words (minus emails and phone numbers) go to an AI model to understand requests and write short bundle notes."
                : "AI assistance is off; requests are understood with standard rules."}
            </Body>
            <Promises
              items={[
                { icon: BlockRounded, label: "AI never sets prices, stock, allergens or payments" },
                { icon: AutoAwesomeRounded, label: "You can turn AI off" },
              ]}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              We keep only the contact details needed for pickup, then delete them after the shop&apos;s retention period.
            </Typography>
          </SectionCard>

        </Stack>
      ) : null}
    </PageShell>
  );
}
