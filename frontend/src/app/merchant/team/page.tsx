import type { Metadata } from "next";

import { TeamPage } from "./team";

export const metadata: Metadata = { title: "Team" };

export default function MerchantTeamPage() {
  return <TeamPage />;
}
