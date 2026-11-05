import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { SignIn } from "./signin";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      <SignIn />
    </Suspense>
  );
}
