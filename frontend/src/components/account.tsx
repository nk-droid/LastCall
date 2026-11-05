"use client";

import {
  AdminPanelSettingsRounded,
  LoginRounded,
  LogoutRounded,
  ManageAccountsRounded,
  ReceiptLongRounded,
  StorefrontRounded,
} from "@mui/icons-material";
import { Box, Button, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import { flow, orderMemory } from "@/lib/flow";
import type { Account } from "@/lib/types";
import { brand } from "@/theme/tokens";

import { useAnnounce } from "./announcer";

type AccountContextValue = {
  account: Account | null;
  loaded: boolean;
  /** Bumps after sign-in or sign-out; add it to data-fetch deps that depend on who is signed in. */
  version: number;
  /** Re-read the session (after sign-in, invite acceptance, shop creation...). */
  refresh: (next?: Account) => void;
  signOut: () => Promise<void>;
};

const EMPTY: Account = { user: null, memberships: [], active_shop_id: null };

const AccountContext = createContext<AccountContextValue>({
  account: null,
  loaded: false,
  version: 0,
  refresh: () => {},
  signOut: async () => {},
});

export function useAccount(): AccountContextValue {
  return useContext(AccountContext);
}

// Baskets, holds and orders belong to the browser's shopper session, which signing out replaces.
const PRIVATE_PREFIXES = ["/review/", "/checkout/", "/orders", "/merchant", "/ops", "/account"];

export function AccountProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const announce = useAnnounce();
  const [state, setState] = useState<{ account: Account | null; loaded: boolean; version: number }>({ account: null, loaded: false, version: 0 });

  const load = useCallback(() => {
    api<Account>("/api/auth/me")
      .then((account) => setState((s) => ({ account, loaded: true, version: s.version })))
      .catch(() => setState((s) => ({ ...s, account: s.account ?? EMPTY, loaded: true })));
  }, []);

  useEffect(load, [load]);

  const refresh = useCallback(
    (next?: Account) => {
      if (next) setState((s) => ({ account: next, loaded: true, version: s.version + 1 }));
      else {
        setState((s) => ({ ...s, version: s.version + 1 }));
        load();
      }
    },
    [load],
  );

  const signOut = useCallback(async () => {
    await api("/api/auth/logout", { body: {} });
    await api("/api/config").catch(() => undefined); // start the fresh shopper session right away
    flow.clear();
    orderMemory.clear();
    setState((s) => ({ account: EMPTY, loaded: true, version: s.version + 1 }));
    announce("Signed out");
    // Read the path at sign-out time: a pathname hook here (root layout) would suspend dynamic routes.
    if (PRIVATE_PREFIXES.some((prefix) => window.location.pathname.startsWith(prefix))) router.push("/");
    else router.refresh();
  }, [announce, router]);

  const value = useMemo(() => ({ ...state, refresh, signOut }), [state, refresh, signOut]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** Initials are drawn as CSS generated content: decorative, never part of a control's visible text. */
export function Avatar({ initials, size = 32 }: { initials: string | null; size?: number }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        bgcolor: initials ? brand.leaf : brand.sand,
        color: initials ? "#FFFFFF" : brand.muted,
        border: `1px solid ${initials ? brand.leaf : brand.line}`,
        fontSize: size * 0.38,
        fontWeight: 700,
        "&::after": { content: `"${initials ?? ""}"` },
      }}
    />
  );
}

export function signInHref(next?: string): string {
  return next ? `/signin?next=${encodeURIComponent(next)}` : "/signin";
}

/** Header control: sign-in for guests; for members, a menu with orders, consoles and sign-out. */
export function AccountMenu() {
  const { account, loaded, signOut } = useAccount();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const user = account?.user ?? null;

  if (!loaded) return <Box sx={{ width: 36, height: 36 }} aria-hidden />;
  if (!user) {
    return (
      <Stack direction="row" spacing={1}>
        <Button href="/signin" variant="outlined" size="small" startIcon={<LoginRounded />}>
          Sign in
        </Button>
      </Stack>
    );
  }
  const close = () => setAnchor(null);
  const runsShops = (account?.memberships.length ?? 0) > 0;
  return (
    <>
      <Tooltip title="Account">
        <IconButton aria-label={`Account menu for ${user.name}`} aria-haspopup="menu" aria-expanded={anchor ? "true" : undefined}
          onClick={(e) => setAnchor(e.currentTarget)} sx={{ p: 0.5 }}>
          <Avatar initials={user.initials} size={34} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={close} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }} slotProps={{ paper: { sx: { minWidth: 240, mt: 1 } } }}>
        <Box sx={{ px: 2, py: 1.25 }}>
          <Typography sx={{ fontWeight: 650 }}>{user.name}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            {user.email}
          </Typography>
        </Box>
        <Divider />
        <MenuItem component="a" href="/orders" onClick={close}>
          <ListItemIcon><ReceiptLongRounded fontSize="small" /></ListItemIcon>
          <ListItemText>My orders</ListItemText>
        </MenuItem>
        <MenuItem component="a" href={runsShops ? "/merchant" : "/sell"} onClick={close}>
          <ListItemIcon><StorefrontRounded fontSize="small" /></ListItemIcon>
          <ListItemText>{runsShops ? "Merchant console" : "List your shop"}</ListItemText>
        </MenuItem>
        {user.is_platform_admin ? (
          <MenuItem component="a" href="/ops" onClick={close}>
            <ListItemIcon><AdminPanelSettingsRounded fontSize="small" /></ListItemIcon>
            <ListItemText>Platform ops</ListItemText>
          </MenuItem>
        ) : null}
        <MenuItem component="a" href="/account" onClick={close}>
          <ListItemIcon><ManageAccountsRounded fontSize="small" /></ListItemIcon>
          <ListItemText>Account settings</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => { close(); void signOut(); }}>
          <ListItemIcon><LogoutRounded fontSize="small" /></ListItemIcon>
          <ListItemText>Sign out</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
