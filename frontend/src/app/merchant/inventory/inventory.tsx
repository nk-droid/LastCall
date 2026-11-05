"use client";

import {
  AddRounded,
  AutoAwesomeRounded,
  CheckCircleRounded,
  DeleteOutlineRounded,
  EditNoteRounded,
  EditRounded,
  ErrorOutlineRounded,
  HealthAndSafetyRounded,
  HistoryRounded,
  Inventory2Rounded,
  PauseCircleRounded,
  PauseRounded,
  PlayArrowRounded,
  ReceiptLongRounded,
  RemoveRounded,
  RemoveShoppingCartRounded,
  ScheduleRounded,
  SearchOffRounded,
  SearchRounded,
  SellRounded,
  ShoppingBagRounded,
  StorefrontRounded,
  UpdateRounded,
  UploadRounded,
  VerifiedRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Grid,
  IconButton,
  InputAdornment,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Tabs,
  TextField,
  Typography,
  useMediaQuery,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { AllergenTags, PriceTag } from "@/components/commerce";
import { Dialog } from "@/components/dialog";
import { hasRole, useStaff } from "@/components/merchant-shell";
import { ProductImage } from "@/components/product-image";
import { EmptyState, ErrorState, FactChip, FilterChip, LoadingBlock, PageHeader, StatTile, StatusChip, brand, surface, shadows, tones, type Icon, type Tone } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ALLERGEN_LABEL, ago, dateTimeLabel, money } from "@/lib/format";
import type { Allergens, InventoryRow } from "@/lib/types";
import { useShopZone } from "@/components/shop-zone";
import { useResource } from "@/lib/use-api";

import { AddProductButton } from "./add-product";

type SortKey = "name" | "available" | "surplus" | "cutoff" | "price" | "updated";
type View = "all" | "attention" | "paused";
type TabKey = "stock" | "details" | "allergens" | "price" | "history";
type Update = (row: InventoryRow, body: Record<string, unknown>, optimistic?: Partial<InventoryRow>, label?: string) => Promise<InventoryRow | null>;

const ALLERGENS = ["tree_nuts", "peanuts", "milk", "eggs", "wheat", "soy", "sesame"];
const AVAILABILITY: Record<string, { tone: Tone; label: string; icon?: Icon }> = {
  available: { tone: "success", label: "Available" },
  low: { tone: "warning", label: "Low stock" },
  sold_out: { tone: "neutral", label: "Sold out", icon: RemoveShoppingCartRounded },
  paused: { tone: "neutral", label: "Paused", icon: PauseCircleRounded },
  past_cutoff: { tone: "danger", label: "Past cutoff", icon: ScheduleRounded },
  unpriced: { tone: "warning", label: "No price", icon: SellRounded },
};
const VERIFICATION: Record<string, { tone: Tone; label: string; icon: Icon }> = {
  verified: { tone: "success", label: "Verified", icon: VerifiedRounded },
  needs_review: { tone: "warning", label: "Needs review", icon: WarningAmberRounded },
  missing: { tone: "danger", label: "Missing", icon: ErrorOutlineRounded },
};
const ATTENTION = new Set(["low", "sold_out", "past_cutoff", "unpriced"]);
// Categorical colors for the stock split (validated for CVD separation); buffer is a neutral.
const STOCK_PARTS = [
  { key: "available", label: "Available", color: brand.leaf },
  { key: "reserved", label: "Held", color: "#2A78D6" },
  { key: "committed", label: "Paid", color: "#E87BA4" },
  { key: "buffer", label: "Buffer", color: surface.edge },
] as const;
const TABS: { key: TabKey; label: string; icon: Icon }[] = [
  { key: "stock", label: "Stock", icon: Inventory2Rounded },
  { key: "details", label: "Details", icon: EditNoteRounded },
  { key: "allergens", label: "Allergens", icon: HealthAndSafetyRounded },
  { key: "price", label: "Price", icon: SellRounded },
  { key: "history", label: "History", icon: HistoryRounded },
];
const fieldset = { border: 0, m: 0, p: 0, minWidth: 0 } as const;
const panel = { ...surface.raised, p: 2.25, borderRadius: "16px" } as const;

function needsAttention(r: InventoryRow): boolean {
  return ATTENTION.has(r.availability_status) || r.allergens.status !== "verified" || r.stale;
}

function allergenList(codes: string[]): string {
  return codes.map((code) => ALLERGEN_LABEL[code]?.toLowerCase() ?? code).join(", ");
}

