import type { Metadata } from "next";

import { Inventory } from "./inventory";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage() {
  return <Inventory />;
}
