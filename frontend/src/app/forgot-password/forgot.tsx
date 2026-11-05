"use client";

import { MarkEmailReadRounded } from "@mui/icons-material";
import { Alert, Button, Link, TextField } from "@mui/material";
import { useState } from "react";

import { AuthCard, FormError, FormStack } from "@/components/auth";
import { api, errorMessage } from "@/lib/api";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/auth/password/forgot", { body: { email: email.trim() } });
      setSent(res.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Reset your password" subtitle="We'll email you a link that works once and expires in an hour."
      footer={<Link href="/signin">Back to sign in</Link>}>
      {sent ? (
        <Alert severity="success" icon={<MarkEmailReadRounded />} role="status">
          {sent} Shop staff can also ask their shop owner for a reset link.
        </Alert>
      ) : (
        <>
          <FormError message={error} />
          <FormStack onSubmit={submit}>
            <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <Button type="submit" variant="contained" size="large" disabled={busy || !email}>
              {busy ? "Sending…" : "Email me a reset link"}
            </Button>
          </FormStack>
        </>
      )}
    </AuthCard>
  );
}
