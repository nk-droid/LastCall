import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { SignUp } from "./signup";

export const metadata: Metadata = { title: "Create an account" };

export default function Page() {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      <SignUp />
    </Suspense>
  );
}
