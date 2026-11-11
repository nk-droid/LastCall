"use client";

// Agent runs for platform ops: the last day at a glance, a list of runs, and the selected run as a timeline of
// model turns and tool calls (each placed where it started within the run), with the chosen step's arguments
// and result. Arguments and results are stored redacted.

import { AutoAwesomeRounded, ErrorOutlineRounded, RouteRounded, SpeedRounded, TollRounded } from "@mui/icons-material";
import { Alert, Box, Grid, ListItemButton, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useState } from "react";

import { ErrorState, LoadingBlock, SectionCard, StatTile, StatusChip, brand, tones, type Tone } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ago } from "@/lib/format";
import { useResource } from "@/lib/use-api";

type Step = {
  idx: number; kind: "tool" | "final" | "message" | "error"; tool: string | null; args: Record<string, unknown>; result: Record<string, unknown>;
  ok: boolean; latency_ms: number; offset_ms: number | null;
};
type Turn = { idx: number; offset_ms: number | null; latency_ms: number; input_tokens: number | null; output_tokens: number | null; result: string };
type Run = {
  id: string; kind: string; status: string; prompt_version: string; steps: number; latency_ms: number; input_tokens: number; output_tokens: number;
  error: string | null; created_at: string; trace: Step[]; turns: Turn[];
};
type Stats = { runs: number; median_ms: number | null; failed: number; input_tokens: number; output_tokens: number };

const KINDS = [
  { key: "", label: "All" },
  { key: "concierge", label: "Concierge" },
  { key: "watch_match", label: "Watch" },
  { key: "closeout", label: "Close-out" },
  { key: "support", label: "Support" },
];
const KIND_LABEL: Record<string, string> = { concierge: "Concierge", watch_match: "Watch match", closeout: "Close-out", support: "Support reply" };
const RUN_TONE: Record<string, Tone> = { done: "success", running: "info", fallback: "neutral", step_limit: "warning", timeout: "warning", error: "danger" };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : seconds(ms));
const count = (n: number) => n.toLocaleString("en-US");
const tick = (ms: number, total: number) => (ms === 0 ? "0 s" : total >= 10_000 ? `${Math.round(ms / 1000)} s` : seconds(ms));

export function AgentRuns() {
  const [kind, setKind] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const runs = useResource((signal) => api<{ runs: Run[]; stats: Stats }>(`/api/ops/agent-runs${kind ? `?kind=${kind}` : ""}`, { signal }), [kind], { pollMs: 15_000 });
  const data = runs.data;
  const selected = data?.runs.find((r) => r.id === picked) ?? data?.runs[0] ?? null;

  return (
    <SectionCard title="Agent runs" icon={<RouteRounded />}
      subtitle="Tool-calling runs, step by step. Agents only call tools that wrap existing checks; anything that moves money waits for a person.">
      <ToggleButtonGroup size="small" exclusive value={kind} aria-label="Filter by agent" sx={{ mb: 2.5, flexWrap: "wrap" }}
        onChange={(_, v: string | null) => { if (v !== null) { setKind(v); setPicked(null); } }}>
        {KINDS.map((k) => <ToggleButton key={k.key} value={k.key} sx={{ px: 1.5, textTransform: "none" }}>{k.label}</ToggleButton>)}
      </ToggleButtonGroup>
      {!data ? (runs.error ? <ErrorState message={errorMessage(runs.error)} onRetry={runs.reload} /> : <LoadingBlock label="Loading agent runs" lines={3} />) : (
        <Stack spacing={2.5}>
          <Grid container spacing={2}>
            <Grid size={{ xs: 6, md: 3 }}><StatTile label="Runs" value={data.stats.runs} caption="last 24 hours" icon={<AutoAwesomeRounded />} /></Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatTile label="Median time" value={data.stats.median_ms === null ? "—" : seconds(data.stats.median_ms)} caption="per run" icon={<SpeedRounded />} tone="info" />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatTile label="Tokens" value={count(data.stats.input_tokens + data.stats.output_tokens)}
                caption={`${count(data.stats.input_tokens)} in · ${count(data.stats.output_tokens)} out`} icon={<TollRounded />} tone="neutral" />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatTile label="Failed or timed out" value={data.stats.failed} caption="the feature fell back to rules" icon={<ErrorOutlineRounded />}
                tone={data.stats.failed ? "warning" : "success"} />
            </Grid>
          </Grid>
          {!data.runs.length ? <Typography color="text.secondary">No agent runs yet.</Typography> : (
            <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(300px, 380px) minmax(0, 1fr)" }, alignItems: "start" }}>
              <RunList runs={data.runs} selected={selected?.id ?? null} onSelect={setPicked} />
              {selected ? <RunTrace key={selected.id} run={selected} /> : null}
            </Box>
          )}
        </Stack>
      )}
    </SectionCard>
  );
}

