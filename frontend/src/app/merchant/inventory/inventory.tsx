"use client";

// Today's surplus in one table you can work in: change the price, the count listed and whether it's on sale right in
// the row; a row with a problem (old count, allergens to review, no price) shows one chip and a one-tap fix. Counts
// save as you go. The full editor (details, allergens, price history) opens from the pencil.

import {
  AddRounded,
  AutoAwesomeRounded,
  CheckRounded,
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
  TrendingDownRounded,
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
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableRow,
  TableSortLabel,
  Tabs,
  TextField,
  Tooltip,
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
import { EmptyState, ErrorState, FactChip, FilterChip, LoadingBlock, PageHeader, StatusChip, brand, shadows, surface, tones, type Icon, type Tone } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { ALLERGEN_LABEL, ago, dateTimeLabel, money } from "@/lib/format";
import type { Allergens, InventoryRow } from "@/lib/types";
import { useShopZone } from "@/components/shop-zone";
import { useResource } from "@/lib/use-api";

import { AddProductButton } from "./add-product";

type Row = InventoryRow & { sold_today: number };
type Listing = {
  rows: Row[];
  as_of: string;
  timezone: string;
  schedule: { relist_label: string | null; pickup_until_label: string | null; pickup_paused: boolean };
};
type SortKey = "name" | "sold" | "left" | "listed";
type View = "all" | "attention" | "low" | "paused";
type TabKey = "stock" | "details" | "allergens" | "price" | "history";
type Update = (row: InventoryRow, body: Record<string, unknown>, optimistic?: Partial<InventoryRow>, label?: string) => Promise<InventoryRow | null>;

const ALLERGENS = ["tree_nuts", "peanuts", "milk", "eggs", "wheat", "soy", "sesame"];
const AVAILABILITY: Record<string, { tone: Tone; label: string; icon?: Icon }> = {
  available: { tone: "success", label: "Available" },
  low: { tone: "info", label: "Running low", icon: TrendingDownRounded },
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
// Categorical colors for the stock split (validated for CVD separation); buffer is a neutral.
const STOCK_PARTS = [
  { key: "available", label: "Available", color: brand.leaf },
  { key: "reserved", label: "Held", color: "#2A78D6" },
  { key: "committed", label: "Paid", color: "#E87BA4" },
  { key: "buffer", label: "Keep back", color: surface.edge },
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

/** The one thing to fix on a row, most important first, with what fixes it. */
type Problem = { tone: Tone; label: string; icon?: Icon; fix?: { label: string; icon: Icon; tab?: TabKey; confirm?: boolean } };
function problemOf(r: InventoryRow): Problem | null {
  if (r.status !== "active") return { tone: "neutral", label: "Paused", icon: PauseCircleRounded };
  if (r.allergens.status !== "verified") return { tone: "danger", label: "Allergen review", icon: HealthAndSafetyRounded, fix: { label: "Review allergens", icon: HealthAndSafetyRounded, tab: "allergens" } };
  if (r.availability_status === "unpriced") return { tone: "warning", label: "No price", icon: SellRounded, fix: { label: "Set price", icon: SellRounded, tab: "price" } };
  if (r.availability_status === "past_cutoff") return { tone: "danger", label: "Past cutoff", icon: ScheduleRounded, fix: { label: "Change cutoff", icon: ScheduleRounded, tab: "stock" } };
  if (r.stale) return { tone: "warning", label: `Counted ${ago(r.updated_at)}`, icon: UpdateRounded, fix: { label: "Count is right", icon: CheckRounded, confirm: true } };
  if (r.availability_status === "sold_out") return { tone: "neutral", label: "Sold out", icon: RemoveShoppingCartRounded };
  if (r.availability_status === "low") return { tone: "info", label: "Running low", icon: TrendingDownRounded };
  return null;
}
const needsAttention = (r: InventoryRow) => r.status === "active" && (r.allergens.status !== "verified" || r.stale || ["unpriced", "past_cutoff"].includes(r.availability_status));
const runningLow = (r: InventoryRow) => r.status === "active" && ["low", "sold_out"].includes(r.availability_status);

export function Inventory() {
  const announce = useAnnounce();
  const user = useStaff();
  const manager = hasRole(user, "manager");
  const inv = useResource((signal) => api<Listing>("/api/merchant/inventory", { signal }), [], { pollMs: 15_000 });
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [pending, setPending] = useState<Record<string, InventoryRow>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ row: InventoryRow; tab: TabKey } | null>(null);
  const compact = useMediaQuery((theme: Theme) => theme.breakpoints.down("lg"), { noSsr: true });

  // A row saved here comes back without today's sales; keep the count from the last listing.
  const all: Row[] = (inv.data?.rows ?? []).map((r) => (pending[r.product_id] ? { ...pending[r.product_id], sold_today: r.sold_today } : r));
  const sortValue = (r: Row) => (sort.key === "name" ? r.name.toLowerCase() : sort.key === "sold" ? r.sold_today : sort.key === "left" ? r.available : r.surplus);
  const rows = all
    .filter((r) => `${r.name} ${r.sku} ${r.category}`.toLowerCase().includes(query.trim().toLowerCase()))
    .filter((r) => view === "all" || (view === "attention" ? needsAttention(r) : view === "low" ? runningLow(r) : r.status !== "active"))
    .sort((a, b) => (sortValue(a) < sortValue(b) ? -1 : sortValue(a) > sortValue(b) ? 1 : 0) * sort.dir);
  const counts = { attention: all.filter(needsAttention).length, low: all.filter(runningLow).length, paused: all.filter((r) => r.status !== "active").length };
  const totals = rows.reduce((t, r) => ({ sold: t.sold + r.sold_today, held: t.held + r.reserved, left: t.left + r.available, listed: t.listed + r.surplus }),
                             { sold: 0, held: 0, left: 0, listed: 0 });

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

  const actions: RowActions = {
    adjust: (r, delta) => update(r, { action: "adjust", delta, reason: "Inline adjust" },
      { surplus: r.surplus + delta, available: Math.max(0, r.available + delta) }, `${r.surplus + delta} listed`),
    confirm: (r) => update(r, { action: "confirm", reason: "Count confirmed" }, { stale: false, updated_at: new Date().toISOString() }, "count confirmed"),
    setOnSale: (r, on) => update(r, { action: on ? "resume" : "pause", reason: "Listing toggled" }, { status: on ? "active" : "paused" }, on ? "back on sale" : "paused"),
    savePrice: async (r, saleMinor) => {
      if (!r.price) return false;
      setRowError((e) => ({ ...e, [r.product_id]: "" }));
      try {
        const res = await api<{ row: InventoryRow }>(`/api/merchant/products/${r.product_id}/price`, {
          body: { reference_minor: r.price.reference_minor, sale_minor: saleMinor, reference_source: r.price.reference_source },
        });
        setPending((p) => ({ ...p, [r.product_id]: res.row }));
        announce(`${r.name}: price ${money(saleMinor, r.price.currency)}.`);
        inv.reload();
        return true;
      } catch (err) {
        setRowError((e) => ({ ...e, [r.product_id]: errorMessage(err) }));
        return false;
      }
    },
    edit: (r, tab = "stock") => setEditing({ row: r, tab }),
  };

  function sortCell(key: SortKey, label: string, align: "left" | "right" | "center" = "left", help?: string) {
    const isActive = sort.key === key;
    const direction = isActive && sort.dir === -1 ? "desc" : "asc";
    const cell = (
      <TableSortLabel active={isActive} direction={direction} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1 }))}>
        {label}
      </TableSortLabel>
    );
    return (
      <TableCell align={align} sortDirection={isActive ? direction : false}>
        {help ? <Tooltip title={help}>{cell}</Tooltip> : cell}
      </TableCell>
    );
  }

  const schedule = inv.data?.schedule;
  const header = (
    <PageHeader
      eyebrow={user?.merchant?.name}
      title="Inventory"
      chips={schedule ? (
        <>
          {schedule.relist_label ? <FactChip icon={UpdateRounded} label={`Relists daily ${schedule.relist_label}`} /> : null}
          {schedule.pickup_paused ? <StatusChip tone="warning" icon={PauseCircleRounded} label="Pickup paused" />
            : schedule.pickup_until_label ? <FactChip icon={ScheduleRounded} label={`Pickup until ${schedule.pickup_until_label}`} /> : null}
        </>
      ) : undefined}
      actions={manager ? (
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

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ mb: 2, justifyContent: "space-between", alignItems: { md: "center" } }}>
        <Stack direction="row" spacing={1} useFlexGap role="group" aria-label="Show" sx={{ flexWrap: "wrap" }}>
          <FilterChip selected={view === "all"} onClick={() => setView("all")} label={<CountLabel label="All" count={all.length} />} />
          <FilterChip selected={view === "attention"} onClick={() => setView("attention")} icon={WarningAmberRounded} label={<CountLabel label="Needs attention" count={counts.attention} />} />
          <FilterChip selected={view === "low"} onClick={() => setView("low")} icon={TrendingDownRounded} label={<CountLabel label="Running low" count={counts.low} />} />
          <FilterChip selected={view === "paused"} onClick={() => setView("paused")} icon={PauseCircleRounded} label={<CountLabel label="Paused" count={counts.paused} />} />
        </Stack>
        <TextField
          size="small"
          placeholder="Search products"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{ htmlInput: { "aria-label": "Search products" }, input: { startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> } }}
          sx={{ width: { xs: "100%", md: 300 }, bgcolor: brand.paper }}
        />
      </Stack>

      <Card>
        {rows.length === 0 ? (
          <Box sx={{ p: { xs: 2, sm: 2.5 } }}>
            <EmptyState
              icon={SearchOffRounded}
              title={query || view !== "all" ? "No matching products" : "No products yet"}
              action={query || view !== "all" ? <Button variant="outlined" color="inherit" onClick={() => { setQuery(""); setView("all"); }}>Show all products</Button> : undefined}
            >
              {query || view !== "all" ? "Try a different search or filter." : "Add what you usually have left at the end of the day."}
            </EmptyState>
          </Box>
        ) : compact ? (
          <Box component="ul" sx={{ m: 0, p: { xs: 2, sm: 2.5 }, listStyle: "none", display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
            {rows.map((r) => <ItemCard key={r.product_id} r={r} manager={manager} error={rowError[r.product_id]} actions={actions} />)}
          </Box>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
            <Table
              size="small"
              className="tabular"
              sx={{
                minWidth: 1080,
                "& th, & td": { px: 1.5, verticalAlign: "middle" },
                "& th:first-of-type, & td:first-of-type": { pl: 3 },
                "& th:last-of-type, & td:last-of-type": { pr: 3 },
                "& tbody td": { py: 1.25 },
              }}
            >
              <caption className="sr-only">Today&apos;s surplus. Column headers sort the table; counts and prices save from each row.</caption>
              <TableHead>
                <TableRow>
                  {sortCell("name", "Item")}
                  <TableCell sx={{ width: 200 }}>Price</TableCell>
                  {sortCell("sold", "Sold", "right", "Sold today on LastCall")}
                  <TableCell align="right"><Tooltip title="In shoppers' checkouts right now"><span>On hold</span></Tooltip></TableCell>
                  {sortCell("left", "Left", "right", "Still free to sell")}
                  {sortCell("listed", "Listed", "center", "Units on the shelf for LastCall, including ones held or paid and waiting for pickup")}
                  <TableCell>On sale</TableCell>
                  <TableCell align="right"><span className="sr-only">Actions</span></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => <ItemRow key={r.product_id} r={r} manager={manager} error={rowError[r.product_id]} actions={actions} />)}
              </TableBody>
              <TableFooter>
                <TableRow sx={{ "& td, & th": { borderBottom: 0, color: "text.primary", fontSize: 14, fontWeight: 700, py: 1.5 } }}>
                  <TableCell component="th" scope="row">
                    {view === "all" && !query ? "Today" : "Shown"}{" "}
                    <Box component="span" sx={{ fontWeight: 500, color: "text.secondary" }}>· {rows.length === 1 ? "1 item" : `${rows.length} items`}</Box>
                  </TableCell>
                  <TableCell />
                  <TableCell align="right">{totals.sold}</TableCell>
                  <TableCell align="right">{totals.held}</TableCell>
                  <TableCell align="right" sx={{ fontSize: "18px !important" }}>{totals.left}</TableCell>
                  <TableCell align="center">{totals.listed}</TableCell>
                  <TableCell />
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </Box>
        )}
      </Card>

      <ItemDrawer
        row={editing?.row ?? null}
        tab={editing?.tab ?? "stock"}
        canManage={manager}
        onClose={() => setEditing(null)}
        onSaved={(row) => {
          setPending((p) => ({ ...p, [row.product_id]: row }));
          setEditing((e) => (e ? { ...e, row } : e));
          inv.reload();
        }}
        update={update}
      />
    </Box>
  );
}

