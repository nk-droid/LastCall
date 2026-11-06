"use client";

import {
  ArticleRounded,
  BlockRounded,
  CheckCircleRounded,
  LockOpenRounded,
  PaymentsRounded,
  PauseCircleRounded,
  ReceiptRounded,
  RuleRounded,
  ScheduleRounded,
  StorefrontRounded,
  VerifiedRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  FormControlLabel,
  Grid,
  LinearProgress,
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
import { useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { TimelineToggle, WeekHoursTimeline, type TimelineView } from "@/components/pickup-timeline";
import { CLOSED_BY_MERCHANT, slotStatus, splitLabel } from "@/components/slot-status";
import { InfoTip, SectionCard, StatusChip } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { hhmmLabel } from "@/lib/format";
import type { Address, ShopPolicies, ShopSettings, Slot, Week, Weekday } from "@/lib/types";

export const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: "mon", label: "Monday" }, { key: "tue", label: "Tuesday" }, { key: "wed", label: "Wednesday" }, { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" }, { key: "sat", label: "Saturday" }, { key: "sun", label: "Sunday" },
];

const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu"];

type Saver = (next: ShopSettings, message: string) => void;

/** Shared save behaviour: field errors inline, everything else as one alert. */
function useSave(onSaved: Saver) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function save(path: string, method: "PUT" | "PATCH" | "POST" | "DELETE", body: unknown, message: string) {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const next = await api<ShopSettings>(path, { method, body });
      onSaved(next, message);
      announce(message);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_error") {
        const f = err.fieldErrors();
        setFields(f);
        if (!Object.keys(f).length) setError(err.message);
      } else setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, fields, save };
}

