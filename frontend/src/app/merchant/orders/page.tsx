import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { Orders } from "./orders";

export const metadata: Metadata = { title: "Orders" };

export default function OrdersPage() {
  return (
    <Suspense fallback={<RouteFallback label="Loading orders…" />}>
      <Orders />
    </Suspense>
  );
}
