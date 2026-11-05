import type { Metadata } from "next";

import { Insights } from "./insights";

export const metadata: Metadata = { title: "Insights" };

export default function InsightsPage() {
  return <Insights />;
}
