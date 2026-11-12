"use client";

import { StorefrontRounded } from "@mui/icons-material";
import { Alert, Button, Stack, TextField, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signInHref, useAccount } from "@/components/account";
import { AuthCard, FormError, FormStack, PasswordField } from "@/components/auth";
import { FactChip, LoadingBlock } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { Account } from "@/lib/types";
import { useResource } from "@/lib/use-api";

type Preview = { email: string; role: string; role_label: string; has_account: boolean; shop: { id: string; name: string; slug: string; category: string } };

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const { account, refresh } = useAccount();
  const preview = useResource((signal) => api<Preview>(`/api/invites/${token}`, { signal }), [token]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const body = preview.data?.has_account ? {} : { name: name.trim(), password };
      const next = await api<Account>(`/api/invites/${token}/accept`, { body });
      refresh(next);
      router.push("/merchant");
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") setFieldErrors(err.fieldErrors());
      else setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (preview.error) {
    return (
      <AuthCard title="This invitation can't be used">
        <Alert severity="warning">{errorMessage(preview.error)}</Alert>
      </AuthCard>
    );
  }
  const p = preview.data;
  if (!p) return <AuthCard title="Loading your invitation"><LoadingBlock label="Loading invitation" lines={3} /></AuthCard>;
  const signedInAs = account?.user?.email ?? null;
  const wrongAccount = p.has_account && signedInAs && signedInAs !== p.email;

  return (
    <AuthCard title={`Join ${p.shop.name}`} subtitle={`You've been invited as ${p.role_label.toLowerCase()} on LastCall.`}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mb: 2.5 }}>
        <FactChip icon={StorefrontRounded} label={p.shop.name} />
        <FactChip label={p.shop.category} />
        <FactChip label={p.email} />
      </Stack>
      <FormError message={error} />
      {p.has_account ? (
        signedInAs === p.email ? (
          <Button variant="contained" size="large" fullWidth disabled={busy} onClick={accept}>
            {busy ? "Joining…" : `Join ${p.shop.name}`}
          </Button>
        ) : (
          <Stack spacing={2}>
            <Typography color="text.secondary">
              {wrongAccount ? `You're signed in as ${signedInAs}. ` : ""}Sign in as {p.email} to accept.
            </Typography>
            <Button href={signInHref(`/invite/${token}`)} variant="contained" size="large">
              Sign in as {p.email}
            </Button>
          </Stack>
        )
      ) : (
        <FormStack onSubmit={accept}>
          <TextField label="Your name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)}
            error={!!fieldErrors.name} helperText={fieldErrors.name} autoFocus />
          <PasswordField label="Choose a password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)}
            error={!!fieldErrors.password} helperText={fieldErrors.password ?? "At least 10 characters"} />
          <Button type="submit" variant="contained" size="large" disabled={busy || !name || !password}>
            {busy ? "Creating your account…" : "Create account and join"}
          </Button>
        </FormStack>
      )}
    </AuthCard>
  );
}
