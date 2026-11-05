import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Checkout } from "./checkout";

export const metadata: Metadata = { title: "Checkout" };

export default function CheckoutPage({ params }: PageProps<"/checkout/[quoteId]">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading checkout…" />}>
      {params.then(({ quoteId }) => <Checkout key={quoteId} quoteId={quoteId} />)}
    </Suspense>
  );
}
