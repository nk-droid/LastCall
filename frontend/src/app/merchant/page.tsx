import type { Metadata } from "next";

import { Today } from "./today";

export const metadata: Metadata = { title: "Today" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function MerchantHome() {
  return <Today />;
}
