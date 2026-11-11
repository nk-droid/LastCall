"use client";

import {
  AutoAwesomeRounded,
  ChatRounded,
  CloseRounded,
  EditNoteRounded,
  FormatQuoteRounded,
  HelpOutlineRounded,
  PersonRounded,
  PsychologyRounded,
  SmartToyRounded,
  TuneRounded,
} from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  LinearProgress,
  Skeleton,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { useAnnounce } from "@/components/announcer";
import { useConfig } from "@/components/config";
import { FlowSteps, PageShell } from "@/components/site";
import { FilterChip, PageHeader, QuantityStepper, SectionCard, StatusChip, brand, surface, tones, type Icon, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { flow, useFlowSnapshot } from "@/lib/flow";
import { money } from "@/lib/format";
import type { Clarification, Controls, Exclusion, MerchantPublic, ParseField, ParseResponse, Severity, Slot } from "@/lib/types";
import { useResource } from "@/lib/use-api";

const PROMPTS = [
  "Snacks for 4 people, under $18, no nuts, pickup after 5",
  "Breakfast for 2, something sweet, under $12",
  "Bread and something savory for a dinner for 6",
  "Treats for 3 kids, egg-free",
];
const ALLERGEN_CHOICES: { key: string; label: string; codes: string[] }[] = [
  { key: "nuts", label: "Nuts", codes: ["tree_nuts", "peanuts"] },
  { key: "milk", label: "Dairy", codes: ["milk"] },
  { key: "wheat", label: "Gluten / wheat", codes: ["wheat"] },
  { key: "eggs", label: "Eggs", codes: ["eggs"] },
  { key: "soy", label: "Soy", codes: ["soy"] },
  { key: "sesame", label: "Sesame", codes: ["sesame"] },
];
const PREFERENCES = [
  { key: "sweet_and_savory", label: "Sweet & savory" },
  { key: "sweet", label: "Sweet" },
  { key: "savory", label: "Savory" },
  { key: "pastries", label: "Pastries" },
  { key: "bread", label: "Bread" },
  { key: "variety", label: "Variety" },
  { key: "kid_friendly", label: "Kid-friendly" },
  { key: "chocolate", label: "Chocolate" },
];
const OCCASIONS = ["snacks", "breakfast", "brunch", "dessert", "party", "office", "picnic", "dinner"];

const SOURCE: Record<ParseField["source"], { label: string; icon: Icon }> = {
  text: { label: "Your words", icon: ChatRounded },
  control: { label: "You set this", icon: PersonRounded },
  ai: { label: "AI", icon: SmartToyRounded },
  default: { label: "Default", icon: TuneRounded },
  system: { label: "Note", icon: HelpOutlineRounded },
};
const STATUS_TONE: Record<string, Tone> = {
  confirmed: "success",
  strict: "success",
  needs_confirmation: "warning",
  preference: "info",
  assumed: "info",
  soft: "neutral",
  default: "neutral",
  note: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  confirmed: "confirmed",
  strict: "strict",
  needs_confirmation: "needs your answer",
  preference: "preference",
  assumed: "assumed",
  soft: "preference",
  default: "default",
  note: "",
};

const fieldset = { border: 0, p: 0, m: 0, minWidth: 0 } as const;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <Typography component="label" htmlFor={htmlFor} variant="subtitle2" sx={{ display: "block", mb: 0.75 }}>
      {children}
    </Typography>
  );
}

/** One understood fact as a tinted pill, with an optional remove button (its own 28px target). */
function FieldChip({ tone, label, status, onRemove }: { tone: Tone; label: string; status?: string; onRemove?: () => void }) {
  const t = tones[tone];
  return (
    <Box
      component="span"
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, minHeight: 32, borderRadius: "999px", bgcolor: t.bg, color: t.fg, pl: 1.5, pr: onRemove ? 0.25 : 1.5, fontSize: "0.85rem", fontWeight: 650 }}
    >
      <span>
        {label}
        {status ? (
          <Box component="span" sx={{ fontWeight: 500 }}>
            {" "}
            · {status}
          </Box>
        ) : null}
      </span>
      {onRemove ? (
        <IconButton aria-label={`Remove ${label}`} onClick={onRemove} size="small" sx={{ width: 28, height: 28, color: "inherit", borderRadius: "50%" }}>
          <CloseRounded sx={{ fontSize: 16 }} />
        </IconButton>
      ) : null}
    </Box>
  );
}