function RunList({ runs, selected, onSelect }: { runs: Run[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <Box component="ul" aria-label="Runs" sx={{ listStyle: "none", m: 0, p: 0, border: 1, borderColor: brand.line, borderRadius: "14px", overflow: "auto", maxHeight: 560 }}>
      {runs.map((r) => (
        <Box component="li" key={r.id} sx={{ "& + &": { borderTop: 1, borderColor: brand.line } }}>
          <ListItemButton selected={r.id === selected} aria-current={r.id === selected ? "true" : undefined} onClick={() => onSelect(r.id)}
            sx={{ py: 1.25, px: 2, gap: 1.5, alignItems: "flex-start", "&.Mui-selected": { bgcolor: brand.mint, boxShadow: `inset 3px 0 0 ${brand.leaf}` } }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="subtitle2" component="span" sx={{ fontWeight: 700 }}>{KIND_LABEL[r.kind] ?? r.kind}</Typography>
                {r.status !== "done" ? <StatusChip tone={RUN_TONE[r.status] ?? "neutral"} label={r.status.replace("_", " ")} /> : null}
              </Stack>
              <Typography variant="caption" color="text.secondary">{ago(r.created_at)} · {r.steps} step{r.steps === 1 ? "" : "s"}</Typography>
            </Box>
            <Box sx={{ textAlign: "right" }}>
              <Typography variant="body2" className="tabular" sx={{ fontWeight: 600 }}>{seconds(r.latency_ms)}</Typography>
              <Typography variant="caption" color="text.secondary" className="tabular">{count(r.input_tokens)} / {count(r.output_tokens)}</Typography>
            </Box>
          </ListItemButton>
        </Box>
      ))}
    </Box>
  );
}

// ----------------------------------------------------------------------------- timeline

type Row = { key: string; label: string; detail?: string; offset: number | null; latency: number; tone: "turn" | "ok" | "empty" | "error"; step?: Step; turn?: Turn };

function toolLabel(st: Step): { label: string; detail?: string } {
  const shop = typeof st.args.shop === "string" ? st.args.shop : undefined;
  return { label: st.tool ?? st.kind, detail: shop };
}

function toolTone(st: Step): Row["tone"] {
  if (!st.ok || st.kind === "error") return "error";
  const options = st.result.options;
  if ((Array.isArray(options) && !options.length) || st.result.no_match) return "empty";
  return "ok";
}

/** Model turns and tool calls in the order they happened. A final answer (or a rejected call) belongs to the turn that made it. */
function rows(run: Run): Row[] {
  const timed = run.turns.length > 0 && run.turns.every((t) => t.offset_ms !== null);
  const turnRows: Row[] = run.turns.map((t) => ({ key: `t${t.idx}`, label: `Model turn ${t.idx}`, offset: t.offset_ms, latency: t.latency_ms, tone: "turn", turn: t }));
  const out: Row[] = [...turnRows];
  for (const st of run.trace) {
    if (st.kind === "tool") {
      out.push({ key: `s${st.idx}`, ...toolLabel(st), offset: st.offset_ms, latency: st.latency_ms, tone: toolTone(st), step: st });
      continue;
    }
    const owner = timed ? [...turnRows].reverse().find((t) => (t.offset ?? 0) <= (st.offset_ms ?? 0)) : undefined;
    if (owner && st.kind !== "error") {
      owner.detail = st.tool ?? (st.kind === "message" ? "reply" : st.kind);
      owner.step = st;
      continue;
    }
    // A rejected call: shown where its turn ended.
    const end = owner ? (owner.offset ?? 0) + owner.latency : st.offset_ms;
    out.push({ key: `s${st.idx}`, label: st.tool ?? st.kind, detail: "rejected", offset: end, latency: 0, tone: "error", step: st });
  }
  if (!timed) return out.filter((r) => r.step || r.turn);
  return out.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0) || (a.tone === "turn" ? -1 : 0) - (b.tone === "turn" ? -1 : 0));
}