export function Inventory() {
  const announce = useAnnounce();
  const user = useStaff();
  const inv = useResource((signal) => api<{ rows: InventoryRow[]; as_of: string; timezone: string }>("/api/merchant/inventory", { signal }), [], { pollMs: 15_000 });
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [pending, setPending] = useState<Record<string, InventoryRow>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<InventoryRow | null>(null);
  const compact = useMediaQuery((theme: Theme) => theme.breakpoints.down("lg"), { noSsr: true });

  const all = (inv.data?.rows ?? []).map((r) => pending[r.product_id] ?? r);
  const sortValue = (r: InventoryRow) =>
    sort.key === "name" ? r.name : sort.key === "available" ? r.available : sort.key === "surplus" ? r.surplus : sort.key === "cutoff" ? r.cutoff_at : sort.key === "price" ? r.price?.sale_minor ?? 0 : r.updated_at;
  const rows = all
    .filter((r) => `${r.name} ${r.sku} ${r.category}`.toLowerCase().includes(query.toLowerCase()))
    .filter((r) => view === "all" || (view === "attention" ? needsAttention(r) : r.status !== "active"))
    .sort((a, b) => (sortValue(a) < sortValue(b) ? -1 : sortValue(a) > sortValue(b) ? 1 : 0) * sort.dir);
  const active = all.filter((r) => r.status === "active");
  const totals = {
    available: active.reduce((sum, r) => sum + r.available, 0),
    held: all.reduce((sum, r) => sum + r.reserved, 0),
    paid: all.reduce((sum, r) => sum + r.committed, 0),
    attention: all.filter(needsAttention).length,
    paused: all.length - active.length,
  };

  async function update(row: InventoryRow, body: Record<string, unknown>, optimistic?: Partial<InventoryRow>, label?: string) {
    setRowError((e) => ({ ...e, [row.product_id]: "" }));
    if (optimistic) setPending((p) => ({ ...p, [row.product_id]: { ...row, ...optimistic } }));
    try {
      const res = await api<{ row: InventoryRow }>("/api/merchant/inventory", { body: { product_id: row.product_id, expected_version: row.version, ...body } });
      setPending((p) => ({ ...p, [row.product_id]: res.row }));
      announce(label ? `${row.name}: ${label}.` : `${row.name} saved.`);
      inv.reload();
      return res.row;
    } catch (err) {
      setPending((p) => {
        const next = { ...p };
        delete next[row.product_id];
        return next;
      });
      const message = err instanceof ApiError && err.code === "version_conflict" ? "Someone else changed this item. Showing the latest count; please try again." : errorMessage(err);
      setRowError((e) => ({ ...e, [row.product_id]: message }));
      announce(`${row.name}: ${message}`, "assertive");
      inv.reload();
      return null;
    }
  }

  const adjust = (r: InventoryRow, delta: 1 | -1) =>
    update(
      r,
      { action: "adjust", delta, reason: "Inline adjust" },
      delta > 0 ? { surplus: r.surplus + 1, available: r.available + 1 } : { surplus: r.surplus - 1, available: Math.max(0, r.available - 1) },
      `surplus ${r.surplus + delta}`,
    );

  function sortCell(key: SortKey, label: string) {
    const isActive = sort.key === key;
    const direction = isActive && sort.dir === -1 ? "desc" : "asc";
    return (
      <TableCell sortDirection={isActive ? direction : false}>
        <TableSortLabel active={isActive} direction={direction} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
          {label}
        </TableSortLabel>
      </TableCell>
    );
  }

  const header = (
    <PageHeader
      eyebrow={user?.merchant?.name}
      title="Inventory"
      subtitle="Today's surplus. Held or paid units can't be removed."
      chips={inv.data ? <FactChip icon={UpdateRounded} label={`Updated ${ago(inv.data.as_of)}`} /> : undefined}
      actions={hasRole(user, "manager") ? (
        <>
          <PublishListing onDone={inv.reload} />
          <AddProductButton rows={inv.data?.rows ?? []} onCreated={inv.reload} />
        </>
      ) : undefined}
    />
  );

  if (inv.error && !inv.data) {
    return (
      <>
        {header}
        <ErrorState title="Couldn't load inventory" message={errorMessage(inv.error)} onRetry={inv.reload} />
      </>
    );
  }
  if (!inv.data) {
    return (
      <>
        {header}
        <LoadingBlock label="Loading inventory" slow={inv.slow} lines={8} />
      </>
    );
  }

  return (
    <Box>
      {header}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile label="Active listings" value={active.length} caption={`${totals.paused} paused · ${all.length} products`} icon={<StorefrontRounded />} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile label="Available to sell" value={totals.available} caption="Units across active listings" icon={<Inventory2Rounded />} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile label="Held or paid" value={totals.held + totals.paid} caption={`${totals.held} in checkouts · ${totals.paid} paid`} icon={<ShoppingBagRounded />} tone="info" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile
            label="Needs attention"
            value={totals.attention}
            caption="Low stock, allergen review or stale count"
            icon={totals.attention ? <WarningAmberRounded /> : <CheckCircleRounded />}
            tone={totals.attention ? "warning" : "success"}
          />
        </Grid>
      </Grid>

      <Card>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          sx={{ p: { xs: 2, sm: 2.5 }, justifyContent: "space-between", alignItems: { md: "center" } }}
        >
          <Stack direction="row" spacing={1} useFlexGap role="group" aria-label="Filter products" sx={{ flexWrap: "wrap" }}>
            <FilterChip selected={view === "all"} onClick={() => setView("all")} label={<CountLabel label="All" count={all.length} />} />
            <FilterChip selected={view === "attention"} onClick={() => setView("attention")} icon={WarningAmberRounded} label={<CountLabel label="Needs attention" count={totals.attention} />} />
            <FilterChip selected={view === "paused"} onClick={() => setView("paused")} icon={PauseCircleRounded} label={<CountLabel label="Paused" count={totals.paused} />} />
          </Stack>
          <TextField
            size="small"
            label="Search products"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> } }}
            sx={{ width: { xs: "100%", md: 280 } }}
          />
        </Stack>

        {rows.length === 0 ? (
          <Box sx={{ px: { xs: 2, sm: 2.5 }, pb: { xs: 2, sm: 2.5 } }}>
            <EmptyState
              icon={SearchOffRounded}
              title="No matching products"
              action={<Button variant="outlined" color="inherit" onClick={() => { setQuery(""); setView("all"); }}>Show all products</Button>}
            >
              Try a different search or filter.
            </EmptyState>
          </Box>
        ) : compact ? (
          <Box component="ul" sx={{ m: 0, px: { xs: 2, sm: 2.5 }, pt: 0.5, pb: { xs: 2, sm: 2.5 }, listStyle: "none", display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
            {rows.map((r) => (
              // Paused listings sit pressed into the card instead of raised.
              <Box component="li" key={r.product_id} sx={{ ...(r.status !== "active" ? surface.inset : surface.raisedSm), borderRadius: "18px", p: 1.75 }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
                  <ProductImage image={r.image} size="sm" />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" component="p" sx={{ fontWeight: 700 }}>
                      {r.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" component="p">
                      {r.sku} · {r.category}
                    </Typography>
                  </Box>
                  <Button size="small" variant="outlined" color="inherit" startIcon={<EditRounded />} onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                    Edit
                  </Button>
                </Stack>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", mt: 1.25 }}>
                  <AvailabilityChip row={r} />
                  <VerificationChip status={r.allergens.status} prefix />
                  {r.stale ? <StatusChip tone="warning" label="Stale count" /> : null}
                </Stack>
                <Box component="dl" sx={{ m: 0, mt: 1.5, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 2, rowGap: 1.5 }}>
                  <Fact label="Available">
                    <AvailableCell row={r} />
                  </Fact>
                  <Fact label="Surplus listed">
                    <SurplusStepper row={r} onAdjust={(delta) => adjust(r, delta)} error={rowError[r.product_id]} />
                  </Fact>
                  <Fact label="Price">
                    <PriceCell row={r} />
                  </Fact>
                  <Fact label="Pickup cutoff">
                    <Typography component="p" sx={{ fontWeight: 700 }}>
                      {r.cutoff_label}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" component="p">
                      Updated {ago(r.updated_at)}
                    </Typography>
                  </Fact>
                </Box>
                <AllergenText allergens={r.allergens} />
              </Box>
            ))}
          </Box>
        ) : (
          <Box sx={{ overflowX: "auto", position: "relative" }}>
            <Table size="small" sx={{ minWidth: 900, "& th, & td": { px: 1 }, "& tbody td": { py: 1.5 }, "& tbody tr:last-of-type td": { borderBottom: 0 } }}>
              <caption className="sr-only">Surplus inventory. Column headers sort the table.</caption>
              <TableHead>
                <TableRow>
                  {sortCell("name", "Product")}
                  {sortCell("available", "Available")}
                  {sortCell("surplus", "Listed")}
                  {sortCell("cutoff", "Cutoff")}
                  {sortCell("price", "Price")}
                  <TableCell>Allergens</TableCell>
                  {sortCell("updated", "Updated")}
                  <TableCell align="right">
                    <span className="sr-only">Actions</span>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.product_id} hover sx={r.status !== "active" ? { bgcolor: "rgba(27, 42, 35, 0.04)" } : undefined}>
                    <TableCell>
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                        <ProductImage image={r.image} size="sm" sx={{ width: 52, height: 46 }} />
                        <Box sx={{ minWidth: 120 }}>
                          <Typography variant="subtitle2" component="p" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
                            {r.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" component="p">
                            {r.sku} · {r.category}
                          </Typography>
                          <Box sx={{ mt: 0.5 }}>
                            <AvailabilityChip row={r} />
                          </Box>
                        </Box>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <AvailableCell row={r} />
                    </TableCell>
                    <TableCell>
                      <SurplusStepper row={r} onAdjust={(delta) => adjust(r, delta)} error={rowError[r.product_id]} />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap" }}>{r.cutoff_label}</TableCell>
                    <TableCell>
                      <PriceCell row={r} />
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.5} sx={{ alignItems: "flex-start", maxWidth: 200 }}>
                        <VerificationChip status={r.allergens.status} />
                        <AllergenText allergens={r.allergens} dense />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                        {ago(r.updated_at)}
                      </Typography>
                      {r.stale ? <StatusChip tone="warning" label="Stale count" sx={{ mt: 0.5 }} /> : null}
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" variant="outlined" color="inherit" startIcon={<EditRounded />} onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Card>

      <ItemDrawer
        row={editing}
        canManage={hasRole(user, "manager")}
        onClose={() => setEditing(null)}
        onSaved={(row) => {
          setPending((p) => ({ ...p, [row.product_id]: row }));
          setEditing(row);
          inv.reload();
        }}
        update={update}
      />
    </Box>
  );
}

// ----------------------------------------------------------------------------- row pieces

function CountLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}{" "}
      <Box component="span" className="tabular" sx={{ ml: 0.25, px: 0.75, borderRadius: "99px", bgcolor: "rgba(27, 42, 35, 0.07)", fontWeight: 700, fontSize: "0.78rem" }}>
        {count}
      </Box>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ fontWeight: 650, mb: 0.5 }}>
        {label}
      </Typography>
      <Box component="dd" sx={{ m: 0 }}>
        {children}
      </Box>
    </div>
  );
}

