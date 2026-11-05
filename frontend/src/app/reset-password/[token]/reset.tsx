"use client";

import { Button, Link } from "@mui/material";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAccount } from "@/components/account";
import { AuthCard, FormError, FormStack, PasswordField } from "@/components/auth";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { Account } from "@/lib/types";

export function ResetPassword({ token }: { token: string }) {
  const router = useRouter();
  const { refresh } = useAccount();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit() {
    if (mismatch) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const account = await api<Account>("/api/auth/password/reset", { body: { token, password } });
      refresh(account);
      router.push(account.memberships.length ? "/merchant" : "/");
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") setFieldError(err.fieldErrors().password ?? err.message);
      else setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Choose a new password" subtitle="Other devices signed in to your account will be signed out."
      footer={<Link href="/forgot-password">Request a new link</Link>}>
      <FormError message={error} />
      <FormStack onSubmit={submit}>
        <PasswordField label="New password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          error={!!fieldError} helperText={fieldError ?? "At least 10 characters"} autoFocus />
        <PasswordField label="Confirm new password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)}
          error={mismatch} helperText={mismatch ? "The passwords don't match" : " "} />
        <Button type="submit" variant="contained" size="large" disabled={busy || !password || mismatch}>
          {busy ? "Saving…" : "Save and sign in"}
        </Button>
      </FormStack>
    </AuthCard>
  );
}
