import type { Metadata } from "next";

import { Inventory } from "./inventory";

export const metadata: Metadata = { title: "Inventory" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function InventoryPage() {
  return <Inventory />;
}
