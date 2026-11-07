"use client";

// Ask LastCall from any shopping page: a floating button opens the chat as a side sheet. On a shop's pages it looks
// only at that shop (with a switch to every shop); elsewhere it checks them all. The chat carries on across pages.
// Hidden where it would get in the way: the home page (which leads with Ask LastCall), checkout and sign-in.

import { AutoAwesomeRounded } from "@mui/icons-material";
import { Button, Link } from "@mui/material";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { Dialog } from "@/components/dialog";
import { brand } from "@/components/ui";

import { ConciergePanel } from "./concierge";
import type { Scope } from "./use-conversation";

const SHOW_ON = [/^\/shops\/[^/]+\/?$/, /^\/shops\/[^/]+\/(browse|policies)\/?$/, /^\/orders\/?$/, /^\/account\/?$/, /^\/policies\/?$/, /^\/alerts\/?$/];

type Ask = { open: (where?: "shop" | "all") => void };
const AskContext = createContext<Ask | null>(null);

export function useAsk(): Ask | null {
  return useContext(AskContext);
}

export function AskProvider({ shop, children }: { shop?: Scope; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [everyShop, setEveryShop] = useState(false);
  const scope = shop && !everyShop ? shop : undefined;
  const floating = SHOW_ON.some((r) => r.test(pathname ?? ""));
  const value = useMemo<Ask>(() => ({ open: (where) => { setEveryShop(where === "all"); setOpen(true); } }), []);

  return (
    <AskContext.Provider value={value}>
      {children}
      {floating && !open ? (
        <Button onClick={() => value.open(shop ? "shop" : "all")} aria-haspopup="dialog" startIcon={<AutoAwesomeRounded />}
          sx={{
            position: "fixed", zIndex: (t) => t.zIndex.speedDial, right: { xs: 16, sm: 28 }, bottom: { xs: 16, sm: 28 },
            height: 52, px: 2.5, borderRadius: 999, bgcolor: brand.forest, color: "#fff", fontWeight: 700, fontSize: 15,
            boxShadow: "0 10px 30px rgba(20, 35, 29, 0.3)", "&:hover": { bgcolor: brand.forestSoft },
          }}>
          Ask LastCall
        </Button>
      ) : null}
      {open ? (
        <Dialog open side onClose={() => setOpen(false)} title={scope ? `Ask LastCall · ${scope.name}` : "Ask LastCall"}
          description={scope ? (
            <>Looking only at {scope.name} · <Link component="button" type="button" onClick={() => setEveryShop(true)} sx={{ verticalAlign: "baseline" }}>ask about every shop</Link></>
          ) : "Say who it's for, your budget, allergies and pickup time. It checks every shop open today."}>
          <ConciergePanel key={scope?.slug ?? "all"} shop={scope} autoFocus />
        </Dialog>
      ) : null}
    </AskContext.Provider>
  );
}

/** A shop page's own "let LastCall pick" link, opening the sheet for that shop. */
export function AskShopButton({ children, sx }: { children: ReactNode; sx?: object }) {
  const ask = useAsk();
  return (
    <Button variant="text" startIcon={<AutoAwesomeRounded />} onClick={() => ask?.open("shop")} aria-haspopup="dialog" sx={sx}>
      {children}
    </Button>
  );
}