// ----------------------------------------------------------------------------- row pieces

type RowActions = {
  adjust: (r: InventoryRow, delta: 1 | -1) => Promise<InventoryRow | null>;
  confirm: (r: InventoryRow) => Promise<InventoryRow | null>;
  setOnSale: (r: InventoryRow, on: boolean) => Promise<InventoryRow | null>;
  savePrice: (r: InventoryRow, saleMinor: number) => Promise<boolean>;
  edit: (r: InventoryRow, tab?: TabKey) => void;
};

function ItemRow({ r, manager, error, actions }: { r: Row; manager: boolean; error?: string; actions: RowActions }) {
  const problem = problemOf(r);
  return (
    <TableRow hover sx={r.status !== "active" ? { bgcolor: brand.cream } : undefined}>
      <TableCell>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <ProductImage image={r.image} category={r.category} size="sm" sx={{ width: 44, height: 44, flexShrink: 0 }} />
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <Typography sx={{ fontWeight: 650, fontSize: 15 }}>{r.name}</Typography>
              {problem ? <StatusChip tone={problem.tone} icon={problem.icon} label={problem.label} /> : null}
            </Stack>
            {error ? <RowError message={error} /> : null}
          </Box>
        </Stack>
      </TableCell>
      <TableCell><PriceEditor r={r} manager={manager} onSave={actions.savePrice} /></TableCell>
      <TableCell align="right">{r.sold_today}</TableCell>
      <TableCell align="right" sx={{ color: r.reserved ? "text.primary" : "text.secondary" }}>{r.reserved}</TableCell>
      <TableCell align="right">
        <Typography component="span" sx={{ fontSize: 20, fontWeight: 700, color: runningLow(r) ? tones.info.fg : "text.primary" }}>{r.available}</Typography>
      </TableCell>
      <TableCell align="center"><Stepper r={r} onAdjust={(d) => actions.adjust(r, d)} /></TableCell>
      <TableCell><OnSaleSwitch r={r} manager={manager} onChange={(on) => actions.setOnSale(r, on)} /></TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
        <Stack direction="row" spacing={0.75} sx={{ justifyContent: "flex-end", alignItems: "center" }}>
          <FixButton r={r} problem={problem} actions={actions} />
          <Tooltip title="Edit details, allergens and price">
            <IconButton aria-label={`Edit ${r.name}`} onClick={() => actions.edit(r)}><EditRounded fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
      </TableCell>
    </TableRow>
  );
}

