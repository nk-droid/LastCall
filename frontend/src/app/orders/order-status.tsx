"use client";

import {
  BlockRounded,
  CheckCircleRounded,
  ErrorRounded,
  HourglassTopRounded,
  InfoRounded,
  ReplayRounded,
  ShoppingBagRounded,
  TaskAltRounded,
  TimerOffRounded,
} from "@mui/icons-material";

import { StatusChip, type Icon } from "@/components/ui";
import type { MyOrder } from "@/lib/types";

const STATUS_ICON: Record<string, Icon> = {
  confirmed: CheckCircleRounded,
  ready: ShoppingBagRounded,
  picked_up: TaskAltRounded,
  awaiting_payment: HourglassTopRounded,
  payment_failed: ErrorRounded,
  expired: TimerOffRounded,
  cancelled: BlockRounded,
  refund_pending: ReplayRounded,
  refunded: ReplayRounded,
};

/** The order's customer-facing status (icon + text + color), as on the pickup pass. */
export function OrderStatusChip({ status }: { status: MyOrder["status"] }) {
  return <StatusChip tone={status.tone} icon={STATUS_ICON[status.key] ?? InfoRounded} label={status.title} />;
}
