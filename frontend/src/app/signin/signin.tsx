"use client";

import { Button, Link, TextField } from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { useAccount } from "@/components/account";
import { AuthCard, FormError, FormStack, PasswordField, safeNext } from "@/components/auth";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { Account } from "@/lib/types";

export function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAccount();
  const next = params.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const account = await api<Account>("/api/auth/login", { body: { email: email.trim(), password } });
      refresh(account);
      router.push(safeNext(next, account.memberships.length ? "/merchant" : "/"));
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") setFieldErrors(err.fieldErrors());
      else setError(errorMessage(err));
      setBusy(false);
    }
  }

  const query = next ? `?next=${encodeURIComponent(next)}` : "";
  return (
    <AuthCard
      title="Sign in"
      subtitle="Shop with your saved details and see your orders on any device. Shop staff sign in here too."
      footer={<>New to LastCall? <Link href={`/signup${query}`}>Create an account</Link></>}
    >
      <FormError message={error} />
      <FormStack onSubmit={submit}>
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          error={!!fieldErrors.email} helperText={fieldErrors.email} autoFocus />
        <PasswordField label="Password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          error={!!fieldErrors.password} helperText={fieldErrors.password} />
        <Link href="/forgot-password" variant="body2" sx={{ alignSelf: "flex-start" }}>
          Forgot your password?
        </Link>
        <Button type="submit" variant="contained" size="large" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </FormStack>
    </AuthCard>
  );
}