const COLUMNS = "minmax(120px, 210px) minmax(0, 1fr) 64px";
const BAR: Record<Row["tone"], string> = { turn: brand.lineStrong, ok: brand.leaf, empty: brand.warning, error: tones.danger.fg };
const LEGEND: { tone: Row["tone"]; label: string }[] = [
  { tone: "turn", label: "Model thinking" }, { tone: "ok", label: "Tool returned results" },
  { tone: "empty", label: "Tool found nothing that fits" }, { tone: "error", label: "Tool error or rejected call" },
];

function RunTrace({ run }: { run: Run }) {
  const all = rows(run);
  const timed = all.some((r) => r.offset !== null);
  const total = Math.max(run.latency_ms, ...all.map((r) => (r.offset ?? 0) + r.latency), 1);
  const [active, setActive] = useState<string | null>(() => all.find((r) => r.tone !== "turn")?.key ?? all[0]?.key ?? null);
  const current = all.find((r) => r.key === active) ?? null;
  const tools = run.trace.filter((s) => s.kind === "tool").length;
  const pct = (ms: number) => `${(ms / total) * 100}%`;

  return (
    <Box component="section" aria-label={`${KIND_LABEL[run.kind] ?? run.kind} run`} sx={{ border: 1, borderColor: brand.line, borderRadius: "14px", p: { xs: 2, sm: 2.5 }, minWidth: 0 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ justifyContent: "space-between", alignItems: { sm: "baseline" }, mb: 0.5 }}>
        <Typography variant="h4" component="h3">{KIND_LABEL[run.kind] ?? run.kind} · {ago(run.created_at)}</Typography>
        <Typography variant="body2" color="text.secondary" className="tabular">
          {seconds(run.latency_ms)} · {run.turns.length} model turn{run.turns.length === 1 ? "" : "s"} · {tools} tool call{tools === 1 ? "" : "s"}
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "ui-monospace, monospace" }}>{run.prompt_version}</Typography>
      {run.error ? <Alert severity="warning" sx={{ mt: 1.5 }}>{run.error}</Alert> : null}

      {timed ? (
        <Box aria-hidden sx={{ display: { xs: "none", sm: "grid" }, gridTemplateColumns: COLUMNS, gap: 1.5, mt: 2, mb: 0.5 }}>
          <span />
          <Stack direction="row" sx={{ justifyContent: "space-between", color: brand.muted }}>
            {[0, 1 / 3, 2 / 3, 1].map((f) => <Typography key={f} variant="caption" className="tabular">{tick(total * f, total)}</Typography>)}
          </Stack>
          <span />
        </Box>
      ) : <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>Recorded before step timing was kept; durations only.</Typography>}

      <Stack component="ol" aria-label="Timeline" spacing={0.25} sx={{ listStyle: "none", m: 0, p: 0 }}>
        {all.map((r) => (
          <Box component="li" key={r.key}>
            <Box component="button" type="button" onClick={() => setActive(r.key)} aria-pressed={r.key === active}
              sx={{
                all: "unset", boxSizing: "border-box", width: "100%", cursor: "pointer", display: "grid", alignItems: "center", columnGap: 1.5, rowGap: 0.5,
                gridTemplateColumns: { xs: "minmax(0, 1fr) auto", sm: COLUMNS }, gridTemplateAreas: { xs: '"label dur" "bar bar"', sm: '"label bar dur"' },
                px: 1, py: 0.6, mx: -1, borderRadius: "8px",
                bgcolor: r.key === active ? brand.mint : "transparent", "&:hover": { bgcolor: r.key === active ? brand.mint : brand.sand },
                "&:focus-visible": { outline: `2px solid ${brand.leaf}`, outlineOffset: 1 },
              }}>
              <Typography variant="body2" noWrap sx={{ gridArea: "label", fontFamily: r.tone === "turn" ? undefined : "ui-monospace, monospace", fontSize: r.tone === "turn" ? 14 : 13, color: r.tone === "turn" ? brand.muted : brand.forest }}>
                {r.label}{r.detail ? <Box component="span" sx={{ color: brand.muted }}> · {r.detail}</Box> : null}
              </Typography>
              <Box sx={{ gridArea: "bar", position: "relative", height: 16, bgcolor: r.key === active ? "#fff" : brand.cream, borderRadius: "5px" }}>
                {timed && r.offset !== null ? (
                  <Box sx={{ position: "absolute", top: 3, bottom: 3, left: pct(r.offset), width: pct(r.latency), minWidth: 3, maxWidth: `calc(100% - ${pct(r.offset)})`, bgcolor: BAR[r.tone], borderRadius: "3px" }} />
                ) : null}
              </Box>
              <Typography variant="body2" className="tabular" sx={{ gridArea: "dur", textAlign: "right", fontWeight: r.key === active ? 700 : 400 }}>{duration(r.latency)}</Typography>
            </Box>
          </Box>
        ))}
      </Stack>

      {timed ? (
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", mt: 1.5 }}>
          {LEGEND.filter((l) => all.some((r) => r.tone === l.tone)).map((l) => (
            <Stack key={l.tone} direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
              <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: "3px", bgcolor: BAR[l.tone] }} />
              <Typography variant="caption" color="text.secondary">{l.label}</Typography>
            </Stack>
          ))}
        </Stack>
      ) : null}

      {current ? <Detail row={current} /> : null}
    </Box>
  );
}

