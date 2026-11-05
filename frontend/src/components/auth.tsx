"use client";

import { VisibilityOffRounded, VisibilityRounded } from "@mui/icons-material";
import { Alert, Box, Card, CardContent, IconButton, InputAdornment, Stack, TextField, Typography, type TextFieldProps } from "@mui/material";
import { useState, type ReactNode } from "react";

import { PageShell } from "./site";

/** Centered card for sign-in style pages: one task, one primary action. */
export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <PageShell width="narrow">
      <Box sx={{ maxWidth: 460, mx: "auto", pt: { xs: 1, sm: 4 } }}>
        <Card>
          <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
            <Typography variant="h1" sx={{ fontSize: { xs: "1.6rem", sm: "1.85rem" } }}>
              {title}
            </Typography>
            {subtitle ? (
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                {subtitle}
              </Typography>
            ) : null}
            <Box sx={{ mt: 3 }}>{children}</Box>
          </CardContent>
        </Card>
        {footer ? (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center", mt: 2.5 }}>
            {footer}
          </Typography>
        ) : null}
      </Box>
    </PageShell>
  );
}

export function PasswordField(props: TextFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      {...props}
      type={shown ? "text" : "password"}
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton aria-label={shown ? "Hide password" : "Show password"} onClick={() => setShown((v) => !v)} edge="end">
                {shown ? <VisibilityOffRounded /> : <VisibilityRounded />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert severity="error" role="alert" sx={{ mb: 2 }}>
      {message}
    </Alert>
  );
}

export function FormStack({ children, onSubmit }: { children: ReactNode; onSubmit: () => void }) {
  return (
    <Stack component="form" spacing={2.25} noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {children}
    </Stack>
  );
}

/** Only same-site paths are followed after sign-in (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}
