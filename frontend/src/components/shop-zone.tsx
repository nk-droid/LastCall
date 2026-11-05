"use client";

import { createContext, useContext, type ReactNode } from "react";

// Times on a shop's pages (pickup cutoffs, stock checks, order timelines) are shown in the shop's
// time zone, so a shopper or judge elsewhere sees the same clock the shop does.
const ShopZoneContext = createContext<string | undefined>(undefined);

export function ShopZone({ zone, children }: { zone: string | undefined; children: ReactNode }) {
  return <ShopZoneContext.Provider value={zone}>{children}</ShopZoneContext.Provider>;
}

export function useShopZone(): string | undefined {
  return useContext(ShopZoneContext);
}
