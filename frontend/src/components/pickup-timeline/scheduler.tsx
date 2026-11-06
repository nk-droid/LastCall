"use client";

// Bryntum Scheduler views for pickup windows and slot capacity. Bryntum can't render on the server,
// so this module is only ever loaded through the `ssr: false` wrappers in ./index.tsx.

import "@bryntum/core-enterprise/fontawesome/css/fontawesome.css";
import "@bryntum/core-enterprise/fontawesome/css/solid.css";
import "@bryntum/scheduler-enterprise/scheduler.css";
import "@bryntum/scheduler-enterprise/material3-light.css";
import "./timeline.css";

import { StringHelper, type DomConfig } from "@bryntum/core-enterprise";
import { EventModelBusiness, type EventModel } from "@bryntum/scheduler-enterprise";
import { BryntumScheduler, type BryntumSchedulerProps } from "@bryntum/scheduler-react-enterprise";
import { useEffect, useMemo, useRef, useState } from "react";

import { useShopZone } from "@/components/shop-zone";
import { slotStatus, splitLabel, CLOSED_BY_MERCHANT } from "@/components/slot-status";
import { hhmmLabel } from "@/lib/format";
import type { Slot, Week, Weekday } from "@/lib/types";
import { brand } from "@/theme/tokens";

// The key is public by design (it ships in the browser bundle); it only lifts the trial badge.
const licenseKey = process.env.NEXT_PUBLIC_BRYNTUM_LICENSE_KEY;
if (licenseKey) (window.bryntum as { licenseKey?: string }).licenseKey = licenseKey;

// --------------------------------------------------------------------------- time helpers

// Both views plot wall-clock times of the shop's day on one reference day, so the browser's own time
// zone never shifts them. 3 Jan 2000 has no DST change in any zone.
const DAY_START = new Date(2000, 0, 3);
const DAY_END = new Date(2000, 0, 4);

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 3, h, m);
}

function atHour(hour: number): Date {
  return hour >= 24 ? DAY_END : new Date(2000, 0, 3, Math.max(0, hour));
}

/** Ends are exclusive on the axis; "23:59" (the API's end of day) and midnight both mean 24:00. */
function atEnd(hhmm: string, start?: Date): Date {
  const end = hhmm === "23:59" ? DAY_END : at(hhmm);
  return start && end <= start ? DAY_END : end;
}

