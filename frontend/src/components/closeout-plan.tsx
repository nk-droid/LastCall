"use client";

// Close-out plan: before pickup ends, an agent suggests end-of-day changes. Code has already checked each one
// against the shop's bounds; nothing changes until a manager applies it.

import {
  AutoAwesomeRounded,
  EventAvailableRounded,
  EventBusyRounded,
  Inventory2Rounded,
  PauseRounded,
  PlayArrowRounded,
  SellRounded,
  ShieldRounded,
  TuneRounded,
} from "@mui/icons-material";
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { SectionCard, StatusChip, brand, surface, tones, type Icon, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { CloseoutAction, CloseoutPlan, CloseoutState } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const ICON: Record<CloseoutAction["type"], Icon> = {
  lower_price: SellRounded, adjust_surplus: Inventory2Rounded, pause_listing: PauseRounded, resume_listing: PlayArrowRounded,
  close_slot: EventBusyRounded, reopen_slot: EventAvailableRounded, set_slot_capacity: TuneRounded,
};
const RESULT: Record<string, { tone: Tone; label: string }> = {
  applied: { tone: "success", label: "Applied" }, skipped: { tone: "warning", label: "Skipped" }, failed: { tone: "danger", label: "Failed" },
};

export function CloseoutCard() {
  const announce = useAnnounce();
  const state = useResource((signal) => api<CloseoutState>("/api/merchant/closeout", { signal }), [], { pollMs: 60_000 });
  const [busy, setBusy] = useState<"run" | "apply" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const s = state.data;
  const plan = s?.plan ?? null;
  const open = plan && (plan.status === "pending" || plan.status === "partly_applied");
  const proposed = plan?.actions.filter((a) => a.status === "proposed") ?? [];
  const selected = proposed.filter((a) => !unchecked.has(a.id));
  const done = plan?.actions.filter((a) => RESULT[a.status]) ?? [];
  const dropped = plan?.actions.filter((a) => a.status === "dropped") ?? [];

  async function act(kind: "run" | "apply" | "dismiss") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "run") await api<CloseoutPlan>("/api/merchant/closeout/run", { body: {}, timeoutMs: 120_000 });
      else if (kind === "apply") await api<CloseoutPlan>(`/api/merchant/closeout/${plan!.id}/apply`, { body: { action_ids: selected.map((a) => a.id) } });
      else await api<CloseoutPlan>(`/api/merchant/closeout/${plan!.id}/dismiss`, { body: {} });
      setUnchecked(new Set());
      announce(kind === "run" ? "Close-out plan ready" : kind === "apply" ? `Applied ${selected.length} changes` : "Close-out plan dismissed");
      state.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const scheduleChip = !s ? null : !s.schedule.enabled ? <StatusChip tone="neutral" label="Off" />
    : s.schedule.runs_at_label ? <Chip size="small" variant="outlined" label={`Plans at ${s.schedule.runs_at_label}`} /> : null;
  const statusChip = plan && !open ? (
    <StatusChip tone={plan.status === "applied" ? "success" : "neutral"} label={plan.status === "applied" ? "Done" : plan.status === "dismissed" ? "Dismissed" : "Expired"} />
  ) : null;

  return (
    <SectionCard title="Close-out plan" icon={<AutoAwesomeRounded />}
      subtitle={open ? plan.summary : plan ? plan.summary : s?.schedule.enabled
        ? `${s.schedule.lead_minutes} minutes before pickup ends${s.schedule.closes_at_label ? ` (${s.schedule.closes_at_label})` : ""}, the assistant suggests price cuts and slot changes. Nothing changes until a manager applies them.`
        : "The close-out assistant is off. Turn it on in Settings → Policies."}
      action={<Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>{statusChip ?? scheduleChip}</Stack>}>
      {error ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert> : null}
      {!s ? null : open ? (
        <>
          {proposed.length ? (
            <Stack component="ul" spacing={1} sx={{ listStyle: "none", m: 0, p: 0 }}>
              {proposed.map((a) => <ActionRow key={a.id} action={a} checked={!unchecked.has(a.id)} editable={s.can_apply}
                onToggle={() => setUnchecked((u) => { const next = new Set(u); if (next.has(a.id)) next.delete(a.id); else next.add(a.id); return next; })} />)}
            </Stack>
          ) : null}
          {done.length ? <Results actions={done} /> : null}
          <Footer dropped={dropped} source={plan.source} expires={plan.expires_label} />
          {s.can_apply ? (
            <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: "flex-end" }}>
              <Button color="inherit" onClick={() => act("dismiss")} loading={busy === "dismiss"} disabled={!!busy}>Dismiss</Button>
              <Button variant="contained" onClick={() => act("apply")} loading={busy === "apply"} disabled={!!busy || !selected.length}>
                Apply {selected.length === proposed.length ? "all" : "selected"} ({selected.length})
              </Button>
            </Stack>
          ) : <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>A manager can apply these changes.</Typography>}
        </>
      ) : (
        <>
          {plan && done.length ? <Results actions={done} /> : null}
          {s.can_apply && s.schedule.enabled ? (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", justifyContent: "flex-end", mt: plan ? 2 : 0 }}>
              {busy === "run" ? (
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: "text.secondary" }} role="status">
                  <CircularProgress size={16} /><Typography variant="body2">Checking stock, slots and today&apos;s sales…</Typography>
                </Stack>
              ) : null}
              <Button variant="outlined" color="inherit" startIcon={<AutoAwesomeRounded />} onClick={() => act("run")} loading={busy === "run"}>
                {plan ? "Plan again" : "Plan now"}
              </Button>
            </Stack>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

function ActionRow({ action, checked, editable, onToggle }: { action: CloseoutAction; checked: boolean; editable: boolean; onToggle: () => void }) {
  const ActionIcon = ICON[action.type];
  return (
    <Box component="li" sx={{ ...surface.raisedSm, borderRadius: "14px", px: 1.5, py: 1.25, display: "flex", gap: 1.25, alignItems: "flex-start" }}>
      {editable ? <Checkbox checked={checked} onChange={onToggle} size="small" sx={{ mt: -0.5, ml: -0.5 }} slotProps={{ input: { "aria-label": action.title ?? action.type } }} /> : null}
      <ActionIcon aria-hidden sx={{ fontSize: 20, color: brand.leaf, mt: 0.25, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography variant="subtitle2" component="span" sx={{ fontWeight: 700 }}>{action.title}</Typography>
          {action.before && action.after ? (
            <Typography variant="caption" className="tabular" sx={{ color: brand.muted }}>
              <Box component="span" sx={{ textDecoration: "line-through" }}>{action.before}</Box> → <Box component="span" sx={{ color: brand.leafDark, fontWeight: 700 }}>{action.after}</Box>
            </Typography>
          ) : null}
        </Stack>
        {action.reason ? <Typography variant="caption" color="text.secondary" component="p">{action.reason}</Typography> : null}
      </Box>
    </Box>
  );
}

function Results({ actions }: { actions: CloseoutAction[] }) {
  return (
    <Stack component="ul" spacing={0.75} sx={{ listStyle: "none", m: 0, mt: 1.5, p: 0 }}>
      {actions.map((a) => (
        <Stack component="li" key={a.id} direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <StatusChip tone={RESULT[a.status].tone} label={RESULT[a.status].label} />
          <Typography variant="body2" sx={{ color: brand.forest }}>{a.title}</Typography>
          {a.note ? <Typography variant="caption" color="text.secondary">· {a.note}</Typography> : null}
        </Stack>
      ))}
    </Stack>
  );
}

function Footer({ dropped, source, expires }: { dropped: CloseoutAction[]; source: string; expires: string }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, alignItems: "center", flexWrap: "wrap", color: "text.secondary" }}>
      <Typography variant="caption">Expires at {expires} when pickup ends.</Typography>
      {source === "rules" ? <Typography variant="caption">· Simple rules plan (assistant unavailable).</Typography> : null}
      {dropped.length ? (
        <Typography variant="caption" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }} title={dropped.map((d) => `${d.type.replace(/_/g, " ")}: ${d.note}`).join("\n")}>
          <ShieldRounded aria-hidden sx={{ fontSize: 14, color: tones.info.fg }} />
          {dropped.length} suggestion{dropped.length === 1 ? " was" : "s were"} blocked by the shop&apos;s safety rules
        </Typography>
      ) : null}
    </Stack>
  );
}
