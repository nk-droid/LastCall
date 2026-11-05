"use client";

import {
  AutoAwesomeRounded,
  BugReportRounded,
  CheckRounded,
  EmailRounded,
  HistoryRounded,
  PaymentsRounded,
  RouteRounded,
  StorefrontRounded,
  SyncRounded,
  WebhookRounded,
  WorkHistoryRounded,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Grid,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { signInHref, useAccount } from "@/components/account";
import { useAnnounce } from "@/components/announcer";
import { Dialog } from "@/components/dialog";
import { PageShell } from "@/components/site";
import { EmptyState, ErrorState, FactChip, LoadingBlock, PageHeader, SectionCard, StatTile, StatusChip, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ago, money } from "@/lib/format";
import type { ShopSettings } from "@/lib/types";
import { useResource } from "@/lib/use-api";

type ShopRow = { id: string; slug: string; name: string; category: string; status: string; city: string; is_showcase: boolean; submitted_at: string | null; owners: string[] };
type Status = {
  shops: Record<string, number>; orders_captured_today_utc: number; payments_unresolved: number; jobs_dead: number; faults_enabled: boolean;
  worker: { at: string; worker: string } | null; paypal: { ok: boolean; checked_at: string; error?: string } | null;
};
type Payment = {
  id: string; order_id: string; order_number: string; merchant: { slug: string; name: string }; state: string; order_payment_status: string;
  payee: { merchant_id: string } | null; paypal_order_id: string | null; capture_id: string | null; request_id: string; amount_minor: number; currency: string;
  reconcile_count: number; created_at: string; captured_at: string | null; trace_id: string; last_error: { kind?: string; detail?: string } | null;
};
type Webhook = { id: string; event_type: string; resource_id: string | null; verification: string; summary: string; duplicate_count: number; received_at: string; processing_result: string | null };
type AICall = { id: string; task: string; prompt_version: string; validation_result: string; failure_reason: string | null; latency_ms: number; fallback_used: boolean; created_at: string };
type Job = { id: number; kind: string; state: string; attempts: number; run_at: string; last_error: string | null; created_at: string };
type Email = { id: string; to: string; template: string; subject: string; status: string; attempts: number; last_error: string | null; created_at: string };
type AuditRow = { id: number; at: string; actor: string; role: string; entity_type: string; entity_id: string; action: string; trace_id: string | null };
type Faults = { enabled: boolean; armed: { id: string; kind: string; remaining: number; description: string }[]; available: Record<string, string> };

const TABS = [
  { key: "shops", label: "Shops", icon: StorefrontRounded },
  { key: "payments", label: "Payments", icon: PaymentsRounded },
  { key: "webhooks", label: "Webhooks", icon: WebhookRounded },
  { key: "ai", label: "AI calls", icon: AutoAwesomeRounded },
  { key: "jobs", label: "Jobs", icon: WorkHistoryRounded },
  { key: "emails", label: "Emails", icon: EmailRounded },
  { key: "faults", label: "Failure injection", icon: BugReportRounded },
  { key: "audit", label: "Audit log", icon: HistoryRounded },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const SHOP_TONE: Record<string, Tone> = { live: "success", pending_review: "info", draft: "neutral", rejected: "warning", suspended: "danger" };

function Cell({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <TableCell sx={mono ? { fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "nowrap" } : undefined}>{children}</TableCell>;
}

function DataTable({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) {
  if (empty) return <Typography color="text.secondary">Nothing here yet.</Typography>;
  return (
    <Box sx={{ overflowX: "auto", mx: { xs: -2, sm: -2.5 } }}>
      <Table size="small" sx={{ minWidth: 720, "& td:first-of-type, & th:first-of-type": { pl: { xs: 2, sm: 2.5 } } }}>
        <TableHead><TableRow>{head.map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
        <TableBody>{children}</TableBody>
      </Table>
    </Box>
  );
}

export function Ops() {
  const { account, loaded } = useAccount();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "shops") as TabKey;
  const admin = !!account?.user?.is_platform_admin;

  if (!loaded) return <PageShell><LoadingBlock label="Loading" /></PageShell>;
  if (!account?.user) {
    return <PageShell><EmptyState title="Sign in as a LastCall administrator" action={<Button href={signInHref("/ops")} variant="contained">Sign in</Button>} /></PageShell>;
  }
  if (!admin) return <PageShell><EmptyState title="This area is for LastCall administrators">Your account doesn&apos;t have platform access.</EmptyState></PageShell>;

  return (
    <PageShell>
      <PageHeader eyebrow="LastCall" title="Platform ops" subtitle="Shop review and the evidence trail behind every payment." />
      <StatusTiles />
      <Box sx={{ borderBottom: 1, borderColor: "divider", my: 3 }}>
        <Tabs value={tab} onChange={(_, v: TabKey) => router.replace(`/ops?tab=${v}`, { scroll: false })} variant="scrollable" allowScrollButtonsMobile>
          {TABS.map((t) => <Tab key={t.key} value={t.key} label={t.label} icon={<t.icon />} iconPosition="start" />)}
        </Tabs>
      </Box>
      {tab === "shops" ? <ShopsTab /> : null}
      {tab === "payments" ? <PaymentsTab /> : null}
      {tab === "webhooks" ? <WebhooksTab /> : null}
      {tab === "ai" ? <AITab /> : null}
      {tab === "jobs" ? <JobsTab /> : null}
      {tab === "emails" ? <EmailsTab /> : null}
      {tab === "faults" ? <FaultsTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
    </PageShell>
  );
}

function StatusTiles() {
  const status = useResource((signal) => api<Status>("/api/ops/status", { signal }), [], { pollMs: 20_000 });
  const s = status.data;
  if (!s) return status.error ? <ErrorState message={errorMessage(status.error)} onRetry={status.reload} /> : <LoadingBlock label="Loading status" lines={2} />;
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 6, md: 3 }}><StatTile label="Live shops" value={s.shops.live ?? 0} caption={`${s.shops.pending_review ?? 0} awaiting review`} icon={<StorefrontRounded />} /></Grid>
      <Grid size={{ xs: 6, md: 3 }}><StatTile label="Paid orders today" value={s.orders_captured_today_utc} caption="Verified captures (UTC day)" icon={<PaymentsRounded />} tone="info" /></Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatTile label="Payments in flight" value={s.payments_unresolved} caption="Being reconciled with PayPal" icon={<SyncRounded />} tone={s.payments_unresolved ? "warning" : "success"} />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatTile label="Worker" value={s.worker ? "Running" : "Stopped"} caption={s.worker ? `Heartbeat ${ago(s.worker.at)}` : "No heartbeat"} icon={<WorkHistoryRounded />}
          tone={s.worker ? "success" : "danger"} />
      </Grid>
    </Grid>
  );
}

// ----------------------------------------------------------------------------- shops

function ShopsTab() {
  const [filter, setFilter] = useState<string>("pending_review");
  const shops = useResource((signal) => api<{ shops: ShopRow[]; approval_checks: string[] }>(`/api/ops/shops${filter ? `?status=${filter}` : ""}`, { signal }), [filter]);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <SectionCard title="Shops" icon={<StorefrontRounded />}
      action={
        <Stack direction="row" spacing={1}>
          {[["pending_review", "Awaiting review"], ["live", "Live"], ["", "All"]].map(([key, label]) => (
            <Button key={key} size="small" variant={filter === key ? "contained" : "outlined"} onClick={() => setFilter(key)}>{label}</Button>
          ))}
        </Stack>
      }>
      {!shops.data ? <LoadingBlock label="Loading shops" lines={3} /> : (
        <DataTable head={["Shop", "Status", "Owners", "Submitted", ""]} empty={!shops.data.shops.length}>
          {shops.data.shops.map((s) => (
            <TableRow key={s.id} hover>
              <Cell><Typography variant="body2" sx={{ fontWeight: 650 }}>{s.name}</Typography><Typography variant="caption" color="text.secondary">{s.category} · {s.city}{s.is_showcase ? " · showcase" : ""}</Typography></Cell>
              <Cell><StatusChip tone={SHOP_TONE[s.status] ?? "neutral"} label={s.status.replace("_", " ")} /></Cell>
              <Cell>{s.owners.join(", ") || "—"}</Cell>
              <Cell>{s.submitted_at ? ago(s.submitted_at) : "—"}</Cell>
              <TableCell align="right"><Button size="small" onClick={() => setOpenId(s.id)}>Review</Button></TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {openId ? <ShopReview id={openId} onClose={() => setOpenId(null)} onChanged={shops.reload} /> : null}
    </SectionCard>
  );
}

function ShopReview({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const announce = useAnnounce();
  const detail = useResource((signal) => api<ShopSettings & { owners: string[]; approval_checks: string[] }>(`/api/ops/shops/${id}`, { signal }), [id]);
  const [checks, setChecks] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;

  async function act(kind: "approve" | "reject" | "suspend" | "reinstate") {
    setBusy(kind);
    setError(null);
    try {
      const body = kind === "approve" ? { checks } : kind === "reinstate" ? {} : { note };
      detail.setData(await api(`/api/ops/shops/${id}/${kind}`, { body }));
      announce(`Shop ${kind === "approve" ? "approved" : kind === "reject" ? "sent back" : kind === "suspend" ? "suspended" : "reinstated"}`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onClose={onClose} side title={d ? d.shop.name : "Shop"} description={d ? `${d.shop.category} · ${d.shop.address.city} · ${d.shop.status.replace("_", " ")}` : undefined}>
      {!d ? <LoadingBlock label="Loading shop" /> : (
        <Stack spacing={2.5}>
          {error ? <Alert severity="error" role="alert">{error}</Alert> : null}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <FactChip label={`Owners: ${d.owners.join(", ") || "none"}`} />
            <FactChip label={d.payouts.status === "connected" ? `PayPal ${d.payouts.display}` : "No PayPal account"} />
            <Button size="small" href={`/shops/${d.shop.slug}`} target="_blank">Open storefront</Button>
          </Stack>
          <Box>
            <Typography variant="subtitle2">Setup</Typography>
            {d.checklist.map((c) => (
              <Typography key={c.key} variant="body2" sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                <CheckRounded fontSize="small" sx={{ color: c.done ? "success.main" : "text.disabled" }} />{c.label}
              </Typography>
            ))}
          </Box>
          <Box>
            <Typography variant="subtitle2">Address and contact</Typography>
            <Typography variant="body2" color="text.secondary">{[d.shop.address.line1, d.shop.address.city, d.shop.address.region, d.shop.address.postal_code].filter(Boolean).join(", ")}</Typography>
            <Typography variant="body2" color="text.secondary">{d.shop.phone} · {d.shop.support_email || "no support email"}</Typography>
          </Box>
          <Box>
            <Typography variant="subtitle2">Allergen disclosure</Typography>
            <Typography variant="body2" color="text.secondary">{d.policies.dietary_disclosure_text}</Typography>
          </Box>
          {d.shop.status === "pending_review" ? (
            <>
              <Box>
                <Typography variant="subtitle2">Before approving, confirm</Typography>
                {d.approval_checks.map((c) => (
                  <FormControlLabel key={c} label={c} sx={{ display: "flex" }}
                    control={<Checkbox checked={checks.includes(c)} onChange={() => setChecks((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))} />} />
                ))}
              </Box>
              <Button variant="contained" disabled={checks.length !== d.approval_checks.length} loading={busy === "approve"} onClick={() => act("approve")}>
                Approve and list the shop
              </Button>
            </>
          ) : null}
          {d.shop.status === "pending_review" || d.shop.status === "live" ? (
            <Stack spacing={1}>
              <TextField label={d.shop.status === "live" ? "Reason for suspending" : "What needs to change"} multiline minRows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              <Button variant="outlined" color="warning" disabled={note.trim().length < 3} loading={busy === "reject" || busy === "suspend"}
                onClick={() => act(d.shop.status === "live" ? "suspend" : "reject")}>
                {d.shop.status === "live" ? "Suspend shop" : "Send back with note"}
              </Button>
            </Stack>
          ) : null}
          {d.shop.status === "suspended" ? <Button variant="contained" loading={busy === "reinstate"} onClick={() => act("reinstate")}>Reinstate</Button> : null}
        </Stack>
      )}
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- payments + trace

function PaymentsTab() {
  const announce = useAnnounce();
  const payments = useResource((signal) => api<{ payments: Payment[] }>("/api/ops/payments", { signal }), [], { pollMs: 15_000 });
  const [trace, setTrace] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function reconcile(p: Payment) {
    setBusy(p.id);
    try {
      const res = await api<{ result: string }>(`/api/ops/payments/${p.id}/reconcile`, { body: {} });
      announce(`Reconciled ${p.order_number}: ${res.result}`);
      payments.reload();
    } finally {
      setBusy(null);
    }
  }
  return (
    <SectionCard title="Payments" subtitle="Every PayPal attempt with its provider IDs and idempotency key." icon={<PaymentsRounded />}>
      {!payments.data ? <LoadingBlock label="Loading payments" lines={3} /> : (
        <DataTable head={["Order", "Shop", "State", "Amount", "PayPal order / capture", "Payee", ""]} empty={!payments.data.payments.length}>
          {payments.data.payments.map((p) => (
            <TableRow key={p.id} hover>
              <Cell><Typography variant="body2" sx={{ fontWeight: 650 }}>{p.order_number}</Typography><Typography variant="caption" color="text.secondary">{ago(p.created_at)}</Typography></Cell>
              <Cell>{p.merchant.name}</Cell>
              <Cell><StatusChip tone={p.state === "CAPTURED" ? "success" : ["OUTCOME_UNKNOWN", "CAPTURE_PENDING", "CAPTURE_REQUESTED"].includes(p.state) ? "warning" : "neutral"} label={p.state} /></Cell>
              <Cell>{money(p.amount_minor, p.currency)}</Cell>
              <Cell mono>{p.paypal_order_id ?? "—"}<br />{p.capture_id ?? ""}</Cell>
              <Cell mono>{p.payee?.merchant_id ?? "platform"}</Cell>
              <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                <Button size="small" startIcon={<RouteRounded />} onClick={() => setTrace(p.trace_id)}>Trace</Button>
                <Button size="small" startIcon={<SyncRounded />} loading={busy === p.id} onClick={() => reconcile(p)}>Reconcile</Button>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {trace ? <TraceDrawer traceId={trace} onClose={() => setTrace(null)} /> : null}
    </SectionCard>
  );
}

function TraceDrawer({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const trace = useResource((signal) => api<{ events: { at: string; actor: string; entity_type: string; action: string }[] }>(`/api/ops/trace/${traceId}`, { signal }), [traceId]);
  return (
    <Dialog open onClose={onClose} side title="Order trace" description="Quote → hold → PayPal → fulfillment, from the audit log">
      {!trace.data ? <LoadingBlock label="Loading trace" /> : (
        <Stack component="ol" spacing={1.5} sx={{ m: 0, pl: 2.5 }}>
          {trace.data.events.map((e, i) => (
            <li key={i}>
              <Typography variant="body2" sx={{ fontWeight: 650 }}>{e.action.replaceAll("_", " ")}</Typography>
              <Typography variant="caption" color="text.secondary">{new Date(e.at).toLocaleTimeString()} · {e.entity_type} · {e.actor}</Typography>
            </li>
          ))}
        </Stack>
      )}
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- the rest

function WebhooksTab() {
  const events = useResource((signal) => api<{ events: Webhook[] }>("/api/ops/webhooks", { signal }), [], { pollMs: 15_000 });
  return (
    <SectionCard title="PayPal webhooks" subtitle="Verified, de-duplicated, then reconciled against PayPal." icon={<WebhookRounded />}>
      {!events.data ? <LoadingBlock label="Loading webhooks" lines={3} /> : (
        <DataTable head={["Event", "Resource", "Verified", "Duplicates", "Result", "Received"]} empty={!events.data.events.length}>
          {events.data.events.map((w) => (
            <TableRow key={w.id} hover>
              <Cell>{w.event_type}</Cell><Cell mono>{w.resource_id ?? "—"}</Cell>
              <Cell><StatusChip tone={w.verification === "verified" ? "success" : "danger"} label={w.verification} /></Cell>
              <Cell>{w.duplicate_count}</Cell><Cell>{w.processing_result ?? "queued"}</Cell><Cell>{ago(w.received_at)}</Cell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

function AITab() {
  const calls = useResource((signal) => api<{ invocations: AICall[] }>("/api/ops/ai-invocations", { signal }), [], { pollMs: 15_000 });
  return (
    <SectionCard title="AI calls" subtitle="Every model call is schema-validated; rules take over on any failure." icon={<AutoAwesomeRounded />}>
      {!calls.data ? <LoadingBlock label="Loading AI calls" lines={3} /> : (
        <DataTable head={["Task", "Prompt", "Result", "Latency", "Fallback", "When"]} empty={!calls.data.invocations.length}>
          {calls.data.invocations.map((c) => (
            <TableRow key={c.id} hover>
              <Cell>{c.task}</Cell><Cell mono>{c.prompt_version}</Cell>
              <Cell><StatusChip tone={c.validation_result.startsWith("valid") ? "success" : "warning"} label={c.validation_result} /></Cell>
              <Cell>{c.latency_ms} ms</Cell><Cell>{c.fallback_used ? "Rules" : "—"}</Cell><Cell>{ago(c.created_at)}</Cell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

function JobsTab() {
  const announce = useAnnounce();
  const jobs = useResource((signal) => api<{ jobs: Job[]; periodic: Record<string, number> }>("/api/ops/jobs", { signal }), [], { pollMs: 15_000 });
  const [busy, setBusy] = useState(false);
  return (
    <SectionCard title="Background jobs" icon={<WorkHistoryRounded />}
      action={<Button size="small" loading={busy} onClick={async () => { setBusy(true); const r = await api<{ ran: number }>("/api/ops/jobs/run-due", { body: {} }).finally(() => setBusy(false)); announce(`Ran ${r.ran} jobs`); jobs.reload(); }}>Run due jobs now</Button>}>
      {!jobs.data ? <LoadingBlock label="Loading jobs" lines={3} /> : (
        <>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mb: 2 }}>
            {Object.entries(jobs.data.periodic).map(([kind, every]) => <FactChip key={kind} label={`${kind} · every ${every >= 60 ? `${every / 60} min` : `${every}s`}`} />)}
          </Stack>
          <DataTable head={["Job", "State", "Attempts", "Run at", "Last error"]} empty={!jobs.data.jobs.length}>
            {jobs.data.jobs.map((j) => (
              <TableRow key={j.id} hover>
                <Cell>{j.kind}</Cell><Cell><StatusChip tone={j.state === "done" ? "success" : j.state === "dead" ? "danger" : "neutral"} label={j.state} /></Cell>
                <Cell>{j.attempts}</Cell><Cell>{ago(j.run_at)}</Cell><Cell>{j.last_error ?? "—"}</Cell>
              </TableRow>
            ))}
          </DataTable>
        </>
      )}
    </SectionCard>
  );
}

function EmailsTab() {
  const emails = useResource((signal) => api<{ configured: boolean; emails: Email[] }>("/api/ops/emails", { signal }), [], { pollMs: 20_000 });
  return (
    <SectionCard title="Email outbox" icon={<EmailRounded />}
      action={emails.data ? <StatusChip tone={emails.data.configured ? "success" : "warning"} label={emails.data.configured ? "SMTP connected" : "SMTP not set up (skipped)"} /> : null}>
      {!emails.data ? <LoadingBlock label="Loading emails" lines={3} /> : (
        <DataTable head={["To", "Template", "Subject", "Status", "Attempts", "Queued"]} empty={!emails.data.emails.length}>
          {emails.data.emails.map((m) => (
            <TableRow key={m.id} hover>
              <Cell>{m.to}</Cell><Cell>{m.template}</Cell><Cell>{m.subject}</Cell>
              <Cell><StatusChip tone={m.status === "sent" ? "success" : m.status === "failed" ? "danger" : "neutral"} label={m.status} /></Cell>
              <Cell>{m.attempts}</Cell><Cell>{ago(m.created_at)}</Cell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

function FaultsTab() {
  const announce = useAnnounce();
  const faults = useResource((signal) => api<Faults>("/api/ops/faults", { signal }), []);
  const [error, setError] = useState<string | null>(null);
  const f = faults.data;
  async function arm(kind: string) {
    setError(null);
    try {
      await api("/api/ops/faults", { body: { kind } });
      announce("Fault armed for the next capture");
      faults.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <SectionCard title="Failure injection" subtitle="Arm a PayPal failure for the next capture to show how LastCall recovers without charging twice." icon={<BugReportRounded />}>
      {!f ? <LoadingBlock label="Loading" lines={2} /> : !f.enabled ? (
        <Alert severity="info">Disabled on this deployment (set OPS_FAULTS_ENABLED=true).</Alert>
      ) : (
        <Stack spacing={2}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {Object.entries(f.available).map(([kind, label]) => (
            <Stack key={kind} direction="row" spacing={2} sx={{ alignItems: "center" }}>
              <Typography sx={{ flex: 1 }}>{label}</Typography>
              <Button variant="outlined" onClick={() => arm(kind)}>Arm once</Button>
            </Stack>
          ))}
          {f.armed.length ? (
            <Alert severity="warning" action={<Button color="inherit" size="small" onClick={async () => { await api("/api/ops/faults", { method: "DELETE" }); faults.reload(); }}>Disarm all</Button>}>
              Armed: {f.armed.map((a) => a.description).join("; ")}
            </Alert>
          ) : null}
        </Stack>
      )}
    </SectionCard>
  );
}

function AuditTab() {
  const audit = useResource((signal) => api<{ events: AuditRow[] }>("/api/ops/audit?limit=150", { signal }), [], { pollMs: 20_000 });
  return (
    <SectionCard title="Audit log" subtitle="Append-only: the database rejects edits and deletes." icon={<HistoryRounded />}>
      {!audit.data ? <LoadingBlock label="Loading audit log" lines={3} /> : (
        <DataTable head={["When", "Action", "Entity", "Actor"]} empty={!audit.data.events.length}>
          {audit.data.events.map((e) => (
            <TableRow key={e.id} hover>
              <Cell>{ago(e.at)}</Cell><Cell>{e.action.replaceAll("_", " ")}</Cell><Cell mono>{e.entity_type}:{e.entity_id.slice(-10)}</Cell><Cell>{e.actor}</Cell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}
