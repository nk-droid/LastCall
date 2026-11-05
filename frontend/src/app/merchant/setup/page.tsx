import type { Metadata } from "next";

import { Setup } from "./setup";

export const metadata: Metadata = { title: "Set up your shop" };

export default function SetupPage() {
  return <Setup />;
}