function SaveRow({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <Stack direction="row" spacing={1.5} useFlexGap sx={{ mt: 2.5, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
      {caption ? <Typography variant="caption" color="text.secondary">{caption}</Typography> : null}
      {children}
    </Stack>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? <Alert severity="error" role="alert" sx={{ mb: 2 }}>{message}</Alert> : null;
}

// ----------------------------------------------------------------------------- profile

export function ProfileSection({ settings, onSaved }: { settings: ShopSettings; onSaved: Saver }) {
  const s = settings.shop;
  const [form, setForm] = useState({ name: s.name, category: s.category, tagline: s.tagline, description: s.description, phone: s.phone,
                                     support_email: s.support_email, timezone: s.timezone });
  const [address, setAddress] = useState<Address>(s.address);
  const { busy, error, fields, save } = useSave(onSaved);
  const disabled = !settings.can_edit;
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setAddr = (key: keyof Address) => (e: { target: { value: string } }) => setAddress((a) => ({ ...a, [key]: e.target.value }));
  return (
    <SectionCard title="Shop profile" subtitle="Shown to shoppers on your storefront, receipts and pickup pass." icon={<StorefrontRounded />}>
      <ErrorLine message={error} />
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 7 }}>
          <TextField label="Shop name" fullWidth required value={form.name} onChange={set("name")} disabled={disabled} error={!!fields.name} helperText={fields.name} />
        </Grid>
        <Grid size={{ xs: 12, sm: 5 }}>
          <Autocomplete freeSolo options={settings.category_suggestions} value={form.category} disabled={disabled}
            onInputChange={(_, value) => setForm((f) => ({ ...f, category: value }))}
            renderInput={(params) => <TextField {...params} label="Category" required error={!!fields.category} helperText={fields.category} />} />
        </Grid>
        <Grid size={12}>
          <TextField label="Tagline" fullWidth value={form.tagline} onChange={set("tagline")} disabled={disabled} slotProps={{ htmlInput: { maxLength: 200 } }}
            helperText="One line, e.g. “Neighborhood sourdough and pastry, baked daily”" />
        </Grid>
        <Grid size={12}>
          <TextField label="About your surplus" fullWidth multiline minRows={2} value={form.description} onChange={set("description")} disabled={disabled}
            slotProps={{ htmlInput: { maxLength: 1200 } }} helperText="When you list leftovers and what shoppers can expect." />
        </Grid>
        <Grid size={{ xs: 12, sm: 8, md: 5 }}>
          <TextField label="Street address" fullWidth required value={address.line1} onChange={setAddr("line1")} disabled={disabled} autoComplete="address-line1" />
        </Grid>
        <Grid size={{ xs: 12, sm: 4, md: 3 }}>
          <TextField label="City" fullWidth required value={address.city} onChange={setAddr("city")} disabled={disabled} autoComplete="address-level2" />
        </Grid>
        <Grid size={{ xs: 6, sm: 4, md: 2 }}>
          <TextField label="State" fullWidth value={address.region} onChange={setAddr("region")} disabled={disabled} autoComplete="address-level1" />
        </Grid>
        <Grid size={{ xs: 6, sm: 4, md: 2 }}>
          <TextField label="ZIP code" fullWidth value={address.postal_code} onChange={setAddr("postal_code")} disabled={disabled} autoComplete="postal-code" />
        </Grid>
        <Grid size={{ xs: 12, sm: 4, md: 4 }}>
          <TextField select label="Time zone" fullWidth value={form.timezone} onChange={set("timezone")} disabled={disabled || s.status === "live"}
            error={!!fields.timezone} helperText={fields.timezone ?? (s.status === "live" ? "Fixed once live" : " ")}>
            {(TIMEZONES.includes(form.timezone) ? TIMEZONES : [form.timezone, ...TIMEZONES]).map((tz) => (
              <MenuItem key={tz} value={tz}>{tz.replace("America/", "").replace("Pacific/", "").replace("_", " ")}</MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <TextField label="Phone" fullWidth value={form.phone} onChange={set("phone")} disabled={disabled} autoComplete="tel" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <TextField label="Support email" type="email" fullWidth value={form.support_email} onChange={set("support_email")} disabled={disabled}
            error={!!fields.support_email} helperText={fields.support_email ?? "Shown to customers who need help with an order"} />
        </Grid>
      </Grid>
      {settings.can_edit ? (
        <SaveRow>
          <Button variant="contained" loading={busy} onClick={() => save("/api/merchant/shop/profile", "PUT", { ...form, support_email: form.support_email || null, address }, "Shop profile saved")}>
            Save profile
          </Button>
        </SaveRow>
      ) : null}
    </SectionCard>
  );
}

// ----------------------------------------------------------------------------- hours + pickup

export function HoursSection({ settings, onSaved }: { settings: ShopSettings; onSaved: Saver }) {
  const [hours, setHours] = useState<Week>(settings.hours);
  const [windows, setWindows] = useState<Week>(settings.pickup.windows);
  const [slotMinutes, setSlotMinutes] = useState(settings.pickup.slot_minutes);
  const [capacity, setCapacity] = useState(settings.pickup.capacity);
  const { busy, error, fields, save } = useSave(onSaved);
  const pause = useSave(onSaved);
  const disabled = !settings.can_edit;
  const [view, setView] = useState<TimelineView>("timeline");

  function setDay(week: Week, set: (w: Week) => void, day: Weekday, index: 0 | 1, value: string) {
    const current = week[day] ?? ["16:00", "19:00"];
    const next: [string, string] = index === 0 ? [value, current[1]] : [current[0], value];
    set({ ...week, [day]: next });
  }
  function toggleDay(day: Weekday, open: boolean) {
    setWindows((w) => ({ ...w, [day]: open ? (settings.pickup.windows[day] ?? ["16:00", "19:00"]) : null }));
    setHours((h) => ({ ...h, [day]: open ? (settings.hours[day] ?? ["07:00", "19:00"]) : h[day] }));
  }
  const allDay = (w: [string, string] | null) => !!w && w[0] === "00:00" && w[1] === "23:59";

  return (
    <SectionCard title="Hours and pickup" subtitle="Pickup slots are generated from these windows. Shoppers never see invented times." icon={<ScheduleRounded />}
      action={settings.can_edit ? (
        <FormControlLabel control={<Switch checked={!settings.pickup_paused} disabled={pause.busy}
          onChange={(e) => pause.save("/api/merchant/shop/pickup-paused", "PUT", { paused: !e.target.checked }, e.target.checked ? "Pickup resumed" : "Pickup paused")} />}
          label={settings.pickup_paused ? "Pickup paused" : "Taking pickups"} />
      ) : settings.pickup_paused ? <StatusChip tone="warning" icon={PauseCircleRounded} label="Pickup paused" /> : null}>
      <ErrorLine message={error ?? pause.error} />
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mb: 2, alignItems: { sm: "center" }, justifyContent: "space-between" }}>
        <TimelineToggle value={view} onChange={setView} listLabel="Table" />
        <Typography variant="caption" color="text.secondary">
          {view === "timeline"
            ? disabled ? "Each day's band is its opening hours; the green pill is its pickup window." : "Drag the band or pill to move it, or drag an end to change the time. Turn days on or off in the table."
            : "Turn pickup on or off for each day, or type exact times."}
        </Typography>
      </Stack>
      {view === "timeline" ? (
        <WeekHoursTimeline hours={hours} windows={windows} disabled={disabled}
          onChange={(kind, day, value) => (kind === "hours" ? setHours : setWindows)((w) => ({ ...w, [day]: value }))} />
      ) : (
      /* Bleed to the card edges so the columns get the whole width; gutters match the card padding. */
      <Box sx={{ overflowX: "auto", mx: { xs: -2.5, sm: -3 } }}>
        <Table size="small" sx={{ minWidth: 900, "& th:first-of-type, & td:first-of-type": { pl: { xs: 2.5, sm: 3 } }, "& th:last-of-type, & td:last-of-type": { pr: { xs: 2.5, sm: 3 } } }}>
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
              const err = fields[`pickup.windows.${key}`] ?? fields[`hours.${key}`];
              return (
                <TableRow key={key}>
                  <TableCell sx={{ fontWeight: 650 }}>{label}</TableCell>
                  <TableCell>
                    <Switch checked={!!win} disabled={disabled} onChange={(e) => toggleDay(key, e.target.checked)} slotProps={{ input: { "aria-label": `Pickup on ${label}` } }} />
                  </TableCell>
                  <TableCell>
                    {win ? (
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <TimeInput label={`${label} pickup from`} value={win[0]} disabled={disabled} onChange={(v) => setDay(windows, setWindows, key, 0, v)} />
                        <Typography aria-hidden color="text.secondary">–</Typography>
                        <TimeInput label={`${label} pickup until`} value={win[1]} disabled={disabled} onChange={(v) => setDay(windows, setWindows, key, 1, v)} />
                        {allDay(win) ? <StatusChip tone="info" label="All day" /> : null}
                      </Stack>
                    ) : (
                      <Typography variant="body2" color="text.secondary">No pickup</Typography>
                    )}
                    {err ? <Typography variant="caption" color="error" role="alert">{err}</Typography> : null}
                  </TableCell>
                  <TableCell>
                    {h ? (
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <TimeInput label={`${label} opens`} value={h[0]} disabled={disabled} onChange={(v) => setDay(hours, setHours, key, 0, v)} />
                        <Typography aria-hidden color="text.secondary">–</Typography>
                        <TimeInput label={`${label} closes`} value={h[1]} disabled={disabled} onChange={(v) => setDay(hours, setHours, key, 1, v)} />
                      </Stack>
                    ) : (
                      <Button size="small" disabled={disabled} onClick={() => setHours((x) => ({ ...x, [key]: ["07:00", "19:00"] }))}>Set hours</Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
      )}
      {view === "timeline" && Object.keys(fields).length ? (
        <Alert severity="error" role="alert" sx={{ mt: 2 }}>Some times need fixing. Switch to the table to see which day.</Alert>
      ) : null}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2.5 }}>
        <TextField select label="Slot length" value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))} disabled={disabled} sx={{ minWidth: 160 }}>
          {[15, 30, 60].map((m) => <MenuItem key={m} value={m}>{m} minutes</MenuItem>)}
        </TextField>
        <TextField type="number" label="Orders per slot" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} disabled={disabled}
          slotProps={{ htmlInput: { min: 0, max: 100 } }} sx={{ width: 160 }} helperText="How many pickups staff can hand off per slot" />
      </Stack>
      {settings.can_edit ? (
        <SaveRow caption="Slots already booked keep their time.">
          <Button variant="contained" loading={busy}
            onClick={() => save("/api/merchant/shop/hours", "PUT", { hours, pickup: { windows, slot_minutes: slotMinutes, capacity } }, "Hours and pickup windows saved")}>
            Save hours
          </Button>
        </SaveRow>
      ) : null}
    </SectionCard>
  );
}

