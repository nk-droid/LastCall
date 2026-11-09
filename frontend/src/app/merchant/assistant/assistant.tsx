"use client";

// The shop's AI teammates, one at a time: a list of the three assistants (each with what it did today and
// whether it's on) and the selected one's details: its switch, its rules, what it did this week, and what came
// of it. The selection lives in the URL (?a=ask), so a link can open a specific assistant.

import { ArrowForwardRounded, ForumRounded, NotificationsActiveRounded, ScheduleRounded, VerifiedUserRounded } from "@mui/icons-material";
import {
  Alert, Box, Button, Link, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, Typography,
} from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { changeLabel, cut } from "@/components/closeout-plan";
import { useStaff } from "@/components/merchant-shell";
import { ErrorState, FactChip, IconBadge, LoadingBlock, PageHeader, StatusChip, brand, surface, tones, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import type { CloseoutAction, CloseoutState } from "@/lib/types";
import { useResource, useSecondsUntil, type Resource } from "@/lib/use-api";

type FeedItem = {
  id: string; kind: "closeout" | "concierge" | "concierge_skip" | "watch"; at: string; day: string; time_label: string;
  title: string; detail: string; status: { tone: Tone; label: string } | null; action: "review" | null;
};
type Activity = {
  today: string;
  teammates: {
    closeout: { enabled: boolean; status: string | null; waiting: boolean; runs_at_label: string | null };
    concierge: { listed: boolean; suggested_today: number; suggested_week: number; ordered_week: number };
    watch: { alerts_today: number; alerts_week: number; watching: number; opened_week: number; ordered_week: number };
  };
  feed: FeedItem[];
  gaps: { label: string; count: number }[];
  policies: { closeout_enabled: boolean; concierge_listed: boolean };
  can_edit: boolean;
};

type Key = "closeout" | "ask" | "watch";
const KEYS: Key[] = ["closeout", "ask", "watch"];
const list = { listStyle: "none", m: 0, p: 0 } as const;

export function Assistant() {
  const shopName = useStaff()?.merchant?.name;
  const params = useSearchParams();
  const router = useRouter();
  const activity = useResource((signal) => api<Activity>("/api/merchant/assistant", { signal }), [], { pollMs: 60_000 });
  const closeout = useResource((signal) => api<CloseoutState>("/api/merchant/closeout", { signal }), [], { pollMs: 60_000 });
  const asked = params.get("a") as Key | null;
  const selected: Key = asked && KEYS.includes(asked) ? asked : "closeout";
  const select = (key: Key) => router.replace(key === "closeout" ? "/merchant/assistant" : `/merchant/assistant?a=${key}`, { scroll: false });
  const a = activity.data;
  const reload = () => {
    activity.reload();
    closeout.reload();
  };

  return (
    <Box>
      <PageHeader eyebrow={shopName} title="AI teammates"
        subtitle={
          <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}>
            <VerifiedUserRounded aria-hidden sx={{ fontSize: 18, color: brand.leaf }} />
            Prices and listings never change without a manager.
          </Box>
        } />
      {!a ? (activity.error ? <ErrorState message={errorMessage(activity.error)} onRetry={activity.reload} /> : <LoadingBlock label="Loading your assistants" lines={4} />) : (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
          <Stack spacing={2} sx={{ flex: "1 1 300px", maxWidth: { md: 380 }, minWidth: 0 }}>
            <AssistantTabs a={a} selected={selected} onSelect={select} />
            {a.gaps.length ? <Missed gaps={a.gaps} onOpen={() => select("ask")} /> : null}
          </Stack>
          <Box role="tabpanel" id={`assistant-panel-${selected}`} aria-labelledby={`assistant-tab-${selected}`} sx={{ flex: "3 1 600px", minWidth: 0 }}>
            {selected === "closeout" ? <CloseoutDetail a={a} closeout={closeout} onChanged={reload} />
              : selected === "ask" ? <AskDetail a={a} onChanged={reload} /> : <WatchDetail a={a} />}
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ----------------------------------------------------------------------------- the list

function AssistantTabs({ a, selected, onSelect }: { a: Activity; selected: Key; onSelect: (key: Key) => void }) {
  const { closeout: co, concierge: cc, watch: w } = a.teammates;
  const tabs: { key: Key; icon: ReactNode; tone: Tone; name: string; status: string; statusTone?: Tone; state: string }[] = [
    {
      key: "closeout", icon: <ScheduleRounded />, tone: "warning", name: "Close-out", state: co.enabled ? "On" : "Off",
      statusTone: co.waiting ? "warning" : undefined,
      status: !co.enabled ? "Off" : co.waiting ? "Plan waiting for your OK" : co.status ? `Today: ${co.status.toLowerCase()}`
        : co.runs_at_label ? `Plans at ${co.runs_at_label}` : "No pickup today",
    },
    {
      key: "ask", icon: <ForumRounded />, tone: "success", name: "Ask LastCall", state: cc.listed ? "On" : "Off",
      status: !cc.listed ? "Your shop is hidden"
        : `${plural(cc.suggested_today, "suggestion")} today${cc.ordered_week ? ` · ${plural(cc.ordered_week, "order")} this week` : ""}`,
    },
    {
      key: "watch", icon: <NotificationsActiveRounded />, tone: "info", name: "Watch alerts", state: "On",
      status: `${plural(w.alerts_today, "alert")} today · ${w.watching} watching`,
    },
  ];
  return (
    <Tabs orientation="vertical" value={selected} onChange={(_, value: Key) => onSelect(value)} aria-label="Assistants"
      slotProps={{ indicator: { sx: { display: "none" } } }}
      sx={{ "& .MuiTabs-flexContainer, & .MuiTabs-list": { gap: 1 } }}>
      {tabs.map((t) => (
        <Tab key={t.key} value={t.key} id={`assistant-tab-${t.key}`} aria-controls={`assistant-panel-${t.key}`} disableRipple
          sx={{
            ...surface.raisedSm, p: 1.75, minHeight: 0, maxWidth: "none", borderRadius: "14px", textTransform: "none", textAlign: "left",
            alignItems: "stretch", color: brand.forest, opacity: 1,
            "&.Mui-selected": { color: brand.forest, borderColor: brand.leaf, boxShadow: `inset 0 0 0 1px ${brand.leaf}` },
            "&:hover": { borderColor: brand.lineStrong }, "&.Mui-focusVisible": { outline: `2px solid ${brand.leaf}`, outlineOffset: 2 },
          }}
          label={
            <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", width: "100%" }}>
              <IconBadge tone={t.tone} size={40}>{t.icon}</IconBadge>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700 }}>{t.name}</Typography>
                <Typography variant="body2" sx={{ color: t.statusTone ? tones[t.statusTone].fg : "text.secondary", fontWeight: t.statusTone ? 650 : 400 }}>
                  {t.status}
                </Typography>
              </Box>
              <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: "0.06em", color: t.state === "On" ? brand.leafDark : brand.muted }}>
                {t.state.toUpperCase()}
              </Typography>
            </Stack>
          } />
      ))}
    </Tabs>
  );
}

