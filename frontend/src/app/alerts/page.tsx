import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Alerts } from "./alerts";

export const metadata: Metadata = { title: "Alerts" };

export default function Page() {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      <Alerts />
    </Suspense>
  );
}
