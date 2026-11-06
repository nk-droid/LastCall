"use client";

import { TableRowsRounded, ViewTimelineRounded } from "@mui/icons-material";
import { Skeleton, ToggleButton, ToggleButtonGroup } from "@mui/material";
import dynamic from "next/dynamic";

// Bryntum renders in the browser only, and its bundle is large: load it on the pages that show a timeline.
const loading = () => <Skeleton variant="rounded" height={180} aria-label="Loading timeline" />;

export const WeekHoursTimeline = dynamic(() => import("./scheduler").then((m) => m.WeekHoursTimeline), { ssr: false, loading });
export const SlotsTimeline = dynamic(() => import("./scheduler").then((m) => m.SlotsTimeline), { ssr: false, loading });

export type TimelineView = "timeline" | "list";

export function TimelineToggle({ value, onChange, listLabel = "List" }: { value: TimelineView; onChange: (v: TimelineView) => void; listLabel?: string }) {
  return (
    <ToggleButtonGroup size="small" exclusive value={value} onChange={(_, v: TimelineView | null) => v && onChange(v)} aria-label="View">
      <ToggleButton value="timeline" sx={{ gap: 0.5, px: 1.25 }}>
        <ViewTimelineRounded fontSize="small" />
        Timeline
      </ToggleButton>
      <ToggleButton value="list" sx={{ gap: 0.5, px: 1.25 }}>
        <TableRowsRounded fontSize="small" />
        {listLabel}
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