/** One request type per row with its count on the right, so the list scans down instead of wrapping. */
function Missed({ gaps, onOpen }: { gaps: Activity["gaps"]; onOpen: () => void }) {
  const t = tones.warning;
  const total = gaps.reduce((n, g) => n + g.count, 0);
  // Top three, then the rest folded into one row so the counts add up to the total.
  const rest = gaps.slice(3).reduce((n, g) => n + g.count, 0);
  const rows = rest ? [...gaps.slice(0, 3), { label: "Other requests", count: rest }] : gaps.slice(0, 3);
  return (
    <Box component="section" aria-labelledby="missed-heading" sx={{ bgcolor: t.bg, border: 1, borderColor: t.border, borderRadius: "14px", px: 2, py: 1.5, color: t.fg }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", justifyContent: "space-between", mb: 0.75 }}>
        <Typography id="missed-heading" component="h2" variant="body2" sx={{ fontWeight: 700 }}>Missed this week</Typography>
        <Typography variant="caption" className="tabular" sx={{ fontWeight: 650 }}>{plural(total, "request")}</Typography>
      </Stack>
      <Box component="ul" sx={{ ...list, borderTop: 1, borderColor: t.border }}>
        {rows.map((g) => (
          <Box component="li" key={g.label} sx={{ display: "flex", alignItems: "baseline", gap: 2, py: 0.75, borderBottom: 1, borderColor: t.border }}>
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>{g.label}</Typography>
            <Typography variant="body2" className="tabular" sx={{ fontWeight: 700 }}>{g.count}</Typography>
          </Box>
        ))}
      </Box>
      <Link component="button" type="button" variant="body2" onClick={onOpen}
        sx={{ mt: 1, display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 600, color: t.fg }}>
        See what shoppers asked for <ArrowForwardRounded aria-hidden sx={{ fontSize: 16 }} />
      </Link>
    </Box>
  );
}

// ----------------------------------------------------------------------------- shared detail parts

function Panel({ icon, tone, title, description, control, children }: {
  icon: ReactNode; tone: Tone; title: string; description: string; control: ReactNode; children: ReactNode;
}) {
  return (
    <Box component="section" aria-label={title} sx={{ ...surface.raised, borderRadius: "16px", p: { xs: 2.5, sm: 3 }, display: "grid", gap: 2.5 }}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <IconBadge tone={tone} size={48}>{icon}</IconBadge>
        <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>
          <Typography variant="h3" component="h2">{title}</Typography>
          <Typography variant="body2" color="text.secondary">{description}</Typography>
        </Box>
        <Box sx={{ ml: "auto" }}>{control}</Box>
      </Stack>
      {children}
    </Box>
  );
}

function Facts({ items }: { items: (string | null | false)[] }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      {items.filter(Boolean).map((label) => <FactChip key={label as string} label={label} />)}
    </Stack>
  );
}