function AvailabilityChip({ row }: { row: InventoryRow }) {
  const s = AVAILABILITY[row.availability_status] ?? { tone: "neutral" as Tone, label: row.availability_status };
  return <StatusChip tone={s.tone} icon={s.icon} label={s.label} />;
}

function VerificationChip({ status, prefix }: { status: string; prefix?: boolean }) {
  const v = VERIFICATION[status] ?? VERIFICATION.missing;
  return <StatusChip tone={v.tone} icon={v.icon} label={prefix ? `Allergens ${v.label.toLowerCase()}` : v.label} />;
}

function AllergenText({ allergens, dense }: { allergens: Allergens; dense?: boolean }) {
  return (
    <Box sx={{ mt: dense ? 0 : 1.25 }}>
      <Typography variant="caption" color="text.secondary" component="p">
        {allergens.contains.length ? `Contains ${allergenList(allergens.contains)}` : "No listed allergens"}
      </Typography>
      {allergens.cross_contact.length ? (
        <Typography variant="caption" component="p" sx={{ color: tones.warning.fg, fontWeight: 650, display: "flex", gap: 0.5 }}>
          <WarningAmberRounded aria-hidden sx={{ fontSize: 14, mt: "2px", flexShrink: 0 }} />
          May contain {allergenList(allergens.cross_contact)}
        </Typography>
      ) : null}
    </Box>
  );
}

function AvailableCell({ row }: { row: InventoryRow }) {
  const share = row.surplus ? Math.min(100, Math.round((row.available / row.surplus) * 100)) : 0;
  return (
    <Box sx={{ minWidth: 92 }}>
      <Typography component="p" className="tabular" sx={{ fontWeight: 800, fontSize: "1.15rem", lineHeight: 1.2 }}>
        {row.available}
      </Typography>
      <LinearProgress
        variant="determinate"
        value={share}
        aria-label={`${row.name}: ${row.available} of ${row.surplus} listed units available`}
        sx={{ height: 4, my: 0.75, maxWidth: 88 }}
      />
      <Typography variant="caption" color="text.secondary" component="p" className="tabular" sx={{ whiteSpace: "nowrap" }}>
        {row.reserved} held · {row.committed} paid
        {row.buffer ? ` · ${row.buffer} buffer` : ""}
      </Typography>
    </Box>
  );
}

