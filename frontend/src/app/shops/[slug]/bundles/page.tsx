import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { BundleChooser } from "./chooser";

export const metadata: Metadata = { title: "Bundle options" };

export default function BundlesPage({ params }: PageProps<"/shops/[slug]/bundles">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading…" />}>
      {params.then(({ slug }) => <BundleChooser key={slug} slug={slug} />)}
    </Suspense>
  );
}
