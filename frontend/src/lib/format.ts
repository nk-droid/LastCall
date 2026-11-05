const EXPONENT: Record<string, number> = { JPY: 0, KRW: 0 };

export function money(minor: number | null | undefined, currency = "USD"): string {
  if (minor === null || minor === undefined) return "—";
  const exp = EXPONENT[currency] ?? 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(
    minor / 10 ** exp,
  );
}

export function timeLabel(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

export function dateTimeLabel(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function hhmmLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export const ALLERGEN_LABEL: Record<string, string> = {
  tree_nuts: "Tree nuts",
  peanuts: "Peanuts",
  milk: "Milk",
  eggs: "Eggs",
  wheat: "Wheat (gluten)",
  soy: "Soy",
  sesame: "Sesame",
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  QUOTED: "Quoted",
  RESERVED: "Reserved",
  APPROVAL_PENDING: "Awaiting PayPal approval",
  APPROVED: "Approved, not captured",
  CAPTURE_REQUESTED: "Capturing",
  CAPTURE_PENDING: "Capture pending at PayPal",
  CAPTURED: "Paid (capture verified)",
  CAPTURE_FAILED: "Payment failed",
  OUTCOME_UNKNOWN: "Confirming with PayPal",
  EXPIRED: "Expired, not charged",
};

export const FULFILLMENT_LABEL: Record<string, string> = {
  NEW: "New",
  PACKING: "Packing",
  READY: "Ready",
  PICKED_UP: "Picked up",
  CANCELLED: "Cancelled",
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
