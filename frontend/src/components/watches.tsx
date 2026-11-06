"use client";

// Watch for me: shoppers save a request and get one email when a shop lists a bundle that fits.

import { NotificationsActiveRounded, NotificationsOffRounded, PauseRounded, PlayArrowRounded, StorefrontRounded } from "@mui/icons-material";
import { Alert, Box, Button, Chip, IconButton, Link, Stack, Tooltip, Typography } from "@mui/material";
import { useState } from "react";

import { signInHref, useAccount } from "@/components/account";
import { useAnnounce } from "@/components/announcer";
import { EmptyState, LoadingBlock, SectionCard, StatusChip, brand, surface } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Watch } from "@/lib/types";
import { useResource } from "@/lib/use-api";

/** Under a concierge reply: save what the shopper asked for as a watch. */
export function WatchThis({ conversationId, hasCards }: { conversationId: string; hasCards: boolean }) {
  const { account } = useAccount();
  const announce = useAnnounce();
  const [saved, setSaved] = useState<Watch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lead = hasCards ? "Want more like this later?" : "Nothing fits right now.";
  if (!account?.user) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ pl: 4.5 }}>
        {lead}{" "}
        <Link href={signInHref(typeof window === "undefined" ? "/" : window.location.pathname)}>Sign in</Link> and we&apos;ll email you when a shop lists one.
      </Typography>
    );
  }
  if (saved) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", pl: 4.5 }} role="status">
        <NotificationsActiveRounded aria-hidden sx={{ fontSize: 18, color: brand.leaf }} />
        <Typography variant="body2" sx={{ color: brand.forest }}>
          Watching. We&apos;ll email you once a day at most when a shop lists a bundle like this. <Link href="/account#watches">Manage</Link>
        </Typography>
      </Stack>
    );
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const watch = await api<Watch>("/api/me/watches", { body: { conversation_id: conversationId } });
      setSaved(watch);
      announce("Watching for bundles like this");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack direction="row" spacing={1.25} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", pl: 4.5 }}>
      <Typography variant="body2" color="text.secondary">{lead}</Typography>
      <Button size="small" variant="outlined" color="inherit" startIcon={<NotificationsActiveRounded />} loading={busy} onClick={save}>
        Watch for this
      </Button>
      {error ? <Typography variant="caption" color="error" role="alert">{error}</Typography> : null}
    </Stack>
  );
}

/** Account page: the shopper's watches, with pause/resume and stop. */
export function WatchList() {
  const announce = useAnnounce();
  const list = useResource((signal) => api<{ watches: Watch[]; limit: number }>("/api/me/watches", { signal }), []);
  const [error, setError] = useState<string | null>(null);
  async function act(watch: Watch, action: "pause" | "resume" | "stop") {
    setError(null);
    try {
      if (action === "stop") await api(`/api/me/watches/${watch.id}`, { method: "DELETE" });
      else await api(`/api/me/watches/${watch.id}`, { method: "PATCH", body: { status: action === "pause" ? "paused" : "active" } });
      announce(action === "stop" ? "Stopped watching" : action === "pause" ? "Watch paused" : "Watch resumed");
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <SectionCard id="watches" title="Watching for" icon={<NotificationsActiveRounded />}
      subtitle="We check these whenever shops list surplus and email you at most once a day per watch. Nothing is held until you tap the email.">
      {error ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert> : null}
      {!list.data ? <LoadingBlock label="Loading your watches" lines={2} /> : !list.data.watches.length ? (
        <EmptyState icon={NotificationsOffRounded} title="Nothing yet">Ask LastCall for something, then tap “Watch for this”.</EmptyState>
      ) : (
        <Stack component="ul" spacing={1.5} sx={{ listStyle: "none", m: 0, p: 0 }}>
          {list.data.watches.map((w) => (
            <Box component="li" key={w.id} sx={{ ...surface.raisedSm, borderRadius: "14px", p: 1.75 }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" component="p" sx={{ fontWeight: 700 }}>“{w.request}”</Typography>
                  <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", mt: 0.75 }}>
                    <StatusChip tone={w.status === "active" ? "success" : w.status === "paused" ? "neutral" : "warning"}
                      label={w.status === "active" ? "Watching" : w.status === "paused" ? "Paused" : "Expired"} />
                    {w.shop ? <Chip size="small" icon={<StorefrontRounded />} label={w.shop.name} /> : <Chip size="small" label="Any shop" />}
                    {w.facts.map((f) => <Chip key={f} size="small" variant="outlined" label={f} />)}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
                    {w.matches_sent ? `${w.matches_sent} sent · last ${ago(w.last_notified_at)}` : "No matches yet"} · {w.status === "expired" ? "ended" : `ends ${new Date(w.expires_at).toLocaleDateString()}`}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.5}>
                  {w.status === "active" ? (
                    <Tooltip title="Pause"><IconButton aria-label={`Pause watching for ${w.request}`} onClick={() => act(w, "pause")}><PauseRounded /></IconButton></Tooltip>
                  ) : (
                    <Tooltip title={w.status === "expired" ? "Watch for another week" : "Resume"}>
                      <IconButton aria-label={`Resume watching for ${w.request}`} onClick={() => act(w, "resume")}><PlayArrowRounded /></IconButton>
                    </Tooltip>
                  )}
                  <Button size="small" color="inherit" onClick={() => act(w, "stop")} aria-label={`Stop watching for ${w.request}`}>Stop</Button>
                </Stack>
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </SectionCard>
  );
}