function Section({ title, chip, subtitle, children }: { title: string; chip?: ReactNode; subtitle?: string; children: ReactNode }) {
  return (
    <Box>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", mb: subtitle ? 0.25 : 1 }}>
        <Typography variant="h4" component="h3">{title}</Typography>
        {chip}
      </Stack>
      {subtitle ? <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{subtitle}</Typography> : null}
      {children}
    </Box>
  );
}

function PolicySwitch({ policy, label, checked, canEdit, onText = "On", offText = "Off", onChanged }: {
  policy: "closeout_enabled" | "concierge_listed"; label: string; checked: boolean; canEdit: boolean; onText?: string; offText?: string; onChanged: () => void;
}) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function set(value: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/merchant/shop/policies", { method: "PATCH", body: { [policy]: value } });
      announce(policy === "closeout_enabled" ? `Close-out plans turned ${value ? "on" : "off"}` : value ? "Your shop is back in Ask LastCall" : "Your shop is hidden from Ask LastCall");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack sx={{ alignItems: "flex-end" }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <Typography variant="body2" aria-hidden sx={{ fontWeight: 650 }}>{checked ? onText : offText}</Typography>
        <Switch checked={checked} disabled={!canEdit || busy} onChange={(_, value) => set(value)} slotProps={{ input: { "aria-label": label } }} />
      </Stack>
      {!canEdit ? <Typography variant="caption" color="text.secondary">A manager can change these.</Typography> : null}
      {error ? <Typography variant="caption" color="error" role="alert">{error}</Typography> : null}
    </Stack>
  );
}

function shortDay(day: string, today: string): string {
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  if (diff === 0) return "";
  if (diff === 1) return "Yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

/** "Ask LastCall suggested your bundle" reads as "Suggested your bundle" inside Ask LastCall's own panel. */
function shortTitle(title: string): string {
  const t = title.replace(/^(Ask LastCall|Close-out) /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function ActivityList({ items, today, empty }: { items: FeedItem[]; today: string; empty: string }) {
  if (!items.length) return <Typography variant="body2" color="text.secondary">{empty}</Typography>;
  return (
    <Box component="ol" sx={list}>
      {items.map((item) => {
        const day = shortDay(item.day, today);
        return (
          <Box component="li" key={item.id} sx={{
            display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr) auto", sm: "92px minmax(0, 1fr) auto" }, columnGap: 1.5, rowGap: 0.25,
            alignItems: "center", py: 1.25, borderTop: 1, borderColor: brand.line,
          }}>
            <Typography variant="body2" color="text.secondary" className="tabular" sx={{ display: { xs: "none", sm: "block" } }}>
              {day ? `${day} ` : ""}{item.time_label}
            </Typography>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 650 }}>{shortTitle(item.title)}</Typography>
              <Typography variant="body2" color="text.secondary">{item.detail}</Typography>
            </Box>
            <Box>{item.status ? <StatusChip tone={item.status.tone} label={item.status.label} /> : null}</Box>
          </Box>
        );
      })}
    </Box>
  );
}

