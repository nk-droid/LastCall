"use client";

// The five settings sections. Each one edits a draft the page keeps (so switching sections loses nothing),
// shows changed rows with their old value, and saves only the fields that changed from a sticky bar. Sending
// only what changed matters: some policy fields make shoppers re-accept at checkout.

import {
  BlockRounded,
  LockOpenRounded,
  PauseCircleRounded,
  VerifiedRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  InputAdornment,
  LinearProgress,
  Link,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useId, useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { TimelineToggle, WeekHoursTimeline, type TimelineView } from "@/components/pickup-timeline";
import { CLOSED_BY_MERCHANT, slotStatus, splitLabel } from "@/components/slot-status";
import { InfoTip, StatusChip, brand, surface, tones } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { hhmmLabel, money, plural } from "@/lib/format";
import type { Address, ShopPolicies, ShopSettings, Slot, Week, Weekday } from "@/lib/types";

export const WEEKDAYS: { key: Weekday; label: string; short: string }[] = [
  { key: "mon", label: "Monday", short: "Mon" }, { key: "tue", label: "Tuesday", short: "Tue" }, { key: "wed", label: "Wednesday", short: "Wed" },
  { key: "thu", label: "Thursday", short: "Thu" }, { key: "fri", label: "Friday", short: "Fri" }, { key: "sat", label: "Saturday", short: "Sat" },
  { key: "sun", label: "Sunday", short: "Sun" },
];

const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu"];

// ----------------------------------------------------------------------------- drafts

export type SectionKey = "profile" | "pickup" | "rules" | "policies" | "payouts";
export type Change = { label: string; detail?: string };

type ProfileDraft = {
  name: string; category: string; tagline: string; description: string; phone: string; support_email: string; timezone: string; address: Address;
};
type PickupDraft = { hours: Week; windows: Week; slot_minutes: number; capacity: number; relist_at_local: string };
type RulesDraft = {
  hold_minutes: number; max_units_per_order: number; cancellation_cutoff_minutes: number; no_show_policy: ShopPolicies["no_show_policy"];
  no_show_grace_minutes: number; low_stock_threshold: number; closeout_lead_minutes: number;
};
type TextKey = "cancellation_policy_text" | "refund_policy_text" | "dietary_disclosure_text" | "cross_contact_text"
  | "reference_price_policy_text" | "pickup_instructions" | "what_to_bring";
type PoliciesDraft = Record<TextKey, string>;
type MoneyDraft = { tax_percent: number; fee: number };

export type Drafts = { profile?: ProfileDraft; pickup?: PickupDraft; rules?: RulesDraft; policies?: PoliciesDraft; payouts?: MoneyDraft };

export type SectionProps<D> = {
  settings: ShopSettings;
  draft: D | undefined;
  setDraft: (draft: D | undefined) => void;
  /** A save from this section's bar: new settings, and the draft is done. */
  onSaved: (next: ShopSettings) => void;
  /** An instant change (pause pickup, connect PayPal, review policies) that leaves the draft alone. */
  onSettings: (next: ShopSettings) => void;
};

const profileOf = (s: ShopSettings): ProfileDraft => ({
  name: s.shop.name, category: s.shop.category, tagline: s.shop.tagline, description: s.shop.description, phone: s.shop.phone,
  support_email: s.shop.support_email ?? "", timezone: s.shop.timezone, address: s.shop.address,
});
const pickupOf = (s: ShopSettings): PickupDraft => ({
  hours: s.hours, windows: s.pickup.windows, slot_minutes: s.pickup.slot_minutes, capacity: s.pickup.capacity,
  relist_at_local: s.policies.relist_at_local ?? "06:00",
});
const rulesOf = (s: ShopSettings): RulesDraft => {
  const p = s.policies;
  return {
    hold_minutes: Math.round(p.reservation_ttl_seconds / 60), max_units_per_order: p.max_units_per_order,
    cancellation_cutoff_minutes: p.cancellation_cutoff_minutes, no_show_policy: p.no_show_policy, no_show_grace_minutes: p.no_show_grace_minutes,
    low_stock_threshold: p.low_stock_threshold, closeout_lead_minutes: p.closeout_lead_minutes ?? 60,
  };
};
const moneyOf = (s: ShopSettings): MoneyDraft => ({ tax_percent: (s.policies.tax_rates_bps?.bakery ?? 0) / 100, fee: s.policies.fees_minor / 100 });

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "—");
const mins = (v: unknown) => `${num(v)} min`;
const time = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? hhmmLabel(v) : "—");
const span = (w: [string, string] | null) => (w ? `${time(w[0])}–${time(w[1])}` : "off");
const zone = (v: unknown) => String(v).replace(/^(America|Pacific)\//, "").replace("_", " ");

type FieldSpec<D> = { key: keyof D; label: string; show?: (v: unknown) => string };

function diff<D>(a: D, b: D, fields: FieldSpec<D>[]): Change[] {
  return fields.filter((f) => !same(a[f.key], b[f.key]))
    .map((f) => ({ label: f.label, detail: f.show ? `${f.show(a[f.key])} → ${f.show(b[f.key])}` : undefined }));
}

/** For a row: false when unchanged, the old value ("Was 30 min") when it can be shown, otherwise just "Edited". */
function wasOf<D>(base: D, value: D) {
  return (key: keyof D, show?: (v: unknown) => string): string | boolean => (same(base[key], value[key]) ? false : show ? show(base[key]) : true);
}

const PROFILE_FIELDS: FieldSpec<ProfileDraft>[] = [
  { key: "name", label: "Shop name" }, { key: "category", label: "Category" }, { key: "tagline", label: "Tagline" },
  { key: "description", label: "About" }, { key: "address", label: "Address" }, { key: "timezone", label: "Time zone", show: zone },
  { key: "phone", label: "Phone" }, { key: "support_email", label: "Support email" },
];

const NO_SHOW: { value: RulesDraft["no_show_policy"]; label: string }[] = [
  { value: "hold_for_review", label: "Hold for staff review" },
  { value: "auto_refund", label: "Refund automatically" },
  { value: "auto_cancel_no_refund", label: "Cancel without refund" },
];
const noShow = (v: unknown) => NO_SHOW.find((o) => o.value === v)?.label ?? String(v);

const RULE_FIELDS: FieldSpec<RulesDraft>[] = [
  { key: "hold_minutes", label: "Checkout hold", show: mins },
  { key: "max_units_per_order", label: "Max items", show: num },
  { key: "cancellation_cutoff_minutes", label: "Cancellation cutoff", show: mins },
  { key: "no_show_policy", label: "Missed pickup", show: noShow },
  { key: "no_show_grace_minutes", label: "Grace period", show: mins },
  { key: "low_stock_threshold", label: "Low-stock alert", show: num },
  { key: "closeout_lead_minutes", label: "Close-out plan", show: mins },
];

const POLICY_ROWS: { label: string; help: string; texts: { key: TextKey; label: string }[] }[] = [
  { label: "Cancellations", help: "Shown before checkout and on the pickup pass", texts: [{ key: "cancellation_policy_text", label: "Cancellation policy" }] },
  { label: "Refunds", help: "When and how refunds are made", texts: [{ key: "refund_policy_text", label: "Refund policy" }] },
  {
    label: "Allergens", help: "How you check allergen info, and any shared equipment",
    texts: [{ key: "dietary_disclosure_text", label: "How it's checked" }, { key: "cross_contact_text", label: "Shared equipment" }],
  },
  { label: "Reference prices", help: "What “regular price” means at your shop", texts: [{ key: "reference_price_policy_text", label: "Reference prices" }] },
  {
    label: "Pickup", help: "Where to go, who to ask and what to bring",
    texts: [{ key: "pickup_instructions", label: "Pickup instructions" }, { key: "what_to_bring", label: "What to bring" }],
  },
];
const TEXT_FIELDS: FieldSpec<PoliciesDraft>[] = POLICY_ROWS.flatMap((r) => r.texts.map((t) => ({ key: t.key, label: t.label })));
const policiesOf = (s: ShopSettings): PoliciesDraft =>
  Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, String(s.policies[f.key] ?? "")])) as PoliciesDraft;

