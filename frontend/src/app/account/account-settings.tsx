"use client";

import { Alert, Button, Card, CardContent, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";

import { signInHref, useAccount } from "@/components/account";
import { FormError, FormStack, PasswordField } from "@/components/auth";
import { PageShell } from "@/components/site";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { Account } from "@/lib/types";

export function AccountSettings() {
  const { account, loaded, refresh } = useAccount();
  const user = account?.user ?? null;
  if (!loaded) return <PageShell width="narrow"><LoadingBlock label="Loading your account" /></PageShell>;
  if (!user) {
    return (
      <PageShell width="narrow">
        <EmptyState title="Sign in to manage your account" action={<Button href={signInHref("/account")} variant="contained">Sign in</Button>} />
      </PageShell>
    );
  }
  return (
    <PageShell width="narrow">
      <PageHeader title="Account settings" subtitle={user.email} />
      <Stack spacing={3}>
        <Profile key={user.id} name={user.name} phone={user.phone} onSaved={refresh} />
        <ChangePassword />
      </Stack>
    </PageShell>
  );
}

function Profile({ name: initialName, phone: initialPhone, onSaved }: { name: string; phone: string; onSaved: (a: Account) => void }) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      onSaved(await api<Account>("/api/auth/me", { method: "PATCH", body: { name: name.trim(), phone: phone.trim() } }));
      setStatus("Saved. Checkout will prefill these details.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Card>
      <CardContent>
        <Typography variant="h3" component="h2" sx={{ mb: 2 }}>Profile</Typography>
        <FormError message={error} />
        {status ? <Alert severity="success" role="status" sx={{ mb: 2 }}>{status}</Alert> : null}
        <FormStack onSubmit={save}>
          <TextField label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
          <TextField label="Phone (optional)" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
            helperText="Shops use it only to reach you about a pickup." />
          <Button type="submit" variant="contained" sx={{ alignSelf: "flex-start" }} disabled={!name.trim()}>Save profile</Button>
        </FormStack>
      </CardContent>
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setErrors({});
    setError(null);
    try {
      await api("/api/auth/password/change", { body: { current_password: current, new_password: next } });
      setCurrent("");
      setNext("");
      setStatus("Password changed. Your other devices were signed out.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") setErrors(err.fieldErrors());
      else setError(errorMessage(err));
    }
  }
  return (
    <Card>
      <CardContent>
        <Typography variant="h3" component="h2" sx={{ mb: 2 }}>Password</Typography>
        <FormError message={error} />
        {status ? <Alert severity="success" role="status" sx={{ mb: 2 }}>{status}</Alert> : null}
        <FormStack onSubmit={save}>
          <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
            error={!!errors.current_password} helperText={errors.current_password} />
          <PasswordField label="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
            error={!!errors.new_password} helperText={errors.new_password ?? "At least 10 characters"} />
          <Button type="submit" variant="outlined" sx={{ alignSelf: "flex-start" }} disabled={!current || !next}>Change password</Button>
        </FormStack>
      </CardContent>
    </Card>
  );
}
