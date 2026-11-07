import type { Metadata } from "next";

import { Assistant } from "./assistant";

export const metadata: Metadata = { title: "AI teammates" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function AssistantPage() {
  return <Assistant />;
}
