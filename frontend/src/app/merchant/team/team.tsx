"use client";

import { ContentCopyRounded, DeleteOutlineRounded, GroupsRounded, KeyRounded, MailOutlineRounded, PersonAddRounded } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useState } from "react";

import { useAnnounce } from "@/components/announcer";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { ErrorState, LoadingBlock, PageHeader, SectionCard, StatusChip } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Role, Team } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const ROLE_HELP: Record<Role, string> = {
  staff: "Count stock, pack orders, hand off pickups",
  manager: "Also products, prices, allergens, refunds, settings, invites staff",
  owner: "Also taxes and fees, PayPal payouts and managing the team",
};

function CopyLink({ label, link }: { label: string; link: string }) {
  const announce = useAnnounce();
  return (
    <Alert severity="success" sx={{ mt: 2 }} action={
      <Button size="small" color="inherit" startIcon={<ContentCopyRounded />}
        onClick={() => navigator.clipboard?.writeText(link).then(() => announce("Link copied"), () => undefined)}>
        Copy
      </Button>
    }>
      <Typography variant="body2" sx={{ fontWeight: 650 }}>{label}</Typography>
      <Typography variant="caption" sx={{ overflowWrap: "anywhere", fontFamily: "ui-monospace, monospace" }}>{link}</Typography>
    </Alert>
  );
}

