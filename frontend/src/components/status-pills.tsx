"use client";

import {
  BlockRounded,
  CheckCircleRounded,
  CreditCardRounded,
  ErrorRounded,
  HourglassTopRounded,
  Inventory2Rounded,
  ReplayRounded,
  ShoppingBagRounded,
  SyncRounded,
  TaskAltRounded,
} from "@mui/icons-material";

import { FULFILLMENT_LABEL, PAYMENT_STATUS_LABEL } from "@/lib/format";

import { StatusChip, type Icon, type Tone } from "./ui";

const PAYMENT_TONE: Record<string, Tone> = {
  CAPTURED: "success",
  CAPTURE_FAILED: "danger",
  OUTCOME_UNKNOWN: "warning",
  CAPTURE_PENDING: "warning",
  CAPTURE_REQUESTED: "warning",
  APPROVED: "info",
  APPROVAL_PENDING: "info",
  RESERVED: "neutral",
  EXPIRED: "neutral",
};

export function PaymentPill({ status }: { status: string }) {
  const icon: Icon =
    status === "CAPTURED"
      ? CheckCircleRounded
      : status === "CAPTURE_FAILED"
        ? ErrorRounded
        : ["OUTCOME_UNKNOWN", "CAPTURE_PENDING", "CAPTURE_REQUESTED"].includes(status)
          ? SyncRounded
          : status === "EXPIRED"
            ? BlockRounded
            : CreditCardRounded;
  return <StatusChip tone={PAYMENT_TONE[status] ?? "neutral"} icon={icon} label={PAYMENT_STATUS_LABEL[status] ?? status} />;
}

export function FulfillmentPill({ status }: { status: string }) {
  const tone: Tone = status === "READY" ? "success" : status === "CANCELLED" ? "danger" : status === "PACKING" ? "info" : "neutral";
  const icon: Icon =
    status === "READY" ? ShoppingBagRounded : status === "PICKED_UP" ? TaskAltRounded : status === "CANCELLED" ? BlockRounded : status === "PACKING" ? Inventory2Rounded : HourglassTopRounded;
  return <StatusChip tone={tone} icon={icon} label={FULFILLMENT_LABEL[status] ?? status} />;
}

export function RefundPill({ status }: { status: string }) {
  if (status === "NONE") return null;
  const tone: Tone = status === "COMPLETED" ? "success" : status === "FAILED" ? "danger" : "warning";
  const label = status === "COMPLETED" ? "Refunded" : status === "FAILED" ? "Refund failed" : "Refund pending";
  return <StatusChip tone={tone} icon={ReplayRounded} label={label} />;
}
