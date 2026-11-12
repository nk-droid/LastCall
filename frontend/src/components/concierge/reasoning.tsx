"use client";

// What an Ask LastCall reply was based on, built only from facts code recorded for the turn: read the request,
// checked the shops (and why any were passed on), left out risky items, compared what was left.

import { ExpandLessRounded, ExpandMoreRounded } from "@mui/icons-material";
import { Box, Button, Collapse, Stack, Typography } from "@mui/material";
import { useId, useState } from "react";

import { MetaRow, brand, tones } from "@/components/ui";
import { money, plural } from "@/lib/format";
import type { ConciergeDetails } from "@/lib/types";

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
          <Step n={++n} title="Read your request">{details.understood.map((u) => u.label).join(", ") || "Your message"}</Step>
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
                    <MetaRow
                      component="span"
                      color="inherit"
                      sx={{ fontWeight: "inherit", lineHeight: "inherit", minWidth: 0 }}
                      items={[s.name, s.shown_units ? plural(s.shown_units, "item") : plural(s.options, "bundle"), s.top ? "Top pick" : null]}
                    />
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
