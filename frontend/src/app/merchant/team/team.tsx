"use client";

// Everyone who can sign in to the shop, in one table: members with their role (owners change it in place), last
// sign-in and actions, then pending invitations as rows of the same table. Inviting stays in its own card on top.

import {
  BadgeRounded, CloseRounded, ContentCopyRounded, KeyRounded, LockRounded, MailOutlineRounded, ManageAccountsRounded, PersonAddRounded, RefreshRounded,
} from "@mui/icons-material";
import {
  Alert, Avatar, Box, Button, Chip, IconButton, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import { useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { Dialog } from "@/components/dialog";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { ErrorState, FactChip, LoadingBlock, PageHeader, SectionCard, StatusChip, brand, surface, tones, type Icon, type Tone } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ago, plural } from "@/lib/format";
import type { Role, Team, TeamInvite, TeamMember } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const ROLES: Role[] = ["staff", "manager", "owner"];
const ROLE_NAME: Record<Role, string> = { staff: "Staff", manager: "Manager", owner: "Owner" };
const ROLE_HELP: Record<Role, string> = {
  staff: "Count stock, pack orders, hand off pickups",
  manager: "Also products, prices, allergens, refunds, settings, invites staff",
  owner: "Also taxes and fees, PayPal payouts and managing the team",
};
const ROLE_CAN: Record<Role, string> = {
  staff: "count stock, pack, hand off",
  manager: "+ prices, allergens, refunds, settings, invite staff",
  owner: "+ payouts, taxes, team roles",
};
const ROLE_LOOK: Record<Role, { tone: Tone; icon: Icon }> = {
  owner: { tone: "success", icon: LockRounded },
  manager: { tone: "info", icon: ManageAccountsRounded },
  staff: { tone: "warning", icon: BadgeRounded },
};

const DAY = 86_400_000;

/** "just now", "3 h ago", "yesterday", "4 days ago". */
function since(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (ms < DAY) return ago(iso, now);
  const days = Math.floor(ms / DAY);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function expiresIn(iso: string, now = Date.now()): string {
  const hours = (new Date(iso).getTime() - now) / 3_600_000;
  return hours < 24 ? `expires in ${Math.max(1, Math.round(hours))} h` : `expires in ${plural(Math.round(hours / 24), "day")}`;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function CopyLink({ label, link, onClose }: { label: string; link: string; onClose: () => void }) {
  const announce = useAnnounce();
  return (
    <Alert severity="success" action={
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <Button size="small" color="inherit" startIcon={<ContentCopyRounded />}
          onClick={() => navigator.clipboard?.writeText(link).then(() => announce("Link copied"), () => undefined)}>
          Copy
        </Button>
        <IconButton size="small" color="inherit" aria-label="Dismiss" onClick={onClose}><CloseRounded fontSize="small" /></IconButton>
      </Stack>
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
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const t = team.data;
  const owner = hasRole(staff, "owner");

  async function run<T>(key: string, fn: () => Promise<T>, done: (r: T) => void) {
    setBusy(key);
    setError(null);
    try {
      done(await fn());
    } catch (err) {
      if (key === "invite" && err instanceof ApiError && Array.isArray(err.details)) setFieldError(err.fieldErrors().email ?? err.message);
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function sendInvite(to: string, as: Role, key: string, again = false) {
    if (key === "invite") setFieldError(null);
    void run(key, () => api<{ link: string }>("/api/merchant/team/invites", { body: { email: to, role: as } }), (r) => {
      setShared({ label: `${again ? "New invitation" : "Invitation"} for ${to} (expires in 7 days). We've emailed it too.`, link: r.link });
      announce(`Invitation ${again ? "sent again" : "sent"} to ${to}`);
      if (key === "invite") setEmail("");
      team.reload();
    });
  }

  function remove(m: TeamMember) {
    void run(`remove-${m.membership_id}`, () => api(`/api/merchant/team/members/${m.membership_id}`, { method: "DELETE" }), () => {
      announce(`${m.name} removed`);
      setRemoving(null);
      team.reload();
    });
  }

  const owners = t?.members.filter((m) => m.role === "owner").length ?? 0;
  // You first, then owners, managers and staff.
  const members = t ? [...t.members].sort((a, b) => Number(b.user_id === t.you) - Number(a.user_id === t.you)
    || ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.name.localeCompare(b.name)) : [];
  const count = t ? [plural(t.members.length, "member"), t.invites.length ? `${t.invites.length} invited` : null].filter(Boolean).join(", ") : undefined;

  return (
    <>
      <PageHeader title="Team" eyebrow={staff?.merchant.name} subtitle={count} />
      {team.error && !t ? (
        <ErrorState title="Couldn't load the team" message={errorMessage(team.error)} onRetry={team.reload} />
      ) : !t ? (
        <LoadingBlock label="Loading the team" />
      ) : (
        <Stack spacing={3}>
          <SectionCard title="Invite someone" icon={<PersonAddRounded />} subtitle="They get an email link to set a password and join.">
            <Stack component="form" direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "flex-start" } }}
              onSubmit={(e) => { e.preventDefault(); if (email.includes("@")) sendInvite(email.trim(), role, "invite"); }}>
              <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={!!fieldError}
                helperText={fieldError ?? " "} sx={{ flex: 1 }} />
              <TextField select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} sx={{ minWidth: 170 }} helperText={ROLE_HELP[role]}>
                {t.assignable_roles.map((r) => <MenuItem key={r} value={r}>{ROLE_NAME[r]}</MenuItem>)}
              </TextField>
              <Button type="submit" variant="contained" startIcon={<MailOutlineRounded />} loading={busy === "invite"} disabled={!email.includes("@")} sx={{ mt: { sm: 0.5 } }}>
                Send invite
              </Button>
            </Stack>
          </SectionCard>

          {error ? <Alert severity="error" role="alert">{error}</Alert> : null}
          {shared ? <CopyLink {...shared} onClose={() => setShared(null)} /> : null}

          <Box>
            <Stack component="ul" aria-label="What each role can do" direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", m: 0, mb: 1.5, p: 0, listStyle: "none" }}>
              {ROLES.map((r) => (
                <Box component="li" key={r} sx={{ ...surface.raisedSm, display: "inline-flex", gap: 0.75, alignItems: "baseline", px: 1.5, py: 0.5, borderRadius: 999 }}>
                  <Typography component="span" variant="body2" sx={{ fontWeight: 700, color: tones[ROLE_LOOK[r].tone].fg }}>{ROLE_NAME[r]}</Typography>
                  <Typography component="span" variant="body2" color="text.secondary">{ROLE_CAN[r]}</Typography>
                </Box>
              ))}
            </Stack>

            <Box component="section" aria-label="People" sx={{ ...surface.raised, borderRadius: "16px", overflowX: "auto" }}>
              <Table sx={{ minWidth: 820, "& th:first-of-type, & td:first-of-type": { pl: 3 }, "& th:last-of-type, & td:last-of-type": { pr: 3 } }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Person</TableCell>
                    <TableCell sx={{ width: 190 }}>Role</TableCell>
                    <TableCell sx={{ width: 250 }}>Last sign-in</TableCell>
                    <TableCell align="right" sx={{ width: 280 }}><span className="sr-only">Actions</span></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {members.map((m) => (
                    <MemberRow key={m.membership_id} m={m} you={m.user_id === t.you} owner={owner} soleOwner={m.role === "owner" && owners <= 1}
                      canRemove={m.user_id !== t.you && t.assignable_roles.includes(m.role) && !(m.role === "owner" && owners <= 1)} busy={busy}
                      onRole={(next) => run(m.membership_id, () => api(`/api/merchant/team/members/${m.membership_id}`, { method: "PATCH", body: { role: next } }),
                        () => { announce(`${m.name} is now ${ROLE_NAME[next].toLowerCase()}`); team.reload(); })}
                      onReset={() => run(`reset-${m.membership_id}`, () => api<{ link: string }>(`/api/merchant/team/members/${m.membership_id}/reset-link`, { body: {} }),
                        (r) => setShared({ label: `Password reset link for ${m.name} (works once, for 1 hour)`, link: r.link }))}
                      onRemove={() => setRemoving(m)} />
                  ))}
                  {t.invites.map((i) => (
                    <InviteRow key={i.id} i={i} canManage={t.assignable_roles.includes(i.role)} busy={busy}
                      onResend={() => sendInvite(i.email, i.role, `resend-${i.id}`, true)}
                      onWithdraw={() => run(`revoke-${i.id}`, () => api(`/api/merchant/team/invites/${i.id}`, { method: "DELETE" }),
                        () => { announce(`Invitation to ${i.email} withdrawn`); team.reload(); })} />
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Box>
        </Stack>
      )}

      <Dialog open={!!removing} onClose={() => setRemoving(null)} title={removing ? `Remove ${removing.name}?` : ""}
        actions={
          <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
            <Button color="inherit" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="contained" color="error" loading={!!removing && busy === `remove-${removing.membership_id}`}
              onClick={() => removing && remove(removing)}>
              Remove
            </Button>
          </Stack>
        }>
        <Typography variant="body2">
          They lose access to {staff?.merchant.name ?? "this shop"} right away. You can invite them again later.
        </Typography>
      </Dialog>
    </>
  );
}

function Person({ avatar, title, chip, caption }: { avatar: ReactNode; title: string; chip?: ReactNode; caption: string }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
      {avatar}
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography sx={{ fontWeight: 650, overflowWrap: "anywhere" }}>{title}</Typography>
          {chip}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{caption}</Typography>
      </Box>
    </Stack>
  );
}

function MemberRow({ m, you, owner, soleOwner, canRemove, busy, onRole, onReset, onRemove }: {
  m: TeamMember; you: boolean; owner: boolean; soleOwner: boolean; canRemove: boolean; busy: string | null;
  onRole: (role: Role) => void; onReset: () => void; onRemove: () => void;
}) {
  const look = ROLE_LOOK[m.role];
  const tone = tones[look.tone];
  return (
    <TableRow hover>
      <TableCell>
        <Person title={m.name} caption={m.email}
          chip={you ? <Chip size="small" label="You" sx={{ height: 22, bgcolor: brand.sand, fontWeight: 600, color: brand.muted }} /> : null}
          avatar={
            <Avatar aria-hidden sx={{ width: 40, height: 40, fontSize: 14, fontWeight: 700, ...(m.role === "owner" ? { bgcolor: brand.leaf, color: brand.paper } : { bgcolor: tone.bg, color: tone.fg }) }}>
              {initials(m.name)}
            </Avatar>
          } />
      </TableCell>
      <TableCell>
        {owner && !you ? (
          <TextField select size="small" value={m.role} disabled={busy === m.membership_id} sx={{ width: 150 }}
            slotProps={{ htmlInput: { "aria-label": `Role for ${m.name}` } }} onChange={(e) => onRole(e.target.value as Role)}>
            {ROLES.map((r) => <MenuItem key={r} value={r}>{ROLE_NAME[r]}</MenuItem>)}
          </TextField>
        ) : (
          <StatusChip tone={look.tone} icon={look.icon} label={m.role_label} />
        )}
      </TableCell>
      <TableCell>
        <Typography variant="body2" color="text.secondary">{m.last_login_at ? capital(since(m.last_login_at)) : "Never"}</Typography>
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
        {soleOwner ? (
          <Typography variant="body2" color="text.secondary">Only owner, can&apos;t be removed</Typography>
        ) : (
          <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
            {owner && !you ? (
              <Button size="small" variant="outlined" color="inherit" startIcon={<KeyRounded />} loading={busy === `reset-${m.membership_id}`}
                aria-label={`Password reset link for ${m.name}`} onClick={onReset}>
                Reset link
              </Button>
            ) : null}
            {canRemove ? (
              <Button size="small" color="error" aria-label={`Remove ${m.name}`} onClick={onRemove}>Remove</Button>
            ) : null}
          </Stack>
        )}
      </TableCell>
    </TableRow>
  );
}

function InviteRow({ i, canManage, busy, onResend, onWithdraw }: {
  i: TeamInvite; canManage: boolean; busy: string | null; onResend: () => void; onWithdraw: () => void;
}) {
  return (
    <TableRow sx={{ bgcolor: "#FCFBF8" }}>
      <TableCell>
        <Person title={i.email} caption={`Invited ${since(i.created_at)}`}
          avatar={
            <Avatar aria-hidden sx={{ width: 40, height: 40, bgcolor: brand.paper, color: brand.muted, border: `1.5px dashed ${surface.edge}` }}>
              <MailOutlineRounded sx={{ fontSize: 18 }} />
            </Avatar>
          } />
      </TableCell>
      <TableCell><FactChip label={i.role_label} /></TableCell>
      <TableCell><StatusChip tone="warning" icon={MailOutlineRounded} label={`Invited, ${expiresIn(i.expires_at)}`} /></TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
        {canManage ? (
          <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
            <Button size="small" variant="outlined" color="inherit" startIcon={<RefreshRounded />} loading={busy === `resend-${i.id}`}
              aria-label={`Resend invite to ${i.email}`} onClick={onResend}>
              Resend
            </Button>
            <Button size="small" color="error" loading={busy === `revoke-${i.id}`} aria-label={`Withdraw invite to ${i.email}`} onClick={onWithdraw}>
              Withdraw
            </Button>
          </Stack>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
