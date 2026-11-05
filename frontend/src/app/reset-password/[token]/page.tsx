import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { ResetPassword } from "./reset";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };

export default function Page({ params }: PageProps<"/reset-password/[token]">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      {params.then(({ token }) => <ResetPassword token={token} />)}
    </Suspense>
  );
}
