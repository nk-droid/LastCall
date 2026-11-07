"use client";

// The request read back as one sentence: "Savory snacks for 6 people, under $25, picked up after 5 PM today, with no
// peanuts or tree nuts." Size, budget and time open a small editor and taste offers a swap; each sends a follow-up
// message. Allergies and diets are strict: shown, never changed by a tap (a new chat starts over).

import { AddRounded, VerifiedUserRounded } from "@mui/icons-material";
import { Box, Button, Menu, MenuItem, Popover, Stack, TextField, Typography } from "@mui/material";
import { useState, type FormEvent } from "react";

import { brand } from "@/components/ui";
import type { ConciergeDetails } from "@/lib/types";

const EDIT: Record<string, { label: string; type: "number" | "text"; placeholder: string; max?: number; message: (v: string) => string }> = {
  party_size: { label: "How many people?", type: "number", placeholder: "6", max: 40, message: (v) => `Make it for ${v} people` },
  budget: { label: "Budget in dollars", type: "number", placeholder: "25", max: 1000, message: (v) => `Keep it under $${v}` },
  pickup: { label: "Pickup time", type: "text", placeholder: "after 6 PM", message: (v) => `Pickup ${v}` },
};

const TASTES = [
  { key: "preference:sweet", label: "Sweet", message: "Make it sweet instead" },
  { key: "preference:savory", label: "Savory", message: "Make it savory instead" },
  { key: "preference:sweet_and_savory", label: "A mix of sweet and savory", message: "Make it a mix of sweet and savory" },
];

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

const token = {
  font: "inherit", letterSpacing: "inherit", lineHeight: 1.3, color: brand.forest, display: "inline-flex", alignItems: "center", gap: "0.2em",
  px: "0.4em", py: "0.05em", borderRadius: "10px", verticalAlign: "baseline", textAlign: "left",
} as const;

export function AskSentence({ details, onSend, disabled }: { details: ConciergeDetails; onSend: (text: string) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const [value, setValue] = useState("");
  const [menu, setMenu] = useState<{ kind: "taste" | "add"; key?: string; anchor: HTMLElement } | null>(null);
  const have = new Set(details.understood.map((u) => u.key));
  const strict = details.understood.some((u) => u.strict);
  const edit = editing ? EDIT[editing.key] : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!edit || !value.trim()) return;
    onSend(edit.message(value.trim()));
    setEditing(null);
    setValue("");
  }

  return (
    <Box component="section" aria-labelledby="asked-heading">
      <Typography id="asked-heading" variant="overline" component="h2" sx={{ color: brand.muted, display: "block", mb: 0.5 }}>You asked for</Typography>
      <Typography variant="h2" component="p" sx={{ fontSize: { xs: 22, sm: 28 }, fontWeight: 600, lineHeight: 1.75, m: 0 }}>
        {(details.ask ?? []).map((part, i) => {
          if (!part.key) return <span key={i}>{part.text}</span>;
          const key = part.key;
          if (key === "exclusions" || key.startsWith("dietary:")) {
            return (
              <Box key={i} component="span" sx={{ ...token, bgcolor: brand.mint, color: brand.leafDark }}>
                <VerifiedUserRounded aria-hidden sx={{ fontSize: "0.85em" }} />{part.text}
              </Box>
            );
          }
          const taste = key.startsWith("preference:");
          return (
            <Box key={i} component="button" type="button" disabled={disabled} aria-label={`${part.text}, change`} aria-haspopup={taste ? "menu" : "dialog"}
              onClick={(e: React.MouseEvent<HTMLElement>) => {
                if (taste) setMenu({ kind: "taste", key, anchor: e.currentTarget });
                else if (EDIT[key]) { setEditing({ key, anchor: e.currentTarget }); setValue(""); }
              }}
              sx={{
                ...token, bgcolor: "#fff", border: `1px solid ${brand.lineStrong}`, cursor: "pointer", mx: "0.05em",
                "&:hover:not(:disabled)": { bgcolor: brand.sand, borderColor: brand.leaf },
                "&:focus-visible": { outline: `3px solid ${brand.leafLight}`, outlineOffset: 2 },
                "&:disabled": { cursor: "default", opacity: 0.6 },
              }}>
              {part.text}
            </Box>
          );
        })}
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mt: 0.75 }}>
        <Typography variant="body2" color="text.secondary">
          Tap a part to change it.{strict ? " Allergies and diets stay on for this chat." : ""}
        </Typography>
        <Button size="small" startIcon={<AddRounded />} disabled={disabled} aria-haspopup="menu" onClick={(e) => setMenu({ kind: "add", anchor: e.currentTarget })}>
          Allergy or diet
        </Button>
      </Stack>

      <Popover open={!!editing} anchorEl={editing?.anchor} onClose={() => setEditing(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 1.5, mt: 0.75, borderRadius: "14px" } } }}>
        {edit ? (
          <Stack component="form" direction="row" spacing={1} onSubmit={submit} sx={{ alignItems: "center" }}>
            <TextField size="small" autoFocus label={edit.label} placeholder={edit.placeholder} value={value} onChange={(e) => setValue(e.target.value)}
              type={edit.type} slotProps={{ htmlInput: edit.type === "number" ? { min: 1, max: edit.max } : { maxLength: 40 } }} sx={{ width: 180 }} />
            <Button type="submit" variant="contained" disabled={!value.trim()}>Update</Button>
          </Stack>
        ) : null}
      </Popover>
      <Menu open={!!menu} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
        {menu?.kind === "taste"
          ? TASTES.filter((t) => t.key !== menu.key).map((t) => (
            <MenuItem key={t.key} onClick={() => { setMenu(null); onSend(t.message); }}>{t.label}</MenuItem>
          ))
          : ADDABLE.filter((a) => !have.has(a.key)).map((a) => (
            <MenuItem key={a.key} onClick={() => { setMenu(null); onSend(a.message); }}>{a.label}</MenuItem>
          ))}
      </Menu>
    </Box>
  );
}
