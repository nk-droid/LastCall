import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { SettingsPage } from "./settings";

export const metadata: Metadata = { title: "Settings" };

export default function MerchantSettingsPage() {
  return (
    <Suspense fallback={<RouteFallback label="Loading settings…" />}>
      <SettingsPage />
    </Suspense>
  );
}
