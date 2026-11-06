import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { StopWatch } from "./stop-watch";

export const metadata: Metadata = { title: "Stop watching", robots: { index: false } };

export default function Page({ params }: PageProps<"/watches/stop/[token]">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      {params.then(({ token }) => <StopWatch token={token} />)}
    </Suspense>
  );
}
