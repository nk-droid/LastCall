"use client";

import { CheckCircleRounded, HourglassTopRounded, Inventory2Rounded, RadioButtonUncheckedRounded, SendRounded, VerifiedRounded } from "@mui/icons-material";
import { Alert, Box, Button, Card, CardActionArea, CardContent, Collapse, LinearProgress, Stack, Typography } from "@mui/material";
import { useState } from "react";

import { useAccount } from "@/components/account";
import { useAnnounce } from "@/components/announcer";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { ErrorState, LoadingBlock, PageHeader, SectionCard, StatusChip } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { ShopSettings } from "@/lib/types";
import { useResource } from "@/lib/use-api";
import { brand } from "@/theme/tokens";

import { HoursSection, PayoutsSection, PoliciesSection, ProfileSection } from "../settings/sections";

type StepKey = ShopSettings["checklist"][number]["key"];

export function Setup() {
  const staff = useStaff();
  const { refresh } = useAccount();
  const announce = useAnnounce();
  const settings = useResource((signal) => api<ShopSettings>("/api/merchant/shop", { signal }), [staff?.merchant.id]);
  const [open, setOpen] = useState<StepKey | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const s = settings.data;
  const owner = hasRole(staff, "owner");

  if (settings.error && !s) return <ErrorState title="Couldn't load setup" message={errorMessage(settings.error)} onRetry={settings.reload} />;
  if (!s) return <LoadingBlock label="Loading setup" />;

  const done = s.checklist.filter((c) => c.done).length;
  const nextOpen = open ?? s.checklist.find((c) => !c.done)?.key ?? null;
  const onSaved = (next: ShopSettings) => settings.setData(next);
  const status = s.shop.status;

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      settings.setData(await api<ShopSettings>("/api/merchant/shop/submit", { body: {} }));
      announce("Submitted for review");
      refresh();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const body = (key: StepKey) => {
    switch (key) {
      case "profile":
        return <ProfileSection settings={s} onSaved={onSaved} />;
      case "hours":
        return <HoursSection settings={s} onSaved={onSaved} />;
      case "policies":
        return <PoliciesSection settings={s} onSaved={onSaved} onConfirm={settings.reload} />;
      case "payouts":
        return <PayoutsSection settings={s} onSaved={onSaved} owner={owner} />;
      case "catalog":
        return (
          <SectionCard title="List your first products" icon={<Inventory2Rounded />}>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Add what you usually have left at the end of the day, with its regular and surplus price and its allergen record.
            </Typography>
            <Button href="/merchant/inventory" variant="contained">Open inventory</Button>
          </SectionCard>
        );
    }
  };

  return (
    <Box>
      <PageHeader eyebrow={s.shop.name} title="Set up your shop" subtitle="Finish each step, then send your shop for a quick review before it goes live." />

      {status === "pending_review" ? (
        <Alert severity="info" icon={<HourglassTopRounded />} sx={{ mb: 3 }}>
          Submitted {s.shop.submitted_at ? new Date(s.shop.submitted_at).toLocaleDateString() : ""}. The LastCall team checks your profile, address, policies and
          allergen records, usually within a day. We&apos;ll email you when it&apos;s live.
        </Alert>
      ) : status === "live" ? (
        <Alert severity="success" icon={<VerifiedRounded />} sx={{ mb: 3 }} action={<Button href={`/shops/${s.shop.slug}`} color="inherit" size="small">View storefront</Button>}>
          Your shop is live and listed for shoppers.
        </Alert>
      ) : status === "rejected" && s.shop.review_note ? (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <strong>Changes requested:</strong> {s.shop.review_note}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ alignItems: "center", mb: 2.5 }}>
        <LinearProgress variant="determinate" value={(done / s.checklist.length) * 100} sx={{ flex: 1 }} aria-label={`${done} of ${s.checklist.length} steps done`} />
        <Typography variant="body2" sx={{ fontWeight: 650 }} className="tabular">{done} of {s.checklist.length} done</Typography>
      </Stack>

      <Stack spacing={1.5}>
        {s.checklist.map((step, index) => {
          const expanded = nextOpen === step.key;
          return (
            <Card key={step.key} sx={expanded ? { borderColor: brand.leaf } : undefined}>
              <CardActionArea onClick={() => setOpen(expanded ? null : step.key)} aria-expanded={expanded}>
                <CardContent sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                  {step.done ? <CheckCircleRounded sx={{ color: brand.leaf }} /> : <RadioButtonUncheckedRounded sx={{ color: brand.muted }} />}
                  <Typography sx={{ fontWeight: 650, flex: 1 }}>{index + 1}. {step.label}</Typography>
                  <StatusChip tone={step.done ? "success" : "neutral"} label={step.done ? "Done" : "To do"} />
                </CardContent>
              </CardActionArea>
              <Collapse in={expanded} unmountOnExit>
                <Box sx={{ px: { xs: 1.5, sm: 2.5 }, pb: 2.5 }}>{body(step.key)}</Box>
              </Collapse>
            </Card>
          );
        })}
      </Stack>

      {status === "draft" || status === "rejected" ? (
        <Card sx={{ mt: 3 }}>
          <CardContent sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: 2, alignItems: { sm: "center" } }}>
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontWeight: 650 }}>Submit for review</Typography>
              <Typography variant="body2" color="text.secondary">
                {s.ready_to_submit ? "Everything's ready. Only the owner can submit." : "Finish the steps above to submit."}
              </Typography>
              {submitError ? <Typography variant="body2" color="error" role="alert" sx={{ mt: 1 }}>{submitError}</Typography> : null}
            </Box>
            <Button variant="contained" size="large" startIcon={<SendRounded />} disabled={!s.ready_to_submit || !owner} loading={submitting} onClick={submit}>
              Submit for review
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </Box>
  );
}
