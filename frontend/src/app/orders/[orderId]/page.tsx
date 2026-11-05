import type { Metadata } from "next";
import { Suspense } from "react";

import { RouteFallback } from "@/components/route-fallback";

import { OrderPage } from "./order-page";

export const metadata: Metadata = { title: "Your order" };

export default function OrderRoute({ params }: PageProps<"/orders/[orderId]">) {
  return (
    <Suspense fallback={<RouteFallback label="Loading your order…" />}>
      {params.then(({ orderId }) => <OrderPage key={orderId} orderId={orderId} />)}
    </Suspense>
  );
}
