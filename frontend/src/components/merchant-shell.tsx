"use client";

import {
  AddBusinessRounded,
  AdminPanelSettingsRounded,
  AutoAwesomeRounded,
  DashboardRounded,
  GroupsRounded,
  InsightsRounded,
  Inventory2Rounded,
  OpenInNewRounded,
  ReceiptLongRounded,
  SettingsRounded,
  StorefrontRounded,
  SwapHorizRounded,
} from "@mui/icons-material";
import { Alert, AppBar, Box, Button, Chip, Link, List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Toolbar } from "@mui/material";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api, errorMessage } from "@/lib/api";
import type { Account, Role, ShopStatus } from "@/lib/types";
import { brand, surface } from "@/theme/tokens";

import { AccountMenu, signInHref, useAccount } from "./account";
import { ShopZone } from "./shop-zone";
import { Wordmark } from "./site";
import { EmptyState, LoadingBlock } from "./ui";

/** The signed-in member acting in the shop the console is open on. */
export type Staff = {
  id: string;
  display_name: string;
  email: string;
  role: Role;
  is_platform_admin: boolean;
  merchant: { id: string; slug: string; name: string; category: string; status: ShopStatus; timezone: string };
};

const StaffContext = createContext<Staff | null>(null);

export function useStaff(): Staff | null {
  return useContext(StaffContext);
}

const RANK: Record<Role, number> = { staff: 1, manager: 2, owner: 3 };

export function hasRole(staff: Staff | null, role: Role): boolean {
  return !!staff && RANK[staff.role] >= RANK[role];
}

const NAV: { href: string; label: string; icon: typeof DashboardRounded; role: Role }[] = [
  { href: "/merchant", label: "Today", icon: DashboardRounded, role: "staff" },
  { href: "/merchant/assistant", label: "Assistant", icon: AutoAwesomeRounded, role: "staff" },
  { href: "/merchant/orders", label: "Orders", icon: ReceiptLongRounded, role: "staff" },
  { href: "/merchant/inventory", label: "Inventory", icon: Inventory2Rounded, role: "staff" },
  { href: "/merchant/insights", label: "Insights", icon: InsightsRounded, role: "staff" },
  { href: "/merchant/team", label: "Team", icon: GroupsRounded, role: "manager" },
  { href: "/merchant/settings", label: "Settings", icon: SettingsRounded, role: "staff" },
];

const STATUS_NOTE: Partial<Record<ShopStatus, { severity: "info" | "warning"; text: string }>> = {
  draft: { severity: "info", text: "Your shop isn't live yet. Finish setup and submit it for review." },
  rejected: { severity: "warning", text: "Your shop needs changes before it can go live. See the reviewer's note in setup." },
  pending_review: { severity: "info", text: "Your shop is with the LastCall team for review. You can keep editing products meanwhile." },
  suspended: { severity: "warning", text: "Your shop is paused and isn't taking new orders. Existing orders stay here." },
};

const SIDEBAR = 232;

function staffFrom(account: Account | null): Staff | null {
  const user = account?.user;
  if (!user || !account.memberships.length) return null;
  const member = account.memberships.find((m) => m.shop.id === account.active_shop_id) ?? account.memberships[0];
  return { id: user.id, display_name: user.name, email: user.email, role: member.role, is_platform_admin: user.is_platform_admin, merchant: member.shop };
}

