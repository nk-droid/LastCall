"use client";

import {
  ArrowForwardRounded,
  AutoAwesomeRounded,
  BakeryDiningRounded,
  EventBusyRounded,
  LocalCafeRounded,
  LocalOfferRounded,
  LocationOnRounded,
  PauseCircleRounded,
  PaymentsRounded,
  RemoveShoppingCartRounded,
  ScheduleRounded,
  StorefrontRounded,
} from "@mui/icons-material";
import { Box, Button, Card, CardActionArea, CardContent, Chip, Grid, Link, Stack, Typography } from "@mui/material";
import { useId } from "react";

import { Avatar, useAccount } from "@/components/account";
import { ProductImage } from "@/components/product-image";
import { PageShell } from "@/components/site";
import { ErrorState, IconBadge, LoadingBlock, PageHeader, StatusChip, brand, surface, shadows, type Icon } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { money, plural } from "@/lib/format";
import type { MerchantCard, MyOrdersResponse, PickupStatus } from "@/lib/types";
import { useResource } from "@/lib/use-api";

import { OrderStatusChip } from "./orders/order-status";

export function Marketplace() {
  const { account, version } = useAccount();
  const user = account?.user ?? null;
  const shops = useResource((signal) => api<{ merchants: MerchantCard[]; as_of: string }>("/api/merchants", { signal }), [], { pollMs: 60_000 });
  const list = shops.data?.merchants ?? [];
  const openNow = list.filter((s) => s.pickup.state === "open").length;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Pickup-only surplus marketplace"
        title="Today's surplus, nearby"
        subtitle="Pick a local shop and get a verified bundle below menu price."
        chips={
          user ? (
            <Chip avatar={<Avatar initials={user.initials} size={24} />} label={`Shopping as ${user.name}`}
              sx={{ ...surface.raisedSm, fontWeight: 600, height: 36, pl: 0.5, pr: 0.5 }} />
          ) : undefined
        }
      />

      <ActiveOrders key={version} />

      <Box component="section" aria-labelledby="shops-heading" sx={{ mb: { xs: 5, sm: 7 } }}>
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "baseline", flexWrap: "wrap", mb: 2.5 }}>
          <Typography id="shops-heading" variant="h2">
            Shops near you
          </Typography>
          {shops.data ? (
            <Typography variant="body2" color="text.secondary">
              {plural(list.length, "shop")} · {openNow} open for pickup now
            </Typography>
          ) : null}
        </Stack>
        {shops.error && !shops.data ? (
          <ErrorState title="Couldn't load shops" message={errorMessage(shops.error)} onRetry={shops.reload} />
        ) : !shops.data ? (
          <LoadingBlock label="Loading shops" slow={shops.slow} variant="cards" count={3} />
        ) : (
          <Grid container spacing={3}>
            {list.map((shop) => (
              <Grid key={shop.slug} size={{ xs: 12, sm: 6, md: 4 }}>
                <ShopCard shop={shop} />
              </Grid>
            ))}
          </Grid>
        )}
      </Box>

      <HowItWorks />
    </PageShell>
  );
}

function pickupChip(p: PickupStatus) {
  switch (p.state) {
    case "open":
      return <StatusChip tone="success" icon={ScheduleRounded} label={`Pickup today ${p.today_window?.label ?? ""}`.trim()} />;
    case "paused":
      return <StatusChip tone="warning" icon={PauseCircleRounded} label="Pickup paused today" />;
    case "no_surplus":
      return <StatusChip tone="neutral" icon={RemoveShoppingCartRounded} label="Sold out for today" />;
    case "closed_for_today":
      return <StatusChip tone="neutral" icon={EventBusyRounded} label={p.next_slot ? `Closed · next ${p.next_slot.label.split("–")[0]}` : "Closed for today"} />;
    default:
      return <StatusChip tone="neutral" icon={EventBusyRounded} label="No pickup available" />;
  }
}

function CategoryIcon({ category }: { category: string }) {
  const sx = { fontSize: 16, color: brand.leaf };
  return /caf[eé]/i.test(category) ? <LocalCafeRounded aria-hidden sx={sx} /> : <BakeryDiningRounded aria-hidden sx={sx} />;
}

