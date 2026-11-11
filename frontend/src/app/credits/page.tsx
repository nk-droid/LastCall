import type { Metadata } from "next";

import { Credits } from "./credits";

export const metadata: Metadata = { title: "Photo credits" };

export default function CreditsPage() {
  return <Credits />;
}