export function MerchantShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { account, loaded, refresh } = useAccount();
  const staff = useMemo(() => staffFrom(account), [account]);
  const signedOut = loaded && !account?.user;

  useEffect(() => {
    if (signedOut) router.replace(signInHref(pathname));
  }, [signedOut, pathname, router]);

  const isActive = (href: string) => (href === "/merchant" ? pathname === "/merchant" : pathname.startsWith(href));
  const items = NAV.filter((n) => hasRole(staff, n.role));
  const note = staff ? STATUS_NOTE[staff.merchant.status] : undefined;
  const setupPath = "/merchant/setup";

  let body: ReactNode = children;
  if (!loaded || signedOut) body = <LoadingBlock label={signedOut ? "Redirecting to sign in…" : "Loading your shop…"} />;
  else if (!staff) {
    body = (
      <EmptyState
        icon={StorefrontRounded}
        title="You're not part of a shop yet"
        action={
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ justifyContent: "center" }}>
            <Button href="/sell" variant="contained" startIcon={<AddBusinessRounded />}>List your shop</Button>
            <Button href="/" variant="outlined">Back to shops</Button>
          </Stack>
        }
      >
        Shop owners invite their team by email. Ask yours for an invitation, or list your own shop.
      </EmptyState>
    );
  }

  return (
    <StaffContext.Provider value={staff}>
      <ShopZone zone={staff?.merchant.timezone}>
      <AppBar position="sticky" sx={{ bgcolor: "rgba(255, 255, 255, 0.94)", backdropFilter: "saturate(1.2) blur(12px)", color: brand.forest }}>
        <Toolbar sx={{ gap: 1.5, minHeight: { xs: 60, sm: 64 }, px: { xs: 2, sm: 3 } }}>
          <Link href="/merchant" underline="none" aria-label="LastCall merchant console home" sx={{ borderRadius: "6px", py: 0.5 }}>
            <Wordmark />
          </Link>
          {account ? <ShopSwitcher account={account} onSwitched={(next) => { refresh(next); router.refresh(); }} /> : null}
          <Box sx={{ flex: 1 }} />
          {staff ? (
            <Button href={`/shops/${staff.merchant.slug}`} target="_blank" color="inherit" endIcon={<OpenInNewRounded />}
              sx={{ display: { xs: "none", md: "inline-flex" }, color: "text.secondary" }}>
              View storefront
            </Button>
          ) : null}
          <AccountMenu />
        </Toolbar>
        {items.length ? (
          <Box component="nav" aria-label="Merchant console" sx={{ display: { xs: "block", md: "none" } }}>
            <Stack component="ul" direction="row" spacing={1} sx={{ m: 0, px: 2, pt: 0.5, pb: 1.5, listStyle: "none", overflowX: "auto" }}>
              {items.map((n) => {
                const active = isActive(n.href);
                return (
                  <li key={n.href}>
                    <Button href={n.href} color="inherit" aria-current={active ? "page" : undefined} startIcon={<n.icon />}
                      sx={{ minHeight: 40, px: 1.75, color: active ? brand.leafDark : brand.muted, border: "1px solid transparent", ...(active ? surface.pressed : {}) }}>
                      {n.label}
                    </Button>
                  </li>
                );
              })}
            </Stack>
          </Box>
        ) : null}
      </AppBar>
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        {items.length ? (
          <Box component="nav" aria-label="Merchant console"
            sx={{ display: { xs: "none", md: "flex" }, flexDirection: "column", width: SIDEBAR, flexShrink: 0, borderRight: `1px solid ${brand.line}`,
                  bgcolor: brand.paper, position: "sticky", top: 64, alignSelf: "flex-start", height: "calc(100dvh - 64px)", overflowY: "auto", p: 1.5 }}>
            <List disablePadding sx={{ display: "grid", gap: 0.5 }}>
              {items.map((n) => {
                const active = isActive(n.href);
                return (
                  <li key={n.href}>
                    <ListItemButton href={n.href} selected={active} aria-current={active ? "page" : undefined} sx={{ minHeight: 44 }}>
                      <ListItemIcon sx={{ minWidth: 36, color: active ? brand.leafDark : brand.muted }}><n.icon fontSize="small" /></ListItemIcon>
                      <ListItemText primary={n.label} slotProps={{ primary: { sx: { fontWeight: active ? 700 : 600, fontSize: "0.94rem" } } }} />
                    </ListItemButton>
                  </li>
                );
              })}
            </List>
            <Box sx={{ flex: 1 }} />
            {staff?.is_platform_admin ? (
              <ListItemButton href="/ops" sx={{ minHeight: 44 }}>
                <ListItemIcon sx={{ minWidth: 36, color: brand.muted }}><AdminPanelSettingsRounded fontSize="small" /></ListItemIcon>
                <ListItemText primary="Platform ops" slotProps={{ primary: { sx: { fontWeight: 600, fontSize: "0.94rem" } } }} />
              </ListItemButton>
            ) : null}
          </Box>
        ) : null}
        <Box component="main" id="main" sx={{ flex: 1, minWidth: 0, px: { xs: 2, sm: 3, lg: 4 }, py: { xs: 2.5, sm: 3.5 } }}>
          <Box sx={{ maxWidth: 1320, mx: "auto" }}>
            {note && staff && !pathname.startsWith(setupPath) ? (
              <Alert severity={note.severity} sx={{ mb: 3 }}
                action={<Button href={setupPath} size="small" color="inherit">{staff.merchant.status === "draft" || staff.merchant.status === "rejected" ? "Open setup" : "View status"}</Button>}>
                {note.text}
              </Alert>
            ) : null}
            {body}
          </Box>
        </Box>
      </Box>
      </ShopZone>
    </StaffContext.Provider>
  );
}

/** The shop the console works on; people who staff several shops switch here. */
function ShopSwitcher({ account, onSwitched }: { account: Account; onSwitched: (next: Account) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = account.memberships.find((m) => m.shop.id === account.active_shop_id) ?? account.memberships[0];
  if (!current) return null;
  const many = account.memberships.length > 1;
  const chip = (
    <Chip icon={<StorefrontRounded />} label={current.shop.name} variant="outlined" size="small"
      deleteIcon={many ? <SwapHorizRounded /> : undefined} onDelete={many ? (e) => setAnchor(e.currentTarget.closest(".MuiChip-root") as HTMLElement) : undefined}
      onClick={many ? (e) => setAnchor(e.currentTarget) : undefined}
      aria-label={many ? `Shop: ${current.shop.name}. Switch shop` : `Shop: ${current.shop.name}`}
      sx={{ maxWidth: 280, "& .MuiChip-icon": { color: brand.leaf } }} />
  );
  async function choose(shopId: string) {
    setAnchor(null);
    try {
      onSwitched(await api<Account>("/api/auth/active-shop", { body: { shop_id: shopId } }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      {chip}
      {error ? <Box component="span" role="alert" sx={{ color: brand.danger, fontSize: 13 }}>{error}</Box> : null}
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {account.memberships.map((m) => (
          <MenuItem key={m.shop.id} selected={m.shop.id === current.shop.id} onClick={() => choose(m.shop.id)}>
            <ListItemText primary={m.shop.name} secondary={`${m.role[0].toUpperCase()}${m.role.slice(1)} · ${m.shop.status.replace("_", " ")}`} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