/** Phone and tablet: one card per item with the same controls as a table row. */
function ItemCard({ r, manager, error, actions }: { r: Row; manager: boolean; error?: string; actions: RowActions }) {
  const problem = problemOf(r);
  return (
    <Box component="li" sx={{ ...(r.status !== "active" ? surface.inset : surface.raisedSm), borderRadius: "16px", p: 1.75, display: "grid", gap: 1.5 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
        <ProductImage image={r.image} category={r.category} size="sm" sx={{ width: 48, height: 48 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 650 }}>{r.name}</Typography>
          {problem ? <StatusChip tone={problem.tone} icon={problem.icon} label={problem.label} sx={{ mt: 0.5 }} /> : null}
        </Box>
        <IconButton aria-label={`Edit ${r.name}`} onClick={() => actions.edit(r)}><EditRounded fontSize="small" /></IconButton>
      </Stack>
      <Box component="dl" className="tabular" sx={{ m: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1 }}>
        {[["Sold", r.sold_today], ["On hold", r.reserved], ["Left", r.available]].map(([label, value]) => (
          <Box key={label}>
            <Typography component="dt" variant="caption" color="text.secondary">{label}</Typography>
            <Typography component="dd" sx={{ m: 0, fontWeight: 700, fontSize: label === "Left" ? 20 : 15 }}>{value}</Typography>
          </Box>
        ))}
      </Box>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="body2" color="text.secondary">Listed</Typography>
        <Stepper r={r} onAdjust={(d) => actions.adjust(r, d)} />
        <Box sx={{ ml: "auto" }}><OnSaleSwitch r={r} manager={manager} onChange={(on) => actions.setOnSale(r, on)} /></Box>
      </Stack>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <PriceEditor r={r} manager={manager} onSave={actions.savePrice} />
        <Box sx={{ ml: "auto" }}><FixButton r={r} problem={problem} actions={actions} /></Box>
      </Stack>
      {error ? <RowError message={error} /> : null}
    </Box>
  );
}

function RowError({ message }: { message: string }) {
  return (
    <Typography role="alert" variant="caption" component="p" sx={{ mt: 0.5, display: "flex", gap: 0.5, color: brand.danger, fontWeight: 650 }}>
      <ErrorOutlineRounded aria-hidden sx={{ fontSize: 15, mt: "1px", flexShrink: 0 }} />
      {message}
    </Typography>
  );
}

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

/** The units listed for LastCall. It can't go below what's held or paid. */
function Stepper({ r, onAdjust }: { r: InventoryRow; onAdjust: (delta: 1 | -1) => void }) {
  const held = r.reserved + r.committed;
  return (
    <Stack direction="row" role="group" aria-label={`Listed today, ${r.name}`}
      sx={{ display: "inline-flex", alignItems: "center", border: `1px solid ${brand.lineStrong}`, borderRadius: "10px", overflow: "hidden", bgcolor: brand.paper }}>
      <IconButton aria-label={`List one fewer ${r.name}`} disabled={r.surplus <= held} onClick={() => onAdjust(-1)} sx={{ borderRadius: 0, width: 38, height: 38 }}>
        <RemoveRounded fontSize="small" />
      </IconButton>
      <Typography component="span" className="tabular" sx={{ minWidth: 34, textAlign: "center", fontWeight: 700 }}>{r.surplus}</Typography>
      <IconButton aria-label={`List one more ${r.name}`} onClick={() => onAdjust(1)} sx={{ borderRadius: 0, width: 38, height: 38 }}>
        <AddRounded fontSize="small" />
      </IconButton>
    </Stack>
  );
}

function OnSaleSwitch({ r, manager, onChange }: { r: InventoryRow; manager: boolean; onChange: (on: boolean) => void }) {
  const control = (
    <Switch checked={r.status === "active"} disabled={!manager} onChange={(_, on) => onChange(on)}
      slotProps={{ input: { "aria-label": `On sale: ${r.name}` } }} />
  );
  return manager ? control : <Tooltip title="A manager can pause or resume a listing"><span>{control}</span></Tooltip>;
}

/** Sale price in place: Save appears once it changes; Enter saves, Escape puts it back. */
function PriceEditor({ r, manager, onSave }: { r: InventoryRow; manager: boolean; onSave: (r: InventoryRow, saleMinor: number) => Promise<boolean> }) {
  const current = r.price ? (r.price.sale_minor / 100).toFixed(2) : "";
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState(current);
  if (current !== base) {
    // The price changed elsewhere (or was just saved); start from the new one.
    setBase(current);
    setValue(current);
  }
  if (!r.price) return <Typography variant="body2" color="text.secondary">No price</Typography>;
  const was = r.price.reference_minor > r.price.sale_minor ? money(r.price.reference_minor, r.price.currency) : null;
  if (!manager) {
    return (
      <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
        <b>{money(r.price.sale_minor, r.price.currency)}</b>
        {was ? <Box component="span" sx={{ color: "text.secondary", ml: 1 }}>was {was}</Box> : null}
      </Typography>
    );
  }
  const cents = Math.round(Number(value) * 100);
  const dirty = value !== current && Number.isFinite(cents) && value.trim() !== "";
  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    if (!(await onSave(r, cents))) setValue(current);
    setBusy(false);
  }
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <TextField size="small" value={value} disabled={busy} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setValue(current);
        }}
        slotProps={{
          htmlInput: { inputMode: "decimal", "aria-label": `Sale price, ${r.name}`, className: "tabular" },
          input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
        }}
        sx={{ width: 96, "& input": { fontWeight: 650 }, ...(dirty ? { "& fieldset": { borderColor: `${brand.leaf} !important`, borderWidth: 2 } } : null) }} />
      {dirty ? (
        <Button size="small" variant="contained" loading={busy} onClick={save}>Save</Button>
      ) : was ? (
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>was {was}</Typography>
      ) : null}
    </Stack>
  );
}