const MONEY_FIELDS: FieldSpec<MoneyDraft>[] = [
  { key: "tax_percent", label: "Sales tax", show: (v) => `${num(v)}%` },
  { key: "fee", label: "Service fee", show: (v) => (typeof v === "number" && Number.isFinite(v) ? money(Math.round(v * 100)) : "—") },
];

function pickupChanges(a: PickupDraft, b: PickupDraft): Change[] {
  const days: Change[] = [];
  for (const d of WEEKDAYS) {
    if (!same(a.windows[d.key], b.windows[d.key])) days.push({ label: `${d.short} pickup`, detail: `${span(a.windows[d.key])} → ${span(b.windows[d.key])}` });
    if (!same(a.hours[d.key], b.hours[d.key])) days.push({ label: `${d.short} hours`, detail: `${span(a.hours[d.key])} → ${span(b.hours[d.key])}` });
  }
  return [...days, ...diff(a, b, [
    { key: "slot_minutes", label: "Slot length", show: mins },
    { key: "capacity", label: "Orders per slot", show: num },
    { key: "relist_at_local", label: "Daily relist", show: time },
  ])];
}

/** What's unsaved in a section, for its sticky bar and the "Unsaved" badge in the section list. */
export function changesFor(key: SectionKey, s: ShopSettings, d: Drafts): Change[] {
  switch (key) {
    case "profile": return d.profile ? diff(profileOf(s), d.profile, PROFILE_FIELDS) : [];
    case "pickup": return d.pickup ? pickupChanges(pickupOf(s), d.pickup) : [];
    case "rules": return d.rules ? diff(rulesOf(s), d.rules, RULE_FIELDS) : [];
    case "policies": return d.policies ? diff(policiesOf(s), d.policies, TEXT_FIELDS) : [];
    case "payouts": return d.payouts ? diff(moneyOf(s), d.payouts, MONEY_FIELDS) : [];
  }
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The owner's review counts only for the policy version they saw. */
export function reviewState(s: ShopSettings): { label: string; current: boolean } {
  const v = s.shop.verification;
  if (!v.policies_confirmed_at) return { label: "Not reviewed", current: false };
  if ((v.policies_version ?? s.policy_version) !== s.policy_version) return { label: "Changed since review", current: false };
  return { label: `Reviewed ${shortDate(v.policies_confirmed_at)}`, current: true };
}

// ----------------------------------------------------------------------------- building blocks

function Panel({ title, subtitle, action, changes, editable, note, saveLabel, saved, save, onSaved, onDiscard, children }: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  changes: Change[];
  editable: boolean;
  note?: string | false;
  saveLabel: string;
  saved: string;
  save: () => Promise<ShopSettings>;
  onSaved: (next: ShopSettings) => void;
  onDiscard: () => void;
  children: (errors: Record<string, string>) => ReactNode;
}) {
  const announce = useAnnounce();
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const n = changes.length;

  async function submit() {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      onSaved(await save());
      announce(saved);
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") {
        const f = err.fieldErrors();
        setFields(f);
        setError(Object.keys(f).length ? "Some fields need fixing." : err.message);
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    onDiscard();
    setFields({});
    setError(null);
  }

  const summary = changes.slice(0, 2).map((c) => (c.detail ? `${c.label} ${c.detail}` : c.label)).join(" · ") + (n > 2 ? ` · +${n - 2} more` : "");
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ ...surface.raised, borderRadius: "16px" }}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ px: { xs: 2.5, sm: 3.5 }, pt: { xs: 2.5, sm: 2.75 }, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Box sx={{ flex: "1 1 260px", minWidth: 0 }}>
          <Typography id={headingId} variant="h3" component="h2">{title}</Typography>
          <Typography variant="body2" color="text.secondary">{subtitle}</Typography>
        </Box>
        {action ? <Box sx={{ ml: "auto" }}>{action}</Box> : null}
      </Stack>
      <Box sx={{ px: { xs: 2.5, sm: 3.5 }, pb: 2.5 }}>
        {error ? <Alert severity="error" role="alert" sx={{ mt: 2 }}>{error}</Alert> : null}
        {children(fields)}
      </Box>
      {editable ? (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{
          position: "sticky", bottom: 0, zIndex: 2, alignItems: "center", flexWrap: "wrap", px: { xs: 2.5, sm: 3.5 }, py: 1.75,
          borderTop: `1px solid ${brand.line}`, bgcolor: brand.paper, borderRadius: "0 0 16px 16px",
        }}>
          <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, bgcolor: n ? brand.warningText : brand.leaf }} />
          <Box sx={{ mr: "auto", minWidth: 0, flex: "1 1 240px" }}>
            <Typography variant="body2" sx={{ fontWeight: 650 }}>
              {n ? plural(n, "unsaved change") : "No unsaved changes"}
              {n ? <Box component="span" sx={{ fontWeight: 400, color: "text.secondary" }}> · {summary}</Box> : null}
            </Typography>
            {n && note ? <Typography variant="caption" color="text.secondary">{note}</Typography> : null}
          </Box>
          <Button variant="outlined" color="inherit" disabled={!n || busy} onClick={discard}>Discard</Button>
          <Button variant="contained" disabled={!n} loading={busy} onClick={submit}>{saveLabel}</Button>
        </Stack>
      ) : null}
    </Box>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ mt: 2.5 }}>
      <Typography variant="overline" component="h3" color="text.secondary" sx={{ display: "block" }}>{title}</Typography>
      {children}
    </Box>
  );
}

