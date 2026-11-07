"use client";

// Watch alerts in the header: a bell with the number of new matches, for signed-in shoppers.

import { NotificationsRounded } from "@mui/icons-material";
import { Badge, IconButton, Tooltip } from "@mui/material";
import { useEffect } from "react";

import { useAccount } from "@/components/account";
import { brand } from "@/components/ui";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-api";

/** Fired by the alerts page once it has marked everything seen, so the bell clears straight away. */
export const ALERTS_SEEN = "lastcall:alerts-seen";

export function AlertsBell() {
  const { account } = useAccount();
  const signedIn = !!account?.user;
  const unread = useResource((signal) => api<{ unread: number }>("/api/me/alerts/unread", { signal }), [signedIn], { pollMs: 60_000, enabled: signedIn });
  const { setData } = unread;
  useEffect(() => {
    const clear = () => setData({ unread: 0 });
    window.addEventListener(ALERTS_SEEN, clear);
    return () => window.removeEventListener(ALERTS_SEEN, clear);
  }, [setData]);
  if (!signedIn) return null;
  const n = unread.data?.unread ?? 0;
  return (
    <Tooltip title="Alerts">
      <IconButton href="/alerts" aria-label={n ? `Alerts, ${n} new` : "Alerts"} sx={{ color: "text.secondary" }}>
        {n ? (
          <Badge badgeContent={n} max={9} sx={{ "& .MuiBadge-badge": { bgcolor: brand.leaf, color: "#fff", fontWeight: 700 } }}>
            <NotificationsRounded />
          </Badge>
        ) : <NotificationsRounded />}
      </IconButton>
    </Tooltip>
  );
}
