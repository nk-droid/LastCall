import type { Metadata } from "next";

import { Insights } from "./insights";

export const metadata: Metadata = { title: "Insights" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function InsightsPage() {
  return <Insights />;
}