/** One setting: name and a line of help on the left, a compact control on the right (or below, when `stacked`). */
function Row({ label, help, was = false, badge, stacked, children }: {
  label: string; help?: ReactNode; was?: string | boolean; badge?: ReactNode; stacked?: boolean; children: ReactNode;
}) {
  return (
    <Box sx={{
      display: "flex", flexDirection: stacked ? "column" : "row", flexWrap: "wrap", alignItems: stacked ? "stretch" : "center",
      gap: stacked ? 1 : 2, minHeight: 64, py: 1.25, borderBottom: `1px solid ${brand.line}`,
      ...(was ? { bgcolor: brand.mint, mx: -1.5, px: 1.5, borderRadius: "10px" } : null),
    }}>
      <Box sx={{ flex: stacked ? "none" : "1 1 240px", minWidth: 0 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography sx={{ fontWeight: 600 }}>{label}</Typography>
          {badge}
          {was ? (
            <Chip size="small" label={typeof was === "string" ? `Was ${was}` : "Edited"}
              sx={{ height: 22, bgcolor: brand.paper, color: brand.leafDark, border: `1px solid ${tones.success.border}`, fontWeight: 600 }} />
          ) : null}
        </Stack>
        {help ? <Typography variant="body2" color="text.secondary">{help}</Typography> : null}
      </Box>
      <Box sx={{ flex: "none", maxWidth: "100%", ...(stacked ? { width: "100%" } : null) }}>{children}</Box>
    </Box>
  );
}

function NumberInput({ label, value, onChange, unit, prefix, min, max, step, width = 150, disabled, error }: {
  label: string; value: number; onChange: (v: number) => void; unit?: string; prefix?: string; min?: number; max?: number; step?: number;
  width?: number; disabled?: boolean; error?: string;
}) {
  return (
    <TextField type="number" size="small" value={Number.isFinite(value) ? value : ""} disabled={disabled} error={!!error} helperText={error}
      onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      slotProps={{
        htmlInput: { min, max, step, "aria-label": label, className: "tabular" },
        input: {
          startAdornment: prefix ? <InputAdornment position="start">{prefix}</InputAdornment> : undefined,
          endAdornment: unit ? <InputAdornment position="end">{unit}</InputAdornment> : undefined,
        },
      }}
      sx={{ width: { xs: "100%", sm: width } }} />
  );
}

function TextInput({ label, value, onChange, width = 360, disabled, error, type, multiline, maxLength, autoComplete, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; width?: number | "100%"; disabled?: boolean; error?: string; type?: string;
  multiline?: boolean; maxLength?: number; autoComplete?: string; placeholder?: string;
}) {
  return (
    <TextField size="small" type={type} value={value} disabled={disabled} error={!!error} helperText={error} multiline={multiline}
      minRows={multiline ? 2 : undefined} autoComplete={autoComplete} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
      slotProps={{ htmlInput: { "aria-label": label, maxLength } }} sx={{ width: width === "100%" ? "100%" : { xs: "100%", sm: width } }} />
  );
}

function SelectInput<V extends string | number>({ label, value, onChange, options, width = 230, disabled, error }: {
  label: string; value: V; onChange: (v: V) => void; options: { value: V; label: string }[]; width?: number; disabled?: boolean; error?: string;
}) {
  return (
    <TextField select size="small" value={value} disabled={disabled} error={!!error} helperText={error}
      onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)?.value ?? value)}
      slotProps={{ htmlInput: { "aria-label": label } }} sx={{ width: { xs: "100%", sm: width } }}>
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );
}

function TimeInput({ label, value, onChange, disabled, width = 136 }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; width?: number }) {
  return (
    <TextField type="time" size="small" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      slotProps={{ htmlInput: { "aria-label": label, step: 300 } }} sx={{ width }} />
  );
}

/** A request whose only job is to swap in fresh settings: pause pickup, connect PayPal, mark policies reviewed. */
function useInstant(onSettings: (next: ShopSettings) => void) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function run(path: string, method: "PUT" | "POST", body: unknown, message: string) {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      onSettings(await api<ShopSettings>(path, { method, body }));
      announce(message);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error" && Object.keys(err.fieldErrors()).length) setFields(err.fieldErrors());
      else setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, fields, run };
}