function hhmmOf(date: Date): string {
  if (date >= DAY_END) return "23:59";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function hoursOf(date: Date): number {
  return date >= DAY_END ? 24 : date.getHours() + date.getMinutes() / 60;
}

function rangeLabel(start: Date, end: Date): string {
  return `${hhmmLabel(hhmmOf(start))} – ${end >= DAY_END ? "midnight" : hhmmLabel(hhmmOf(end))}`;
}

/** Short enough for a narrow bar: "4–7 PM", "7 AM–7 PM", "9 PM–midnight", "all day". */
function shortRange(start: Date, end: Date): string {
  if (start <= DAY_START && end >= DAY_END) return "all day";
  const clock = (d: Date) => `${d.getHours() % 12 || 12}${d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, "0")}` : ""}`;
  const period = (d: Date) => (d.getHours() < 12 ? "AM" : "PM");
  if (end >= DAY_END) return `${clock(start)} ${period(start)}–midnight`;
  return period(start) === period(end) ? `${clock(start)}–${clock(end)} ${period(end)}` : `${clock(start)} ${period(start)}–${clock(end)} ${period(end)}`;
}

function hourHeader(start: Date): string {
  const h = start.getHours();
  return h === 0 ? "12 AM" : h === 12 ? "Noon" : `${h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** Whole hours around the given times, padded and at least `minSpan` long. */
function axisAround(starts: number[], ends: number[], pad: number, minSpan: number): { from: number; to: number } {
  if (!starts.length) return { from: 0, to: 24 };
  let from = Math.max(0, Math.floor(Math.min(...starts)) - pad);
  let to = Math.min(24, Math.ceil(Math.max(...ends)) + pad);
  while (to - from < minSpan && (from > 0 || to < 24)) {
    if (to < 24) to += 1;
    if (to - from < minSpan && from > 0) from -= 1;
  }
  return { from, to };
}

/** The shop's current date and time, so "now" matches the slots' wall clock. */
function shopNow(zone?: string): { date: string; time: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: at(`${get("hour")}:${get("minute")}`) };
}

/**
 * These views run on the Business tier (`tier: "business"`), so stores hold Business-tier models; the
 * React wrapper types the store as Enterprise, hence the cast.
 */
function storeOf(modelClass: typeof EventModelBusiness) {
  return { modelClass } as unknown as BryntumSchedulerProps["eventStore"];
}

// Everything these views don't use is switched off, so there are no stray menus or editors.
const QUIET: Partial<BryntumSchedulerProps> = {
  tier: "business",
  autoHeight: true,
  // A single row would otherwise sit on Bryntum's default minimum height, leaving a blank strip.
  minHeight: 0,
  cellEditFeature: false,
  cellMenuFeature: false,
  headerMenuFeature: false,
  sortFeature: false,
  columnReorderFeature: false,
  stripeFeature: false,
  timeAxisHeaderMenuFeature: false,
  scheduleMenuFeature: false,
  scheduleTooltipFeature: false,
  eventDragCreateFeature: false,
  eventEditFeature: false,
  zoomOnMouseWheel: false,
  zoomOnTimeAxisDoubleClick: false,
  managedEventSizing: true,
};

const DAY_COLUMN = { text: "Day", field: "name", width: 110, sortable: false, draggable: false };

// --------------------------------------------------------------------------- weekly hours editor

type Kind = "hours" | "pickup";

class WindowEvent extends EventModelBusiness {
  static fields = [{ name: "kind", type: "string" }];
  declare kind: Kind;
}

const WEEK: { id: Weekday; name: string }[] = [
  { id: "mon", name: "Monday" }, { id: "tue", name: "Tuesday" }, { id: "wed", name: "Wednesday" }, { id: "thu", name: "Thursday" },
  { id: "fri", name: "Friday" }, { id: "sat", name: "Saturday" }, { id: "sun", name: "Sunday" },
];

const KIND_LABEL: Record<Kind, string> = { hours: "Open", pickup: "Pickup" };
const KIND_TITLE: Record<Kind, string> = { hours: "Opening hours", pickup: "Pickup window" };
const HOURS_SWATCH = "#E3E7E2";

/** One lane per day: opening hours fill it as a band, the pickup window sits inside as a pill. */
const ROW = 44;
const PILL_INSET = 9;
function bandLayout(items: { top: number; height: number; eventRecord?: EventModel }[]) {
  for (const item of items) {
    const pickup = (item.eventRecord as unknown as WindowEvent | undefined)?.kind === "pickup";
    item.top = pickup ? PILL_INSET : 0;
    item.height = pickup ? ROW - 2 * PILL_INSET : ROW;
  }
  return ROW;
}

/**
 * The shop's opening hours and pickup window for each weekday, zoomed to the shop's hours. Dragging
 * or resizing a bar reports the new HH:MM pair; the parent form owns the values and the Save button.
 */
export function WeekHoursTimeline({ hours, windows, disabled, onChange }: {
  hours: Week;
  windows: Week;
  disabled?: boolean;
  onChange: (kind: Kind, day: Weekday, value: [string, string]) => void;
}) {
  // Bryntum keeps the listeners it was created with, so they read the latest callback through a ref.
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  });

  const view = useMemo(() => {
    const events: Record<string, unknown>[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    for (const { id: day } of WEEK) {
      for (const [kind, week] of [["hours", hours], ["pickup", windows]] as const) {
        const span = week[day];
        if (!span) continue;
        const startDate = at(span[0]);
        const endDate = atEnd(span[1], startDate);
        starts.push(hoursOf(startDate));
        ends.push(hoursOf(endDate));
        events.push({
          id: `${kind}-${day}`, resourceId: day, kind, startDate, endDate, cls: `lc-kind-${kind}`,
          name: `${KIND_LABEL[kind]} ${shortRange(startDate, endDate)}`,
          eventColor: kind === "pickup" ? brand.leaf : brand.muted,
          eventStyle: kind === "pickup" ? "filled" : "tonal",
        });
      }
    }
    // An hour either side of the shop's day, so a bar can still be stretched a little past it.
    const { from, to } = axisAround(starts, ends, 1, 10);
    return { events: events as BryntumSchedulerProps["events"], startDate: atHour(from), endDate: atHour(to) };
  }, [hours, windows]);

  const sync = (record: EventModel) => {
    const event = record as unknown as WindowEvent;
    report.current(event.kind, event.resourceId as Weekday, [hhmmOf(event.startDate as Date), hhmmOf(event.endDate as Date)]);
  };

  const [config] = useState<BryntumSchedulerProps>(() => ({
    ...QUIET,
    snap: true,
    resources: WEEK,
    columns: [DAY_COLUMN],
    viewPreset: {
      base: "hourAndDay",
      tickWidth: 30,
      headers: [{ unit: "hour", increment: 1, renderer: hourHeader }],
      timeResolution: { unit: "minute", increment: 15 },
    },
    rowHeight: ROW,
    resourceMargin: 8,
    eventLayout: { layoutFn: bandLayout },
    eventStore: storeOf(WindowEvent),
    eventDragFeature: { constrainDragToResource: true, constrainDragToTimeline: true },
    eventResizeFeature: { showTooltip: true },
    eventMenuFeature: false,
    eventTooltipFeature: {
      hoverDelay: 300,
      template: ({ eventRecord }: { eventRecord: EventModel }) => {
        const event = eventRecord as unknown as WindowEvent;
        return `<strong>${KIND_TITLE[event.kind]}</strong><br>${rangeLabel(event.startDate as Date, event.endDate as Date)}`;
      },
    },
  }));

  return (
    <div className="lc-timeline lc-week" aria-label="Weekly opening hours and pickup windows. Drag a bar to move it, or drag its ends to change the times.">
      <BryntumScheduler
        {...config}
        events={view.events}
        startDate={view.startDate}
        endDate={view.endDate}
        readOnly={disabled}
        onAfterEventDrop={({ eventRecords }) => eventRecords.forEach(sync)}
        onEventResizeEnd={({ changed, eventRecord }) => {
          if (changed) sync(eventRecord);
        }}
      />
      <div className="lc-legend" aria-hidden>
        <span><i style={{ background: HOURS_SWATCH }} />Opening hours</span>
        <span><i style={{ background: brand.leaf }} />Pickup window</span>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- slot capacity

class SlotEvent extends EventModelBusiness {
  static fields = [{ name: "fill", type: "number" }, { name: "slotId", type: "string" }, { name: "state", type: "string" }];
  declare fill: number;
  declare slotId: string;
  declare state: string;
}

const FILL_COLOR: Record<string, string> = { Open: brand.leaf, Full: brand.warning };

type SlotUpdate = (slot: Slot, body: { capacity?: number; status?: string }) => void;

/** A slot as a column that fills from the bottom to booked / capacity, with the count above it. */
function slotColumn(event: SlotEvent): DomConfig[] {
  return [
    { className: "lc-hist-label", text: event.name },
    {
      className: "lc-hist-track",
      children: [{ className: "lc-hist-fill", style: { height: `${Math.max(event.fill, 3)}%`, background: FILL_COLOR[event.state] ?? brand.muted } }],
    },
  ];
}

/**
 * Pickup slots on a time axis, one row per day, as columns that fill up as they book. Past time on
 * today's row is shaded. Right-click a slot to change it when `onUpdate` is given.
 */
export function SlotsTimeline({ slots, canEdit, onUpdate }: { slots: Slot[]; canEdit?: boolean; onUpdate?: SlotUpdate }) {
  const zone = useShopZone();

  const view = useMemo(() => {
    const now = shopNow(zone);
    const resources: { id: string; name: string }[] = [];
    const events: Record<string, unknown>[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    for (const slot of slots) {
      if (!resources.some((r) => r.id === slot.date_local)) resources.push({ id: slot.date_local, name: splitLabel(slot.label).day || slot.date_local });
      const startDate = at(slot.start_local);
      const endDate = atEnd(slot.end_local, startDate);
      starts.push(hoursOf(startDate));
      ends.push(hoursOf(endDate));
      const status = slotStatus(slot);
      events.push({
        id: slot.id, slotId: slot.id, resourceId: slot.date_local, startDate, endDate, state: status.label,
        name: `${slot.booked}/${slot.capacity}`,
        fill: slot.capacity ? Math.min(100, Math.round((slot.booked / slot.capacity) * 100)) : 0,
        cls: `lc-slot lc-slot-${status.label.toLowerCase()}`,
        draggable: false,
        resizable: false,
      });
    }
    const { from, to } = axisAround(starts, ends, 0, 1);
    const startDate = atHour(from);
    const endDate = atHour(to);
    const live = resources.some((r) => r.id === now.date) && now.time > startDate && now.time < endDate;
    return {
      byId: new Map(slots.map((s) => [s.id, s])),
      resources,
      events: events as BryntumSchedulerProps["events"],
      startDate,
      endDate,
      // Past time on today's row is shaded; a single-day view also gets a "Now" line.
      resourceTimeRanges: live ? [{ id: "past", resourceId: now.date, startDate, endDate: now.time, name: "", cls: "lc-past" }] : [],
      timeRanges: live && resources.length === 1 ? [{ id: "now", startDate: now.time, name: "Now", cls: "lc-now" }] : [],
      visibleDate: { date: live ? now.time : startDate, block: "start" as const, edgeOffset: 60 },
    };
  }, [slots, zone]);

  // The tooltip and menu are created once, so they read the latest slots and callback through refs.
  const byId = useRef(view.byId);
  const update = useRef(onUpdate);
  useEffect(() => {
    byId.current = view.byId;
    update.current = onUpdate;
  });

  const [config] = useState<BryntumSchedulerProps>(() => ({
    ...QUIET,
    // Open on the current window. Set once: the slot list refreshes every 30 s and must not scroll the view back.
    visibleDate: view.visibleDate,
    columns: [DAY_COLUMN],
    viewPreset: {
      base: "hourAndDay",
      tickWidth: 112,
      headers: [{ unit: "hour", increment: 1, renderer: hourHeader }],
      timeResolution: { unit: "minute", increment: 30 },
    },
    rowHeight: 104,
    barMargin: 2,
    resourceMargin: 6,
    eventStyle: "minimal",
    eventStore: storeOf(SlotEvent),
    eventDragFeature: false,
    eventResizeFeature: false,
    stickyEventsFeature: false,
    eventRenderer: ({ eventRecord, renderData }) => {
      renderData.iconCls = "";
      return slotColumn(eventRecord as unknown as SlotEvent);
    },
    resourceTimeRangesFeature: true,
    timeRangesFeature: { showHeaderElements: true, enableResizing: false },
    eventTooltipFeature: {
      hoverDelay: 150,
      template: ({ eventRecord }: { eventRecord: EventModel }) => {
        const slot = byId.current.get((eventRecord as unknown as SlotEvent).slotId);
        if (!slot) return "";
        const status = slotStatus(slot);
        const time = splitLabel(slot.label).time;
        return `<strong>${StringHelper.encodeHtml(time)}</strong><br>${slot.booked} of ${slot.capacity} booked · ${StringHelper.encodeHtml(status.label)}`
          + (status.reason ? `<br><small>${StringHelper.encodeHtml(status.reason)}</small>` : "");
      },
    },
    eventMenuFeature: canEdit && onUpdate ? {
      // Replace the default edit/delete/copy items with the three things a shop can change on a slot.
      processItems: ({ items, eventRecord }: { items: Record<string, unknown>; eventRecord: EventModel }) => {
        for (const key of Object.keys(items)) delete items[key];
        const slot = byId.current.get((eventRecord as unknown as SlotEvent).slotId);
        const act = update.current;
        if (!slot || !act) return false;
        const closed = slot.unavailable_reason === CLOSED_BY_MERCHANT;
        Object.assign(items, {
          addSpot: { text: "Add a spot", icon: "fa fa-plus", weight: 100, onItem: () => act(slot, { capacity: slot.capacity + 1 }) },
          removeSpot: {
            text: "Remove a spot", icon: "fa fa-minus", weight: 110, disabled: slot.capacity <= Math.max(0, slot.booked),
            onItem: () => act(slot, { capacity: slot.capacity - 1 }),
          },
          toggle: {
            text: closed ? "Reopen slot" : "Close slot", icon: closed ? "fa fa-lock-open" : "fa fa-ban", weight: 120, separator: true,
            onItem: () => act(slot, { status: closed ? "open" : "closed" }),
          },
        });
      },
    } : false,
  }));

  return (
    <div className="lc-timeline lc-slots" aria-label="Pickup slots on a timeline. Each column fills as the slot books up.">
      <BryntumScheduler
        {...config}
        resources={view.resources}
        events={view.events}
        startDate={view.startDate}
        endDate={view.endDate}
        resourceTimeRanges={view.resourceTimeRanges}
        timeRanges={view.timeRanges}
      />
      <div className="lc-legend" aria-hidden>
        <span><i style={{ background: brand.leaf }} />Booked</span>
        <span><i style={{ background: brand.warning }} />Full</span>
        <span><i className="lc-hatch" />Closed</span>
      </div>
    </div>
  );
}
