import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Assistant } from "./assistant";

export const metadata: Metadata = { title: "AI teammates" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function AssistantPage() {
  return (
    <Suspense fallback={<RouteFallback label="Loading your assistants…" />}>
      <Assistant />
    </Suspense>
  );
}
