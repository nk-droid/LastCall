"use client";

// What an Ask LastCall reply was based on, built only from facts code recorded for the turn:
// - HowWePicked: read the request, checked the shops (and why any were passed on), left out risky items, compared.
// - Understood: the request as chips. Size, budget and time can be changed (that sends a follow-up message);
//   allergens and diets are locked, because they're always applied from what the shopper wrote.
// - ShopBoard: every shop checked, with its bundle, what else it had, or why nothing fit.

import {
  AddRounded, EditRounded, ExpandLessRounded, ExpandMoreRounded, LockRounded, RemoveCircleOutlineRounded, StorefrontRounded,
} from "@mui/icons-material";
import { Box, Button, Chip, Collapse, Menu, MenuItem, Popover, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { useId, useState, type FormEvent } from "react";

import { brand, tones } from "@/components/ui";
import { money, plural } from "@/lib/format";
import type { ConciergeCard, ConciergeDetails } from "@/lib/types";

import { BundleCard } from "./bundle-card";

// ----------------------------------------------------------------------------- how we picked this

function Step({ n, tone = "success", title, children }: { n: number; tone?: "success" | "warning"; title: string; children: React.ReactNode }) {
  return (
    <Box component="li" sx={{ display: "grid", gridTemplateColumns: "26px minmax(0, 1fr)", gap: 1.25 }}>
      <Box aria-hidden sx={{ width: 26, height: 26, borderRadius: "50%", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, bgcolor: tones[tone].bg, color: tones[tone].fg }}>{n}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>{title}</Typography>
        <Box sx={{ color: brand.muted, typography: "body2", lineHeight: 1.5 }}>{children}</Box>
      </Box>
    </Box>
  );
}

export function HowWePicked({ details, defaultOpen = false }: { details: ConciergeDetails; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();
  const checked = details.shops;
  const skipped = checked.filter((s) => !s.options);
  const fitting = [...checked.filter((s) => s.options)].sort((a, b) => Number(b.top) - Number(a.top) || Number(b.shown) - Number(a.shown));
  const strict = details.understood.filter((u) => u.strict);
  const ruledOut = checked.filter((s) => s.left_out.length);
  let n = 0;
  return (
    <Box sx={{ border: 1, borderColor: brand.line, borderRadius: "14px", bgcolor: "#fff" }}>
      <Button fullWidth color="inherit" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={regionId}
        endIcon={open ? <ExpandLessRounded /> : <ExpandMoreRounded />} sx={{ justifyContent: "space-between", px: 2, py: 1.25, fontWeight: 700, borderRadius: "14px" }}>
        How we picked this
      </Button>
      <Collapse in={open} id={regionId}>
        <Box component="ol" sx={{ listStyle: "none", m: 0, px: 2, pb: 2, pt: 0.5, display: "grid", gap: 1.5 }}>
          <Step n={++n} title="Read your request">{details.understood.map((u) => u.label).join(" · ") || "Your message"}</Step>
          <Step n={++n} title={`Checked ${plural(checked.length, "shop")}${details.listed && details.listed > checked.length ? ` of ${details.listed} open` : ""}`}>
            {skipped.length ? skipped.map((s) => <Box key={s.slug}>Skipped {s.name}: {s.reason}</Box>) : "Each one had something that fits."}
          </Step>
          {strict.length ? (
            <Step n={++n} tone="warning" title="Left out anything risky">
              {verifiedLine(strict.map((s) => s.key), strict.map((s) => s.label))}
              {ruledOut.map((s) => (
                <Box key={s.slug}>
                  At {s.name} that ruled out {s.left_out.join(", ")}{s.left_out_count > s.left_out.length ? ` and ${s.left_out_count - s.left_out.length} more` : ""}.
                </Box>
              ))}
            </Step>
          ) : null}
          {fitting.length ? (
            <Step n={++n} title="Compared what was left">
              <Stack spacing={0.75} sx={{ mt: 0.75 }}>
                {fitting.map((s) => (
                  <Box key={s.slug} sx={{ display: "flex", justifyContent: "space-between", gap: 1, px: 1.25, py: 0.9, borderRadius: "10px", bgcolor: s.top ? brand.mint : brand.sand, color: brand.forest, fontWeight: s.top ? 700 : 500 }}>
                    <span>{s.name}{s.shown_units ? ` · ${plural(s.shown_units, "item")}` : ` · ${plural(s.options, "bundle")}`}{s.top ? " · top pick" : ""}</span>
                    <span className="tabular">{s.shown_total_minor !== null ? money(s.shown_total_minor, s.currency) : s.from_minor !== null ? `from ${money(s.from_minor, s.currency)}` : ""}</span>
                  </Box>
                ))}
              </Stack>
            </Step>
          ) : null}
        </Box>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 2, pb: 1.75, mt: -0.5 }}>
          Allergen facts come from each shop&apos;s records, not from the assistant.
        </Typography>
      </Collapse>
    </Box>
  );
}

