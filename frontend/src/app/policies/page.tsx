import type { Metadata } from "next";

import { Policies } from "./policies";

export const metadata: Metadata = { title: "How LastCall works" };

export default function PoliciesPage() {
  return <Policies />;
}