function TimeInput({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <TextField type="time" size="small" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      slotProps={{ htmlInput: { "aria-label": label, step: 300 } }} sx={{ width: 136 }} />
  );
}

// ----------------------------------------------------------------------------- payouts

export function PayoutsSection({ settings, onSaved, owner }: { settings: ShopSettings; onSaved: Saver; owner: boolean }) {
  const [merchantId, setMerchantId] = useState("");
  const { busy, error, fields, save } = useSave(onSaved);
  const p = settings.payouts;
  return (
    <SectionCard title="PayPal payouts" subtitle="Customers pay your PayPal business account directly; refunds come out of it." icon={<PaymentsRounded />}
      action={<StatusChip tone={p.status === "connected" ? "success" : "warning"} icon={p.status === "connected" ? VerifiedRounded : WarningAmberRounded}
        label={p.status === "connected" ? `Connected · ${p.display}` : "Not connected"} />}>
      <ErrorLine message={error} />
      {owner ? (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Enter your PayPal <strong>merchant ID</strong> (13 letters and numbers). In PayPal, open{" "}
            <em>Account settings → Business information</em>. We check it with PayPal before saving; no money moves.
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "flex-start" } }}>
            <TextField label="PayPal merchant ID" value={merchantId} onChange={(e) => setMerchantId(e.target.value.toUpperCase())}
              error={!!fields.merchant_id} helperText={fields.merchant_id ?? (p.status === "connected" ? "Enter a new ID to switch accounts" : " ")}
              slotProps={{ htmlInput: { maxLength: 13, autoCapitalize: "characters", spellCheck: false, className: "tabular" } }} sx={{ minWidth: 260 }} />
            <Button variant="contained" loading={busy} disabled={merchantId.length !== 13} sx={{ mt: { sm: 0.5 } }}
              onClick={async () => { if (await save("/api/merchant/shop/payouts", "PUT", { merchant_id: merchantId }, "PayPal account connected")) setMerchantId(""); }}>
              {p.status === "connected" ? "Switch account" : "Verify and connect"}
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
            Refunds for past orders always go back through the account that was paid.
          </Typography>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">Only the shop owner can change where payments go.</Typography>
      )}
    </SectionCard>
  );
}

