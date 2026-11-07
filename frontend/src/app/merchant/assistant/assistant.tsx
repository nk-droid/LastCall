"use client";

// The shop's AI teammates: what the close-out agent, Ask LastCall and Watch alerts did for this shop this week,
// what shoppers asked for that the shop couldn't offer, and the switches for both agents.

import {
  AutoAwesomeRounded, ForumRounded, NotificationsActiveRounded, ScheduleRounded, SearchOffRounded, TuneRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, FormControlLabel, Grid, Stack, Switch, Typography } from "@mui/material";
import { useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { useStaff } from "@/components/merchant-shell";
import { EmptyState, ErrorState, IconBadge, LoadingBlock, PageHeader, SectionCard, StatusChip, brand, tones, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import { useResource } from "@/lib/use-api";

type FeedItem = {
  id: string; kind: "closeout" | "concierge" | "concierge_skip" | "watch"; at: string; day: string; time_label: string;
  title: string; detail: string; status: { tone: Tone; label: string } | null; action: "review" | null;
};
type Activity = {
  today: string;
  teammates: {
    closeout: { enabled: boolean; status: string | null; waiting: boolean; runs_at_label: string | null };
    concierge: { listed: boolean; suggested_today: number; suggested_week: number };
    watch: { alerts_today: number; alerts_week: number; watching: number };
  };
  feed: FeedItem[];
  gaps: { label: string; count: number }[];
  policies: { closeout_enabled: boolean; concierge_listed: boolean };
  can_edit: boolean;
};

const DOT: Record<FeedItem["kind"], string> = {
  closeout: tones.warning.fg, concierge: brand.leaf, concierge_skip: brand.lineStrong, watch: tones.info.fg,
};

export function Assistant() {
  const shopName = useStaff()?.merchant?.name;
  const activity = useResource((signal) => api<Activity>("/api/merchant/assistant", { signal }), [], { pollMs: 60_000 });
  const a = activity.data;

  return (
    <Box>
      <PageHeader eyebrow={shopName} title="Your AI teammates"
        subtitle="Three assistants work for your shop. Each one uses your live stock and rules, and nothing that changes prices or listings happens without a manager." />
      {!a ? (activity.error ? <ErrorState message={errorMessage(activity.error)} onRetry={activity.reload} /> : <LoadingBlock label="Loading your assistants" lines={4} />) : (
        <Stack spacing={3}>
          <Teammates a={a} />
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, lg: 8 }}><Feed a={a} /></Grid>
            <Grid size={{ xs: 12, lg: 4 }}>
              <Stack spacing={3}>
                <Gaps gaps={a.gaps} />
                <Switches a={a} onChanged={activity.reload} />
              </Stack>
            </Grid>
          </Grid>
        </Stack>
      )}
    </Box>
  );
}

// ----------------------------------------------------------------------------- teammates

function Teammate({ icon, tone, name, description, status, statusTone }: {
  icon: ReactNode; tone: Tone; name: string; description: string; status: ReactNode; statusTone: Tone;
}) {
  return (
    <Box component="article" aria-label={name} sx={{ bgcolor: "#fff", border: 1, borderColor: brand.line, borderRadius: "16px", p: 2.25, display: "flex", gap: 1.5, height: "100%", boxSizing: "border-box" }}>
      <IconBadge tone={tone} size={40}>{icon}</IconBadge>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 800, lineHeight: 1.3 }}>{name}</Typography>
        <Typography variant="body2" color="text.secondary">{description}</Typography>
        <Typography variant="body2" sx={{ mt: 1, fontWeight: 700, color: tones[statusTone].fg }}>{status}</Typography>
      </Box>
    </Box>
  );
}

function Teammates({ a }: { a: Activity }) {
  const { closeout: co, concierge: cc, watch: w } = a.teammates;
  return (
    <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(3, minmax(0, 1fr))" } }}>
      <Teammate icon={<ScheduleRounded />} tone="warning" name="Close-out" description="Drafts price and slot changes before pickup ends."
        statusTone={co.waiting ? "warning" : "neutral"}
        status={!co.enabled ? "Off" : co.waiting ? "1 plan waiting for your OK" : co.status ? `Today: ${co.status.toLowerCase()}` : co.runs_at_label ? `Plans at ${co.runs_at_label}` : "No pickup today"} />
      <Teammate icon={<ForumRounded />} tone="success" name="Ask LastCall" description="Suggests your bundles when shoppers ask for something."
        statusTone={cc.listed ? "success" : "neutral"}
        status={!cc.listed ? "Your shop is hidden from it" : cc.suggested_today ? `Suggested you ${cc.suggested_today}× today`
          : cc.suggested_week ? `Suggested you ${cc.suggested_week}× this week` : "Not suggested yet this week"} />
      <Teammate icon={<NotificationsActiveRounded />} tone="info" name="Watch alerts" description="Tells waiting shoppers when you list something that fits."
        statusTone="info"
        status={`${w.alerts_today ? `${plural(w.alerts_today, "alert")} sent today` : w.alerts_week ? `${plural(w.alerts_week, "alert")} this week` : "No alerts yet this week"}`
          + ` · ${plural(w.watching, "shopper")} watching`} />
    </Box>
  );
}

