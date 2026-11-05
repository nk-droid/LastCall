import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Storefront } from "./storefront";

export const metadata: Metadata = { title: "Shop" };

export default function ShopPage({ params }: PageProps<"/shops/[slug]">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading the shop…" />}>
      {params.then(({ slug }) => <Storefront key={slug} slug={slug} />)}
    </Suspense>
  );
}
