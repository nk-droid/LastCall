import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { PayPalReturn } from "./paypal-return";

export const metadata: Metadata = { title: "Connecting PayPal" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function PayPalReturnPage() {
  return (
    <Suspense fallback={<RouteFallback label="Connecting your PayPal account…" />}>
      <PayPalReturn />
    </Suspense>
  );
}