function joinAnd(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0] ?? "";
}

/** "Only items each shop verified free of tree nuts and peanuts, with no cross-contact." */
function verifiedLine(keys: string[], labels: string[]): string {
  const free = keys.map((k, i) => (k.startsWith("exclusion:") ? labels[i].replace(/^No /, "").toLowerCase() : null)).filter((x): x is string => !!x);
  const diets = keys.map((k, i) => (k.startsWith("dietary:") ? labels[i].toLowerCase() : null)).filter((x): x is string => !!x);
  const parts = [free.length ? `free of ${joinAnd(free)}` : "", diets.length ? `as ${joinAnd(diets)}` : ""].filter(Boolean);
  return `Only items each shop verified ${parts.join(" and ")}${free.length ? ", with no cross-contact" : ""}.`;
}

// ----------------------------------------------------------------------------- what I understood

const ADDABLE = [
  { key: "exclusion:tree_nuts", label: "Tree nuts", message: "Also no tree nuts" },
  { key: "exclusion:peanuts", label: "Peanuts", message: "Also no peanuts" },
  { key: "exclusion:milk", label: "Milk", message: "Also no dairy" },
  { key: "exclusion:eggs", label: "Eggs", message: "Also no eggs" },
  { key: "exclusion:wheat", label: "Wheat (gluten)", message: "Also no gluten" },
  { key: "exclusion:soy", label: "Soy", message: "Also no soy" },
  { key: "exclusion:sesame", label: "Sesame", message: "Also no sesame" },
  { key: "dietary:vegetarian", label: "Vegetarian", message: "Make it vegetarian" },
  { key: "dietary:vegan", label: "Vegan", message: "Make it vegan" },
];

const EDIT: Record<string, { label: string; type: "number" | "text"; placeholder: string; message: (v: string) => string }> = {
  party_size: { label: "How many people?", type: "number", placeholder: "6", message: (v) => `Make it for ${v} people` },
  budget: { label: "Budget in dollars", type: "number", placeholder: "25", message: (v) => `Keep it under $${v}` },
  pickup: { label: "Pickup time", type: "text", placeholder: "after 6 PM", message: (v) => `Pickup ${v}` },
};

