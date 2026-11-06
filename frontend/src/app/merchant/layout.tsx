import type { Metadata } from "next";

import { MerchantShell } from "@/components/merchant-shell";

export const metadata: Metadata = { title: { default: "Merchant console", template: "%s · Merchant console · LastCall" } };

// The console is behind sign-in: MerchantShell shows a loading state until the account loads in the
// browser, so its pages never render on the server and can't be checked for instant navigation.
// Moving between console pages is still instant on the client, because the shell stays mounted.
export const instant = false;

export default function MerchantLayout({ children }: LayoutProps<"/merchant">) {
  return <MerchantShell>{children}</MerchantShell>;
}
