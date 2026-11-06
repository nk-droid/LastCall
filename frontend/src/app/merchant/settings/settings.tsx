"use client";

import { EventAvailableRounded, GavelRounded, PaymentsRounded, ScheduleRounded, StorefrontRounded } from "@mui/icons-material";
import { Box, Stack, Tab, Tabs } from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { ErrorState, FactChip, LoadingBlock, PageHeader, SectionCard, StatusChip } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { ShopSettings, Slot } from "@/lib/types";
import { useResource } from "@/lib/use-api";

import { HoursSection, PayoutsSection, PoliciesSection, ProfileSection, SlotTable } from "./sections";

const TABS = [
  { key: "profile", label: "Profile", icon: StorefrontRounded },
  { key: "pickup", label: "Hours & pickup", icon: ScheduleRounded },
  { key: "payouts", label: "Payouts", icon: PaymentsRounded },
  { key: "policies", label: "Policies", icon: GavelRounded },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function SettingsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const staff = useStaff();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "profile") as TabKey;
  const settings = useResource((signal) => api<ShopSettings>("/api/merchant/shop", { signal }), [staff?.merchant.id]);
  const s = settings.data;
  const onSaved = (next: ShopSettings) => settings.setData(next);

  return (
    <>
      <PageHeader title="Settings" eyebrow={staff?.merchant.name}
        chips={s ? (
          <>
            <StatusChip tone={s.shop.status === "live" ? "success" : "warning"} label={s.shop.status === "live" ? "Live" : s.shop.status.replace("_", " ")} />
            <FactChip icon={GavelRounded} label={`Policy v${s.policy_version}`} />
            {s.shop.verification.verified_at ? <FactChip label={`Verified ${s.shop.verification.verified_at}`} /> : null}
          </>
        ) : null} />
      <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}>
        <Tabs value={tab} onChange={(_, value: TabKey) => router.replace(`/merchant/settings?tab=${value}`, { scroll: false })} variant="scrollable" allowScrollButtonsMobile>
          {TABS.map((t) => <Tab key={t.key} value={t.key} label={t.label} icon={<t.icon />} iconPosition="start" />)}
        </Tabs>
      </Box>
      {settings.error && !s ? (
        <ErrorState title="Couldn't load settings" message={errorMessage(settings.error)} onRetry={settings.reload} />
      ) : !s ? (
        <LoadingBlock label="Loading settings" slow={settings.slow} />
      ) : (
        <Box>
          {tab === "profile" ? <ProfileSection key={s.shop.id} settings={s} onSaved={onSaved} /> : null}
          {tab === "pickup" ? (
            <Stack spacing={3}>
              <HoursSection key={`${s.shop.id}:${JSON.stringify(s.pickup)}`} settings={s} onSaved={onSaved} />
              <UpcomingSlots canEdit={s.can_edit} />
            </Stack>
          ) : null}
          {tab === "payouts" ? <PayoutsSection settings={s} onSaved={onSaved} owner={hasRole(staff, "owner")} /> : null}
          {tab === "policies" ? <PoliciesSection key={`${s.shop.id}:${s.policy_version}`} settings={s} onSaved={onSaved} onConfirm={() => settings.reload()} /> : null}
        </Box>
      )}
    </>
  );
}

function UpcomingSlots({ canEdit }: { canEdit: boolean }) {
  const announce = useAnnounce();
  const slots = useResource((signal) => api<{ slots: Slot[] }>("/api/merchant/slots", { signal }), [], { pollMs: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function update(slot: Slot, body: { capacity?: number; status?: string }) {
    setBusy(`slot-${slot.id}`);
    setError(null);
    try {
      await api(`/api/merchant/slots/${slot.id}`, { method: "PUT", body });
      announce(`${slot.label} updated`);
      slots.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <SectionCard title="Upcoming pickup slots" subtitle="Today and tomorrow. Close a slot or change its capacity." icon={<EventAvailableRounded />}>
      {error ? <Box role="alert" sx={{ color: "error.main", mb: 1.5 }}>{error}</Box> : null}
      {slots.data ? <SlotTable slots={slots.data.slots} canEdit={canEdit} busy={busy} onUpdate={update} /> : <LoadingBlock label="Loading slots" lines={3} />}
    </SectionCard>
  );
}
