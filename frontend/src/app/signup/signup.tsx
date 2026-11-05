"use client";

import { Button, Link, TextField } from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { useAccount } from "@/components/account";
import { AuthCard, FormError, FormStack, PasswordField, safeNext } from "@/components/auth";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { Account } from "@/lib/types";

export function SignUp() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAccount();
  const next = params.get("next");
  const [name, setName] = useState("");
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
      const account = await api<Account>("/api/auth/signup", { body: { name: name.trim(), email: email.trim(), password } });
      refresh(account);
      router.push(safeNext(next));
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") setFieldErrors(err.fieldErrors());
      else if (err instanceof ApiError && err.code === "email_taken") setFieldErrors({ email: err.message });
      else setError(errorMessage(err));
      setBusy(false);
    }
  }

  const query = next ? `?next=${encodeURIComponent(next)}` : "";
  return (
    <AuthCard
      title="Create your account"
      subtitle="Orders you've placed in this browser move to your new account."
      footer={<>Already have an account? <Link href={`/signin${query}`}>Sign in</Link></>}
    >
      <FormError message={error} />
      <FormStack onSubmit={submit}>
        <TextField label="Your name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)}
          error={!!fieldErrors.name} helperText={fieldErrors.name} autoFocus />
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          error={!!fieldErrors.email} helperText={fieldErrors.email} />
        <PasswordField label="Password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          error={!!fieldErrors.password} helperText={fieldErrors.password ?? "At least 10 characters"} />
        <Button type="submit" variant="contained" size="large" disabled={busy || !name || !email || !password}>
          {busy ? "Creating your account…" : "Create account"}
        </Button>
      </FormStack>
    </AuthCard>
  );
}
