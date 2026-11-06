import type { Metadata } from "next";

import { TeamPage } from "./team";

export const metadata: Metadata = { title: "Team" };
// Renders only after sign-in loads in the browser; see app/merchant/layout.tsx.
export const instant = false;

export default function MerchantTeamPage() {
  return <TeamPage />;
}