// ----------------------------------------------------------------------------- shop profile

export function ProfileSection({ settings, draft, setDraft, onSaved }: SectionProps<ProfileDraft>) {
  const base = profileOf(settings);
  const v = draft ?? base;
  const was = wasOf(base, v);
  const set = (patch: Partial<ProfileDraft>) => setDraft({ ...v, ...patch });
  const setAddress = (patch: Partial<Address>) => set({ address: { ...v.address, ...patch } });
  const live = settings.shop.status === "live";
  const disabled = !settings.can_edit;
  return (
    <Panel title="Shop profile" subtitle="Shown on your storefront, receipts and pickup pass." changes={diff(base, v, PROFILE_FIELDS)}
      editable={settings.can_edit} saveLabel="Save profile" saved="Shop profile saved" onSaved={onSaved} onDiscard={() => setDraft(undefined)}
      save={() => api<ShopSettings>("/api/merchant/shop/profile", { method: "PUT", body: { ...v, support_email: v.support_email.trim() || null } })}>
      {(f) => (
        <>
          <Group title="Storefront">
            <Row label="Shop name" was={was("name")}>
              <TextInput label="Shop name" value={v.name} onChange={(name) => set({ name })} disabled={disabled} error={f.name} autoComplete="organization" />
            </Row>
            <Row label="Category" help="Helps shoppers find you" was={was("category")}>
              <Autocomplete freeSolo size="small" options={settings.category_suggestions} value={v.category} disabled={disabled}
                onInputChange={(_, category) => { if (category !== v.category) set({ category }); }} sx={{ width: { xs: "100%", sm: 360 } }}
                renderInput={(params) => (
                  <TextField {...params} error={!!f.category} helperText={f.category}
                    slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, "aria-label": "Category" } }} />
                )} />
            </Row>
            <Row label="Tagline" help="One line under your shop name" was={was("tagline")}>
              <TextInput label="Tagline" value={v.tagline} onChange={(tagline) => set({ tagline })} disabled={disabled} maxLength={200} width={420} />
            </Row>
            <Row stacked label="About your surplus" help="When you list leftovers and what shoppers can expect" was={was("description")}>
              <TextInput multiline label="About your surplus" value={v.description} onChange={(description) => set({ description })}
                disabled={disabled} maxLength={1200} width="100%" />
            </Row>
          </Group>

          <Group title="Location">
            <Row stacked label="Address" was={was("address")}>
              <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr 1fr", md: "2fr 1.3fr 0.6fr 0.8fr" } }}>
                <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" } }}>
                  <TextInput label="Street address" placeholder="Street address" value={v.address.line1} onChange={(line1) => setAddress({ line1 })}
                    disabled={disabled} autoComplete="address-line1" width="100%" error={f["address.line1"]} />
                </Box>
                <TextInput label="City" placeholder="City" value={v.address.city} onChange={(city) => setAddress({ city })} disabled={disabled}
                  autoComplete="address-level2" width="100%" error={f["address.city"]} />
                <TextInput label="State" placeholder="State" value={v.address.region} onChange={(region) => setAddress({ region })} disabled={disabled}
                  autoComplete="address-level1" width="100%" />
                <TextInput label="ZIP code" placeholder="ZIP" value={v.address.postal_code} onChange={(postal_code) => setAddress({ postal_code })}
                  disabled={disabled} autoComplete="postal-code" width="100%" />
              </Box>
            </Row>
            <Row label="Time zone" help={live ? "Fixed once your shop is live" : "Pickup times use this zone"} was={was("timezone", zone)}>
              <SelectInput label="Time zone" value={v.timezone} onChange={(timezone) => set({ timezone })} disabled={disabled || live} error={f.timezone}
                options={(TIMEZONES.includes(v.timezone) ? TIMEZONES : [v.timezone, ...TIMEZONES]).map((tz) => ({ value: tz, label: zone(tz) }))} />
            </Row>
          </Group>

          <Group title="Contact">
            <Row label="Phone" help="On your storefront" was={was("phone")}>
              <TextInput label="Phone" type="tel" value={v.phone} onChange={(phone) => set({ phone })} disabled={disabled} autoComplete="tel" width={230} />
            </Row>
            <Row label="Support email" help="For customers who need help with an order" was={was("support_email")}>
              <TextInput label="Support email" type="email" value={v.support_email} onChange={(support_email) => set({ support_email })}
                disabled={disabled} error={f.support_email} autoComplete="email" />
            </Row>
          </Group>
        </>
      )}
    </Panel>
  );
}

// ----------------------------------------------------------------------------- hours and pickup

