import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { SettingsPage } from "./settings";

export const metadata: Metadata = { title: "Settings" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function MerchantSettingsPage() {
  return (
    <Suspense fallback={<RouteFallback label="Loading settings…" />}>
      <SettingsPage />
    </Suspense>
  );
}
