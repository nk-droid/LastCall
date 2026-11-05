"use client";

import {
  AddBusinessRounded,
  CheckCircleRounded,
  Inventory2Rounded,
  PaymentsRounded,
  ScheduleRounded,
  StorefrontRounded,
  VerifiedRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Card, CardContent, Grid, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signInHref, useAccount } from "@/components/account";
import { PageShell } from "@/components/site";
import { IconBadge, LoadingBlock, PageHeader, type Icon } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { Account } from "@/lib/types";

const STEPS: { icon: Icon; title: string; text: string }[] = [
  { icon: StorefrontRounded, title: "Create your shop", text: "Name, address and how shoppers reach you." },
  { icon: ScheduleRounded, title: "Set pickup windows", text: "Per day, with how many pickups you can hand off." },
  { icon: PaymentsRounded, title: "Connect PayPal", text: "Customers pay your business account directly." },
  { icon: Inventory2Rounded, title: "List today's surplus", text: "Prices, allergen records, and repeat-daily items." },
  { icon: VerifiedRounded, title: "Go live", text: "We review your shop, then it's listed." },
];

const CATEGORIES = ["Bakery", "Café", "Asian bakery", "Deli", "Dessert shop", "Doughnut shop", "Grocery", "Restaurant"];
const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix", "Pacific/Honolulu"];

export function Sell() {
  const { account, loaded } = useAccount();
  const user = account?.user ?? null;
  return (
    <PageShell>
      <PageHeader eyebrow="For local food shops" title="Sell today's surplus before close"
        subtitle="Shoppers describe what they need; LastCall builds bundles from what you actually have left, holds the stock while they pay with PayPal, and hands you a pickup queue." />
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 5 }}>
          <Stack component="ol" spacing={2} sx={{ listStyle: "none", m: 0, p: 0 }}>
            {STEPS.map((s, i) => (
              <Stack component="li" key={s.title} direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
                <IconBadge><s.icon /></IconBadge>
                <Box>
                  <Typography sx={{ fontWeight: 650 }}>{i + 1}. {s.title}</Typography>
                  <Typography variant="body2" color="text.secondary">{s.text}</Typography>
                </Box>
              </Stack>
            ))}
          </Stack>
          <Alert severity="info" icon={<CheckCircleRounded />} sx={{ mt: 3 }}>
            No listing fees. Strict allergy requests only ever see items you&apos;ve verified.
          </Alert>
        </Grid>
        <Grid size={{ xs: 12, md: 7 }}>
          {!loaded ? <LoadingBlock label="Loading" /> : user ? <CreateShop /> : (
            <Card>
              <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
                <Typography variant="h3" component="h2">Start with an account</Typography>
                <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>You&apos;ll be the shop&apos;s owner and can invite your team afterwards.</Typography>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <Button href="/signup?next=/sell" variant="contained" size="large" startIcon={<AddBusinessRounded />}>Create an account</Button>
                  <Button href={signInHref("/sell")} variant="outlined" size="large">I have an account</Button>
                </Stack>
              </CardContent>
            </Card>
          )}
        </Grid>
      </Grid>
    </PageShell>
  );
}

function CreateShop() {
  const router = useRouter();
  const { refresh } = useAccount();
  const [f, setF] = useState({ name: "", category: "Bakery", phone: "", line1: "", city: "", region: "", postal_code: "", timezone: "America/Los_Angeles" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [key]: e.target.value }));

  async function submit() {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const res = await api<{ account: Account }>("/api/shops", {
        body: { name: f.name.trim(), category: f.category, phone: f.phone.trim(), timezone: f.timezone,
                address: { line1: f.line1.trim(), city: f.city.trim(), region: f.region.trim(), postal_code: f.postal_code.trim(), country: "US" } },
      });
      refresh(res.account);
      router.push("/merchant/setup");
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") setErrors(err.fieldErrors());
      else setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card component="form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
        <Typography variant="h3" component="h2" sx={{ mb: 2.5 }}>Create your shop</Typography>
        {error ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert> : null}
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 7 }}>
            <TextField label="Shop name" fullWidth required value={f.name} onChange={set("name")} error={!!errors.name} helperText={errors.name} autoFocus />
          </Grid>
          <Grid size={{ xs: 12, sm: 5 }}>
            <TextField select label="Category" fullWidth value={f.category} onChange={set("category")}>
              {CATEGORIES.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid size={12}>
            <TextField label="Street address" fullWidth required value={f.line1} onChange={set("line1")} autoComplete="address-line1"
              error={!!errors["address.line1"]} helperText={errors["address.line1"] ?? "Where shoppers pick up"} />
          </Grid>
          <Grid size={{ xs: 12, sm: 5 }}>
            <TextField label="City" fullWidth required value={f.city} onChange={set("city")} autoComplete="address-level2" />
          </Grid>
          <Grid size={{ xs: 6, sm: 3 }}>
            <TextField label="State" fullWidth value={f.region} onChange={set("region")} autoComplete="address-level1" />
          </Grid>
          <Grid size={{ xs: 6, sm: 4 }}>
            <TextField label="ZIP code" fullWidth value={f.postal_code} onChange={set("postal_code")} autoComplete="postal-code" />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField label="Phone" fullWidth value={f.phone} onChange={set("phone")} autoComplete="tel" helperText="For customers with a pickup question" />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField select label="Time zone" fullWidth value={f.timezone} onChange={set("timezone")} error={!!errors.timezone} helperText={errors.timezone ?? "Pickup times use this"}>
              {TIMEZONES.map((tz) => <MenuItem key={tz} value={tz}>{tz.split("/")[1].replace("_", " ")}</MenuItem>)}
            </TextField>
          </Grid>
        </Grid>
        <Button type="submit" variant="contained" size="large" loading={busy} disabled={!f.name.trim() || !f.line1.trim() || !f.city.trim()} sx={{ mt: 3 }}>
          Create shop and continue setup
        </Button>
      </CardContent>
    </Card>
  );
}
