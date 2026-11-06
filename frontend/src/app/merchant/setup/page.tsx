import type { Metadata } from "next";

import { Setup } from "./setup";

export const metadata: Metadata = { title: "Set up your shop" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function SetupPage() {
  return <Setup />;
}
