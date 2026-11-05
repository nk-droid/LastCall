import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { AcceptInvite } from "./invite";

export const metadata: Metadata = { title: "Join a shop", robots: { index: false } };

export default function Page({ params }: PageProps<"/invite/[token]">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      {params.then(({ token }) => <AcceptInvite token={token} />)}
    </Suspense>
  );
}
