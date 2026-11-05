import type { Metadata, Viewport } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";

import { AnnouncerProvider } from "@/components/announcer";
import { ConfigProvider } from "@/components/config";
import { AccountProvider } from "@/components/account";
import { ThemeRegistry } from "@/theme/registry";
import { brand } from "@/theme/tokens";

import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const heading = Plus_Jakarta_Sans({ variable: "--font-heading", subsets: ["latin"], display: "swap", weight: ["600", "700", "800"] });

export const metadata: Metadata = {
  title: { default: "LastCall · Surplus bundles from local shops", template: "%s · LastCall" },
  description: "Tell a local bakery or café what you need and get a verified bundle of today's surplus, ready for pickup. Payments by PayPal.",
  applicationName: "LastCall",
  openGraph: { type: "website", siteName: "LastCall", title: "LastCall · Surplus bundles from local shops",
               description: "Today's surplus from local bakeries and cafés, bundled for what you need and ready for pickup." },
};

export const viewport: Viewport = {
  themeColor: brand.forest,
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${heading.variable}`} data-scroll-behavior="smooth">
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        <ThemeRegistry>
          <ConfigProvider>
            <AnnouncerProvider>
              <AccountProvider>{children}</AccountProvider>
            </AnnouncerProvider>
          </ConfigProvider>
        </ThemeRegistry>
      </body>
    </html>
  );
}
