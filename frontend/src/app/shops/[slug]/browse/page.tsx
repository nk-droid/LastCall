import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Browse } from "./browse";

export const metadata: Metadata = { title: "Available items" };

export default function BrowsePage({ params }: PageProps<"/shops/[slug]/browse">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading items…" />}>
      {params.then(({ slug }) => <Browse key={slug} slug={slug} />)}
    </Suspense>
  );
}
