"use client";

// The link in a watch email: re-check the bundle for this browser and continue to the normal review page.

import { RemoveShoppingCartRounded } from "@mui/icons-material";
import { Button } from "@mui/material";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PageShell } from "@/components/site";
import { EmptyState, LoadingBlock } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";

type Opened = { status: "ready" | "sold_out" | "unavailable"; quote_id?: string; changed?: boolean; shop: { slug: string; name: string } };

export function OpenMatch({ matchId }: { matchId: string }) {
  const router = useRouter();
  const [result, setResult] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Opened>(`/api/watches/matches/${matchId}/open`, { body: {} })
      .then((opened) => {
        if (opened.status === "ready" && opened.quote_id) router.replace(`/review/${opened.quote_id}${opened.changed ? "?from=watch-changed" : ""}`);
        else setResult(opened);
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? "The watch may have been stopped. Today's shops are still worth a look." : errorMessage(err)));
  }, [matchId, router]);
  return (
    <PageShell width="narrow">
      {error ? (
        <EmptyState title="This link has expired" action={<Button href="/" variant="contained">See today&apos;s shops</Button>}>{error}</EmptyState>
      ) : result ? (
        <EmptyState icon={RemoveShoppingCartRounded} title={result.status === "sold_out" ? `That bundle has sold out at ${result.shop.name}` : `${result.shop.name} isn't taking orders right now`}
          action={<Button href={`/shops/${result.shop.slug}`} variant="contained">See what&apos;s left</Button>}>
          Your watch stays on, so we&apos;ll email you if something like it is listed again.
        </EmptyState>
      ) : (
        <LoadingBlock label="Checking the bundle is still available" />
      )}
    </PageShell>
  );
}
