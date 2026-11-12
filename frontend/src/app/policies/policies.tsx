"use client";

import {
  ArrowForwardRounded,
  AutoAwesomeRounded,
  BakeryDiningRounded,
  EventBusyRounded,
  GppGoodRounded,
  Inventory2Rounded,
  LocalCafeRounded,
  LocationOnRounded,
  LockClockRounded,
  PaymentsRounded,
  ScheduleRounded,
  StorefrontRounded,
} from "@mui/icons-material";
import { Box, Card, CardContent, Grid, Link, Skeleton, Stack, Typography } from "@mui/material";
import { useId } from "react";

import { PageShell } from "@/components/site";
import { ErrorState, IconBadge, InfoList, LoadingBlock, MetaRow, PageHeader, StatTile } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { MerchantCard, MerchantPublic } from "@/lib/types";
import { useResource } from "@/lib/use-api";

/** Platform rules every shop follows, plus each shop's own pickup and cancellation terms. */
export function Policies() {
  const shops = useResource((signal) => api<{ merchants: MerchantCard[] }>("/api/merchants", { signal }), []);
  const slugs = (shops.data?.merchants ?? []).map((m) => m.slug);
  const details = useResource(
    (signal) => Promise.all(slugs.map((slug) => api<MerchantPublic>(`/api/merchants/${slug}`, { signal }))),
    [slugs.join(",")],
    { enabled: slugs.length > 0 },
  );
  const ttls = (details.data ?? []).map((m) => m.policies.reservation_ttl_seconds).filter(Boolean);
  const holdMinutes = ttls.length ? Math.round(Math.min(...ttls) / 60) : 10;

  return (
    <PageShell>
      <PageHeader title="How LastCall works" subtitle="Rules every shop follows. Each shop sets its own pickup and cancellation terms." />

      <Grid container spacing={{ xs: 2, sm: 3 }} sx={{ mb: { xs: 5, sm: 7 } }}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatTile label="Held while you pay" value={`${holdMinutes} min`} caption="No one else can buy items you're holding." icon={<LockClockRounded />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatTile label="When you're charged" value="On approval" caption="Only after you approve the exact total in PayPal." icon={<PaymentsRounded />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatTile label="Strict allergies" value="Fail closed" caption="Unverified or may-contain items are never offered." icon={<GppGoodRounded />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatTile label="AI assistance" value="Advisory" caption="It can't change prices, stock or payments." icon={<AutoAwesomeRounded />} />
        </Grid>
      </Grid>

      <Box component="section" aria-labelledby="shop-policies-heading">
        <Typography id="shop-policies-heading" variant="h2" sx={{ mb: 3 }}>
          Shop policies
        </Typography>
        {shops.error && !shops.data ? (
          <ErrorState title="Couldn't load shops" message={errorMessage(shops.error)} onRetry={shops.reload} />
        ) : !shops.data ? (
          <LoadingBlock label="Loading shops" slow={shops.slow} variant="cards" count={3} />
        ) : (
          <Grid container spacing={3}>
            {shops.data.merchants.map((shop) => (
              <Grid key={shop.slug} size={{ xs: 12, md: 4 }}>
                <ShopPolicyCard shop={shop} detail={details.data?.find((d) => d.slug === shop.slug) ?? null} />
              </Grid>
            ))}
          </Grid>
        )}
        {details.error && !details.data ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Some shop details didn&apos;t load. Open a shop&apos;s policies for the full terms.
          </Typography>
        ) : null}
      </Box>
    </PageShell>
  );
}

function ShopPolicyCard({ shop, detail }: { shop: MerchantCard; detail: MerchantPublic | null }) {
  const headingId = useId();
  const CategoryIcon = /caf[eé]/i.test(shop.category) ? LocalCafeRounded : BakeryDiningRounded;
  const next = shop.pickup.next_slot?.label.split("–")[0];
  const pickup =
    shop.pickup.state === "open" && shop.pickup.today_window
      ? `Today ${shop.pickup.today_window.label}`
      : next
        ? `Closed today, opens ${next.replace(/^(Today|Tomorrow)\b/, (w) => w.toLowerCase())}`
        : "No pickup scheduled";
  return (
    <Card component="article" aria-labelledby={headingId} sx={{ height: "100%" }}>
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 2.5, height: "100%", p: 3, "&:last-child": { pb: 3 } }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <IconBadge>
            <CategoryIcon />
          </IconBadge>
          <Box sx={{ minWidth: 0 }}>
            <Typography id={headingId} variant="h4" component="h3">
              {shop.name}
            </Typography>
            <MetaRow items={[shop.category, shop.neighborhood ? { label: shop.neighborhood, icon: LocationOnRounded } : null]} />
          </Box>
        </Stack>
        {detail ? (
          <InfoList
            items={[
              { label: "Pickup", value: pickup, icon: ScheduleRounded },
              { label: "Cancellation requests", value: `Close ${detail.policies.cancellation_cutoff_minutes} min before pickup`, icon: EventBusyRounded },
              { label: "Items per order", value: `Up to ${detail.policies.max_units_per_order}`, icon: Inventory2Rounded },
              { label: "Hold while paying", value: `${Math.round(detail.policies.reservation_ttl_seconds / 60)} min`, icon: LockClockRounded },
            ]}
          />
        ) : (
          <Box role="status">
            <span className="sr-only">Loading {shop.name} policies</span>
            <Stack spacing={1.25}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} variant="rounded" height={36} />
              ))}
            </Stack>
          </Box>
        )}
        <Stack direction="row" spacing={1} useFlexGap sx={{ mt: "auto", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <MetaRow items={[{ label: "PayPal", icon: PaymentsRounded }, { label: "Pickup only", icon: StorefrontRounded }]} />
          <Link href={`/shops/${shop.slug}/policies`} variant="body2" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            {shop.name} policies
            <ArrowForwardRounded aria-hidden sx={{ fontSize: 16 }} />
          </Link>
        </Stack>
      </CardContent>
    </Card>
  );
}
