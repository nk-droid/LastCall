"use client";

// Close-out plan: before pickup ends, an agent suggests end-of-day changes. Code has already checked each one
// against the shop's bounds; nothing changes until a manager applies it. The card pairs the plan (a before → after
// table) with a countdown to the end of pickup and the slots it would touch.

import { AutoAwesomeRounded, ShieldRounded } from "@mui/icons-material";
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from "@mui/material";
import { useEffect, useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { CLOSED_BY_MERCHANT } from "@/components/slot-status";
import { MetaRow, SectionCard, StatusChip, brand, tones, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { hhmmLabel } from "@/lib/format";
import type { CloseoutAction, CloseoutPlan, CloseoutState, Slot } from "@/lib/types";
import { useResource, useSecondsUntil, type Resource } from "@/lib/use-api";

const RESULT: Record<string, { tone: Tone; label: string }> = {
  applied: { tone: "success", label: "Applied" }, skipped: { tone: "warning", label: "Skipped" }, failed: { tone: "danger", label: "Failed" },
};

/** `state` lets a page share one close-out fetch with other widgets; `showSchedule` hides the countdown and slot
 *  strip when the page already shows when pickup ends (Today's headline strip does). */
export function CloseoutCard({ slots = [], state: shared, showSchedule = true }: { slots?: Slot[]; state?: Resource<CloseoutState>; showSchedule?: boolean }) {
  const announce = useAnnounce();
  const own = useResource((signal) => api<CloseoutState>("/api/merchant/closeout", { signal }), [], { pollMs: 60_000, enabled: !shared });
  const state = shared ?? own;
  const [busy, setBusy] = useState<"run" | "apply" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const now = useNow(30_000);
  const s = state.data;
  const plan = s?.plan ?? null;
  const ended = !s?.schedule.closes_at || Date.parse(s.schedule.closes_at) <= now;
  const open = plan && (plan.status === "pending" || plan.status === "partly_applied") && Date.parse(plan.expires_at) > now;
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

  const toggle = (id: string) => setUnchecked((u) => {
    const next = new Set(u);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const statusChip = !s ? null : open ? <StatusChip tone="warning" label="Waiting for your OK" />
    : plan ? <StatusChip tone={plan.status === "applied" ? "success" : "neutral"} label={plan.status === "applied" ? "Done" : plan.status === "dismissed" ? "Dismissed" : "Expired"} />
      : !s.schedule.enabled ? <StatusChip tone="neutral" label="Off" />
        : s.schedule.runs_at_label ? <Chip size="small" variant="outlined" label={`Plans at ${s.schedule.runs_at_label}`} /> : null;

  const subtitle = plan ? plan.summary : !s ? undefined
    : !s.schedule.enabled ? "The close-out assistant is off. Turn it on in Settings → Order rules."
      : ended ? "Today's pickup has ended. The next plan comes before tomorrow's pickup ends."
        : `${s.schedule.lead_minutes} minutes before pickup ends, the assistant suggests price cuts and slot changes. Nothing changes until a manager applies them.`;

  return (
    <SectionCard title="Close-out plan" icon={<AutoAwesomeRounded />} subtitle={subtitle} action={statusChip}>
      {error ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{error}</Alert> : null}
      {!s ? null : (
        <Stack spacing={2.5}>
          {showSchedule ? (
            <Box component="aside" aria-label="Pickup today"
              sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "minmax(250px, 300px) minmax(0, 1fr)" }, alignItems: "stretch" }}>
              <Countdown opensAt={s.schedule.opens_at} closesAt={s.schedule.closes_at} closesLabel={s.schedule.closes_at_label} />
              <SlotStrip slots={slots} actions={open ? proposed : []} now={now} />
            </Box>
          ) : null}
          <Box sx={{ minWidth: 0 }}>
            {open && proposed.length ? (
              <DiffTable actions={proposed} editable={s.can_apply} unchecked={unchecked} onToggle={toggle} />
            ) : null}
            {done.length ? <Results actions={done} /> : null}
            {open ? (
              <>
                <Footer dropped={dropped} source={plan.source} expires={plan.expires_label} />
                {s.can_apply ? (
                  <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: "flex-end" }}>
                    <Button color="inherit" variant="outlined" onClick={() => act("dismiss")} loading={busy === "dismiss"} disabled={!!busy}>Dismiss</Button>
                    <Button variant="contained" onClick={() => act("apply")} loading={busy === "apply"} disabled={!!busy || !selected.length}>
                      Apply {selected.length === proposed.length ? "all" : "selected"} ({selected.length})
                    </Button>
                  </Stack>
                ) : <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>A manager can apply these changes.</Typography>}
              </>
            ) : s.can_apply && s.schedule.enabled && !ended ? (
              <Stack direction="row" spacing={1.5} useFlexGap sx={{
                alignItems: "center", justifyContent: plan ? "flex-end" : "space-between", flexWrap: "wrap", mt: done.length ? 2 : 0,
                ...(plan ? {} : { bgcolor: brand.sand, borderRadius: "14px", p: 2 }),
              }}>
                {!plan && busy !== "run" ? (
                  <Typography variant="body2" color="text.secondary">
                    No plan yet{s.schedule.runs_at_label ? `. It runs at ${s.schedule.runs_at_label}, or you can plan now.` : "."}
                  </Typography>
                ) : null}
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
          </Box>
        </Stack>
      )}
    </SectionCard>
  );
}

// ----------------------------------------------------------------------------- plan table

export function changeLabel(a: CloseoutAction): string {
  if (a.type === "close_slot") return `Close ${a.slot_label} slot`;
  if (a.type === "reopen_slot") return `Reopen ${a.slot_label} slot`;
  if (a.type === "set_slot_capacity") return `${a.slot_label} slot`;
  if (a.type === "adjust_surplus") return `${a.name} (listed units)`;
  return a.name ?? a.title ?? a.type.replace(/_/g, " ");
}

export function cut(a: CloseoutAction): string | null {
  if (a.type !== "lower_price" || !a.old_sale_minor || !a.new_sale_minor) return null;
  return `−${Math.round((1 - a.new_sale_minor / a.old_sale_minor) * 100)}%`;
}

function DiffTable({ actions, editable, unchecked, onToggle }: {
  actions: CloseoutAction[]; editable: boolean; unchecked: Set<string>; onToggle: (id: string) => void;
}) {
  const cell = { py: 1.25, verticalAlign: "top" } as const;
  return (
    <Box sx={{ overflowX: "auto", border: 1, borderColor: brand.line, borderRadius: "14px" }}>
      <Table size="small" sx={{ minWidth: { sm: 460 } }}>
        <TableHead>
          <TableRow sx={{ bgcolor: brand.sand }}>
            {editable ? <TableCell padding="checkbox"><Box component="span" sx={visuallyHidden}>Include</Box></TableCell> : null}
            <TableCell>Change</TableCell>
            <TableCell sx={wide}>Now</TableCell>
            <TableCell>After</TableCell>
            <TableCell align="right">Cut</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {actions.map((a) => {
            const off = unchecked.has(a.id);
            return (
              <TableRow key={a.id} sx={{ "&:last-of-type td": { borderBottom: 0 }, opacity: off ? 0.55 : 1 }}>
                {editable ? (
                  <TableCell padding="checkbox" sx={{ verticalAlign: "top", pt: 0.5 }}>
                    <Checkbox size="small" checked={!off} onChange={() => onToggle(a.id)} slotProps={{ input: { "aria-label": `Include: ${a.title ?? changeLabel(a)}` } }} />
                  </TableCell>
                ) : null}
                <TableCell sx={cell}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{changeLabel(a)}</Typography>
                  {a.reason ? <Typography variant="caption" color="text.secondary" component="p">{a.reason}</Typography> : null}
                </TableCell>
                <TableCell sx={{ ...cell, ...wide, color: brand.muted, whiteSpace: "nowrap" }} className="tabular">
                  <Box component="span" sx={a.type === "lower_price" ? { textDecoration: "line-through" } : undefined}>{a.before}</Box>
                  {a.type === "close_slot" && a.booked === 0 ? <Typography variant="caption" component="p">0 booked</Typography> : null}
                </TableCell>
                <TableCell sx={{ ...cell, fontWeight: 700, whiteSpace: "nowrap" }} className="tabular">
                  <Box component="span" sx={{ display: { xs: "block", sm: "none" }, fontWeight: 400, color: brand.muted, textDecoration: a.type === "lower_price" ? "line-through" : "none", fontSize: 12 }}>
                    {a.before}
                  </Box>
                  {a.after}
                </TableCell>
                <TableCell align="right" sx={{ ...cell, color: brand.leafDark, fontWeight: 600 }} className="tabular">{cut(a) ?? "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}

const wide = { display: { xs: "none", sm: "table-cell" } } as const;
const visuallyHidden = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } as const;

function Results({ actions }: { actions: CloseoutAction[] }) {
  return (
    <Stack component="ul" spacing={0.75} sx={{ listStyle: "none", m: 0, mt: 1.5, p: 0 }}>
      {actions.map((a) => (
        <Stack component="li" key={a.id} direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <StatusChip tone={RESULT[a.status].tone} label={RESULT[a.status].label} />
          <Typography variant="body2" sx={{ color: brand.forest }}>{a.title}</Typography>
          {a.note ? <Typography variant="caption" color="text.secondary">{a.note}</Typography> : null}
        </Stack>
      ))}
    </Stack>
  );
}

function Footer({ dropped, source, expires }: { dropped: CloseoutAction[]; source: string; expires: string }) {
  return (
    <MetaRow variant="caption" sx={{ mt: 1.5, color: "text.secondary" }} items={[
      <><ShieldRounded aria-hidden sx={{ fontSize: 14, color: tones.info.fg }} />Checked against your price floor and live stock</>,
      dropped.length ? (
        <Box component="span" title={dropped.map((d) => `${d.type.replace(/_/g, " ")}: ${d.note}`).join("\n")}>
          {dropped.length} suggestion{dropped.length === 1 ? "" : "s"} blocked
        </Box>
      ) : null,
      `Expires at ${expires}`,
      source === "rules" ? "Simple rules plan (assistant unavailable)" : null,
    ]} />
  );
}

// ----------------------------------------------------------------------------- countdown and slots

export function duration(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function Countdown({ opensAt, closesAt, closesLabel }: { opensAt: string | null; closesAt: string | null; closesLabel: string | null }) {
  const left = useSecondsUntil(closesAt);
  if (!closesAt || left === null) {
    return (
      <Box sx={{ bgcolor: brand.sand, borderRadius: "16px", p: 2 }}>
        <Typography variant="body2" color="text.secondary">No pickup today.</Typography>
      </Box>
    );
  }
  const total = opensAt ? Math.max(1, (Date.parse(closesAt) - Date.parse(opensAt)) / 1000) : left || 1;
  const share = Math.min(1, Math.max(0, left / total));
  const r = 34;
  const length = 2 * Math.PI * r;
  return (
    <Box role="timer" aria-label={left ? `${duration(left)} until pickup ends at ${closesLabel}` : "Pickup has ended"}
      sx={{ bgcolor: brand.forest, color: "#fff", borderRadius: "16px", p: 2, display: "flex", gap: 1.75, alignItems: "center" }}>
      <Box component="svg" viewBox="0 0 84 84" aria-hidden sx={{ width: 76, height: 76, flexShrink: 0 }}>
        <circle cx="42" cy="42" r={r} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="8" />
        <circle cx="42" cy="42" r={r} fill="none" stroke="#7FD1A3" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={length} strokeDashoffset={length * (1 - share)} transform="rotate(-90 42 42)" />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="overline" sx={{ color: "#B9D9C6", lineHeight: 1.4, display: "block" }}>Pickup ends {closesLabel}</Typography>
        <Typography className="tabular" sx={{ fontFamily: "var(--font-heading), var(--font-inter), sans-serif", fontSize: 28, fontWeight: 800, lineHeight: 1.15 }}>
          {left ? duration(left) : "Ended"}
        </Typography>
        <Typography variant="caption" sx={{ color: "#D5E5DB" }}>{left ? "left to sell today's surplus" : "Today's pickup is over"}</Typography>
      </Box>
    </Box>
  );
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function SlotStrip({ slots, actions, now }: { slots: Slot[]; actions: CloseoutAction[]; now: number }) {
  const upcoming = slots.filter((sl) => Date.parse(sl.ends_at) > now).slice(0, 8);
  const byslot = new Map(actions.filter((a) => a.slot_id).map((a) => [a.slot_id!, a]));
  return (
    <Box sx={{ border: 1, borderColor: brand.line, borderRadius: "16px", p: 2, minWidth: 0 }}>
      <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 800, mb: 1 }}>Pickup slots left</Typography>
      {!upcoming.length ? <Typography variant="body2" color="text.secondary">No more pickup slots today.</Typography> : (
        <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 1, gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))" }}>
          {upcoming.map((sl) => {
            const change = byslot.get(sl.id);
            const closed = sl.unavailable_reason === CLOSED_BY_MERCHANT;
            const share = sl.capacity ? Math.min(1, sl.booked / sl.capacity) : 0;
            const note = change?.type === "close_slot" ? "Close" : change?.type === "set_slot_capacity" ? `→ ${change.after?.replace(" pickups", "")} spots`
              : change?.type === "reopen_slot" ? "Reopen" : closed ? "Closed" : `${sl.booked}/${sl.capacity} booked`;
            return (
              <Box component="li" key={sl.id} sx={{
                borderRadius: "10px", px: 1, py: 0.75, bgcolor: change ? tones.warning.bg : brand.cream,
                border: 1, borderColor: change ? tones.warning.border : brand.line,
              }}>
                <Typography variant="caption" className="tabular" sx={{ display: "block", fontWeight: 700, color: change ? tones.warning.fg : brand.forest }}>
                  {hhmmLabel(sl.start_local)}
                </Typography>
                <Box aria-hidden sx={{
                  height: 6, my: 0.5, borderRadius: 99, overflow: "hidden",
                  background: change?.type === "close_slot" ? `repeating-linear-gradient(135deg, ${tones.warning.bg} 0 5px, ${tones.warning.border} 5px 10px)` : brand.sand,
                }}>
                  {change?.type === "close_slot" || closed ? null : <Box sx={{ width: `${share * 100}%`, height: "100%", bgcolor: brand.leaf }} />}
                </Box>
                <Typography variant="caption" className="tabular" sx={{ display: "block", color: change ? tones.warning.fg : brand.muted, fontWeight: change ? 700 : 500 }}>
                  {note}
                </Typography>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