export function Composer({ slug }: { slug: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const config = useConfig();
  const announce = useAnnounce();
  const textId = useId();
  const [text, setText] = useState("");
  const [controls, setControls] = useState<Controls>({});
  const [useAi, setUseAi] = useState(true);
  const [live, setLive] = useState<ParseResponse | null>(null);
  const [submitted, setSubmitted] = useState<ParseResponse | null>(null);
  // Questions from the last "Find bundles", kept apart so answering one leaves the others open.
  const [questions, setQuestions] = useState<Clarification[]>([]);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const clarifyRef = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);
  const saved = useFlowSnapshot();
  const shop = useResource((signal) => api<MerchantPublic>(`/api/merchants/${slug}`, { signal }), [slug]);

  // Restore the customer's earlier input once browser storage is readable (after hydration),
  // but only a request started at this shop: another shop's request is never reused.
  if (saved && !hydrated) {
    setHydrated(true);
    if (saved.merchant === slug) {
      if (saved.text) setText(saved.text);
      if (saved.controls) setControls(saved.controls);
      if (saved.useAi === false) setUseAi(false);
    }
  }

  useEffect(() => {
    api<{ slots: Slot[] }>(`/api/merchants/${slug}/pickup-slots`).then((r) => setSlots(r.slots.filter((s) => s.bookable))).catch(() => setSlots([]));
  }, [slug]);

  // Live understanding: deterministic parse (no AI call, nothing stored) as the customer types.
  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setParsing(true);
      api<ParseResponse>("/api/intents/parse", { body: { text, controls, use_ai: false, persist: false, merchant: slug }, signal: controller.signal })
        .then((r) => setLive(r))
        .catch(() => {})
        .finally(() => !controller.signal.aborted && setParsing(false));
    }, 450);
    // The saved request now belongs to this shop; drop another shop's request id.
    flow.set({ merchant: slug, text, controls, useAi, ...(flow.get().merchant !== slug ? { intentId: undefined } : {}) });
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text, controls, useAi, hydrated, slug]);

  const understanding = submitted ?? live;
  const intent = understanding?.intent;

  async function submit(nextControls: Controls = controls) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<ParseResponse>("/api/intents/parse", {
        body: { text, controls: nextControls, use_ai: useAi && !!config?.ai.enabled, persist: true, merchant: slug },
      });
      setSubmitted(result);
      setQuestions(result.clarifications ?? []);
      if (result.state === "ready" && result.intent_id) {
        flow.set({ merchant: slug, intentId: result.intent_id, controls: nextControls, text });
        announce("Request understood. Finding bundles.");
        router.push(`/shops/${slug}/bundles?intent=${result.intent_id}`);
        return;
      }
      if (result.state === "needs_clarification") {
        announce("One more question before we look for bundles.", "assertive");
        window.setTimeout(() => clarifyRef.current?.focus(), 50);
      } else {
        announce("Please fix the highlighted request details.", "assertive");
        window.setTimeout(() => clarifyRef.current?.focus(), 50);
      }
    } catch (err) {
      setError(errorMessage(err));
      announce(errorMessage(err), "assertive");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (hydrated && params.get("start") === "1" && !autoStarted.current && config) {
      autoStarted.current = true;
      const started = flow.get();
      // Only auto-submit a request the storefront of this same shop handed over (after this render).
      if (started.merchant === slug) window.setTimeout(() => void submit(started.controls ?? controls), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, params, config]);

  function setExclusion(codes: string[], on: boolean, severity: Severity = "strict") {
    resolve((c) => codes.includes(c.id.replace("severity:", "")));
    setControls((cur) => {
      const existing = (cur.exclusions ?? []).filter((e) => !codes.includes(e.code));
      const removed = new Set(cur.removed_exclusions ?? []);
      codes.forEach((c) => (on ? removed.delete(c) : removed.add(c)));
      return { ...cur, exclusions: on ? [...existing, ...codes.map((code) => ({ code, severity }))] : existing, removed_exclusions: [...removed] };
    });
  }

  function answer(question: string, value: string) {
    // Each question answers only its own allergen (tree nuts and peanuts are asked separately).
    const code = question.replace("severity:", "");
    setExclusion([code], true, value as Severity);
    announce(`${capitalize(code.replace(/_/g, " "))} saved as ${value === "strict" ? "a strict allergy" : "a preference"}.`);
  }

  /** A changed request: its questions no longer apply. */
  function invalidate() {
    setSubmitted(null);
    setQuestions([]);
  }

  /** Close the answered questions and keep the rest; only "Find bundles" moves on. The summary
   *  switches to the live parse, which reflects the new answer. */
  function resolve(answered: (c: Clarification) => boolean) {
    setQuestions((q) => q.filter((c) => !answered(c)));
    setSubmitted(null);
  }

  const effectiveParty = controls.party_size ?? intent?.party_size ?? null;
  const exclusionState = (codes: string[]): Exclusion | undefined => intent?.exclusions.find((e) => codes.includes(e.code));
  const slotKey = controls.pickup_window ? `${controls.pickup_date ?? ""}|${controls.pickup_window[0]}|${controls.pickup_window[1]}` : "any";
  const errors = (understanding?.warnings ?? []).filter((w) => w.level === "error");
  const infos = (understanding?.warnings ?? []).filter((w) => w.level === "info");
  const clarifications = questions;
  const aiOn = useAi && !!config?.ai.enabled;

  const summaryFields = useMemo(() => (understanding?.fields ?? []).filter((f) => f.status !== "note"), [understanding]);
  const notes = useMemo(() => (understanding?.fields ?? []).filter((f) => f.status === "note"), [understanding]);
  // One strictness row per allergen group, split into its allergens when they differ
  // (e.g. tree nuts answered as strict while peanuts still need an answer).
  const severityRows = ALLERGEN_CHOICES.flatMap((choice) => {
    const members = intent?.exclusions.filter((e) => choice.codes.includes(e.code)) ?? [];
    if (!members.length) return [];
    const whole = members.length === choice.codes.length && members.every((m) => m.severity === members[0].severity);
    return whole
      ? [{ key: choice.key, label: choice.label, codes: choice.codes, severity: members[0].severity }]
      : members.map((m) => ({ key: m.code, label: capitalize(m.code.replace(/_/g, " ")), codes: [m.code], severity: m.severity }));
  });

  return (
    <PageShell shop={shop.data ? { slug, name: shop.data.name } : undefined}>
      <FlowSteps active={0} />
      <PageHeader
        eyebrow={shop.data?.name}
        title="Tell us the occasion"
        subtitle="Type it, use the controls, or both. Controls take priority."
      />

      <Box component="form" onSubmit={(e: React.FormEvent) => { e.preventDefault(); void submit(); }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 7 }}>
            <Stack spacing={3}>
              <SectionCard title="Your request" icon={<EditNoteRounded />}>
                <TextField
                  id={textId}
                  label="What do you need?"
                  multiline
                  minRows={3}
                  fullWidth
                  value={text}
                  onChange={(e) => { setText(e.target.value); invalidate(); }}
                  onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="e.g. snacks for 4 people, under $18, no nuts, pickup after 5"
                  helperText="Optional · Ctrl/⌘ + Enter to search · no personal details"
                  slotProps={{ htmlInput: { maxLength: 600 } }}
                />
                <Stack direction="row" spacing={1.25} useFlexGap role="group" aria-label="Suggested requests" sx={{ flexWrap: "wrap", mt: 2.5 }}>
                  {PROMPTS.map((p) => (
                    <Chip
                      key={p}
                      component="button"
                      type="button"
                      clickable
                      label={p}
                      onClick={() => { setText(p); invalidate(); }}
                      sx={{ ...surface.raisedSm, color: brand.forest, fontWeight: 550, height: "auto", minHeight: 32, py: 0.5, "& .MuiChip-label": { whiteSpace: "normal" }, "&:hover": { bgcolor: "#ECF1EE !important" } }}
                    />
                  ))}
                </Stack>
              </SectionCard>

              <SectionCard title="Constraints" icon={<TuneRounded />}>
                <Grid container spacing={3}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <QuantityStepper
                      label="People"
                      value={effectiveParty ?? 1}
                      min={1}
                      max={40}
                      hint={controls.party_size ? "Set by you" : effectiveParty ? "From your words" : "Not set yet"}
                      onChange={(v) => { invalidate(); setControls((c) => ({ ...c, party_size: v })); }}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <FieldLabel htmlFor={`${textId}-budget`}>Maximum budget</FieldLabel>
                    <TextField
                      id={`${textId}-budget`}
                      type="number"
                      value={controls.budget_minor != null ? controls.budget_minor / 100 : ""}
                      placeholder={intent?.budget_minor ? String(intent.budget_minor / 100) : "No limit"}
                      onChange={(e) => {
                        invalidate();
                        const v = e.target.value;
                        setControls((c) => ({ ...c, budget_minor: v === "" ? null : Math.round(Number(v) * 100) }));
                      }}
                      helperText={controls.budget_minor ? "Set by you" : intent?.budget_minor ? `From your words: ${money(intent.budget_minor)}` : "Empty = no limit"}
                      sx={{ width: 180 }}
                      size="small"
                      slotProps={{
                        htmlInput: { min: 1, max: 1000, step: 1, inputMode: "decimal" },
                        input: { startAdornment: <InputAdornment position="start">$</InputAdornment>, sx: { height: 40 } },
                      }}
                    />
                  </Grid>

                  <Grid size={12}>
                    <Box component="fieldset" sx={fieldset}>
                      <Typography component="legend" variant="subtitle2" sx={{ p: 0 }}>
                        Avoid these allergens
                      </Typography>
                      <Typography variant="caption" color="text.secondary" component="p">
                        Strict = verified free of it, with no cross-contact.
                      </Typography>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1.25 }}>
                        {ALLERGEN_CHOICES.map((choice) => {
                          const active = exclusionState(choice.codes);
                          return (
                            <FilterChip
                              key={choice.key}
                              selected={!!active}
                              label={`No ${choice.label.toLowerCase()}`}
                              onClick={() => setExclusion(choice.codes, !active, active?.severity === "preference" ? "preference" : "strict")}
                            />
                          );
                        })}
                      </Stack>
                      {severityRows.length ? (
                        <Stack spacing={1} sx={{ mt: 1.5 }}>
                          {severityRows.map((row) => (
                            <Stack
                              key={row.key}
                              direction="row"
                              spacing={1}
                              useFlexGap
                              sx={{ ...surface.inset, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between", borderRadius: "16px", px: 2, py: 1.25 }}
                            >
                              <Typography variant="body2" sx={{ fontWeight: 650 }}>
                                No {row.label.toLowerCase()}
                              </Typography>
                              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                                {row.severity === "needs_confirmation" ? <StatusChip tone="warning" label="Choose one" /> : null}
                                <ToggleButtonGroup
                                  exclusive
                                  size="small"
                                  aria-label={`How strict for ${row.label}`}
                                  value={row.severity === "needs_confirmation" ? null : row.severity}
                                  onChange={(_, value: Severity | null) => {
                                    if (value) setExclusion(row.codes, true, value);
                                  }}
                                >
                                  <ToggleButton value="strict" sx={{ px: 1.5 }}>
                                    Strict allergy
                                  </ToggleButton>
                                  <ToggleButton value="preference" sx={{ px: 1.5 }}>
                                    Preference
                                  </ToggleButton>
                                </ToggleButtonGroup>
                              </Stack>
                            </Stack>
                          ))}
                        </Stack>
                      ) : null}
                    </Box>
                  </Grid>

                  <Grid size={{ xs: 12, sm: 6 }}>
                    <FieldLabel htmlFor={`${textId}-occasion`}>Occasion</FieldLabel>
                    <TextField
                      id={`${textId}-occasion`}
                      select
                      fullWidth
                      size="small"
                      value={controls.occasion ?? ""}
                      onChange={(e) => { invalidate(); setControls((c) => ({ ...c, occasion: e.target.value || null })); }}
                      slotProps={{ select: { native: true }, input: { sx: { height: 44 } } }}
                    >
                      <option value="">{intent?.occasion ? `From your words: ${intent.occasion}` : "Not specified"}</option>
                      {OCCASIONS.map((o) => (
                        <option key={o} value={o}>
                          {capitalize(o)}
                        </option>
                      ))}
                    </TextField>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <FieldLabel htmlFor={`${textId}-pickup`}>Pickup time</FieldLabel>
                    <TextField
                      id={`${textId}-pickup`}
                      select
                      fullWidth
                      size="small"
                      value={slotKey}
                      onChange={(e) => {
                        invalidate();
                        const v = e.target.value;
                        if (v === "any") setControls((c) => ({ ...c, pickup_window: null, pickup_date: null }));
                        else {
                          const [date, start, end] = v.split("|");
                          setControls((c) => ({ ...c, pickup_window: [start, end], pickup_date: date }));
                        }
                      }}
                      slotProps={{ select: { native: true }, input: { sx: { height: 44 } } }}
                    >
                      <option value="any">{intent?.pickup_window ? "From your words" : "Any available time"}</option>
                      {slots.map((s) => (
                        <option key={s.id} value={`${s.date_local}|${s.start_local}|${s.end_local}`}>
                          {s.label}
                        </option>
                      ))}
                    </TextField>
                  </Grid>

                  <Grid size={12}>
                    <Box component="fieldset" sx={fieldset}>
                      <Typography component="legend" variant="subtitle2" sx={{ p: 0 }}>
                        Preferences (optional)
                      </Typography>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1.25 }}>
                        {PREFERENCES.map((p) => {
                          const on = intent?.preferences.includes(p.key) ?? false;
                          return (
                            <FilterChip
                              key={p.key}
                              selected={on}
                              label={p.label}
                              onClick={() => {
                                invalidate();
                                setControls((c) => {
                                  const prefs = new Set(c.preferences ?? []);
                                  const removed = new Set(c.removed_preferences ?? []);
                                  if (on) {
                                    prefs.delete(p.key);
                                    removed.add(p.key);
                                  } else {
                                    prefs.add(p.key);
                                    removed.delete(p.key);
                                  }
                                  return { ...c, preferences: [...prefs], removed_preferences: [...removed] };
                                });
                              }}
                            />
                          );
                        })}
                      </Stack>
                    </Box>
                  </Grid>
                </Grid>
              </SectionCard>
            </Stack>
          </Grid>

          <Grid size={{ xs: 12, md: 5 }}>
            <Stack spacing={3} sx={{ position: { md: "sticky" }, top: 88 }}>
              <Box aria-busy={parsing || submitting}>
                <SectionCard
                  title="Live understanding"
                  icon={<PsychologyRounded />}
                  action={<Chip size="small" variant="outlined" label={submitted?.parser === "ai+rules" ? "AI + rules" : "Rules preview"} />}
                  sx={{ position: "relative", overflow: "hidden" }}
                >
                  {parsing || submitting ? (
                    <LinearProgress aria-label="Updating" sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, borderRadius: 0 }} />
                  ) : null}
                  {!understanding ? (
                    <Stack spacing={1}>
                      <Skeleton variant="rounded" height={32} />
                      <Skeleton variant="rounded" height={32} width="66%" />
                    </Stack>
                  ) : summaryFields.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      Start typing or use the controls.
                    </Typography>
                  ) : (
                    <Stack component="ul" spacing={1.25} aria-live="polite" sx={{ m: 0, p: 0, listStyle: "none" }}>
                      {summaryFields.map((f) => {
                        const src = SOURCE[f.source];
                        const removable = f.key.startsWith("exclusion:") || f.key.startsWith("preference:");
                        return (
                          <Stack key={f.key} component="li" direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
                            <FieldChip
                              tone={STATUS_TONE[f.status] ?? "neutral"}
                              label={f.label}
                              status={STATUS_LABEL[f.status] || undefined}
                              onRemove={
                                removable
                                  ? () => {
                                      invalidate();
                                      if (f.key.startsWith("exclusion:")) setExclusion([f.code ?? f.key.split(":")[1]], false);
                                      else
                                        setControls((c) => ({
                                          ...c,
                                          preferences: (c.preferences ?? []).filter((x) => x !== f.key.split(":")[1]),
                                          removed_preferences: [...new Set([...(c.removed_preferences ?? []), f.key.split(":")[1]])],
                                        }));
                                    }
                                  : undefined
                              }
                            />
                            <Typography variant="caption" color="text.secondary" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                              <src.icon aria-hidden sx={{ fontSize: 15 }} />
                              {src.label}
                            </Typography>
                          </Stack>
                        );
                      })}
                    </Stack>
                  )}
                  {notes.length ? (
                    <Stack component="ul" spacing={0.5} sx={{ m: 0, mt: 2, p: 0, listStyle: "none" }}>
                      {notes.map((n) => (
                        <Typography key={n.label} component="li" variant="caption" color="text.secondary" sx={{ display: "flex", gap: 0.5 }}>
                          <HelpOutlineRounded aria-hidden sx={{ fontSize: 15, mt: "1px" }} />
                          {n.label}
                        </Typography>
                      ))}
                    </Stack>
                  ) : null}
                  {submitted?.summary ? (
                    <Box sx={{ ...surface.inset, mt: 2.5, display: "flex", gap: 1, borderRadius: "16px", p: 2 }}>
                      <FormatQuoteRounded aria-hidden sx={{ color: brand.leaf, fontSize: 20 }} />
                      <Typography variant="body2" sx={{ fontStyle: "italic" }}>
                        {submitted.summary}
                      </Typography>
                    </Box>
                  ) : null}
                </SectionCard>
              </Box>

              <Box ref={clarifyRef} tabIndex={-1} sx={{ outline: "none", display: "grid", gap: 2, "&:empty": { display: "none" } }}>
                {errors.length ? (
                  <Alert severity="error" role="alert">
                    <AlertTitle>Please adjust your request</AlertTitle>
                    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                      {errors.map((w) => (
                        <li key={w.message}>{w.message}</li>
                      ))}
                    </Box>
                  </Alert>
                ) : null}
                {clarifications.map((q) => (
                  <Card key={q.id} component="section" aria-labelledby={`${q.id}-q`}>
                    <CardContent sx={{ p: 3, "&:last-child": { pb: 3 } }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                        <HelpOutlineRounded aria-hidden sx={{ color: tones.warning.fg, mt: "2px" }} />
                        <Box sx={{ minWidth: 0 }}>
                          <Typography id={`${q.id}-q`} component="h2" variant="h5">
                            {q.question}
                          </Typography>
                          {q.help ? (
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                              {q.help}
                            </Typography>
                          ) : null}
                        </Box>
                      </Stack>
                      {q.kind === "choice" ? (
                        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: "wrap", mt: 2.5 }}>
                          {q.options?.map((o) => (
                            <Button key={o.value} variant={o.value === "strict" ? "contained" : "outlined"} color={o.value === "strict" ? "primary" : "inherit"} onClick={() => answer(q.id, o.value)}>
                              {o.label}
                            </Button>
                          ))}
                        </Stack>
                      ) : (
                        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "flex-end", flexWrap: "wrap", mt: 2 }}>
                          <QuantityStepper label="People" value={controls.party_size ?? 2} min={1} max={40} onChange={(v) => setControls((c) => ({ ...c, party_size: v }))} />
                          <Button
                            variant="contained"
                            onClick={() => {
                              setControls((c) => ({ ...c, party_size: c.party_size ?? 2 }));
                              resolve((c) => c.id === "party_size");
                            }}
                          >
                            Done
                          </Button>
                        </Stack>
                      )}
                    </CardContent>
                  </Card>
                ))}
                {infos.map((w) => (
                  <Alert key={w.message} severity="info" role="status">
                    {w.message}
                  </Alert>
                ))}
                {error ? (
                  <Alert severity="error" role="alert">
                    <AlertTitle>We couldn&apos;t read your request</AlertTitle>
                    {error}
                  </Alert>
                ) : null}
              </Box>

              <Card sx={{ ...surface.inset, borderRadius: "18px" }}>
                <CardContent sx={{ px: 2.5, py: 2, "&:last-child": { pb: 2 } }}>
                  <FormControlLabel
                    control={<Switch checked={aiOn} disabled={!config?.ai.enabled} onChange={(e) => setUseAi(e.target.checked)} />}
                    label={
                      <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, fontWeight: 650 }}>
                        <AutoAwesomeRounded aria-hidden sx={{ fontSize: 18, color: brand.leaf }} />
                        Use AI to understand my words
                      </Box>
                    }
                    sx={{ mr: 0 }}
                  />
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5, pl: 6.5 }}>
                    {config?.ai.enabled
                      ? "Sent to an AI model without emails or phone numbers. The AI can't change prices, stock, allergens or payments."
                      : "AI is off on this server; standard rules are used."}
                  </Typography>
                </CardContent>
              </Card>

              <Button type="submit" variant="contained" size="large" fullWidth loading={submitting} loadingPosition="start" startIcon={<AutoAwesomeRounded />}>
                {submitting ? (aiOn ? "Understanding your request…" : "Checking…") : "Find bundles"}
              </Button>
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </PageShell>
  );
}
