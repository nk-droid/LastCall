import type { Metadata } from "next";

import { Sell } from "./sell";

export const metadata: Metadata = { title: "List your shop", description: "Sell your end-of-day surplus as bundles shoppers ask for, with PayPal checkout and a pickup queue." };

export default function SellPage() {
  return <Sell />;
}