// ----------------------------------------------------------------------------- feed

function dayLabel(day: string, today: string): string {
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

function Feed({ a }: { a: Activity }) {
  const days = [...new Set(a.feed.map((i) => i.day))];
  return (
    <SectionCard title="This week" icon={<AutoAwesomeRounded />} subtitle="What each assistant did for your shop, newest first.">
      {!a.feed.length ? (
        <EmptyState icon={AutoAwesomeRounded} title="Nothing yet this week">
          Close-out plans, suggestions from Ask LastCall and watch alerts for your shop will show up here.
        </EmptyState>
      ) : days.map((day) => (
        <Box key={day} component="section" aria-label={dayLabel(day, a.today)} sx={{ "& + &": { mt: 2.5 } }}>
          <Typography variant="overline" component="h3" sx={{ color: brand.muted, display: "block", mb: 0.5 }}>{dayLabel(day, a.today)}</Typography>
          <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {a.feed.filter((i) => i.day === day).map((item) => (
              <Box component="li" key={item.id} sx={{
                display: "grid", gridTemplateColumns: { xs: "12px minmax(0, 1fr)", sm: "68px 12px minmax(0, 1fr) auto" }, columnGap: 1.5, rowGap: 0.75,
                alignItems: "start", py: 1.5, "& + &": { borderTop: 1, borderColor: brand.line },
              }}>
                <Typography variant="caption" color="text.secondary" className="tabular" sx={{ display: { xs: "none", sm: "block" }, pt: 0.25 }}>{item.time_label}</Typography>
                <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: DOT[item.kind], mt: 0.75 }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {item.title}
                    <Box component="span" sx={{ display: { sm: "none" }, fontWeight: 400, color: brand.muted }}> · {item.time_label}</Box>
                  </Typography>
                  <Typography variant="body2" color="text.secondary">{item.detail}</Typography>
                </Box>
                <Box sx={{ gridColumn: { xs: "2", sm: "auto" }, justifySelf: { sm: "end" } }}>
                  {item.action === "review" ? (
                    <Button href="/merchant" size="small" variant="contained">Review</Button>
                  ) : item.status ? <StatusChip tone={item.status.tone} label={item.status.label} /> : null}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </SectionCard>
  );
}

// ----------------------------------------------------------------------------- side column

function Gaps({ gaps }: { gaps: Activity["gaps"] }) {
  return (
    <SectionCard title="Asked for, not on your shelf" icon={<SearchOffRounded />}
      subtitle="Shopper requests this week where Ask LastCall passed on your shop.">
      {!gaps.length ? <Typography variant="body2" color="text.secondary">Nothing missed this week.</Typography> : (
        <Stack component="ul" spacing={1} sx={{ listStyle: "none", m: 0, p: 0 }}>
          {gaps.map((g) => (
            <Box component="li" key={g.label} sx={{ display: "flex", justifyContent: "space-between", gap: 2, bgcolor: brand.sand, borderRadius: "12px", px: 1.5, py: 1.25 }}>
              <Typography variant="body2">{g.label}</Typography>
              <Typography variant="body2" className="tabular" sx={{ fontWeight: 800 }} aria-label={plural(g.count, "request")}>{g.count}</Typography>
            </Box>
          ))}
        </Stack>
      )}
    </SectionCard>
  );
}

function Switches({ a, onChanged }: { a: Activity; onChanged: () => void }) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function set(key: "closeout_enabled" | "concierge_listed", value: boolean) {
    setBusy(key);
    setError(null);
    try {
      await api("/api/merchant/shop/policies", { method: "PATCH", body: { [key]: value } });
      announce(key === "closeout_enabled" ? `Close-out plans turned ${value ? "on" : "off"}` : value ? "Your shop is back in Ask LastCall" : "Your shop is hidden from Ask LastCall");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const row = (key: "closeout_enabled" | "concierge_listed", label: string, help: string, checked: boolean) => (
    <Box>
      <FormControlLabel labelPlacement="start" sx={{ m: 0, width: "100%", justifyContent: "space-between", gap: 2 }}
        control={<Switch checked={checked} disabled={!a.can_edit || !!busy} onChange={(_, v) => set(key, v)} />}
        label={<Typography variant="body2" sx={{ fontWeight: 600 }}>{label}</Typography>} />
      <Typography variant="caption" color="text.secondary" component="p">{help}</Typography>
    </Box>
  );

  return (
    <SectionCard title="Assistant settings" icon={<TuneRounded />} subtitle={a.can_edit ? undefined : "A manager can change these."}>
      {error ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert> : null}
      <Stack spacing={2}>
        {row("closeout_enabled", "Close-out plans", "A plan before pickup ends each day. Change the timing in Settings › Order rules.", a.policies.closeout_enabled)}
        {row("concierge_listed", "Suggest my shop in Ask LastCall", "When off, the assistant on LastCall's home page skips your shop. Your storefront's own assistant still works.", a.policies.concierge_listed)}
      </Stack>
    </SectionCard>
  );
}
