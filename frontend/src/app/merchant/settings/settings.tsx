"use client";

// Settings in five sections, one at a time: a list on the left (each with a one-line summary, and "Unsaved" when
// it has edits) and the selected section on the right. Edits are kept per section until saved or discarded, so
// moving between sections loses nothing. The selection lives in the URL (?tab=rules).

import {
  ArticleRounded,
  ExpandLessRounded,
  ExpandMoreRounded,
  LockRounded,
  PaymentsRounded,
  RuleRounded,
  ScheduleRounded,
  StorefrontRounded,
} from "@mui/icons-material";
import { Box, Button, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { useStaff } from "@/components/merchant-shell";
import { SlotsTimeline, TimelineToggle, type TimelineView } from "@/components/pickup-timeline";
import {
  ErrorState, FactChip, IconBadge, LoadingBlock, PageHeader, StatusChip, brand, surface, tones, type Icon, type Tone,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { money, plural } from "@/lib/format";
import type { ShopSettings, Slot } from "@/lib/types";
import { useResource } from "@/lib/use-api";

import {
  PayoutsSection, PickupSection, PoliciesSection, ProfileSection, RulesSection, SlotTable, WEEKDAYS, changesFor, reviewState,
  type Drafts, type SectionKey,
} from "./sections";

const SECTIONS: { key: SectionKey; label: string; icon: Icon }[] = [
  { key: "profile", label: "Shop profile", icon: StorefrontRounded },
  { key: "pickup", label: "Hours & pickup", icon: ScheduleRounded },
  { key: "rules", label: "Order rules", icon: RuleRounded },
  { key: "policies", label: "Customer policies", icon: ArticleRounded },
  { key: "payouts", label: "Payouts & tax", icon: PaymentsRounded },
];

export function SettingsPage() {
  // Drafts belong to one shop; a new key starts clean if someone switches shops.
  const staff = useStaff();
  return <Settings key={staff?.merchant.id ?? "none"} />;
}

function Settings() {
  const router = useRouter();
  const params = useSearchParams();
  const staff = useStaff();
  const settings = useResource((signal) => api<ShopSettings>("/api/merchant/shop", { signal }), [staff?.merchant.id]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const asked = params.get("tab");
  const tab = SECTIONS.find((x) => x.key === asked)?.key ?? "profile";
  const s = settings.data;
  const unsaved = (key: SectionKey) => (s ? changesFor(key, s, drafts).length > 0 : false);
  const anyUnsaved = SECTIONS.some((x) => unsaved(x.key));

  useEffect(() => {
    if (!anyUnsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyUnsaved]);

  const select = (key: SectionKey) => router.replace(`/merchant/settings?tab=${key}`, { scroll: false });

  function sectionProps<K extends SectionKey>(key: K, current: ShopSettings) {
    return {
      settings: current,
      draft: drafts[key],
      setDraft: (draft: Drafts[K]) => setDrafts((all) => ({ ...all, [key]: draft })),
      onSaved: (next: ShopSettings) => {
        settings.setData(next);
        setDrafts((all) => ({ ...all, [key]: undefined }));
      },
      onSettings: (next: ShopSettings) => settings.setData(next),
    };
  }

  return (
    <>
      <PageHeader title="Settings" eyebrow={staff?.merchant.name}
        chips={s ? <StatusChip tone={s.shop.status === "live" ? "success" : "warning"} label={s.shop.status === "live" ? "Live" : s.shop.status.replace("_", " ")} /> : null} />
      {settings.error && !s ? (
        <ErrorState title="Couldn't load settings" message={errorMessage(settings.error)} onRetry={settings.reload} />
      ) : !s ? (
        <LoadingBlock label="Loading settings" slow={settings.slow} />
      ) : (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
          <Stack spacing={2} sx={{ flex: "1 1 280px", maxWidth: { md: 340 }, minWidth: 0, position: { md: "sticky" }, top: { md: 88 } }}>
            <SectionTabs s={s} selected={tab} unsaved={unsaved} onSelect={select} />
            <RoleNote s={s} />
          </Stack>
          <Stack spacing={3} role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} sx={{ flex: "3 1 600px", minWidth: 0 }}>
            {tab === "profile" ? <ProfileSection {...sectionProps("profile", s)} /> : null}
            {tab === "pickup" ? <PickupSection {...sectionProps("pickup", s)} /> : null}
            {tab === "pickup" ? <UpcomingSlots canEdit={s.can_edit} /> : null}
            {tab === "rules" ? <RulesSection {...sectionProps("rules", s)} /> : null}
            {tab === "policies" ? <PoliciesSection {...sectionProps("policies", s)} /> : null}
            {tab === "payouts" ? <PayoutsSection {...sectionProps("payouts", s)} /> : null}
          </Stack>
        </Box>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------- the list

function summary(key: SectionKey, s: ShopSettings): { status: string; tone?: Tone } {
  const p = s.policies;
  switch (key) {
    case "profile":
      return { status: [s.shop.category, s.shop.address.city].filter(Boolean).join(", ") || "Name, address and contact" };
    case "pickup": {
      if (s.pickup_paused) return { status: "Pickup paused", tone: "warning" };
      const days = WEEKDAYS.filter((d) => s.pickup.windows[d.key]).length;
      if (!days) return { status: "No pickup days", tone: "warning" };
      return { status: `${days === 7 ? "Pickup every day" : `Pickup ${plural(days, "day")} a week`}, ${s.pickup.slot_minutes}-min slots` };
    }
    case "rules":
      return { status: `${Math.round(p.reservation_ttl_seconds / 60)}-min hold, cancel ${p.cancellation_cutoff_minutes} min before` };
    case "policies": {
      const review = reviewState(s);
      return { status: review.label, tone: review.current ? undefined : "warning" };
    }
    case "payouts": {
      const connected = s.payouts.status === "connected";
      return { status: `${connected ? "PayPal connected" : "PayPal not connected"}, ${p.fees_minor ? `${money(p.fees_minor)} service fee` : "no service fee"}`, tone: connected ? undefined : "warning" };
    }
  }
}

function SectionTabs({ s, selected, unsaved, onSelect }: { s: ShopSettings; selected: SectionKey; unsaved: (key: SectionKey) => boolean; onSelect: (key: SectionKey) => void }) {
  return (
    <Tabs orientation="vertical" value={selected} onChange={(_, value: SectionKey) => onSelect(value)} aria-label="Settings sections"
      slotProps={{ indicator: { sx: { display: "none" } } }}
      sx={{ "& .MuiTabs-flexContainer, & .MuiTabs-list": { gap: 1 } }}>
      {SECTIONS.map((t) => {
        const { status, tone } = summary(t.key, s);
        return (
          <Tab key={t.key} value={t.key} id={`settings-tab-${t.key}`} aria-controls={`settings-panel-${t.key}`} disableRipple
            sx={{
              ...surface.raisedSm, p: 1.5, minHeight: 0, maxWidth: "none", borderRadius: "14px", textTransform: "none", textAlign: "left",
              alignItems: "stretch", color: brand.forest, opacity: 1,
              "&.Mui-selected": { color: brand.forest, borderColor: brand.leaf, boxShadow: `inset 0 0 0 1px ${brand.leaf}` },
              "&:hover": { borderColor: brand.lineStrong }, "&.Mui-focusVisible": { outline: `2px solid ${brand.leaf}`, outlineOffset: 2 },
            }}
            label={
              <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", width: "100%" }}>
                <IconBadge size={40}><t.icon /></IconBadge>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 700 }}>{t.label}</Typography>
                  <Typography variant="body2" sx={{ color: tone ? tones[tone].fg : "text.secondary", fontWeight: tone ? 650 : 400 }}>{status}</Typography>
                </Box>
                {unsaved(t.key) ? <StatusChip tone="warning" label="Unsaved" />
                  : t.key === "payouts" ? <FactChip icon={LockRounded} label="Owner" /> : null}
              </Stack>
            } />
        );
      })}
    </Tabs>
  );
}

function RoleNote({ s }: { s: ShopSettings }) {
  const t = tones.info;
  return (
    <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", px: 2, py: 1.5, borderRadius: "14px", bgcolor: t.bg, border: 1, borderColor: t.border, color: t.fg }}>
      <LockRounded aria-hidden sx={{ fontSize: 18, mt: 0.25 }} />
      <Typography variant="body2">
        {s.can_edit_money ? <><b>You&apos;re the owner.</b> Managers can change everything here except payouts, tax and the policy review.</>
          : s.can_edit ? <><b>You&apos;re a manager.</b> Payouts, tax and the policy review need the owner.</>
          : <>You can view these settings. <b>A manager can change them.</b></>}
      </Typography>
    </Box>
  );
}

// ----------------------------------------------------------------------------- upcoming slots

/** Day-of slot changes (close one, add a spot) apply right away, so they sit outside the hours draft, folded by default. */
function UpcomingSlots({ canEdit }: { canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ ...surface.raised, borderRadius: "16px", px: { xs: 2.5, sm: 3.5 }, py: 2 }}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>
          <Typography id={headingId} variant="h4" component="h2">Upcoming slots</Typography>
          <Typography variant="body2" color="text.secondary">Close a slot or change its capacity for today and tomorrow. Applies right away.</Typography>
        </Box>
        <Button variant="outlined" color="inherit" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          endIcon={open ? <ExpandLessRounded /> : <ExpandMoreRounded />}>
          {open ? "Hide slots" : "Show slots"}
        </Button>
      </Stack>
      {open ? <Box sx={{ mt: 2 }}><SlotsBody canEdit={canEdit} /></Box> : null}
    </Box>
  );
}

function SlotsBody({ canEdit }: { canEdit: boolean }) {
  const announce = useAnnounce();
  const slots = useResource((signal) => api<{ slots: Slot[] }>("/api/merchant/slots", { signal }), [], { pollMs: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TimelineView>("timeline");
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
    <>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} useFlexGap sx={{ mb: 2, alignItems: { sm: "center" } }}>
        <TimelineToggle value={view} onChange={setView} listLabel="Table" />
        {view === "timeline" && canEdit ? (
          <Typography variant="caption" color="text.secondary" sx={{ ml: { sm: "auto" } }}>Right-click a slot to add or remove a spot, or close it.</Typography>
        ) : null}
      </Stack>
      {error ? <Box role="alert" sx={{ color: "error.main", mb: 1.5 }}>{error}</Box> : null}
      {!slots.data ? (
        <LoadingBlock label="Loading slots" lines={3} />
      ) : view === "timeline" && slots.data.slots.length ? (
        <SlotsTimeline slots={slots.data.slots} canEdit={canEdit} onUpdate={update} />
      ) : (
        <SlotTable slots={slots.data.slots} canEdit={canEdit} busy={busy} onUpdate={update} />
      )}
    </>
  );
}