export function Understood({ details, onSend, disabled }: { details: ConciergeDetails; onSend: (text: string) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const [value, setValue] = useState("");
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const have = new Set(details.understood.map((u) => u.key));
  const edit = editing ? EDIT[editing.key] : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!edit || !value.trim()) return;
    onSend(edit.message(value.trim()));
    setEditing(null);
    setValue("");
  }

  return (
    <Box>
      <Typography variant="overline" component="h3" sx={{ color: brand.muted, display: "block", mb: 0.75 }}>What I understood · tap to change</Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        {details.understood.map((u) => u.strict ? (
          <Tooltip key={u.key} title="Always applied, from what you wrote">
            <Chip icon={<LockRounded />} label={`${u.label} · strict`}
              sx={{ bgcolor: tones.warning.bg, color: tones.warning.fg, border: 1, borderColor: tones.warning.fg, fontWeight: 600, "& .MuiChip-icon": { color: tones.warning.fg } }} />
          </Tooltip>
        ) : u.editable ? (
          <Chip key={u.key} label={u.label} icon={<EditRounded />} aria-label={`${u.label}, change`} disabled={disabled}
            onClick={(e) => { setEditing({ key: u.key, anchor: e.currentTarget }); setValue(""); }}
            variant="outlined" sx={{ bgcolor: "#fff", fontWeight: 600, borderColor: brand.lineStrong, "& .MuiChip-icon": { fontSize: 16, color: brand.muted } }} />
        ) : (
          <Chip key={u.key} label={u.label} variant="outlined" sx={{ bgcolor: "#fff", fontWeight: 600, borderColor: brand.line }} />
        ))}
        <Chip icon={<AddRounded />} label="Allergy or diet" variant="outlined" onClick={(e) => setAdding(e.currentTarget)} disabled={disabled}
          sx={{ borderStyle: "dashed", color: brand.muted }} />
      </Stack>
      <Popover open={!!editing} anchorEl={editing?.anchor} onClose={() => setEditing(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 1.5, mt: 0.75, borderRadius: "14px" } } }}>
        {edit ? (
          <Stack component="form" direction="row" spacing={1} onSubmit={submit} sx={{ alignItems: "center" }}>
            <TextField size="small" autoFocus label={edit.label} placeholder={edit.placeholder} value={value} onChange={(e) => setValue(e.target.value)}
              type={edit.type} slotProps={{ htmlInput: edit.type === "number" ? { min: 1, max: edit.label.startsWith("How") ? 40 : 1000 } : { maxLength: 40 } }} sx={{ width: 180 }} />
            <Button type="submit" variant="contained" disabled={!value.trim()}>Update</Button>
          </Stack>
        ) : null}
      </Popover>
      <Menu open={!!adding} anchorEl={adding} onClose={() => setAdding(null)}>
        {ADDABLE.filter((a) => !have.has(a.key)).map((a) => (
          <MenuItem key={a.key} onClick={() => { setAdding(null); onSend(a.message); }}>{a.label}</MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

// ----------------------------------------------------------------------------- shop board

export function ShopBoard({ details, cards, onSend, disabled }: {
  details: ConciergeDetails; cards: ConciergeCard[]; onSend: (text: string) => void; disabled?: boolean;
}) {
  const shownSlugs = new Set(cards.map((c) => c.shop.slug));
  const others = details.shops.filter((s) => s.options && !shownSlugs.has(s.slug));
  const skipped = details.shops.filter((s) => !s.options);
  return (
    <Box component="ul" aria-label="Shops checked" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 2, alignItems: "start", gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))" } }}>
      {cards.map((card, i) => <Box component="li" key={card.option_id} sx={{ display: "flex", "& > *": { flex: 1 } }}><BundleCard card={card} top={i === 0} /></Box>)}
      {others.map((s) => (
        <Box component="li" key={s.slug} sx={{ border: 1, borderColor: brand.line, borderRadius: "16px", p: 2, bgcolor: "#fff", display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 0.75 }}>
            <StorefrontRounded aria-hidden sx={{ fontSize: 16, color: brand.leaf }} />{s.name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Checked · {plural(s.options, "bundle")} fit{s.options === 1 ? "s" : ""}{s.from_minor !== null ? `, from ${money(s.from_minor, s.currency)}` : ""}
          </Typography>
          <Button size="small" variant="outlined" color="inherit" disabled={disabled} onClick={() => onSend(`Show me bundles from ${s.name}`)} sx={{ alignSelf: "flex-start", mt: "auto" }}>
            Show these
          </Button>
        </Box>
      ))}
      {skipped.map((s) => (
        <Box component="li" key={s.slug} sx={{ border: 1, borderStyle: "dashed", borderColor: brand.lineStrong, borderRadius: "16px", p: 2, bgcolor: brand.sand, display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: brand.muted }}>{s.name}</Typography>
            <Chip size="small" label="Nothing fits" sx={{ bgcolor: "#fff", color: brand.muted, fontWeight: 650 }} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
            <RemoveCircleOutlineRounded aria-hidden sx={{ fontSize: 16, mt: "2px" }} />{s.reason}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