export function PickupSection({ settings, draft, setDraft, onSaved, onSettings }: SectionProps<PickupDraft>) {
  const base = pickupOf(settings);
  const v = draft ?? base;
  const was = wasOf(base, v);
  const set = (patch: Partial<PickupDraft>) => setDraft({ ...v, ...patch });
  const disabled = !settings.can_edit;
  const weekChanged = !same(base.hours, v.hours) || !same(base.windows, v.windows);

  async function save() {
    let next = settings;
    if (weekChanged || v.slot_minutes !== base.slot_minutes || v.capacity !== base.capacity) {
      next = await api<ShopSettings>("/api/merchant/shop/hours", {
        method: "PUT", body: { hours: v.hours, pickup: { windows: v.windows, slot_minutes: v.slot_minutes, capacity: v.capacity } },
      });
    }
    if (v.relist_at_local !== base.relist_at_local) {
      next = await api<ShopSettings>("/api/merchant/shop/policies", { method: "PATCH", body: { relist_at_local: v.relist_at_local } });
    }
    return next;
  }

  return (
    <Panel title="Hours & pickup" subtitle="Pickup slots are made from these windows. Booked slots keep their time." changes={pickupChanges(base, v)}
      editable={settings.can_edit} saveLabel="Save hours" saved="Hours and pickup saved" save={save} onSaved={onSaved} onDiscard={() => setDraft(undefined)}
      action={<PauseSwitch settings={settings} onSettings={onSettings} />}>
      {(f) => (
        <>
          <Group title="Week">
            <WeekEditor value={v} base={base} disabled={disabled} errors={f} changed={weekChanged} onChange={set} />
          </Group>
          <Group title="Slots">
            <Row label="Slot length" help="How long each pickup slot lasts" was={was("slot_minutes", mins)}>
              <SelectInput label="Slot length" value={v.slot_minutes} onChange={(slot_minutes) => set({ slot_minutes })} disabled={disabled} width={150}
                options={[15, 30, 60].map((m) => ({ value: m, label: `${m} minutes` }))} />
            </Row>
            <Row label="Orders per slot" help="How many pickups staff can hand off in one slot" was={was("capacity", num)}>
              <NumberInput label="Orders per slot" value={v.capacity} onChange={(capacity) => set({ capacity })} unit="orders" min={0} max={100}
                disabled={disabled} error={f["pickup.capacity"]} />
            </Row>
            <Row label="Daily relist" help="“Repeat daily” products go back on sale at this time" was={was("relist_at_local", time)}>
              <TimeInput label="Daily relist time" value={v.relist_at_local} onChange={(relist_at_local) => set({ relist_at_local })}
                disabled={disabled} width={150} />
            </Row>
          </Group>
        </>
      )}
    </Panel>
  );
}

