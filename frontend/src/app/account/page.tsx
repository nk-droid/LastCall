import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { AccountSettings } from "./account-settings";

export const metadata: Metadata = { title: "Account settings" };

export default function Page() {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      <AccountSettings />
    </Suspense>
  );
}