// ----------------------------------------------------------------------------- close-out

const RESULT: Record<string, { tone: Tone; label: string }> = {
  applied: { tone: "success", label: "Applied" }, skipped: { tone: "warning", label: "Skipped" }, failed: { tone: "danger", label: "Failed" },
};

function planChip(label: string | null, waiting: boolean) {
  if (!label) return null;
  const tone: Tone = waiting ? "warning" : label === "Applied" || label === "Partly applied" ? "success" : "neutral";
  return <StatusChip tone={tone} label={label} />;
}

function CloseoutDetail({ a, closeout, onChanged }: { a: Activity; closeout: Resource<CloseoutState>; onChanged: () => void }) {
  const [showDrafts, setShowDrafts] = useState(false);
  const co = a.teammates.closeout;
  const s = closeout.data;
  const plan = s?.plan ?? null;
  const planLeft = useSecondsUntil(plan?.expires_at);
  const waiting = !!plan && (plan.status === "pending" || plan.status === "partly_applied") && !!planLeft;
  const rows = !plan ? [] : waiting ? plan.actions.filter((x) => x.status === "proposed") : plan.actions.filter((x) => RESULT[x.status]);
  // Other plans this week: the ones that changed something are listed; drafts nobody used fold into one row.
  const others = a.feed.filter((i) => i.kind === "closeout" && i.id !== (plan ? `plan:${plan.id}` : ""));
  const unused = (i: FeedItem) => i.status?.label === "Dismissed" || i.status?.label === "Expired";
  const drafts = others.filter(unused);
  const earlier = others.filter((i) => !unused(i)).slice(0, 5);
  const lead = s?.schedule.enabled && s.schedule.lead_minutes ? `Plans ${s.schedule.lead_minutes} min before pickup ends` : null;

  return (
    <Panel icon={<ScheduleRounded />} tone="warning" title="Close-out" description="Before pickup ends, drafts price cuts and slot changes for what's left."
      control={<PolicySwitch policy="closeout_enabled" label="Close-out plans" checked={a.policies.closeout_enabled} canEdit={a.can_edit} onChanged={onChanged} />}>
      <Facts items={[lead, "A manager approves every change", "Never below your price floor"]} />
      <Section title="Today" chip={plan ? planChip(co.status, waiting) : null}>
        {!plan ? (
          <Typography variant="body2" color="text.secondary">
            No plan yet today.{co.enabled && co.runs_at_label ? ` The next one drafts at ${co.runs_at_label}.` : ""}
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {plan.summary ? <Typography variant="body2" color="text.secondary">{plan.summary}</Typography> : null}
            {rows.length ? <Changes rows={rows} result={!waiting} /> : null}
            {waiting ? (
              <Box><Button href="/merchant#closeout-plan" variant="contained">Review on Today</Button></Box>
            ) : null}
          </Stack>
        )}
      </Section>
      {earlier.length ? (
        <Section title="Earlier this week">
          <ActivityList items={earlier} today={a.today} empty="" />
        </Section>
      ) : null}
      {drafts.length ? (
        <Box sx={{ ...surface.inset, borderRadius: "12px", px: 2, py: 1.25 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <Typography variant="body2" color="text.secondary">{plural(drafts.length, "draft")} not used this week</Typography>
            <Button size="small" onClick={() => setShowDrafts((v) => !v)} aria-expanded={showDrafts}>{showDrafts ? "Hide" : "Show"}</Button>
          </Stack>
          {showDrafts ? <Box sx={{ mt: 0.5 }}><ActivityList items={drafts} today={a.today} empty="" /></Box> : null}
        </Box>
      ) : null}
      <Link href="/merchant/settings?tab=rules" variant="body2" sx={{ fontWeight: 600, justifySelf: "start" }}>Change plan timing in Settings</Link>
    </Panel>
  );
}

function Changes({ rows, result }: { rows: CloseoutAction[]; result: boolean }) {
  const cell = { py: 1.1, px: 1.5, "&:first-of-type": { pl: 0 }, "&:last-of-type": { pr: 0 } } as const;
  return (
    <Box sx={{ overflowX: "auto" }}>
      <Table size="small" sx={{ minWidth: 480 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={cell}>Change</TableCell>
            <TableCell sx={cell}>Was</TableCell>
            <TableCell sx={cell}>Now</TableCell>
            <TableCell sx={cell} align="right">Cut</TableCell>
            {result ? <TableCell sx={cell} align="right"><Box component="span" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Result</Box></TableCell> : null}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((x) => (
            <TableRow key={x.id} sx={{ "&:last-of-type td": { borderBottom: 0 } }}>
              <TableCell sx={cell}>{changeLabel(x)}</TableCell>
              <TableCell sx={{ ...cell, color: brand.muted, whiteSpace: "nowrap", textDecoration: x.type === "lower_price" ? "line-through" : "none" }} className="tabular">{x.before}</TableCell>
              <TableCell sx={{ ...cell, fontWeight: 700, whiteSpace: "nowrap" }} className="tabular">{x.after}</TableCell>
              <TableCell sx={{ ...cell, color: brand.leafDark, fontWeight: 600 }} align="right" className="tabular">{cut(x) ?? "—"}</TableCell>
              {result ? <TableCell sx={cell} align="right">{RESULT[x.status] ? <StatusChip tone={RESULT[x.status].tone} label={RESULT[x.status].label} /> : null}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

// ----------------------------------------------------------------------------- Ask LastCall and Watch alerts

function AskDetail({ a, onChanged }: { a: Activity; onChanged: () => void }) {
  const cc = a.teammates.concierge;
  const items = a.feed.filter((i) => i.kind === "concierge" || i.kind === "concierge_skip").slice(0, 8);
  return (
    <Panel icon={<ForumRounded />} tone="success" title="Ask LastCall" description="Suggests your bundles when shoppers ask LastCall for something."
      control={<PolicySwitch policy="concierge_listed" label="Suggest my shop in Ask LastCall" checked={a.policies.concierge_listed} canEdit={a.can_edit}
        onText="Listed" offText="Hidden" onChanged={onChanged} />}>
      {!cc.listed ? (
        <Alert severity="info">Shoppers asking on LastCall&apos;s home page won&apos;t see your shop. Your storefront&apos;s own assistant still works.</Alert>
      ) : null}
      <Facts items={[`${plural(cc.suggested_today, "suggestion")} today`, `${cc.suggested_week} this week`, `${plural(cc.ordered_week, "order")} from them`]} />
      <Section title="Recent">
        <ActivityList items={items} today={a.today} empty="No suggestions yet this week." />
      </Section>
      <Section title="Asked for, not on your shelf" subtitle="Shopper requests this week where Ask LastCall passed on your shop.">
        {!a.gaps.length ? <Typography variant="body2" color="text.secondary">Nothing missed this week.</Typography> : (
          <Box component="ul" sx={{ ...list, display: "grid", gap: 1 }}>
            {a.gaps.map((g) => (
              <Box component="li" key={g.label} sx={{ display: "flex", justifyContent: "space-between", gap: 2, bgcolor: brand.sand, borderRadius: "12px", px: 1.75, py: 1.1 }}>
                <Typography variant="body2">{g.label}</Typography>
                <Typography variant="body2" className="tabular" sx={{ fontWeight: 800 }} aria-label={plural(g.count, "request")}>{g.count}</Typography>
              </Box>
            ))}
          </Box>
        )}
      </Section>
    </Panel>
  );
}

function WatchDetail({ a }: { a: Activity }) {
  const w = a.teammates.watch;
  const items = a.feed.filter((i) => i.kind === "watch").slice(0, 8);
  return (
    <Panel icon={<NotificationsActiveRounded />} tone="info" title="Watch alerts" description="Tells shoppers who are waiting for a deal when you list something that fits."
      control={<StatusChip tone="neutral" label="Always on" />}>
      <Facts items={[`${plural(w.alerts_today, "alert")} today`, `${w.alerts_week} this week`, `${w.opened_week} opened`, `${plural(w.watching, "shopper")} watching`]} />
      <Section title="Recent">
        <ActivityList items={items} today={a.today} empty="No alerts sent yet this week." />
      </Section>
      <Typography variant="body2" color="text.secondary">Shoppers choose what to watch. An alert goes out as soon as you list a match.</Typography>
    </Panel>
  );
}
