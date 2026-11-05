"use client";

import { ArrowForwardRounded, ReceiptLongRounded, ScheduleRounded, StorefrontRounded } from "@mui/icons-material";
import { Box, Button, Card, CardContent, Link, Stack, Typography } from "@mui/material";
import { useId } from "react";

import { Avatar, signInHref, useAccount } from "@/components/account";
import { PageShell } from "@/components/site";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, brand } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { money, plural } from "@/lib/format";
import type { MyOrder, MyOrdersResponse } from "@/lib/types";
import { useResource } from "@/lib/use-api";

import { OrderStatusChip } from "./order-status";

export function MyOrders() {
  const { version } = useAccount();
  // Remount on sign-in/out so one person's orders never linger on screen.
  return <OrdersView key={version} />;
}

function OrdersView() {
  const { account } = useAccount();
  const customer = account?.user ?? null;
  const res = useResource((signal) => api<MyOrdersResponse>("/api/me/orders", { signal }), [], { pollMs: 20_000 });
  const orders = res.data?.orders ?? [];
  const active = orders.filter((o) => o.active);
  const past = orders.filter((o) => !o.active);
  const shops = new Set(orders.map((o) => o.merchant.slug)).size;

  return (
    <PageShell>
      <PageHeader
        title="My orders"
        subtitle={
          (customer ? `${customer.name} · all shops` : "Guest · orders from this browser") +
          (res.data && orders.length ? ` · ${plural(orders.length, "order")} at ${plural(shops, "shop")}` : "")
        }
        actions={
          <Button href="/" variant="outlined" color="inherit" startIcon={<StorefrontRounded />}>
            Browse shops
          </Button>
        }
      />

      {res.error && !res.data ? (
        <ErrorState title="Couldn't load your orders" message={errorMessage(res.error)} onRetry={res.reload} />
      ) : !res.data ? (
        <LoadingBlock label="Loading your orders" slow={res.slow} variant="cards" count={2} />
      ) : !orders.length ? (
        <EmptyState
          icon={ReceiptLongRounded}
          title="No orders yet"
          action={
            <Button href="/" variant="contained" startIcon={<StorefrontRounded />}>
              Browse shops
            </Button>
          }
        >
          {customer
            ? `Orders ${customer.name} places at any shop show up here.`
            : "Orders placed in this browser show up here. Sign in to keep them with your account on any device."}
        </EmptyState>
      ) : (
        <Stack spacing={5}>
          {customer ? (
            <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
              <Avatar initials={customer.initials} size={28} />
              <Typography variant="body2" color="text.secondary">
                Orders follow {customer.name}&apos;s account across shops and devices.
              </Typography>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Guest orders stay with this browser. <Link href={signInHref("/orders")}>Sign in</Link> to keep them with your account.
            </Typography>
          )}
          {active.length ? <OrderSection title="Active" orders={active} /> : null}
          {past.length ? <OrderSection title="Past" orders={past} /> : null}
        </Stack>
      )}
    </PageShell>
  );
}

function OrderSection({ title, orders }: { title: string; orders: MyOrder[] }) {
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} variant="h4" component="h2" sx={{ mb: 2 }}>
        {title}{" "}
        <Box component="span" sx={{ color: "text.secondary", fontWeight: 600 }}>
          · {orders.length}
        </Box>
      </Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
        {orders.map((o) => (
          <li key={o.id}>
            <OrderCard order={o} />
          </li>
        ))}
      </Box>
    </Box>
  );
}

function OrderCard({ order: o }: { order: MyOrder }) {
  const headingId = useId();
  const names = o.item_names.slice(0, 3).join(", ");
  const more = o.item_names.length - 3;
  return (
    <Card component="article" aria-labelledby={headingId} sx={{ height: "100%" }}>
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 1.75, height: "100%", p: 3, "&:last-child": { pb: 3 } }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
          <Box sx={{ minWidth: 0 }}>
            <Link href={`/shops/${o.merchant.slug}`} variant="body2" underline="hover" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 700 }}>
              <StorefrontRounded aria-hidden sx={{ fontSize: 17 }} />
              {o.merchant.name}
            </Link>
            <Typography id={headingId} variant="h4" component="h3" className="tabular" sx={{ mt: 0.5 }}>
              Order #{o.number}
            </Typography>
          </Box>
          <Typography className="tabular" sx={{ fontWeight: 700, fontSize: "1.1rem", flexShrink: 0 }}>
            {money(o.amount_minor, o.currency)}
          </Typography>
        </Stack>
        <Box>
          <OrderStatusChip status={o.status} />
        </Box>
        <Box>
          <Typography variant="body2" className="tabular" sx={{ display: "flex", alignItems: "center", gap: 0.75, fontWeight: 600 }}>
            <ScheduleRounded aria-hidden sx={{ fontSize: 17, color: brand.leaf }} />
            {o.pickup.date_label} · {o.pickup.label}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {plural(o.units, "item")}
            {names ? ` · ${names}${more > 0 ? ` +${more} more` : ""}` : ""}
          </Typography>
        </Box>
        <Box sx={{ mt: "auto" }}>
          <Button href={`/orders/${o.id}`} variant={o.active ? "contained" : "outlined"} color={o.active ? "primary" : "inherit"} size="small" endIcon={<ArrowForwardRounded />} aria-label={`View order #${o.number}`}>
            View order
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
