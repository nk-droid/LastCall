"use client";

import { NotificationsOffRounded } from "@mui/icons-material";
import { Button } from "@mui/material";
import { useEffect, useState } from "react";

import { PageShell } from "@/components/site";
import { EmptyState, LoadingBlock } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";

export function StopWatch({ token }: { token: string }) {
  const [request, setRequest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ stopped: boolean; request: string }>("/api/watches/stop", { body: { token } })
      .then((r) => setRequest(r.request))
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? "It may already be stopped. You can manage every watch from your account." : errorMessage(err)));
  }, [token]);
  return (
    <PageShell width="narrow">
      {error ? (
        <EmptyState title="This link has expired" action={<Button href="/account#watches" variant="contained">Manage watches</Button>}>{error}</EmptyState>
      ) : request !== null ? (
        <EmptyState icon={NotificationsOffRounded} title="You won't get more emails for this" action={<Button href="/account#watches" variant="outlined" color="inherit">Manage watches</Button>}>
          Stopped watching for “{request}”.
        </EmptyState>
      ) : (
        <LoadingBlock label="Stopping" />
      )}
    </PageShell>
  );
}