// ----------------------------------------------------------------------------- policies

const TEXTS: { key: keyof ShopPolicies; label: string; help: string }[] = [
  { key: "cancellation_policy_text", label: "Cancellation policy", help: "Shown before checkout and on the pickup pass." },
  { key: "refund_policy_text", label: "Refund policy", help: "When and how refunds are made." },
  { key: "dietary_disclosure_text", label: "Allergen disclosure", help: "How your allergen data is verified." },
  { key: "cross_contact_text", label: "Cross-contact note", help: "Shared equipment or kitchens." },
  { key: "reference_price_policy_text", label: "Reference prices", help: "What “regular price” means at your shop." },
  { key: "pickup_instructions", label: "Pickup instructions", help: "Where to go and who to ask." },
  { key: "what_to_bring", label: "What to bring", help: "Shown on the pickup pass." },
];

export function PoliciesSection({ settings, onSaved, onConfirm }: { settings: ShopSettings; onSaved: Saver; onConfirm?: () => void }) {
  const p = settings.policies;
  const [texts, setTexts] = useState(() => Object.fromEntries(TEXTS.map((t) => [t.key, String(p[t.key] ?? "")])) as Record<string, string>);
  const [rules, setRules] = useState({
    cancellation_cutoff_minutes: p.cancellation_cutoff_minutes, reservation_ttl_minutes: Math.round(p.reservation_ttl_seconds / 60),
    max_units_per_order: p.max_units_per_order, low_stock_threshold: p.low_stock_threshold, no_show_grace_minutes: p.no_show_grace_minutes,
    no_show_policy: p.no_show_policy, relist_at_local: p.relist_at_local ?? "06:00",
  });
  const [money, setMoney] = useState({ tax_percent: ((p.tax_rates_bps?.bakery ?? 0) / 100).toString(), fee: (p.fees_minor / 100).toFixed(2) });
  const textSave = useSave(onSaved);
  const ruleSave = useSave(onSaved);
  const moneySave = useSave(onSaved);
  const confirm = useSave(onSaved);
  const disabled = !settings.can_edit;
  const confirmedAt = settings.shop.verification.policies_confirmed_at;
  const num = (key: keyof typeof rules) => (e: { target: { value: string } }) => setRules((r) => ({ ...r, [key]: e.target.value.includes(":") ? e.target.value : Number(e.target.value) }));

  return (
    <Stack spacing={3}>
      <SectionCard title="Customer-facing text" subtitle={`Policy version ${settings.policy_version}: shoppers re-accept at checkout after changes.`} icon={<ArticleRounded />}
        action={confirmedAt ? <StatusChip tone="success" icon={VerifiedRounded} label="Reviewed by owner" /> : <StatusChip tone="warning" icon={WarningAmberRounded} label="Not reviewed" />}>
        <ErrorLine message={textSave.error ?? confirm.error} />
        <Grid container spacing={2}>
          {TEXTS.map((t) => (
            <Grid key={t.key} size={{ xs: 12, md: 6 }}>
              <TextField label={t.label} fullWidth multiline minRows={3} value={texts[t.key]} disabled={disabled}
                onChange={(e) => setTexts((x) => ({ ...x, [t.key]: e.target.value }))} error={!!textSave.fields[t.key]}
                helperText={textSave.fields[t.key] ?? t.help} slotProps={{ htmlInput: { maxLength: 1200 } }} />
            </Grid>
          ))}
        </Grid>
        <SaveRow caption={confirmedAt ? `Reviewed by ${settings.shop.verification.policies_confirmed_by ?? "the owner"}` : undefined}>
          {settings.can_edit_money && onConfirm !== undefined ? (
            <Button variant="outlined" loading={confirm.busy} startIcon={<CheckCircleRounded />}
              onClick={async () => { if (await confirm.save("/api/merchant/shop/policies/confirm", "POST", {}, "Policies confirmed")) onConfirm(); }}>
              {confirmedAt ? "Confirm again" : "I've reviewed these policies"}
            </Button>
          ) : null}
          {settings.can_edit ? (
            <Button variant="contained" loading={textSave.busy} onClick={() => textSave.save("/api/merchant/shop/policies", "PATCH", texts, "Policy text saved")}>
              Save text
            </Button>
          ) : null}
        </SaveRow>
      </SectionCard>

      <SectionCard title="Order rules" icon={<RuleRounded />}>
        <ErrorLine message={ruleSave.error} />
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField type="number" label="Cancellation cutoff (minutes before pickup)" fullWidth value={rules.cancellation_cutoff_minutes} onChange={num("cancellation_cutoff_minutes")} disabled={disabled}
              error={!!ruleSave.fields.cancellation_cutoff_minutes} helperText={ruleSave.fields.cancellation_cutoff_minutes} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField type="number" label="Hold time at checkout (minutes)" fullWidth value={rules.reservation_ttl_minutes} onChange={num("reservation_ttl_minutes")} disabled={disabled}
              error={!!ruleSave.fields.reservation_ttl_seconds} helperText={ruleSave.fields.reservation_ttl_seconds ?? "How long items stay held while a shopper pays"} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField type="number" label="Max items per order" fullWidth value={rules.max_units_per_order} onChange={num("max_units_per_order")} disabled={disabled}
              error={!!ruleSave.fields.max_units_per_order} helperText={ruleSave.fields.max_units_per_order} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField type="number" label="Low-stock alert at" fullWidth value={rules.low_stock_threshold} onChange={num("low_stock_threshold")} disabled={disabled} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField select label="Missed pickups" fullWidth value={rules.no_show_policy} disabled={disabled}
              onChange={(e) => setRules((r) => ({ ...r, no_show_policy: e.target.value as ShopPolicies["no_show_policy"] }))}>
              <MenuItem value="hold_for_review">Hold for staff to review</MenuItem>
              <MenuItem value="auto_refund">Refund automatically</MenuItem>
              <MenuItem value="auto_cancel_no_refund">Cancel without refund</MenuItem>
            </TextField>
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField type="number" label="Grace after the window (minutes)" fullWidth value={rules.no_show_grace_minutes} onChange={num("no_show_grace_minutes")} disabled={disabled} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField type="time" label="Daily listing time" fullWidth value={rules.relist_at_local} onChange={num("relist_at_local")} disabled={disabled}
              helperText={`“Repeat daily” products are re-listed at ${hhmmLabel(rules.relist_at_local)}`} slotProps={{ inputLabel: { shrink: true } }} />
          </Grid>
        </Grid>
        {settings.can_edit ? (
          <SaveRow>
            <Button variant="contained" loading={ruleSave.busy} onClick={() => {
              const { reservation_ttl_minutes, ...rest } = rules;
              void ruleSave.save("/api/merchant/shop/policies", "PATCH", { ...rest, reservation_ttl_seconds: reservation_ttl_minutes * 60 }, "Order rules saved");
            }}>
              Save rules
            </Button>
          </SaveRow>
        ) : null}
      </SectionCard>

      <SectionCard title="Taxes and fees" subtitle="Owner only. Added to every order total." icon={<ReceiptRounded />}>
        <ErrorLine message={moneySave.error} />
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField type="number" label="Sales tax (%)" value={money.tax_percent} disabled={!settings.can_edit_money}
            onChange={(e) => setMoney((m) => ({ ...m, tax_percent: e.target.value }))} slotProps={{ htmlInput: { min: 0, max: 30, step: 0.125 } }}
            error={!!moneySave.fields.tax_rates_bps} helperText={moneySave.fields.tax_rates_bps ?? "Many states don't tax bakery food"} />
          <TextField type="number" label="Service fee per order ($)" value={money.fee} disabled={!settings.can_edit_money}
            onChange={(e) => setMoney((m) => ({ ...m, fee: e.target.value }))} slotProps={{ htmlInput: { min: 0, max: 10, step: 0.25 } }}
            error={!!moneySave.fields.fees_minor} helperText={moneySave.fields.fees_minor} />
        </Stack>
        {settings.can_edit_money ? (
          <SaveRow>
            <Button variant="contained" loading={moneySave.busy} onClick={() => moneySave.save("/api/merchant/shop/policies", "PATCH",
              { tax_rates_bps: { bakery: Math.round(Number(money.tax_percent) * 100) }, fees_minor: Math.round(Number(money.fee) * 100) }, "Taxes and fees saved")}>
              Save taxes and fees
            </Button>
          </SaveRow>
        ) : null}
      </SectionCard>
    </Stack>
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
    <Box sx={{ position: "relative", overflowX: "auto", minWidth: 0, mx: { xs: -2.5, sm: -3 }, mb: { xs: -2.5, sm: -3 } }}>
      <Table size="small" sx={{ minWidth: 560 }}>
        <caption className="sr-only">Upcoming pickup slots with bookings, capacity and status</caption>
        <TableHead>
          <TableRow>
            <TableCell sx={{ pl: { xs: 2.5, sm: 3 } }}>Time</TableCell>
            <TableCell>Booked</TableCell>
            <TableCell>Capacity</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right" sx={{ pr: { xs: 2.5, sm: 3 } }}><span className="sr-only">Actions</span></TableCell>
          </TableRow>
        </TableHead>
        {groups.map((group) => (
          <TableBody key={group.date}>
            <TableRow>
              <TableCell component="th" scope="rowgroup" colSpan={5} sx={{ pl: { xs: 2.5, sm: 3 }, pt: 2.5, pb: 1 }}>
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
                  <TableCell sx={{ pl: { xs: 2.5, sm: 3 }, fontWeight: 650, whiteSpace: "nowrap" }} className="tabular">{splitLabel(slot.label).time}</TableCell>
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
                  <TableCell align="right" sx={{ pr: { xs: 2.5, sm: 3 } }}>
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

