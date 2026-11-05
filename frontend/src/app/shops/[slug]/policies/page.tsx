import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Policies } from "./policies";

export const metadata: Metadata = { title: "Shop policies" };

export default function ShopPoliciesPage({ params }: PageProps<"/shops/[slug]/policies">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading policies…" />}>
      {params.then(({ slug }) => <Policies key={slug} slug={slug} />)}
    </Suspense>
  );
}
