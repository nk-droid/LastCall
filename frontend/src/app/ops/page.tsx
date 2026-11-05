import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Ops } from "./ops";

export const metadata: Metadata = { title: "Platform ops", robots: { index: false } };

export default function OpsPage() {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      <Ops />
    </Suspense>
  );
}