function Detail({ row }: { row: Row }) {
  const st = row.step;
  const title = `${row.label}${row.detail ? ` · ${row.detail}` : ""}`;
  return (
    <Box sx={{ mt: 2, display: "grid", gap: 1.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "1fr 1fr" } }}>
      {row.turn ? (
        <Box sx={{ gridColumn: "1 / -1" }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: brand.muted }}>{row.label}</Typography>
          <Typography variant="body2" className="tabular">
            {duration(row.turn.latency_ms)} · {count(row.turn.input_tokens ?? 0)} tokens in · {count(row.turn.output_tokens ?? 0)} out · {row.turn.result}
            {st ? ` · ended with ${st.tool ?? st.kind}` : ""}
          </Typography>
        </Box>
      ) : null}
      {st && Object.keys(st.args).length ? (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: brand.muted }}>Arguments · {row.turn ? st.tool : title}</Typography>
          <Box component="pre" sx={{ ...pre, bgcolor: brand.forest, color: brand.mint }}>{JSON.stringify(st.args, null, 2)}</Box>
        </Box>
      ) : null}
      {st && Object.keys(st.result).length ? (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: brand.muted }}>Result</Typography>
          <Box component="pre" sx={{ ...pre, bgcolor: brand.sand, color: st.ok ? brand.forest : tones.danger.fg }}>{JSON.stringify(st.result, null, 2)}</Box>
        </Box>
      ) : null}
    </Box>
  );
}

const pre = {
  m: 0, mt: 0.5, p: 1.5, borderRadius: "12px", fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.55,
  whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 280, overflow: "auto",
} as const;