function ShopCard({ shop }: { shop: MerchantCard }) {
  const headingId = useId();
  const sellable = shop.surplus.items_available > 0;
  const saving = shop.max_saving_percent > 0 ? shop.max_saving_percent : null;
  const from = sellable && shop.from_minor !== null ? `from ${money(shop.from_minor, shop.currency)}` : null;
  const stock = sellable ? `${plural(shop.surplus.items_available, "item")} · ${shop.surplus.units_available} left` : null;
  return (
    <Card component="article" aria-labelledby={headingId} sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box aria-hidden sx={{ display: "flex", gap: 1.25, alignItems: "center", minHeight: 80, px: 2.75, pt: 2.75 }}>
        {shop.featured.length ? (
          shop.featured.map((f) => (
            <ProductImage key={f.name} image={{ url: f.image_url, alt: f.name }} size="sm" />
          ))
        ) : (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: "text.secondary" }}>
            <StorefrontRounded sx={{ fontSize: 22 }} />
            <Typography variant="body2">Nothing listed right now</Typography>
          </Stack>
        )}
      </Box>
      <CardContent sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 1.75 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.75, fontWeight: 600 }}>
          <CategoryIcon category={shop.category} />
          {shop.category}
          {shop.neighborhood ? (
            <>
              <Box component="span" aria-hidden>
                ·
              </Box>
              <LocationOnRounded aria-hidden sx={{ fontSize: 15 }} />
              {shop.neighborhood}
            </>
          ) : null}
        </Typography>
        <Box>
          <Typography id={headingId} component="h3" variant="h3">
            <Link href={`/shops/${shop.slug}`} underline="hover" color="inherit">
              {shop.name}
            </Link>
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {shop.tagline}
          </Typography>
        </Box>
        <Box>{pickupChip(shop.pickup)}</Box>
        {saving || from || stock ? (
          <Box className="tabular">
            {saving || from ? (
              <Typography variant="body2" color="text.secondary" sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 1 }}>
                {saving ? (
                  <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: brand.leafDark, fontWeight: 650 }}>
                    <LocalOfferRounded aria-hidden sx={{ fontSize: 16 }} />
                    Up to {saving}% off
                  </Box>
                ) : null}
                {saving && from ? <span aria-hidden>·</span> : null}
                {from}
              </Typography>
            ) : null}
            {stock ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {stock}
              </Typography>
            ) : null}
          </Box>
        ) : null}
        <Button
          href={`/shops/${shop.slug}`}
          variant={sellable ? "contained" : "outlined"}
          color={sellable ? "primary" : "inherit"}
          fullWidth
          endIcon={<ArrowForwardRounded />}
          aria-label={`${sellable ? "Shop now" : "View shop"} at ${shop.name}`}
          sx={{ mt: "auto" }}
        >
          {sellable ? "Shop now" : "View shop"}
        </Button>
      </CardContent>
    </Card>
  );
}

/** This shopper's open orders across shops; remounted per customer so nothing stale shows. */
function ActiveOrders() {
  const mine = useResource((signal) => api<MyOrdersResponse>("/api/me/orders", { signal }), [], { pollMs: 30_000 });
  const orders = (mine.data?.orders ?? []).filter((o) => o.active);
  if (!orders.length) return null;
  return (
    <Box component="section" aria-labelledby="active-orders-heading" sx={{ mb: { xs: 4, sm: 5 } }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between", mb: 1.5 }}>
        <Typography id="active-orders-heading" variant="h4" component="h2">
          Your active orders
        </Typography>
        <Button href="/orders" size="small" color="inherit" endIcon={<ArrowForwardRounded />}>
          All orders
        </Button>
      </Stack>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 2.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "repeat(3, 1fr)" } }}>
        {orders.map((o) => (
          <li key={o.id}>
            <Card sx={{ height: "100%", boxShadow: shadows.raisedSm }}>
              <CardActionArea href={`/orders/${o.id}`} sx={{ height: "100%", p: 2.25, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
                <Typography component="span" variant="body2" sx={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 0.5 }}>
                  <StorefrontRounded aria-hidden sx={{ fontSize: 17, color: brand.leaf }} />
                  {o.merchant.name}
                </Typography>
                <OrderStatusChip status={o.status} />
                <Typography component="span" variant="caption" color="text.secondary" className="tabular">
                  #{o.number} · {o.pickup.date_label}, {o.pickup.label}
                </Typography>
              </CardActionArea>
            </Card>
          </li>
        ))}
      </Box>
    </Box>
  );
}

const STEPS: { icon: Icon; title: string; text: string }[] = [
  { icon: StorefrontRounded, title: "Pick a shop", text: "See what's left today and when you can collect it." },
  { icon: AutoAwesomeRounded, title: "Say what you need", text: "Get bundles that fit your budget and allergies." },
  { icon: PaymentsRounded, title: "Pay, then pick up", text: "Approve in PayPal and show your code at the counter." },
];

function HowItWorks() {
  return (
    <Card component="section" aria-labelledby="how-heading">
      <CardContent sx={{ p: { xs: "22px", sm: "26px" } }}>
        <Typography id="how-heading" variant="h4" component="h2" sx={{ mb: 2.5 }}>
          How it works
        </Typography>
        <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" } }}>
          {STEPS.map((step, index) => (
            <Box component="li" key={step.title} sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
              <IconBadge>
                <step.icon />
              </IconBadge>
              <Box>
                <Typography variant="subtitle1" component="p" sx={{ fontWeight: 650 }}>
                  {index + 1}. {step.title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {step.text}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}
