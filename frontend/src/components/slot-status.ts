import { BlockRounded, CheckCircleRounded, RemoveCircleOutlineRounded, ScheduleRounded, WarningAmberRounded } from "@mui/icons-material";

import type { Icon, Tone } from "@/components/ui";
import type { Slot } from "@/lib/types";

/** The reason the API gives for a slot a merchant closed by hand (the only state they can undo). */
export const CLOSED_BY_MERCHANT = "This pickup slot was closed by the merchant";

/** "Today 4:00 PM–4:30 PM" → { day: "Today", time: "4:00 PM–4:30 PM" }. */
export function splitLabel(label: string): { day: string; time: string } {
  const match = label.match(/^(.*?)\s+(\d{1,2}:\d{2}.*)$/);
  return match ? { day: match[1], time: match[2] } : { day: "", time: label };
}

export function slotStatus(slot: Slot): { tone: Tone; label: string; icon: Icon; reason?: string } {
  if (slot.unavailable_reason === CLOSED_BY_MERCHANT) return { tone: "neutral", label: "Closed", icon: BlockRounded };
  if (slot.bookable) return { tone: "success", label: "Open", icon: CheckCircleRounded };
  const reason = slot.unavailable_reason ?? undefined;
  if (slot.capacity > 0 && slot.remaining <= 0) return { tone: "warning", label: "Full", icon: WarningAmberRounded, reason };
  if (reason?.includes("started")) return { tone: "neutral", label: "Started", icon: ScheduleRounded, reason };
  return { tone: "neutral", label: "Unavailable", icon: RemoveCircleOutlineRounded, reason };
}