function SurplusStepper({ row, onAdjust, error }: { row: InventoryRow; onAdjust: (delta: 1 | -1) => void; error?: string }) {
  const held = row.reserved + row.committed;
  const control = { ...surface.raisedSm, width: 34, height: 34, borderRadius: "50%", "&.Mui-disabled": { boxShadow: "none" } };
  return (
    <Box>
      <Stack direction="row" spacing={0.5} role="group" aria-label={`Surplus for ${row.name}`} sx={{ alignItems: "center" }}>
        <IconButton aria-label={`Decrease surplus for ${row.name}`} disabled={row.surplus <= held} onClick={() => onAdjust(-1)} sx={control}>
          <RemoveRounded fontSize="small" />
        </IconButton>
        <Typography component="span" className="tabular" sx={{ minWidth: 30, textAlign: "center", fontWeight: 700, fontSize: "1.05rem" }}>
          {row.surplus}
        </Typography>
        <IconButton aria-label={`Increase surplus for ${row.name}`} onClick={() => onAdjust(1)} sx={control}>
          <AddRounded fontSize="small" />
        </IconButton>
      </Stack>
      {error ? (
        <Typography role="alert" variant="caption" component="p" sx={{ mt: 0.75, maxWidth: 220, display: "flex", gap: 0.5, color: brand.danger, fontWeight: 650 }}>
          <ErrorOutlineRounded aria-hidden sx={{ fontSize: 15, mt: "1px", flexShrink: 0 }} />
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}

function PriceCell({ row }: { row: InventoryRow }) {
  if (!row.price) {
    return (
      <Typography color="text.secondary">
        —<span className="sr-only">No price</span>
      </Typography>
    );
  }
  const { sale_minor, reference_minor, currency } = row.price;
  const off = reference_minor > sale_minor ? Math.round((1 - sale_minor / reference_minor) * 100) : 0;
  return (
    <Box>
      <Typography component="p" className="tabular" sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>
        {money(sale_minor, currency)}
        {off ? (
          <Box component="span" sx={{ ml: 0.75, fontSize: "0.75rem", fontWeight: 700, color: brand.leafDark }}>
            −{off}%
          </Box>
        ) : null}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" className="tabular" sx={{ whiteSpace: "nowrap" }}>
        Regular {money(reference_minor, currency)}
      </Typography>
    </Box>
  );
}

// ----------------------------------------------------------------------------- item editor

function ItemDrawer({ row, canManage, onClose, onSaved, update }: { row: InventoryRow | null; canManage: boolean; onClose: () => void; onSaved: (row: InventoryRow) => void; update: Update }) {
  return (
    <Dialog open={!!row} onClose={onClose} side title={row ? `Edit ${row.name}` : "Edit"} description={row ? `${row.sku} · version ${row.version}` : undefined}>
      {row ? <ItemEditor key={row.product_id} row={row} canManage={canManage} onSaved={onSaved} update={update} /> : null}
    </Dialog>
  );
}

function TabPanel({ value, active, render }: { value: TabKey; active: TabKey; render: () => ReactNode }) {
  return (
    <Box role="tabpanel" id={`panel-${value}`} aria-labelledby={`tab-${value}`} hidden={value !== active} sx={{ pt: 2.5 }}>
      {value === active ? render() : null}
    </Box>
  );
}

function StockBreakdown({ row }: { row: InventoryRow }) {
  const parts = STOCK_PARTS.map((p) => ({ ...p, value: row[p.key] }));
  return (
    <Box sx={panel}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <Typography variant="subtitle2" component="h3">
          Stock breakdown
        </Typography>
        <Typography variant="caption" color="text.secondary" className="tabular">
          {row.surplus} listed
        </Typography>
      </Stack>
      <Box aria-hidden sx={{ ...surface.insetSm, display: "flex", gap: "2px", height: 12, p: "3px", mt: 1.5, borderRadius: "99px" }}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <Box key={p.key} sx={{ flexGrow: p.value, flexBasis: 0, bgcolor: p.color, borderRadius: "99px" }} />
          ))}
      </Box>
      <Box component="dl" sx={{ m: 0, mt: 1.5, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 1 }}>
        {parts.map((p) => (
          <div key={p.key}>
            <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.75, fontWeight: 650 }}>
              <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: p.color, flexShrink: 0 }} />
              {p.label}
            </Typography>
            <Typography component="dd" className="tabular" sx={{ m: 0, fontWeight: 700, fontSize: "1.2rem" }}>
              {p.value}
            </Typography>
          </div>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        Surplus can&apos;t go below {row.reserved + row.committed} (held + paid).
      </Typography>
    </Box>
  );
}

