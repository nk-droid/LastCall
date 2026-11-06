import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Orders } from "./orders";

export const metadata: Metadata = { title: "Orders" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function OrdersPage() {
  return (
    <Suspense fallback={<RouteFallback label="Loading orders…" />}>
      <Orders />
    </Suspense>
  );
}