export function TeamPage() {
  const staff = useStaff();
  const announce = useAnnounce();
  const team = useResource((signal) => api<Team>("/api/merchant/team", { signal }), [staff?.merchant.id]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [shared, setShared] = useState<{ label: string; link: string } | null>(null);
  const t = team.data;
  const owner = hasRole(staff, "owner");

  async function run<T>(key: string, fn: () => Promise<T>, done: (r: T) => void) {
    setBusy(key);
    setError(null);
    try {
      done(await fn());
    } catch (err) {
      if (err instanceof ApiError && err.details && Array.isArray(err.details)) setFieldError(err.fieldErrors().email ?? err.message);
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function invite() {
    setFieldError(null);
    void run("invite", () => api<{ link: string }>("/api/merchant/team/invites", { body: { email: email.trim(), role } }), (r) => {
      setShared({ label: `Invitation for ${email.trim()} (expires in 7 days). We've emailed it too.`, link: r.link });
      announce(`Invitation sent to ${email.trim()}`);
      setEmail("");
      team.reload();
    });
  }

  return (
    <>
      <PageHeader title="Team" eyebrow={staff?.merchant.name} subtitle="Everyone who can sign in to this shop's console." />
      {team.error && !t ? (
        <ErrorState title="Couldn't load the team" message={errorMessage(team.error)} onRetry={team.reload} />
      ) : !t ? (
        <LoadingBlock label="Loading the team" />
      ) : (
        <Stack spacing={3} sx={{ maxWidth: 980 }}>
          {error ? <Alert severity="error" role="alert">{error}</Alert> : null}
          {shared ? <CopyLink {...shared} /> : null}

          <SectionCard title="Invite someone" icon={<PersonAddRounded />} subtitle="They get an email link to set a password and join.">
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "flex-start" } }}>
              <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={!!fieldError} helperText={fieldError ?? " "} sx={{ flex: 1 }} />
              <TextField select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} sx={{ minWidth: 170 }} helperText={ROLE_HELP[role]}>
                {t.assignable_roles.map((r) => <MenuItem key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</MenuItem>)}
              </TextField>
              <Button variant="contained" startIcon={<MailOutlineRounded />} loading={busy === "invite"} disabled={!email.includes("@")} onClick={invite} sx={{ mt: { sm: 0.5 } }}>
                Send invite
              </Button>
            </Stack>
          </SectionCard>

          <SectionCard title="Members" icon={<GroupsRounded />} action={<StatusChip tone="neutral" label={`${t.members.length} people`} />}>
            <Box sx={{ overflowX: "auto", mx: { xs: -2, sm: -2.5 } }}>
              <Table size="small" sx={{ minWidth: 640 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ pl: { xs: 2, sm: 2.5 } }}>Name</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Last sign-in</TableCell>
                    <TableCell align="right" sx={{ pr: { xs: 2, sm: 2.5 } }}><span className="sr-only">Actions</span></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {t.members.map((m) => {
                    const you = m.user_id === t.you;
                    const canRemove = !you && t.assignable_roles.includes(m.role);
                    return (
                      <TableRow key={m.membership_id} hover>
                        <TableCell sx={{ pl: { xs: 2, sm: 2.5 } }}>
                          <Typography variant="body2" sx={{ fontWeight: 650 }}>{m.name}{you ? " (you)" : ""}</Typography>
                          <Typography variant="caption" color="text.secondary">{m.email}</Typography>
                        </TableCell>
                        <TableCell>
                          {owner && !you ? (
                            <TextField select size="small" value={m.role} disabled={busy === m.membership_id} sx={{ minWidth: 130 }}
                              slotProps={{ htmlInput: { "aria-label": `Role for ${m.name}` } }}
                              onChange={(e) => run(m.membership_id, () => api(`/api/merchant/team/members/${m.membership_id}`, { method: "PATCH", body: { role: e.target.value } }),
                                () => { announce(`${m.name} is now ${e.target.value}`); team.reload(); })}>
                              {(["staff", "manager", "owner"] as Role[]).map((r) => <MenuItem key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</MenuItem>)}
                            </TextField>
                          ) : (
                            <StatusChip tone={m.role === "owner" ? "success" : "neutral"} label={m.role_label} />
                          )}
                        </TableCell>
                        <TableCell><Typography variant="body2" color="text.secondary">{m.last_login_at ? ago(m.last_login_at) : "Never"}</Typography></TableCell>
                        <TableCell align="right" sx={{ pr: { xs: 2, sm: 2.5 }, whiteSpace: "nowrap" }}>
                          {owner && !you ? (
                            <Tooltip title="Create a password reset link">
                              <IconButton aria-label={`Password reset link for ${m.name}`} onClick={() => run(`reset-${m.membership_id}`,
                                () => api<{ link: string }>(`/api/merchant/team/members/${m.membership_id}/reset-link`, { body: {} }),
                                (r) => setShared({ label: `Password reset link for ${m.name} (works once, for 1 hour)`, link: r.link }))}>
                                <KeyRounded fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          ) : null}
                          {canRemove ? (
                            <Tooltip title="Remove from shop">
                              <IconButton aria-label={`Remove ${m.name}`} onClick={() => run(`remove-${m.membership_id}`,
                                () => api(`/api/merchant/team/members/${m.membership_id}`, { method: "DELETE" }), () => { announce(`${m.name} removed`); team.reload(); })}>
                                <DeleteOutlineRounded fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          </SectionCard>

          {t.invites.length ? (
            <SectionCard title="Pending invitations" icon={<MailOutlineRounded />}>
              <Stack spacing={1.5}>
                {t.invites.map((i) => (
                  <Stack key={i.id} direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 650, overflowWrap: "anywhere" }}>{i.email}</Typography>
                      <Typography variant="caption" color="text.secondary">{i.role_label} · sent {ago(i.created_at)}</Typography>
                    </Box>
                    {t.assignable_roles.includes(i.role) ? (
                      <Button size="small" color="inherit" loading={busy === `revoke-${i.id}`}
                        onClick={() => run(`revoke-${i.id}`, () => api(`/api/merchant/team/invites/${i.id}`, { method: "DELETE" }), () => team.reload())}>
                        Withdraw
                      </Button>
                    ) : null}
                  </Stack>
                ))}
              </Stack>
            </SectionCard>
          ) : null}
        </Stack>
      )}
    </>
  );
}
