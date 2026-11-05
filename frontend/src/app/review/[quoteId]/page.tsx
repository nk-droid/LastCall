import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Review } from "./review";

export const metadata: Metadata = { title: "Review your bundle" };

export default function ReviewPage({ params }: PageProps<"/review/[quoteId]">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading your bundle…" />}>
      {params.then(({ quoteId }) => <Review key={quoteId} quoteId={quoteId} />)}
    </Suspense>
  );
}
