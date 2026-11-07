"use client";

// The shopper's alerts: bundles their watches found (hold one, or say "not this"), and the watches themselves.

import { NotificationsNoneRounded, ScheduleRounded, StorefrontRounded } from "@mui/icons-material";
import { Alert, Box, Button, Chip, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";

import { signInHref, useAccount } from "@/components/account";
import { ALERTS_SEEN } from "@/components/alerts";
import { useAnnounce } from "@/components/announcer";
import { PriceTag } from "@/components/commerce";
import { PageShell } from "@/components/site";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, SectionCard, brand } from "@/components/ui";
import { WatchList } from "@/components/watches";
import { api, errorMessage } from "@/lib/api";
import { ago } from "@/lib/format";
import type { WatchAlert } from "@/lib/types";
import { useResource } from "@/lib/use-api";

export function Alerts() {
  const { account, loaded } = useAccount();
  const signedIn = !!account?.user;
  if (loaded && !signedIn) {
    return (
      <PageShell width="narrow">
        <EmptyState icon={NotificationsNoneRounded} title="Sign in to see your alerts"
          action={<Button href={signInHref("/alerts")} variant="contained">Sign in</Button>}>
          Ask LastCall for something, tap “Watch for this”, and matches show up here and in your email.
        </EmptyState>
      </PageShell>
    );
  }
  return (
    <PageShell width="narrow">
      <PageHeader title="Alerts" subtitle="Bundles your watches found. Nothing is held until you tap Hold & pay." />
      {signedIn ? <Inbox /> : <LoadingBlock label="Loading your alerts" lines={3} />}
      {signedIn ? <Box sx={{ mt: 3 }}><WatchList /></Box> : null}
    </PageShell>
  );
}

function Inbox() {
  const announce = useAnnounce();
  const inbox = useResource((signal) => api<{ alerts: WatchAlert[]; unread: number }>("/api/me/alerts", { signal }), [], { pollMs: 60_000 });
  const [error, setError] = useState<string | null>(null);
  // Which alerts were new when the page opened: they keep their "New" badge while the page is open.
  const fresh = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const data = inbox.data;

  useEffect(() => {
    if (!data || fresh.current) return;
    fresh.current = new Set(data.alerts.filter((a) => !a.seen && !a.opened).map((a) => a.id));
    setFreshIds(fresh.current);
    if (data.unread) {
      api("/api/me/alerts/seen", { body: {} }).then(() => window.dispatchEvent(new Event(ALERTS_SEEN))).catch(() => undefined);
    }
  }, [data]);

  async function dismiss(alert: WatchAlert) {
    setError(null);
    try {
      await api(`/api/me/alerts/${alert.id}/dismiss`, { body: {} });
      if (data) inbox.setData({ ...data, alerts: data.alerts.filter((a) => a.id !== alert.id) });
      announce(`Hidden. We won't show that bundle again.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!data) return inbox.error ? <ErrorState message={errorMessage(inbox.error)} onRetry={inbox.reload} /> : <LoadingBlock label="Loading your alerts" lines={3} />;
  return (
    <SectionCard title="Matches" icon={<NotificationsNoneRounded />} subtitle="From the last two weeks, newest first.">
      {error ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert> : null}
      {!data.alerts.length ? (
        <EmptyState icon={NotificationsNoneRounded} title="No matches yet">
          When a shop lists something that fits one of your watches, it shows up here and in your email.
        </EmptyState>
      ) : (
        <Stack component="ul" spacing={2} sx={{ listStyle: "none", m: 0, p: 0 }}>
          {data.alerts.map((a) => <AlertCard key={a.id} alert={a} fresh={freshIds.has(a.id)} onDismiss={() => dismiss(a)} />)}
        </Stack>
      )}
    </SectionCard>
  );
}

function AlertCard({ alert: a, fresh, onDismiss }: { alert: WatchAlert; fresh: boolean; onDismiss: () => void }) {
  return (
    <Box component="li" aria-label={`Found at ${a.shop.name}`} sx={{
      border: fresh ? `2px solid ${brand.leaf}` : `1px solid ${brand.line}`, borderRadius: "16px", p: 2, bgcolor: "#fff",
      display: "flex", flexDirection: "column", gap: 1,
    }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        {fresh ? <Chip size="small" label="New match" sx={{ bgcolor: brand.leaf, color: "#fff", fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", fontSize: 11 }} /> : null}
        {a.opened ? <Chip size="small" label="Opened" variant="outlined" /> : null}
        <Typography variant="caption" color="text.secondary">{ago(a.created_at)}</Typography>
      </Stack>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 800, display: "flex", alignItems: "center", gap: 0.75 }}>
        <StorefrontRounded aria-hidden sx={{ fontSize: 18, color: brand.leaf }} /> Found at {a.shop.name}
      </Typography>
      <Typography variant="body2" sx={{ color: brand.forest }}>{a.lines.map((ln) => `${ln.qty} × ${ln.name}`).join(" · ")}</Typography>
      {a.summary ? <Typography variant="body2" color="text.secondary">“{a.summary}”</Typography> : null}
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <PriceTag price={a.total_minor} currency={a.currency} size="sm" />
        {a.pickup_label ? (
          <Typography variant="caption" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: brand.leafDark, fontWeight: 650 }}>
            <ScheduleRounded aria-hidden sx={{ fontSize: 15 }} /> Pickup {a.pickup_label}
          </Typography>
        ) : null}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
        <Button href={`/watches/${a.id}`} variant="contained" sx={{ flex: 1 }}>Hold &amp; pay</Button>
        <Button variant="outlined" color="inherit" onClick={onDismiss}>Not this</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {a.watch ? `For “${a.watch.request}”. ` : ""}Price and stock are checked again when you tap Hold &amp; pay.
      </Typography>
    </Box>
  );
}
