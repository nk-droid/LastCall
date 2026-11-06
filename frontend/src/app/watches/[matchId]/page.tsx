import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { OpenMatch } from "./open-match";

export const metadata: Metadata = { title: "Your watched bundle", robots: { index: false } };

export default function Page({ params }: PageProps<"/watches/[matchId]">) {
  return (
    <Suspense fallback={<RouteFallback label="Checking the bundle…" />}>
      {params.then(({ matchId }) => <OpenMatch matchId={matchId} />)}
    </Suspense>
  );
}