function ItemEditor({ row, canManage, onSaved, update }: { row: InventoryRow; canManage: boolean; onSaved: (row: InventoryRow) => void; update: Update }) {
  const announce = useAnnounce();
  const zone = useShopZone();
  const [tab, setTab] = useState<TabKey>("stock");
  const [surplus, setSurplus] = useState(row.surplus);
  const [counterQty, setCounterQty] = useState(1);
  const [buffer, setBuffer] = useState(row.buffer);
  const [cutoff, setCutoff] = useState(row.cutoff_local);
  const [details, setDetails] = useState({
    name: row.name, description: row.description, description_source: row.description_source as "merchant" | "ai_draft_approved",
    category: row.category, flavor: row.attributes.flavor, servings_per_unit: row.attributes.servings_per_unit, tags: row.attributes.tags.join(", "),
    ingredients: row.attributes.ingredients ?? "", per_order_limit: row.per_order_limit, surplus_priority: row.surplus_priority, image_url: row.image.url ?? "",
    vegetarian: row.attributes.dietary?.vegetarian ?? null, vegan: row.attributes.dietary?.vegan ?? null,
  });
  const [allergens, setAllergens] = useState({ contains: row.allergens.contains, cross_contact: row.allergens.cross_contact, status: row.allergens.status, notes: row.allergens.notes ?? "" });
  const [relist, setRelist] = useState({ enabled: row.relist.enabled, qty: row.relist.qty || row.surplus, cutoff_local: row.relist.cutoff_local ?? row.cutoff_local });
  const [price, setPrice] = useState({ reference: (row.price?.reference_minor ?? 0) / 100, sale: (row.price?.sale_minor ?? 0) / 100, source: row.price?.reference_source ?? "" });
  const [draft, setDraft] = useState<{ draft: string; source: string; removed: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [history, setHistory] = useState<{ inventory_events: { at: string; type: string; delta: number; before: number; after: number; actor: string; reason: string }[]; audit: { at: string; action: string; actor: string }[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const held = row.reserved + row.committed;
  const locked = !canManage;
  const isActive = row.status === "active";

  async function run(kind: string, fn: () => Promise<InventoryRow | null>, success: string) {
    setBusy(kind);
    setMessage(null);
    try {
      const saved = await fn();
      if (saved) {
        setMessage({ tone: "success", text: success });
        announce(success);
        onSaved(saved);
      }
    } catch (err) {
      setMessage({ tone: "danger", text: errorMessage(err) });
      announce(errorMessage(err), "assertive");
    } finally {
      setBusy(null);
    }
  }

  const productBody = () => ({
    name: details.name, description: details.description, description_source: details.description_source, category: details.category, flavor: details.flavor,
    servings_per_unit: Number(details.servings_per_unit), tags: details.tags.split(",").map((t) => t.trim()).filter(Boolean), ingredients: details.ingredients,
    dietary: { vegetarian: details.vegetarian, vegan: details.vegan },
    allergens: { contains: allergens.contains, cross_contact: allergens.cross_contact, status: allergens.status, notes: allergens.notes },
    per_order_limit: Number(details.per_order_limit), surplus_priority: Number(details.surplus_priority), image_url: details.image_url || null,
    relist: { enabled: relist.enabled, qty: Number(relist.qty), cutoff_local: relist.cutoff_local || null },
  });

  async function upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    setBusy("upload");
    try {
      const res = await api<{ url: string }>("/api/merchant/assets", { body: form });
      setDetails((d) => ({ ...d, image_url: res.url }));
      setMessage({ tone: "success", text: "Photo uploaded. Save details to use it." });
    } catch (err) {
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function draftWithAi() {
    setBusy("draft");
    try {
      setDraft(await api(`/api/merchant/products/${row.product_id}/copy-draft`, { body: { notes: "" } }));
    } catch (err) {
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  function selectTab(key: TabKey) {
    setTab(key);
    if (key === "history" && !history) api<typeof history>(`/api/merchant/products/${row.product_id}/history`).then(setHistory).catch(() => {});
  }

  const saveProduct = (kind: "details" | "allergens", success: string) => (e: FormEvent) => {
    e.preventDefault();
    void run(kind, async () => (await api<{ row: InventoryRow }>(`/api/merchant/products/${row.product_id}`, { method: "PUT", body: productBody() })).row, success);
  };

  const formRow = { display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "flex-start", p: 2 } as const;
  const verification = VERIFICATION[row.allergens.status] ?? VERIFICATION.missing;

  return (
    <Box>
      <Stack direction="row" spacing={2} sx={{ ...panel, alignItems: "center" }}>
        <ProductImage image={row.image} size="sm" />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
            <AvailabilityChip row={row} />
            <StatusChip tone={verification.tone} icon={verification.icon} label={`Allergens ${verification.label.toLowerCase()}`} />
            {row.stale ? <StatusChip tone="warning" label="Stale count" /> : null}
          </Stack>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
            {row.category} · cutoff {row.cutoff_label}
            {row.price ? ` · ${money(row.price.sale_minor, row.price.currency)}` : ""}
          </Typography>
        </Box>
      </Stack>

      <Tabs
        value={tab}
        onChange={(_, value: TabKey) => selectTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        aria-label="Item sections"
        sx={{ mt: 2.5, position: "sticky", top: -20, zIndex: 1, bgcolor: surface.base, boxShadow: `inset 0 -1px 0 ${surface.hairline}` }}
      >
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} icon={<t.icon fontSize="small" />} iconPosition="start" id={`tab-${t.key}`} aria-controls={`panel-${t.key}`} sx={{ minWidth: 0, px: 1.75 }} />
        ))}
      </Tabs>

      {message ? (
        <Alert severity={message.tone === "success" ? "success" : "error"} role={message.tone === "danger" ? "alert" : "status"} sx={{ mt: 2 }}>
          {message.text}
        </Alert>
      ) : null}

      <TabPanel
        value="stock"
        active={tab}
        render={() => (
          <Stack spacing={2.5}>
            <StockBreakdown row={row} />
            <Card>
              <Stack sx={{ py: 0.5 }}>
                <Box
                  component="form"
                  sx={formRow}
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    void run("counter", () => update(row, { action: "counter_sale", delta: counterQty, reason: "Sold at the counter" }, undefined, `${counterQty} sold at the counter`), "Counter sale recorded.");
                  }}
                >
                  <TextField
                    size="small"
                    type="number"
                    label="Sold at the counter"
                    value={counterQty}
                    onChange={(e) => setCounterQty(Math.max(1, Number(e.target.value)))}
                    helperText={`${row.available} available to sell here`}
                    slotProps={{ htmlInput: { min: 1, max: Math.max(1, row.available) } }}
                    sx={{ width: 180 }}
                  />
                  <Button type="submit" variant="contained" loading={busy === "counter"} disabled={row.available < 1} sx={{ minHeight: 40 }}>
                    Record sale
                  </Button>
                  <Button variant="outlined" color="inherit" disabled={row.available < 1 || busy === "counter"} sx={{ minHeight: 40 }}
                    onClick={() => run("counter", () => update(row, { action: "counter_sale", delta: row.available, reason: "Sold out at the counter" }, undefined, "sold out"), "Marked sold out.")}>
                    Sold out
                  </Button>
                </Box>
                <Box
                  component="form"
                  sx={formRow}
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    void run("surplus", () => update(row, { action: "set", value: surplus, reason: "Set from item drawer" }, undefined, `surplus set to ${surplus}`), "Surplus updated.");
                  }}
                >
                  <TextField
                    size="small"
                    type="number"
                    label="Surplus listed"
                    value={surplus}
                    onChange={(e) => setSurplus(Number(e.target.value))}
                    helperText={`Minimum ${held}`}
                    slotProps={{ htmlInput: { min: held } }}
                    sx={{ width: 180 }}
                  />
                  <Button type="submit" variant="contained" loading={busy === "surplus"} aria-label="Save surplus" sx={{ minHeight: 40 }}>
                    Save
                  </Button>
                </Box>
                <Box
                  component="form"
                  sx={formRow}
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    void run("buffer", () => update(row, { action: "set_buffer", value: buffer, reason: "Reserve buffer" }), "Reserve buffer updated.");
                  }}
                >
                  <TextField
                    size="small"
                    type="number"
                    label="Reserve buffer"
                    value={buffer}
                    onChange={(e) => setBuffer(Number(e.target.value))}
                    helperText="Kept back for the counter"
                    slotProps={{ htmlInput: { min: 0 } }}
                    sx={{ width: 180 }}
                  />
                  <Button type="submit" variant="outlined" color="inherit" loading={busy === "buffer"} aria-label="Save reserve buffer" sx={{ minHeight: 40 }}>
                    Save
                  </Button>
                </Box>
                <Box
                  component="form"
                  sx={formRow}
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    void run("cutoff", () => update(row, { action: "set_cutoff", cutoff_local: cutoff, reason: "Pickup cutoff" }), "Pickup cutoff updated.");
                  }}
                >
                  <TextField
                    size="small"
                    type="time"
                    label="Pickup cutoff (today)"
                    value={cutoff}
                    onChange={(e) => setCutoff(e.target.value)}
                    helperText="Sell-by time you verified"
                    slotProps={{ inputLabel: { shrink: true } }}
                    sx={{ width: 180 }}
                  />
                  <Button type="submit" variant="outlined" color="inherit" loading={busy === "cutoff"} aria-label="Save pickup cutoff" sx={{ minHeight: 40 }}>
                    Save
                  </Button>
                </Box>
              </Stack>
            </Card>
            <Stack direction="row" spacing={2} sx={{ ...panel, alignItems: "center", justifyContent: "space-between" }}>
              <Box>
                <Typography variant="subtitle2" component="p">
                  Listing
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {isActive ? "Offered to shoppers" : "Hidden from shoppers"}
                </Typography>
              </Box>
              <Button
                variant={isActive ? "outlined" : "contained"}
                color={isActive ? "error" : "primary"}
                startIcon={isActive ? <PauseRounded /> : <PlayArrowRounded />}
                loading={busy === "pause"}
                onClick={() => run("pause", () => update(row, { action: isActive ? "pause" : "resume", reason: "Listing toggled" }), isActive ? "Listing paused." : "Listing resumed.")}
              >
                {isActive ? "Pause listing" : "Resume listing"}
              </Button>
            </Stack>
          </Stack>
        )}
      />

      <TabPanel
        value="details"
        active={tab}
        render={() => (
          <Box component="form" onSubmit={saveProduct("details", "Details saved.")}>
            {locked ? (
              <Alert severity="info" role="note" sx={{ mb: 2 }}>
                Editing details needs the manager role.
              </Alert>
            ) : null}
            <Box component="fieldset" disabled={locked} sx={fieldset}>
              <Stack spacing={2.25}>
                <TextField label="Name" value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} disabled={locked} fullWidth />
                <Box>
                  <TextField
                    label="Description"
                    multiline
                    minRows={3}
                    value={details.description}
                    onChange={(e) => setDetails({ ...details, description: e.target.value, description_source: details.description_source })}
                    helperText={details.description_source === "ai_draft_approved" ? "From an AI draft you approved" : "Written by the merchant"}
                    disabled={locked}
                    fullWidth
                  />
                  <Button size="small" variant="outlined" color="inherit" startIcon={<AutoAwesomeRounded />} loading={busy === "draft"} disabled={locked} onClick={draftWithAi} sx={{ mt: 1 }}>
                    Draft with AI
                  </Button>
                  {draft ? (
                    <Box sx={{ mt: 1.5, p: 2, borderRadius: "16px", bgcolor: tones.info.bg, boxShadow: shadows.insetSm }}>
                      <Typography variant="subtitle2" component="p" sx={{ display: "flex", alignItems: "center", gap: 0.75, color: tones.info.fg }}>
                        <AutoAwesomeRounded aria-hidden sx={{ fontSize: 18 }} />
                        {draft.source === "ai" ? "AI draft · review before using" : "Template draft · AI unavailable"}
                      </Typography>
                      <Typography variant="body2" sx={{ mt: 0.75 }}>
                        {draft.draft}
                      </Typography>
                      {draft.removed.length ? (
                        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
                          Removed: {draft.removed.join("; ")}
                        </Typography>
                      ) : null}
                      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                        Drafts can&apos;t add allergen or free-from claims. Nothing is published until you save.
                      </Typography>
                      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => {
                            setDetails({ ...details, description: draft.draft, description_source: draft.source === "ai" ? "ai_draft_approved" : "merchant" });
                            setDraft(null);
                          }}
                        >
                          Use this draft
                        </Button>
                        <Button size="small" color="inherit" onClick={() => setDraft(null)}>
                          Discard
                        </Button>
                      </Stack>
                    </Box>
                  ) : null}
                </Box>
                <TextField
                  label="Ingredients"
                  multiline
                  minRows={2}
                  value={details.ingredients}
                  onChange={(e) => setDetails({ ...details, ingredients: e.target.value })}
                  helperText="Shown to customers"
                  disabled={locked}
                  fullWidth
                />
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      select
                      fullWidth
                      label="Category"
                      value={details.category}
                      onChange={(e) => setDetails({ ...details, category: e.target.value })}
                      disabled={locked}
                      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                    >
                      {["pastry", "bread", "cookie", "cake", "savory"].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </TextField>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      select
                      fullWidth
                      label="Flavor"
                      value={details.flavor}
                      onChange={(e) => setDetails({ ...details, flavor: e.target.value })}
                      disabled={locked}
                      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                    >
                      <option>sweet</option>
                      <option>savory</option>
                    </TextField>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      type="number"
                      fullWidth
                      label="Servings per unit"
                      value={details.servings_per_unit}
                      onChange={(e) => setDetails({ ...details, servings_per_unit: Number(e.target.value) })}
                      disabled={locked}
                      slotProps={{ htmlInput: { step: "0.5", min: 0.5 } }}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      type="number"
                      fullWidth
                      label="Per-order limit"
                      value={details.per_order_limit}
                      onChange={(e) => setDetails({ ...details, per_order_limit: Number(e.target.value) })}
                      disabled={locked}
                      slotProps={{ htmlInput: { min: 1 } }}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      type="number"
                      fullWidth
                      label="Surplus priority (0–3)"
                      value={details.surplus_priority}
                      onChange={(e) => setDetails({ ...details, surplus_priority: Number(e.target.value) })}
                      helperText="Higher sells first in bundles"
                      disabled={locked}
                      slotProps={{ htmlInput: { min: 0, max: 3 } }}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      fullWidth
                      label="Tags"
                      value={details.tags}
                      onChange={(e) => setDetails({ ...details, tags: e.target.value })}
                      helperText="Comma separated"
                      disabled={locked}
                    />
                  </Grid>
                </Grid>
                <Box sx={panel}>
                  <Typography variant="subtitle2" component="p">
                    Photo
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="p">
                    Use a real photo of this product. Without one, shoppers see a plain placeholder, never a stock image.
                  </Typography>
                  <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mt: 1.25 }}>
                    <ProductImage image={{ ...row.image, url: details.image_url || null }} size="sm" />
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      id="photo-upload"
                      tabIndex={-1}
                      aria-label="Product photo file"
                      onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
                    />
                    <Button size="small" variant="outlined" color="inherit" startIcon={<UploadRounded />} loading={busy === "upload"} disabled={locked} onClick={() => fileRef.current?.click()}>
                      Upload photo
                    </Button>
                    {details.image_url ? (
                      <Button size="small" color="inherit" startIcon={<DeleteOutlineRounded />} disabled={locked} onClick={() => setDetails({ ...details, image_url: "" })}>
                        Remove
                      </Button>
                    ) : null}
                  </Stack>
                </Box>
                <Box sx={panel}>
                  <FormControlLabel
                    control={<Checkbox checked={relist.enabled} disabled={locked} onChange={(e) => setRelist({ ...relist, enabled: e.target.checked })} />}
                    label={<Typography variant="subtitle2" component="span">Repeat daily</Typography>}
                  />
                  <Typography variant="caption" color="text.secondary" component="p">
                    Re-list this item every day at your shop&apos;s listing time (Settings → Policies). Units owed to paid orders are kept on top.
                  </Typography>
                  {relist.enabled ? (
                    <Stack direction="row" spacing={1.5} sx={{ mt: 1.5 }}>
                      <TextField type="number" size="small" label="Daily quantity" value={relist.qty} disabled={locked}
                        onChange={(e) => setRelist({ ...relist, qty: Number(e.target.value) })} slotProps={{ htmlInput: { min: 0, max: 500 } }} sx={{ width: 150 }} />
                      <TextField type="time" size="small" label="Pickup cutoff" value={relist.cutoff_local} disabled={locked}
                        onChange={(e) => setRelist({ ...relist, cutoff_local: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 150 }} />
                    </Stack>
                  ) : null}
                </Box>
                <Box>
                  <Button type="submit" variant="contained" loading={busy === "details"} disabled={locked}>
                    Save details
                  </Button>
                </Box>
              </Stack>
            </Box>
          </Box>
        )}
      />

      <TabPanel
        value="allergens"
        active={tab}
        render={() => (
          <Box component="form" onSubmit={saveProduct("allergens", "Allergen information saved.")}>
            {locked ? (
              <Alert severity="info" role="note" sx={{ mb: 2 }}>
                Editing allergen data needs the manager role.
              </Alert>
            ) : null}
            <Alert severity="warning" role="note" sx={{ mb: 2.5 }}>
              Strict-allergy shoppers only see items verified here. Missing or uncertain data always excludes an item.
            </Alert>
            <Box component="fieldset" disabled={locked} sx={fieldset}>
              <Stack spacing={2.5}>
                <Box sx={panel}>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ fontWeight: 650, mb: 0.75 }}>
                    Current record
                  </Typography>
                  <AllergenTags allergens={row.allergens} />
                </Box>
                {(["contains", "cross_contact"] as const).map((group) => {
                  // Unchecked pills are raised; checked ones look pressed in, tinted by group.
                  const tint = group === "contains" ? brand.sand : tones.warning.bg;
                  return (
                    <FormControl key={group} component="fieldset" disabled={locked}>
                      <FormLabel component="legend" sx={{ fontWeight: 700, color: "text.primary", mb: 1, "&.Mui-focused": { color: "text.primary" } }}>
                        {group === "contains" ? "Contains" : "May contain (cross-contact)"}
                      </FormLabel>
                      <FormGroup row sx={{ gap: 1.25 }}>
                        {ALLERGENS.map((code) => {
                          const checked = allergens[group].includes(code);
                          return (
                            <FormControlLabel
                              key={code}
                              label={ALLERGEN_LABEL[code]}
                              control={
                                <Checkbox
                                  size="small"
                                  color={group === "contains" ? "secondary" : "warning"}
                                  checked={checked}
                                  onChange={(e) =>
                                    setAllergens((a) => ({ ...a, [group]: e.target.checked ? [...a[group], code] : a[group].filter((c) => c !== code) }))
                                  }
                                />
                              }
                              sx={{
                                ...(checked ? { ...surface.pressed, bgcolor: tint } : surface.raisedSm),
                                m: 0,
                                pr: 1.5,
                                minHeight: 38,
                                borderRadius: "99px",
                                "& .MuiFormControlLabel-label": { fontSize: "0.88rem", fontWeight: 600 },
                              }}
                            />
                          );
                        })}
                      </FormGroup>
                    </FormControl>
                  );
                })}
                <FormControl component="fieldset" disabled={locked}>
                  <FormLabel component="legend" sx={{ fontWeight: 700, color: "text.primary", mb: 0.5, "&.Mui-focused": { color: "text.primary" } }}>
                    Verification
                  </FormLabel>
                  <RadioGroup name="allergen-status" value={allergens.status} onChange={(e) => setAllergens((a) => ({ ...a, status: e.target.value as Allergens["status"] }))}>
                    <FormControlLabel value="verified" control={<Radio size="small" />} label="Verified by me against the recipe and supplier specs" />
                    <FormControlLabel value="needs_review" control={<Radio size="small" />} label="Needs review" />
                    <FormControlLabel value="missing" control={<Radio size="small" />} label="No information" />
                  </RadioGroup>
                </FormControl>
                <Grid container spacing={2}>
                  {(["vegetarian", "vegan"] as const).map((key) => (
                    <Grid key={key} size={{ xs: 12, sm: 6 }}>
                      <TextField
                        select
                        fullWidth
                        label={key === "vegan" ? "Vegan" : "Vegetarian"}
                        value={details[key] === null ? "" : String(details[key])}
                        onChange={(e) => setDetails({ ...details, [key]: e.target.value === "" ? null : e.target.value === "true" })}
                        disabled={locked}
                        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                      >
                        <option value="">Unknown</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </TextField>
                    </Grid>
                  ))}
                </Grid>
                <TextField label="Notes" value={allergens.notes} onChange={(e) => setAllergens({ ...allergens, notes: e.target.value })} disabled={locked} fullWidth />
                <Box>
                  <Button type="submit" variant="contained" loading={busy === "allergens"} disabled={locked}>
                    Save allergen information
                  </Button>
                </Box>
              </Stack>
            </Box>
          </Box>
        )}
      />

      <TabPanel
        value="price"
        active={tab}
        render={() => (
          <Box
            component="form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(
                "price",
                async () =>
                  (await api<{ row: InventoryRow }>(`/api/merchant/products/${row.product_id}/price`, {
                    body: { reference_minor: Math.round(price.reference * 100), sale_minor: Math.round(price.sale * 100), reference_source: price.source },
                  })).row,
                "Price saved. Shoppers with an open quote will be asked to approve it.",
              );
            }}
          >
            {locked ? (
              <Alert severity="info" role="note" sx={{ mb: 2 }}>
                Changing prices needs the manager role.
              </Alert>
            ) : null}
            <Box component="fieldset" disabled={locked} sx={fieldset}>
              <Stack spacing={2.25}>
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      type="number"
                      fullWidth
                      label="Regular (reference) price"
                      value={price.reference}
                      onChange={(e) => setPrice({ ...price, reference: Number(e.target.value) })}
                      disabled={locked}
                      slotProps={{ htmlInput: { step: "0.01", min: 0.01 }, input: { startAdornment: <InputAdornment position="start">$</InputAdornment> } }}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      type="number"
                      fullWidth
                      label="Surplus price"
                      value={price.sale}
                      onChange={(e) => setPrice({ ...price, sale: Number(e.target.value) })}
                      disabled={locked}
                      slotProps={{ htmlInput: { step: "0.01", min: 0.01 }, input: { startAdornment: <InputAdornment position="start">$</InputAdornment> } }}
                    />
                  </Grid>
                </Grid>
                <TextField
                  fullWidth
                  multiline
                  maxRows={3}
                  label="Where the regular price comes from"
                  value={price.source}
                  onChange={(e) => setPrice({ ...price, source: e.target.value })}
                  helperText="Required. Savings are only shown against a documented price."
                  disabled={locked}
                />
                <Box sx={panel}>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ fontWeight: 650, mb: 0.5 }}>
                    Shoppers see
                  </Typography>
                  <PriceTag price={Math.round(price.sale * 100)} reference={Math.round(price.reference * 100)} />
                  <Typography variant="body2" color="text.secondary" className="tabular" sx={{ mt: 0.75 }}>
                    Customers save {money(Math.max(0, Math.round((price.reference - price.sale) * 100)))} ({price.reference > 0 ? Math.round((1 - price.sale / price.reference) * 100) : 0}%)
                  </Typography>
                </Box>
                <Box>
                  <Button type="submit" variant="contained" loading={busy === "price"} disabled={locked}>
                    Save price
                  </Button>
                </Box>
              </Stack>
            </Box>
          </Box>
        )}
      />

      <TabPanel
        value="history"
        active={tab}
        render={() =>
          !history ? (
            <LoadingBlock label="Loading history" lines={4} />
          ) : (
            <Stack spacing={3}>
              <Box>
                <Typography variant="h5" component="h3" sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                  <HistoryRounded aria-hidden sx={{ fontSize: 20, color: brand.leaf }} />
                  Inventory events
                </Typography>
                {history.inventory_events.length ? (
                  <Box component="ol" sx={{ ...panel, my: 0, listStyle: "none", display: "grid", gap: 2 }}>
                    {history.inventory_events.map((e, i) => (
                      <Box component="li" key={`${e.at}-${i}`} sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
                        <DeltaBadge delta={e.delta} />
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" sx={{ fontWeight: 650, "&::first-letter": { textTransform: "uppercase" } }}>
                            {e.type.replaceAll("_", " ").toLowerCase()}
                            {e.delta ? (
                              <Box component="span" className="tabular" sx={{ fontWeight: 500, color: "text.secondary" }}>
                                {" "}· {e.before} → {e.after}
                              </Box>
                            ) : null}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" component="p">
                            {dateTimeLabel(e.at, zone)} · {e.actor} · {e.reason}
                          </Typography>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No inventory events yet.
                  </Typography>
                )}
              </Box>
              <Box>
                <Typography variant="h5" component="h3" sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                  <ReceiptLongRounded aria-hidden sx={{ fontSize: 20, color: brand.leaf }} />
                  Audit log
                </Typography>
                {history.audit.length ? (
                  <Box component="ol" sx={{ ...panel, my: 0, listStyle: "none", display: "grid", gap: 2 }}>
                    {history.audit.map((a, i) => (
                      <Box component="li" key={`${a.at}-${i}`}>
                        <Typography variant="body2" sx={{ fontWeight: 650, "&::first-letter": { textTransform: "uppercase" } }}>
                          {a.action.replaceAll("_", " ")}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" component="p">
                          {dateTimeLabel(a.at, zone)} · {a.actor}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No audit entries yet.
                  </Typography>
                )}
              </Box>
            </Stack>
          )
        }
      />
    </Box>
  );
}

function DeltaBadge({ delta }: { delta: number }) {
  const tone = delta > 0 ? tones.success : tones.neutral;
  return (
    <Box
      className="tabular"
      aria-hidden={delta === 0 || undefined}
      sx={{ minWidth: 44, height: 28, px: 0.75, display: "grid", placeItems: "center", borderRadius: "99px", bgcolor: tone.bg, color: tone.fg, fontWeight: 700, fontSize: "0.8rem", flexShrink: 0 }}
    >
      {delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : "·"}
    </Box>
  );
}

/** Re-list every "Repeat daily" product now, instead of waiting for the shop's listing time. */
function PublishListing({ onDone }: { onDone: () => void }) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function publish() {
    setBusy(true);
    try {
      const res = await api<{ relisted: number }>("/api/merchant/listings/publish", { body: {} });
      const text = res.relisted ? `Today's listing published: ${res.relisted} item${res.relisted === 1 ? "" : "s"} re-listed` : "No items are set to repeat daily yet";
      setNote(text);
      announce(text);
      onDone();
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      {note ? <Typography variant="caption" color="text.secondary" role="status">{note}</Typography> : null}
      <Button variant="outlined" color="inherit" startIcon={<UpdateRounded />} loading={busy} onClick={publish}>
        Publish today&apos;s listing
      </Button>
    </Stack>
  );
}