function PauseSwitch({ settings, onSettings }: { settings: ShopSettings; onSettings: (next: ShopSettings) => void }) {
  const { busy, error, run } = useInstant(onSettings);
  const paused = settings.pickup_paused;
  if (!settings.can_edit) return paused ? <StatusChip tone="warning" icon={PauseCircleRounded} label="Pickup paused" /> : null;
  return (
    <Stack sx={{ alignItems: "flex-end" }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <Typography variant="body2" aria-hidden sx={{ fontWeight: 650, color: paused ? tones.warning.fg : undefined }}>
          {paused ? "Pickup paused" : "Taking pickups"}
        </Typography>
        <Switch checked={!paused} disabled={busy} slotProps={{ input: { "aria-label": "Taking pickups" } }}
          onChange={(_, on) => run("/api/merchant/shop/pickup-paused", "PUT", { paused: !on }, on ? "Pickup resumed" : "Pickup paused")} />
      </Stack>
      {error ? <Typography variant="caption" color="error" role="alert">{error}</Typography> : null}
    </Stack>
  );
}

function WeekEditor({ value, base, disabled, errors, changed, onChange }: {
  value: PickupDraft; base: PickupDraft; disabled: boolean; errors: Record<string, string>; changed: boolean; onChange: (patch: Partial<PickupDraft>) => void;
}) {
  const [view, setView] = useState<TimelineView>("timeline");
  const { hours, windows } = value;
  const weekErrors = Object.keys(errors).some((k) => k.startsWith("hours.") || k.startsWith("pickup.windows."));

  function setTime(kind: "hours" | "windows", day: Weekday, index: 0 | 1, time: string) {
    const week = value[kind];
    const current = week[day] ?? (kind === "windows" ? ["16:00", "19:00"] : ["07:00", "19:00"]);
    const next: Week = { ...week, [day]: index === 0 ? [time, current[1]] : [current[0], time] };
    onChange(kind === "hours" ? { hours: next } : { windows: next });
  }
  function toggleDay(day: Weekday, open: boolean) {
    onChange({
      windows: { ...windows, [day]: open ? (base.windows[day] ?? ["16:00", "19:00"]) : null },
      hours: { ...hours, [day]: open ? (hours[day] ?? base.hours[day] ?? ["07:00", "19:00"]) : hours[day] },
    });
  }

  return (
    <Box sx={{ pt: 0.5 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} useFlexGap sx={{ mb: 2, alignItems: { sm: "center" } }}>
        <TimelineToggle value={view} onChange={setView} listLabel="Table" />
        {changed ? <Chip size="small" label="Edited" sx={{ height: 22, bgcolor: brand.mint, color: brand.leafDark, fontWeight: 600 }} /> : null}
        <Typography variant="caption" color="text.secondary" sx={{ ml: { sm: "auto" } }}>
          {view === "timeline"
            ? disabled ? "The band is opening hours; the green pill is the pickup window." : "Drag a band or pill to move it, or drag an end to change the time."
            : "Turn pickup on or off for each day, or type exact times."}
        </Typography>
      </Stack>
      {view === "timeline" ? (
        <WeekHoursTimeline hours={hours} windows={windows} disabled={disabled}
          onChange={(kind, day, next) => onChange(kind === "hours" ? { hours: { ...hours, [day]: next } } : { windows: { ...windows, [day]: next } })} />
      ) : (
        <Box sx={{ overflowX: "auto", mx: { xs: -2.5, sm: -3.5 } }}>
          <Table size="small" sx={{ minWidth: 820, "& th:first-of-type, & td:first-of-type": { pl: { xs: 2.5, sm: 3.5 } }, "& th:last-of-type, & td:last-of-type": { pr: { xs: 2.5, sm: 3.5 } } }}>
            <caption className="sr-only">Opening hours and pickup windows for each day</caption>
            <TableHead>
              <TableRow>
                <TableCell>Day</TableCell>
                <TableCell>Pickup</TableCell>
                <TableCell>Pickup window</TableCell>
                <TableCell>Shop hours</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {WEEKDAYS.map(({ key, label }) => {
                const win = windows[key];
                const h = hours[key];
                const err = errors[`pickup.windows.${key}`] ?? errors[`hours.${key}`];
                return (
                  <TableRow key={key}>
                    <TableCell sx={{ fontWeight: 650 }}>{label}</TableCell>
                    <TableCell>
                      <Switch checked={!!win} disabled={disabled} onChange={(e) => toggleDay(key, e.target.checked)} slotProps={{ input: { "aria-label": `Pickup on ${label}` } }} />
                    </TableCell>
                    <TableCell>
                      {win ? (
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          <TimeInput label={`${label} pickup from`} value={win[0]} disabled={disabled} onChange={(t) => setTime("windows", key, 0, t)} />
                          <Typography aria-hidden color="text.secondary">–</Typography>
                          <TimeInput label={`${label} pickup until`} value={win[1]} disabled={disabled} onChange={(t) => setTime("windows", key, 1, t)} />
                        </Stack>
                      ) : (
                        <Typography variant="body2" color="text.secondary">No pickup</Typography>
                      )}
                      {err ? <Typography variant="caption" color="error" role="alert">{err}</Typography> : null}
                    </TableCell>
                    <TableCell>
                      {h ? (
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          <TimeInput label={`${label} opens`} value={h[0]} disabled={disabled} onChange={(t) => setTime("hours", key, 0, t)} />
                          <Typography aria-hidden color="text.secondary">–</Typography>
                          <TimeInput label={`${label} closes`} value={h[1]} disabled={disabled} onChange={(t) => setTime("hours", key, 1, t)} />
                        </Stack>
                      ) : (
                        <Button size="small" disabled={disabled} onClick={() => onChange({ hours: { ...hours, [key]: ["07:00", "19:00"] } })}>Set hours</Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      )}
      {view === "timeline" && weekErrors ? (
        <Alert severity="error" role="alert" sx={{ mt: 2 }}>Some times need fixing. Switch to the table to see which day.</Alert>
      ) : null}
    </Box>
  );
}

// ----------------------------------------------------------------------------- order rules

export function RulesSection({ settings, draft, setDraft, onSaved }: SectionProps<RulesDraft>) {
  const base = rulesOf(settings);
  const v = draft ?? base;
  const was = wasOf(base, v);
  const set = (patch: Partial<RulesDraft>) => setDraft({ ...v, ...patch });
  const disabled = !settings.can_edit;
  const closeoutOn = settings.policies.closeout_enabled ?? true;
  const reaccept = v.cancellation_cutoff_minutes !== base.cancellation_cutoff_minutes || v.no_show_policy !== base.no_show_policy;

  function save() {
    const body: Record<string, unknown> = {};
    for (const f of RULE_FIELDS) {
      if (same(base[f.key], v[f.key])) continue;
      if (f.key === "hold_minutes") body.reservation_ttl_seconds = v.hold_minutes * 60;
      else body[f.key] = v[f.key];
    }
    return api<ShopSettings>("/api/merchant/shop/policies", { method: "PATCH", body });
  }

  return (
    <Panel title="Order rules" subtitle="How orders behave from checkout to pickup." changes={diff(base, v, RULE_FIELDS)} editable={settings.can_edit}
      note={reaccept && "Shoppers re-accept your policies at their next checkout."} saveLabel="Save rules" saved="Order rules saved"
      save={save} onSaved={onSaved} onDiscard={() => setDraft(undefined)}>
      {(f) => (
        <>
          <Group title="Checkout">
            <Row label="Hold at checkout" help="Items stay held while a shopper pays" was={was("hold_minutes", mins)}>
              <NumberInput label="Hold at checkout" value={v.hold_minutes} onChange={(hold_minutes) => set({ hold_minutes })} unit="min" min={2} max={60}
                disabled={disabled} error={f.reservation_ttl_seconds} />
            </Row>
            <Row label="Max items per order" help="Keeps one shopper from taking the whole shelf" was={was("max_units_per_order", num)}>
              <NumberInput label="Max items per order" value={v.max_units_per_order} onChange={(max_units_per_order) => set({ max_units_per_order })}
                unit="items" min={1} max={100} disabled={disabled} error={f.max_units_per_order} />
            </Row>
          </Group>
          <Group title="Cancellations and missed pickups">
            <Row label="Cancellation cutoff" help="Shoppers can ask to cancel until then" was={was("cancellation_cutoff_minutes", mins)}>
              <NumberInput label="Cancellation cutoff" value={v.cancellation_cutoff_minutes} width={230} unit="min before pickup" min={0} max={1440}
                onChange={(cancellation_cutoff_minutes) => set({ cancellation_cutoff_minutes })} disabled={disabled} error={f.cancellation_cutoff_minutes} />
            </Row>
            <Row label="Missed pickup" help="What happens after the grace period" was={was("no_show_policy", noShow)}>
              <SelectInput label="Missed pickup" value={v.no_show_policy} onChange={(no_show_policy) => set({ no_show_policy })} options={NO_SHOW}
                disabled={disabled} error={f.no_show_policy} />
            </Row>
            <Row label="Grace period" help="Extra time after the pickup window ends" was={was("no_show_grace_minutes", mins)}>
              <NumberInput label="Grace period" value={v.no_show_grace_minutes} onChange={(no_show_grace_minutes) => set({ no_show_grace_minutes })}
                unit="min" min={0} max={240} disabled={disabled} error={f.no_show_grace_minutes} />
            </Row>
          </Group>
          <Group title="Stock and close-out">
            <Row label="Low-stock alert" help="Flag an item at or below this count" was={was("low_stock_threshold", num)}>
              <NumberInput label="Low-stock alert" value={v.low_stock_threshold} onChange={(low_stock_threshold) => set({ low_stock_threshold })}
                unit="left" min={0} max={50} disabled={disabled} error={f.low_stock_threshold} />
            </Row>
            <Row label="Close-out plan" help="Drafts end-of-day price cuts; a manager applies them" was={was("closeout_lead_minutes", mins)}
              badge={
                <Link href="/merchant/assistant" underline="none" aria-label={`Close-out plans are ${closeoutOn ? "on" : "off"}. Change in Assistant`}
                  sx={{ px: 1, borderRadius: 999, fontSize: 12, fontWeight: 600, border: 1, lineHeight: "20px",
                        ...(closeoutOn ? { bgcolor: tones.success.bg, color: tones.success.fg, borderColor: tones.success.border }
                          : { bgcolor: tones.neutral.bg, color: brand.muted, borderColor: tones.neutral.border }) }}>
                  {closeoutOn ? "On" : "Off"} · Assistant
                </Link>
              }>
              <NumberInput label="Close-out plan, minutes before pickup ends" value={v.closeout_lead_minutes} width={230} unit="min before end"
                min={15} max={240} step={15} onChange={(closeout_lead_minutes) => set({ closeout_lead_minutes })} disabled={disabled}
                error={f.closeout_lead_minutes} />
            </Row>
          </Group>
        </>
      )}
    </Panel>
  );
}

// ----------------------------------------------------------------------------- customer policies

export function PoliciesSection({ settings, draft, setDraft, onSaved, onSettings }: SectionProps<PoliciesDraft>) {
  const base = policiesOf(settings);
  const v = draft ?? base;
  const changes = diff(base, v, TEXT_FIELDS);
  const disabled = !settings.can_edit;
  const review = reviewState(settings);
  const confirm = useInstant(onSettings);

  function save() {
    const body = Object.fromEntries(TEXT_FIELDS.filter((f) => base[f.key] !== v[f.key]).map((f) => [f.key, v[f.key]]));
    return api<ShopSettings>("/api/merchant/shop/policies", { method: "PATCH", body });
  }

  const action = (
    <Stack sx={{ alignItems: "flex-end" }} spacing={0.75}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <StatusChip tone={review.current ? "success" : "warning"} icon={review.current ? VerifiedRounded : WarningAmberRounded} label={review.label} />
        {settings.can_edit_money && !review.current ? (
          <Button size="small" variant="outlined" color="inherit" loading={confirm.busy} disabled={changes.length > 0}
            onClick={() => confirm.run("/api/merchant/shop/policies/confirm", "POST", {}, "Policies marked as reviewed")}>
            Mark reviewed
          </Button>
        ) : null}
      </Stack>
      {settings.can_edit_money && !review.current && changes.length ? (
        <Typography variant="caption" color="text.secondary">Save or discard your edits first.</Typography>
      ) : null}
      {confirm.error ? <Typography variant="caption" color="error" role="alert">{confirm.error}</Typography> : null}
    </Stack>
  );

  return (
    <Panel title="Customer policies" subtitle="Shoppers see these before checkout and on their pickup pass." action={action} changes={changes}
      editable={settings.can_edit} note="Shoppers re-accept your policies at their next checkout." saveLabel="Save policies" saved="Policies saved"
      save={save} onSaved={onSaved} onDiscard={() => setDraft(undefined)}>
      {(f) => (
        <Box sx={{ mt: 1 }}>
          {POLICY_ROWS.map((row) => (
            <Row key={row.label} stacked label={row.label} help={row.help} was={row.texts.some((t) => base[t.key] !== v[t.key])}>
              <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: row.texts.length > 1 ? "1fr 1fr" : "1fr" } }}>
                {row.texts.map((t) => (
                  <TextField key={t.key} multiline minRows={2} size="small" value={v[t.key]} disabled={disabled}
                    label={row.texts.length > 1 ? t.label : undefined} error={!!f[t.key]} helperText={f[t.key]}
                    onChange={(e) => setDraft({ ...v, [t.key]: e.target.value })}
                    slotProps={{ htmlInput: { maxLength: 1200, "aria-label": row.texts.length > 1 ? undefined : t.label } }} />
                ))}
              </Box>
            </Row>
          ))}
        </Box>
      )}
    </Panel>
  );
}

// ----------------------------------------------------------------------------- payouts and tax

export function PayoutsSection({ settings, draft, setDraft, onSaved, onSettings }: SectionProps<MoneyDraft>) {
  const base = moneyOf(settings);
  const v = draft ?? base;
  const was = wasOf(base, v);
  const owner = settings.can_edit_money;
  const p = settings.payouts;
  const connected = p.status === "connected";
  const connect = useInstant(onSettings);
  const [merchantId, setMerchantId] = useState("");

  function save() {
    const body: Record<string, unknown> = {};
    if (v.tax_percent !== base.tax_percent) body.tax_rates_bps = { ...settings.policies.tax_rates_bps, bakery: Math.round(v.tax_percent * 100) };
    if (v.fee !== base.fee) body.fees_minor = Math.round(v.fee * 100);
    return api<ShopSettings>("/api/merchant/shop/policies", { method: "PATCH", body });
  }

  return (
    <Panel title="Payouts & tax" subtitle="Where payments go, and what's added to each order." changes={diff(base, v, MONEY_FIELDS)} editable={owner}
      note="Shoppers re-accept your policies at their next checkout." saveLabel="Save tax and fees" saved="Taxes and fees saved"
      save={save} onSaved={onSaved} onDiscard={() => setDraft(undefined)}
      action={<StatusChip tone={connected ? "success" : "warning"} icon={connected ? VerifiedRounded : WarningAmberRounded}
        label={connected ? `PayPal · ${p.display}` : "PayPal not connected"} />}>
      {(f) => (
        <>
          <Group title="PayPal">
            <Row label="PayPal account"
              help={owner ? "Your 13-character merchant ID, from Account settings → Business information. We check it with PayPal; no money moves."
                : "Only the owner can change where payments go."}>
              {owner ? (
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-start" } }}>
                  <TextField size="small" value={merchantId} placeholder="Merchant ID" onChange={(e) => setMerchantId(e.target.value.toUpperCase())}
                    error={!!connect.fields.merchant_id} helperText={connect.fields.merchant_id ?? connect.error}
                    slotProps={{ htmlInput: { maxLength: 13, autoCapitalize: "characters", spellCheck: false, className: "tabular", "aria-label": "PayPal merchant ID" } }}
                    sx={{ width: { xs: "100%", sm: 200 } }} />
                  <Button variant="outlined" color="inherit" loading={connect.busy} disabled={merchantId.length !== 13}
                    onClick={async () => { if (await connect.run("/api/merchant/shop/payouts", "PUT", { merchant_id: merchantId }, "PayPal account connected")) setMerchantId(""); }}>
                    {connected ? "Switch account" : "Verify and connect"}
                  </Button>
                </Stack>
              ) : (
                <Typography sx={{ fontWeight: 600 }}>{connected ? p.display : "Not connected"}</Typography>
              )}
            </Row>
          </Group>
          <Group title="Tax and fees">
            <Row label="Sales tax" help="Many states don't tax bakery food" was={was("tax_percent", MONEY_FIELDS[0].show)}>
              <NumberInput label="Sales tax" value={v.tax_percent} onChange={(tax_percent) => setDraft({ ...v, tax_percent })} unit="%"
                min={0} max={30} step={0.125} disabled={!owner} error={f.tax_rates_bps} />
            </Row>
            <Row label="Service fee" help="Added to every order" was={was("fee", MONEY_FIELDS[1].show)}>
              <NumberInput label="Service fee per order" value={v.fee} onChange={(fee) => setDraft({ ...v, fee })} prefix="$"
                min={0} max={10} step={0.25} disabled={!owner} error={f.fees_minor} />
            </Row>
          </Group>
        </>
      )}
    </Panel>
  );
}

// ----------------------------------------------------------------------------- upcoming slots

export function SlotTable({ slots, canEdit, busy, onUpdate }: { slots: Slot[]; canEdit: boolean; busy: string | null; onUpdate: (slot: Slot, body: { capacity?: number; status?: string }) => void }) {
  const groups: { date: string; day: string; slots: Slot[]; booked: number; capacity: number }[] = [];
  for (const slot of slots) {
    let group = groups.find((g) => g.date === slot.date_local);
    if (!group) {
      group = { date: slot.date_local, day: splitLabel(slot.label).day || slot.date_local, slots: [], booked: 0, capacity: 0 };
      groups.push(group);
    }
    group.slots.push(slot);
    group.booked += slot.booked;
    group.capacity += slot.capacity;
  }
  if (!slots.length) return <Typography color="text.secondary">No upcoming pickup slots. Turn on pickup for a day above.</Typography>;
  return (
    <Box sx={{ position: "relative", overflowX: "auto", minWidth: 0, mx: { xs: -2.5, sm: -3.5 }, mb: -2 }}>
      <Table size="small" sx={{ minWidth: 560 }}>
        <caption className="sr-only">Upcoming pickup slots with bookings, capacity and status</caption>
        <TableHead>
          <TableRow>
            <TableCell sx={{ pl: { xs: 2.5, sm: 3.5 } }}>Time</TableCell>
            <TableCell>Booked</TableCell>
            <TableCell>Capacity</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right" sx={{ pr: { xs: 2.5, sm: 3.5 } }}><span className="sr-only">Actions</span></TableCell>
          </TableRow>
        </TableHead>
        {groups.map((group) => (
          <TableBody key={group.date}>
            <TableRow>
              <TableCell component="th" scope="rowgroup" colSpan={5} sx={{ pl: { xs: 2.5, sm: 3.5 }, pt: 2.5, pb: 1 }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "baseline" }}>
                  <Typography variant="subtitle2" component="span">{group.day}</Typography>
                  <Typography variant="caption" color="text.secondary" className="tabular">{group.booked} of {group.capacity} booked</Typography>
                </Stack>
              </TableCell>
            </TableRow>
            {group.slots.map((slot) => {
              const status = slotStatus(slot);
              const closedByMerchant = slot.unavailable_reason === CLOSED_BY_MERCHANT;
              const fill = slot.capacity > 0 ? (slot.booked / slot.capacity) * 100 : 0;
              return (
                <TableRow key={slot.id} hover>
                  <TableCell sx={{ pl: { xs: 2.5, sm: 3.5 }, fontWeight: 650, whiteSpace: "nowrap" }} className="tabular">{splitLabel(slot.label).time}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 120 }}>
                      <LinearProgress variant="determinate" value={Math.min(100, fill)} aria-label={`${slot.label}: ${slot.booked} of ${slot.capacity} booked`}
                        color={fill >= 100 ? "warning" : "primary"} sx={{ flex: 1, height: 6 }} />
                      <Typography variant="caption" className="tabular" sx={{ fontWeight: 650, minWidth: 30 }}>{slot.booked}/{slot.capacity}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <TextField key={`${slot.id}:${slot.capacity}`} type="number" size="small" defaultValue={slot.capacity} disabled={!canEdit}
                      onBlur={(e) => Number(e.target.value) !== slot.capacity && onUpdate(slot, { capacity: Number(e.target.value) })}
                      slotProps={{ htmlInput: { min: 0, max: 100, "aria-label": `Capacity for ${slot.label}`, className: "tabular" } }} sx={{ width: 84 }} />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.25} sx={{ alignItems: "center" }}>
                      <StatusChip tone={status.tone} icon={status.icon} label={status.label} />
                      {status.reason ? <InfoTip label={`Why ${slot.label} is ${status.label.toLowerCase()}`} title={status.reason} /> : null}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ pr: { xs: 2.5, sm: 3.5 } }}>
                    <Button size="small" variant="outlined" color="inherit" disabled={!canEdit} loading={busy === `slot-${slot.id}`}
                      startIcon={closedByMerchant ? <LockOpenRounded /> : <BlockRounded />} aria-label={`${closedByMerchant ? "Reopen" : "Close"} ${slot.label}`}
                      onClick={() => onUpdate(slot, { status: slot.bookable || !closedByMerchant ? "closed" : "open" })}>
                      {closedByMerchant ? "Reopen" : "Close"}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        ))}
      </Table>
    </Box>
  );
}
