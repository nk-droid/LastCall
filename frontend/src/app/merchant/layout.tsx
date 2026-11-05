import type { Metadata } from "next";

import { MerchantShell } from "@/components/merchant-shell";

export const metadata: Metadata = { title: { default: "Merchant console", template: "%s · Merchant console · LastCall" } };

export default function MerchantLayout({ children }: LayoutProps<"/merchant">) {
  return <MerchantShell>{children}</MerchantShell>;
}
