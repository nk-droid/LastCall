import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Composer } from "./composer";

export const metadata: Metadata = { title: "Build a bundle" };

export default function BuildPage({ params }: PageProps<"/shops/[slug]/build">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      {params.then(({ slug }) => <Composer key={slug} slug={slug} />)}
    </Suspense>
  );
}