function FixButton({ r, problem, actions }: { r: InventoryRow; problem: Problem | null; actions: RowActions }) {
  const [busy, setBusy] = useState(false);
  const fix = problem?.fix;
  if (!fix) return null;
  const FixIcon = fix.icon;
  return (
    <Button size="small" variant="outlined" color="inherit" loading={busy} startIcon={<FixIcon sx={{ color: tones[problem.tone].fg }} />}
      onClick={async () => {
        if (!fix.confirm) return actions.edit(r, fix.tab);
        setBusy(true);
        await actions.confirm(r);
        setBusy(false);
      }}>
      {fix.label}
    </Button>
  );
}

function AvailabilityChip({ row }: { row: InventoryRow }) {
  const s = AVAILABILITY[row.availability_status] ?? { tone: "neutral" as Tone, label: row.availability_status };
  return <StatusChip tone={s.tone} icon={s.icon} label={s.label} />;
}

// ----------------------------------------------------------------------------- item editor

function ItemDrawer({ row, tab, canManage, onClose, onSaved, update }: {
  row: InventoryRow | null; tab: TabKey; canManage: boolean; onClose: () => void; onSaved: (row: InventoryRow) => void; update: Update;
}) {
  return (
    <Dialog open={!!row} onClose={onClose} side title={row ? `Edit ${row.name}` : "Edit"} description={row ? row.sku : undefined}>
      {row ? <ItemEditor key={`${row.product_id}:${tab}`} row={row} initialTab={tab} canManage={canManage} onSaved={onSaved} update={update} /> : null}
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

function ItemEditor({ row, initialTab, canManage, onSaved, update }: {
  row: InventoryRow; initialTab: TabKey; canManage: boolean; onSaved: (row: InventoryRow) => void; update: Update;
}) {
  const announce = useAnnounce();
  const zone = useShopZone();
  const [tab, setTab] = useState<TabKey>(initialTab);
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
      <Tooltip title="Put every repeat-daily item back on sale now, instead of waiting for the daily relist">
        <Button variant="outlined" color="inherit" startIcon={<UpdateRounded />} loading={busy} onClick={publish}>
          Relist now
        </Button>
      </Tooltip>
    </Stack>
  );
}
