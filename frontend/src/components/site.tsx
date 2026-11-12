"use client";

import { AddBusinessRounded, CheckRounded, CreditCardOffRounded, PhotoCameraRounded, PolicyRounded, ReceiptLongRounded, StorefrontRounded } from "@mui/icons-material";
import { AppBar, Box, Button, Chip, Container, Divider, IconButton, Link, LinearProgress, Stack, Step, StepLabel, Stepper, Toolbar, Tooltip, Typography, type StepIconProps } from "@mui/material";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { brand, surface } from "@/theme/tokens";

import { AccountMenu } from "./account";
import { AlertsBell } from "./alerts";
import { AskProvider } from "./concierge/ask-launcher";
import { useConfig } from "./config";
import { StatusChip } from "./ui";

export function Wordmark({ light, size = 22 }: { light?: boolean; size?: number }) {
  return (
    <Box component="span" sx={{ fontSize: size, fontWeight: 800, letterSpacing: "-0.03em", color: light ? brand.cream : brand.forest, lineHeight: 1 }}>
      Last
      <Box component="span" sx={{ color: light ? "#7FD1A6" : brand.leaf }}>
        Call
      </Box>
    </Box>
  );
}

export function EnvironmentBadge() {
  const config = useConfig();
  if (!config) return null;
  // Only a problem is worth a badge: checkout can't take payments without PayPal credentials.
  return config.paypal.client_id ? null : <StatusChip tone="warning" icon={CreditCardOffRounded} label="PayPal not connected" />;
}

/** A shop the page belongs to; shows in the header and footer. */
export type ShopContext = { slug: string; name: string };

export function SiteHeader({ children, shop }: { children?: ReactNode; shop?: ShopContext }) {
  return (
    <AppBar
      position="sticky"
      color="inherit"
      sx={{ bgcolor: "rgba(255, 255, 255, 0.92)", backdropFilter: "saturate(1.2) blur(12px)" }}
    >
      <Container maxWidth={false} sx={{ maxWidth: 1200 }}>
        <Toolbar disableGutters sx={{ minHeight: { xs: 60, sm: 64 }, gap: { xs: 1, sm: 1.5 } }}>
          <Link href="/" underline="none" aria-label="LastCall, all shops" sx={{ borderRadius: "6px", py: 0.5 }}>
            <Wordmark />
          </Link>
          {shop ? (
            <Chip
              component={NextLink}
              href={`/shops/${shop.slug}`}
              clickable
              icon={<StorefrontRounded />}
              label={shop.name}
              variant="outlined"
              size="small"
              sx={{ display: { xs: "none", sm: "inline-flex" }, maxWidth: 240, "& .MuiChip-icon": { color: brand.leaf } }}
            />
          ) : null}
          <Box sx={{ flex: 1 }} />
          {children}
          <Box sx={{ display: { xs: "none", sm: "block" } }}>
            <EnvironmentBadge />
          </Box>
          <AlertsBell />
          <Button href="/orders" color="inherit" startIcon={<ReceiptLongRounded />} sx={{ display: { xs: "none", md: "inline-flex" }, color: "text.secondary" }}>
            My orders
          </Button>
          <Tooltip title="My orders">
            <IconButton href="/orders" aria-label="My orders" sx={{ display: { xs: "inline-flex", md: "none" }, color: "text.secondary" }}>
              <ReceiptLongRounded />
            </IconButton>
          </Tooltip>
          <AccountMenu />
        </Toolbar>
      </Container>
    </AppBar>
  );
}

export function SiteFooter({ shop }: { shop?: ShopContext }) {
  return (
    <Box component="footer" sx={{ mt: { xs: 7, sm: 11 } }}>
      <Container maxWidth={false} sx={{ maxWidth: 1200, py: 4 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "center" } }}>
          <Box>
            <Wordmark size={19} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 420 }}>
              Today&apos;s surplus from local shops, at a lower price, ready for pickup.
            </Typography>
          </Box>
        </Stack>
        <Divider sx={{ my: 2.5 }} />
        <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
          {shop ? (
            <Link href={`/shops/${shop.slug}/policies`} variant="body2" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              <PolicyRounded aria-hidden sx={{ fontSize: 18 }} />
              {shop.name} policies
            </Link>
          ) : null}
          <Link href="/policies" variant="body2" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            <PolicyRounded aria-hidden sx={{ fontSize: 18 }} />
            How LastCall works
          </Link>
          <Link href="/sell" variant="body2" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            <AddBusinessRounded aria-hidden sx={{ fontSize: 18 }} />
            List your shop
          </Link>
          <Link href="/merchant" variant="body2" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            <StorefrontRounded aria-hidden sx={{ fontSize: 18 }} />
            Merchant console
          </Link>
          <Link href="/credits" variant="body2" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            <PhotoCameraRounded aria-hidden sx={{ fontSize: 18 }} />
            Photo credits
          </Link>
        </Stack>
      </Container>
    </Box>
  );
}

export function PageShell({ children, width = "wide", shop }: { children: ReactNode; width?: "wide" | "narrow"; shop?: ShopContext }) {
  return (
    <AskProvider shop={shop}>
      <SiteHeader shop={shop} />
      <Container component="main" id="main" maxWidth={false} sx={{ maxWidth: width === "wide" ? 1200 : 820, flex: 1, pt: { xs: 3, sm: 5 }, pb: 4 }}>
        {children}
      </Container>
      <SiteFooter shop={shop} />
    </AskProvider>
  );
}

const FLOW = ["Describe", "Choose", "Review", "Pay", "Pick up"] as const;

/** Raised discs: green when done or current, soft and muted ahead. The label carries the meaning. */
function FlowStepIcon({ active, completed, icon }: StepIconProps) {
  const reached = active || completed;
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        display: "inline-grid",
        placeItems: "center",
        width: 30,
        height: 30,
        borderRadius: "50%",
        fontSize: 13,
        fontWeight: 700,
        ...(reached ? { bgcolor: brand.leaf, color: "#FFFFFF", border: `1px solid ${brand.leaf}` } : { ...surface.raisedSm, color: brand.muted }),
      }}
    >
      {completed ? <CheckRounded sx={{ fontSize: 18 }} /> : icon}
    </Box>
  );
}

/** Shopper progress through the flow (0 = Describe … 4 = Pick up). */
export function FlowSteps({ active }: { active: 0 | 1 | 2 | 3 | 4 }) {
  return (
    <Box component="nav" aria-label="Checkout progress" sx={{ mb: { xs: 2.5, sm: 4 } }}>
      <Box sx={{ display: { xs: "block", sm: "none" } }}>
        <Typography variant="body2" sx={{ fontWeight: 650, color: "text.secondary", mb: 0.75 }}>
          Step {active + 1} of {FLOW.length}:{" "}
          <Box component="span" sx={{ color: "text.primary" }}>
            {FLOW[active]}
          </Box>
        </Typography>
        <LinearProgress variant="determinate" value={((active + 1) / FLOW.length) * 100} aria-hidden sx={{ height: 6 }} />
      </Box>
      <Stepper
        activeStep={active}
        alternativeLabel
        component="ol"
        sx={{ display: { xs: "none", sm: "flex" }, p: 0, m: 0, listStyle: "none" }}
      >
        {FLOW.map((label, index) => (
          <Step key={label} component="li" aria-current={index === active ? "step" : undefined}>
            <StepLabel slots={{ stepIcon: FlowStepIcon }}>
              {label}
              {index < active ? <span className="sr-only"> (done)</span> : null}
            </StepLabel>
          </Step>
        ))}
      </Stepper>
    </Box>
  );
}
