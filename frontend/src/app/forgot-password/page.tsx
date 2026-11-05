import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { ForgotPassword } from "./forgot";

export const metadata: Metadata = { title: "Reset your password" };

export default function Page() {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      <ForgotPassword />
    </Suspense>
  );
}
