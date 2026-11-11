// Shapes returned by the LastCall API (backend/app/services/*). Money is integer minor units.

export type Severity = "strict" | "preference" | "needs_confirmation";
export type Exclusion = { code: string; severity: Severity };

export type Controls = {
  party_size?: number | null;
  budget_minor?: number | null;
  exclusions?: Exclusion[];
  removed_exclusions?: string[];
  dietary?: string[];
  pickup_date?: string | null;
  pickup_window?: [string, string] | null;
  occasion?: string | null;
  preferences?: string[];
  removed_preferences?: string[];
};

export type Intent = {
  party_size: number | null;
  occasion: string | null;
  budget_minor: number | null;
  currency: string;
  pickup_date: string | null;
  pickup_window: [string, string] | null;
  exclusions: Exclusion[];
  dietary: string[];
  preferences: string[];
};

export type ConfigResponse = {
  /** client_id is null when the server has no PayPal credentials (checkout unavailable). */
  paypal: { client_id: string | null; currency: string };
  ai: { enabled: boolean };
};

export type Slot = {
  id: string;
  starts_at: string;
  ends_at: string;
  start_local: string;
  end_local: string;
  date_local: string;
  label: string;
  capacity: number;
  booked: number;
  remaining: number;
  bookable: boolean;
  unavailable_reason: string | null;
};

export type PickupStatus = {
  state: "open" | "closed_for_today" | "paused" | "unavailable" | "no_surplus";
  today_window: { start: string; end: string; label: string } | null;
  closes_at_label: string | null;
  next_slot: Slot | null;
  bookable_count: number;
  slot_minutes?: number;
};

/** The shop a quote or order belongs to (headers, receipts, "My orders"). */
export type MerchantRef = { id: string; slug: string; name: string; category: string; timezone: string; address: string; phone: string; support_email: string };

/** Directory entry from GET /api/merchants. */
export type MerchantCard = {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  neighborhood: string;
  address: string;
  pickup: PickupStatus;
  surplus: { items_available: number; units_available: number };
  max_saving_percent: number;
  from_minor: number | null;
  currency: string;
  featured: { name: string; image_url: string | null }[];
};

export type MerchantPublic = {
  slug: string;
  name: string;
  category: string;
  tagline: string;
  description: string;
  address: { line1: string; city: string; region: string; postal_code: string; country: string; one_line: string };
  phone: string;
  support_email: string;
  timezone: string;
  currency: string;
  hours_today: { open: string; close: string } | null;
  pickup: PickupStatus;
  verification: { verified_by?: string; verified_at?: string; checks?: string[] };
  policies: {
    cancellation_policy_text: string;
    refund_policy_text: string;
    reference_price_policy_text: string;
    dietary_disclosure_text: string;
    cross_contact_text: string;
    pickup_instructions: string;
    what_to_bring: string;
    cancellation_cutoff_minutes: number;
    reservation_ttl_seconds: number;
    max_units_per_order: number;
  };
  policy_version: number;
  surplus: { items_available: number; units_available: number; as_of: string };
  /** True when a member is previewing a shop that isn't live yet (ordering is disabled). */
  preview: boolean;
};

export type ImageRef = { url: string | null; alt: string };

export type PhotoCredit = {
  product: string;
  shop: { name: string; slug: string };
  image_url: string;
  title: string | null;
  author: string | null;
  source: string | null;
  url: string | null;
  license: string;
  license_url: string | null;
};

export type Allergens = {
  contains: string[];
  cross_contact: string[];
  status: "verified" | "needs_review" | "missing";
  source: string;
  source_label: string;
  verified_by?: string | null;
  verified_at?: string | null;
  notes?: string;
};

export type CatalogItem = {
  product_id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  flavor: string;
  servings_per_unit: number;
  tags: string[];
  image: ImageRef;
  price: { currency: string; reference_minor: number; sale_minor: number; discount_minor: number; discount_pct: number; reference_source: string };
  availability: { available: number; status: "available" | "low" | "sold_out" | "paused" | "past_cutoff"; cutoff_at: string; cutoff_label: string; updated_at: string; per_order_limit: number };
  allergens: Allergens;
  dietary: { vegetarian?: boolean | null; vegan?: boolean | null };
  ingredients: string;
};

export type ParseField = { key: string; label: string; source: "text" | "control" | "ai" | "default" | "system"; status: string; code?: string };
export type Clarification = {
  id: string;
  field: string;
  kind: "number" | "choice";
  question: string;
  help?: string;
  options?: { value: string; label: string }[];
};

export type ParseResponse = {
  intent_id: string | null;
  state: "ready" | "needs_clarification" | "invalid";
  intent: Intent;
  fields: ParseField[];
  clarifications: Clarification[];
  warnings: { field: string; level: "error" | "info"; message: string }[];
  parser: "ai+rules" | "rules";
  ai: { used: boolean; model: string | null; latency_ms: number; fallback_reason: string | null; rejected_fields: string[] };
  summary: string;
};

export type Totals = {
  currency?: string;
  reference_minor: number;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  fees_minor: number;
  total_minor: number;
};

export type BundleLine = {
  sku: string;
  product_id: string;
  name: string;
  qty: number;
  category: string;
  flavor: string;
  unit_sale_minor: number;
  unit_reference_minor: number;
  line_total_minor: number;
  line_reference_minor: number;
  available: number;
  stock_limited: boolean;
  image: ImageRef;
  allergens: Allergens;
  cutoff_label: string;
};

export type FitEvidence = { key: string; ok: boolean; label: string; source?: string };

export type BundleOption = {
  id: string;
  kind: "best_fit" | "budget_pick" | "most_variety";
  label: string;
  origin: "engine" | "ai_candidate";
  lines: BundleLine[];
  totals: Totals;
  units: number;
  servings: number;
  fits: FitEvidence[];
  why: string;
  rationale: { text: string; source: "ai" | "rules" };
  score: { total: number; components: Record<string, { score: number; weight: number; contribution: number; detail: string }> };
  pickup_slots: Slot[];
  default_slot_id: string | null;
  flags: string[];
};

export type NoMatch = { headline: string; reasons: string[]; suggestions: { action: string; label: string; value?: number | string[]; date?: string }[] };

export type Proposal = {
  proposal_id: string;
  merchant: MerchantRef;
  intent_id: string;
  intent: Intent;
  options: BundleOption[];
  no_match: NoMatch | null;
  excluded: { sku: string; name: string; reasons: string[] }[];
  inventory_as_of: string;
  engine: { version: string; weights: Record<string, number>; candidates_considered: number };
  ai: { used: boolean; model?: string | null; latency_ms?: number; fallback_reason?: string | null; rejected_candidates?: number; accepted_candidates?: number };
  pickup_window_slots: Slot[];
};

export type QuoteLine = {
  sku: string;
  product_id: string;
  name: string;
  qty: number;
  unit_sale_minor: number;
  unit_reference_minor: number;
  line_total_minor: number;
  line_reference_minor: number;
  category: string;
  flavor: string;
  servings: number;
  reference_source: string;
  allergens: Allergens;
  image: ImageRef;
  cutoff_at: string;
};

export type Problem = { kind: string; message: string; sku?: string; available?: number };

export type ReservationView = { id: string; state: string; expires_at: string; seconds_left: number | null; expired: boolean; quote_id: string; pickup_slot_id: string };

export type Offer = {
  id: string;
  state: "OFFERED" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  trigger: "stock_change" | "price_change" | "eligibility_change" | "customer_swap";
  reasons: Problem[];
  comparison: {
    currency: string;
    before: { lines: { sku: string; name: string; qty: number; line_total_minor: number }[]; total_minor: number };
    after: { lines: { sku: string; name: string; qty: number; line_total_minor: number }[]; total_minor: number } | null;
    removed: { sku: string; name: string; qty: number }[];
    added: { sku: string; name: string; qty: number; unit_sale_minor: number; allergens: Allergens; image: ImageRef }[];
    changed: { sku: string; name: string; from_qty: number; to_qty: number }[];
    delta_minor: number | null;
    budget_minor: number | null;
    within_budget: boolean;
    pickup: { unchanged: boolean; label: string };
    inventory_checked_at: string;
    inventory_updated_at: string | null;
    no_replacement: boolean;
  };
  alternatives: { kind: string; add_sku: string | null; add_name: string | null; add_qty: number; total_minor: number; delta_minor: number; lines: { sku: string; name: string; qty: number }[] }[];
  explanation: string;
  explanation_source: "ai" | "rules";
  original_quote_id: string;
  proposed_quote_id: string | null;
  created_at: string;
};

export type Quote = {
  id: string;
  lineage_id: string;
  version: number;
  status: "PROPOSED" | "ACTIVE" | "INVALIDATED" | "SUPERSEDED" | "EXPIRED" | "CONVERTED";
  source: string;
  merchant: MerchantRef;
  currency: string;
  lines: QuoteLine[];
  totals: Totals;
  pickup: { id: string; starts_at: string; ends_at: string; label: string };
  expires_at: string;
  seconds_left: number;
  intent: Intent | null;
  dietary_evidence: Record<string, { code: string; status: string }[]>;
  checked_at: string;
  inventory_snapshot: Record<string, { available: number; lot_updated_at: string }>;
  validity: { valid: boolean; problems: Problem[]; checked_at: string } | null;
  reservation: ReservationView | null;
  order: { id: string; number: string; payment_status: string } | null;
  pending_offer: Offer | null;
  latest_quote_id: string | null;
  policy_version: number;
};

export type CheckoutStart = {
  order_id: string;
  order_number: string;
  paypal_order_id: string;
  payment_attempt_id: string;
  amount_minor: number;
  currency: string;
  environment: "sandbox";
  access_token: string | null;
  payment_status: string;
};

export type OrderView = {
  id: string;
  number: string;
  status: { key: string; tone: "success" | "warning" | "danger" | "neutral"; title: string; detail: string };
  payment_status: string;
  fulfillment_status: string;
  refund_status: string;
  amount_minor: number;
  currency: string;
  lines: QuoteLine[];
  totals: Totals | null;
  customer: { name: string | null };
  pickup: {
    label: string;
    date_label: string;
    starts_at: string;
    ends_at: string;
    code: string | null;
    qr_svg: string | null;
    instructions: string;
    what_to_bring: string;
    address: string;
    directions_url: string;
    address_is_fictional: boolean;
    expired: boolean;
  };
  merchant: MerchantRef & { email: string };
  payment: { provider: string; environment: string | null; paypal_order_id: string | null; capture_id: string | null; captured_at: string | null; state: string | null };
  cancellation: {
    allowed_until: string;
    allowed_until_label: string;
    can_request: boolean;
    can_cancel_unpaid: boolean;
    request: { status: string; reason?: string; requested_at?: string; decision_reason?: string } | null;
    policy_text: string;
    refund_policy_text: string;
  };
  refunds: { id: string; amount_minor: number; currency: string; state: string; paypal_refund_id: string | null; created_at: string; completed_at: string | null }[];
  support: { id: string; topic: string; message: string; status: string; staff_reply: string | null; created_at: string; replied_at: string | null }[];
  timeline: { at: string; label: string; action: string }[];
  created_at: string;
  confirmed_at: string | null;
  trace_id: string;
  capture_error?: { issue: string | null; restart: boolean; message: string };
};

// ----------------------------------------------------------------------------- merchant console

export type Role = "staff" | "manager" | "owner";
export type ShopStatus = "draft" | "pending_review" | "live" | "suspended" | "rejected";

export type AccountUser = { id: string; email: string; name: string; phone: string; initials: string; is_platform_admin: boolean };
export type Membership = { membership_id: string; role: Role; shop: { id: string; slug: string; name: string; category: string; status: ShopStatus; timezone: string } };
/** GET /api/auth/me: one account for shopping and, through memberships, for running shops. */
export type Account = { user: AccountUser | null; memberships: Membership[]; active_shop_id: string | null };

/** One row of GET /api/me/orders. */
export type MyOrder = {
  id: string;
  number: string;
  merchant: MerchantRef;
  status: { key: string; tone: "success" | "warning" | "danger" | "neutral"; title: string; detail: string };
  payment_status: string;
  fulfillment_status: string;
  refund_status: string;
  amount_minor: number;
  currency: string;
  units: number;
  item_names: string[];
  pickup: { label: string; date_label: string; starts_at: string };
  active: boolean;
  created_at: string;
};
export type MyOrdersResponse = { signed_in: boolean; orders: MyOrder[]; as_of: string };

export type InventoryRow = {
  product_id: string;
  sku: string;
  name: string;
  category: string;
  status: string;
  image: ImageRef;
  surplus: number;
  on_hand: number;
  reserved: number;
  committed: number;
  buffer: number;
  available: number;
  availability_status: string;
  cutoff_at: string;
  cutoff_local: string;
  cutoff_label: string;
  updated_at: string;
  stale: boolean;
  version: number;
  price: { currency: string; reference_minor: number; sale_minor: number; reference_source: string; effective_at: string; tax_category: string } | null;
  allergens: Allergens;
  attributes: { flavor: string; servings_per_unit: number; tags: string[]; dietary?: { vegetarian?: boolean | null; vegan?: boolean | null }; ingredients?: string };
  description: string;
  description_source: string;
  per_order_limit: number;
  surplus_priority: number;
  relist: { enabled: boolean; qty: number; cutoff_local: string | null };
  /** Units sold today; only on the inventory list. */
  sold_today?: number;
};

export type OrderSummary = {
  id: string;
  number: string;
  customer_name: string | null;
  payment_status: string;
  fulfillment_status: string;
  refund_status: string;
  amount_minor: number;
  currency: string;
  units: number;
  pickup_label: string;
  pickup_starts_at: string;
  pickup_slot_id: string;
  pickup_expired: boolean;
  cancel_requested: boolean;
  open_support: number;
  exception_flags: string[];
  environment: string | null;
  created_at: string;
  confirmed_at: string | null;
};

export type Alert = { id: string; kind: string; severity: "high" | "medium" | "low"; message: string; entity_type: string; entity_id: string; created_at: string };

/** An order's items as the counter sees them. */
export type OrderLine = { name: string; qty: number; line_total_minor: number | null };

/** A pickup-queue entry on Today: paid and not yet handed off, or still paying (its units on hold). */
export type OpenOrder = OrderSummary & { lines: OrderLine[]; hold_expires_at: string | null };

/** What POST /api/merchant/pickups/lookup found for a scanned pass or a typed code. Handoff is a separate step. */
export type PickupLookup = { code: string; matches: (OrderSummary & { lines: OrderLine[]; pickup_locked: boolean })[] };

export type Overview = {
  as_of: string;
  shop: { name: string; status: ShopStatus; timezone: string; pickup_paused: boolean };
  counters: { surplus_units: number; available_units: number; reserved_units: number; committed_units: number; sold_units_today: number };
  orders: { awaiting_pickup: number; ready: number; payment_pending: number; picked_up_today: number };
  sales: { amount_minor: number; currency: string; paid_orders: number };
  slots: Slot[];
  open_orders: OpenOrder[];
  stock: (InventoryRow & { sold_today: number })[];
  alerts: Alert[];
  stale_inventory: { sku: string; name: string; updated_at: string }[];
  paypal: { payouts: PayoutStatus; reachable: boolean | null; checked_at: string | null };
};

export type PayoutStatus = { status: "connected" | "not_connected"; display?: string; verified_at?: string | null };

export type OrderDetail = OrderSummary & {
  customer_contact: { name?: string; email?: string | null; phone?: string | null };
  lines: (QuoteLine & { packed: boolean })[];
  totals: Totals;
  pickup_attempts: number;
  pickup_locked: boolean;
  cancel_request: { status: string; reason?: string; requested_at?: string; decision_reason?: string } | null;
  refundable_minor: number;
  payments: {
    id: string; state: string; environment: string; paypal_order_id: string | null; capture_id: string | null; request_id: string;
    capture_request_id: string | null; amount_minor: number; provider_state: string | null; last_error: unknown; reconcile_count: number;
    created_at: string; captured_at: string | null;
  }[];
  refunds: { id: string; state: string; amount_minor: number; paypal_refund_id: string | null; request_id: string; reason: string; requested_by: string; created_at: string; completed_at: string | null }[];
  support: { id: string; topic: string; message: string; ai_draft: string; ai_draft_source: string; status: string; staff_reply: string | null; replied_by: string | null; created_at: string }[];
  timeline: { at: string; action: string; actor: string; entity: string; meta: Record<string, unknown> }[];
  trace_id: string;
};

export type InsightsItem = {
  product_id: string; name: string; image: ImageRef; category: string; relist_daily: boolean;
  sold: number; listed: number; left: number | null; left_days: number; sold_out_days: number; sold_out_by: string | null; days: number;
  suggestion: { kind: "more" | "fewer" | "keep" | "early"; label: string };
};

/** The owner's view of a week or a month (GET /api/merchant/insights/summary). */
export type InsightsSummary = {
  period: "7d" | "30d";
  days: number;
  start: string;
  end: string;
  compare_start: string;
  compare_end: string;
  currency: string;
  headline: {
    net_sales_minor: number; prev_net_sales_minor: number; prev_daily_average_minor: number; change: number | null;
    orders: number; average_order_minor: number; refunded_minor: number;
    menu_value_minor: number; paid_value_minor: number; saved_minor: number; recovered: number | null;
    sold_units: number; listed_units: number;
    left_at_close: { units: number; menu_value_minor: number; prev_units: number; closed_days: number } | null;
  };
  sales_by_day: { date: string; sales_minor: number; orders: number; today: boolean }[];
  orders_by_hour: number[];
  busiest: { start: number; end: number; label: string; share: number } | null;
  pickup: { slot_fill: number | null; slot_fill_label: string | null; no_shows: number; median_wait_minutes: number | null };
  items: InsightsItem[];
  rule: string;
  missed: { requests: { label: string; count: number }[]; total: number; watching: number; alerts: number; alerts_ordered: number };
  caution: string | null;
  computed_at: string;
};

export type Metric = { value: number | null; numerator?: number; denominator?: number; definition: string };

export type Insights = {
  period: "today" | "7d";
  period_start: string;
  period_end: string;
  currency: string;
  metrics: Record<string, Metric>;
  money: { gross_merchandise_value_minor: number; gmv_label: string; refunded_minor: number; net_captured_sales_minor: number; discounts_given_minor: number; completed_captures: number };
  units: { listed: number; sold: number; remaining: number };
  funnel: { step: string; sessions: number; events: number }[];
  waste_avoided: { reported: boolean; reason: string };
  caution: string | null;
  computed_at: string;
  last_snapshot_at?: string | null;
};

// ----------------------------------------------------------------------------- shop settings and onboarding

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Week = Record<Weekday, [string, string] | null>;
export type Address = { line1: string; city: string; region: string; postal_code: string; country: string };

export type ShopPolicies = {
  cancellation_policy_text: string;
  refund_policy_text: string;
  reference_price_policy_text: string;
  dietary_disclosure_text: string;
  cross_contact_text: string;
  pickup_instructions: string;
  what_to_bring: string;
  cancellation_cutoff_minutes: number;
  reservation_ttl_seconds: number;
  quote_ttl_seconds: number;
  payment_window_seconds: number;
  max_units_per_order: number;
  min_lead_minutes: number;
  low_stock_threshold: number;
  stale_inventory_minutes: number;
  data_retention_days: number;
  no_show_policy: "hold_for_review" | "auto_refund" | "auto_cancel_no_refund";
  no_show_grace_minutes: number;
  relist_at_local: string;
  closeout_enabled?: boolean;
  closeout_lead_minutes?: number;
  tax_rates_bps: Record<string, number>;
  fees_minor: number;
};

export type ShopSettings = {
  shop: {
    id: string; slug: string; name: string; category: string; tagline: string; description: string; phone: string; support_email: string;
    timezone: string; currency: string; address: Address; status: ShopStatus; is_showcase: boolean; review_note: string | null;
    submitted_at: string | null; approved_at: string | null;
    verification: {
      verified_by?: string; verified_at?: string; checks?: string[]; policies_confirmed_at?: string; policies_confirmed_by?: string;
      /** The policy version the owner reviewed; a later edit makes the review stale. */
      policies_version?: number;
    };
  };
  hours: Week;
  pickup: { windows: Week; slot_minutes: number; capacity: number };
  pickup_paused: boolean;
  payouts: PayoutStatus;
  policies: ShopPolicies;
  policy_version: number;
  checklist: { key: "profile" | "hours" | "policies" | "payouts" | "catalog"; label: string; done: boolean }[];
  ready_to_submit: boolean;
  category_suggestions: string[];
  can_edit: boolean;
  can_edit_money: boolean;
};

export type TeamMember = { membership_id: string; user_id: string; name: string; email: string; role: Role; role_label: string; joined_at: string; last_login_at: string | null };
export type TeamInvite = { id: string; email: string; role: Role; role_label: string; expires_at: string; created_at: string };
export type Team = { members: TeamMember[]; invites: TeamInvite[]; assignable_roles: Role[]; you: string };

// ----------------------------------------------------------------------------- shopping concierge (agent)

export type ConciergeCard = {
  option_id: string;
  proposal_id: string;
  option_key: string;
  shop: { slug: string; name: string };
  label: string;
  kind: string;
  lines: { name: string; qty: number; image: ImageRef | null }[];
  units: number;
  total_minor: number;
  reference_minor: number;
  discount_minor: number;
  currency: string;
  fits: FitEvidence[];
  pickup_label: string | null;
  default_slot_id: string | null;
  /** Each part of the request beside what this bundle does about it. */
  checks?: { key: string; asked: string; answer: string; ok: boolean; strict?: boolean }[];
};

export type ConciergeMessage = {
  role: "user" | "assistant";
  text: string;
  at: string;
  cards?: ConciergeCard[];
  questions?: string[];
  source?: "agent" | "rules" | "system";
  details?: ConciergeDetails;
};

/** What a reply was based on: the request as understood, and every shop checked this turn. */
export type ConciergeDetails = {
  understood: { key: string; label: string; strict: boolean; editable: boolean }[];
  /** The request as one sentence; parts with a key are the ones the shopper can tap. */
  ask?: { text: string; key?: string }[];
  shops: {
    slug: string; name: string; options: number; currency: string; from_minor: number | null; reason: string | null;
    left_out: string[]; left_out_count: number; top: boolean; shown: boolean; shown_total_minor: number | null; shown_units: number | null;
  }[];
  listed: number | null;
};

export type Conversation = {
  id: string;
  status: "idle" | "working";
  scope: { slug: string; name: string } | null;
  messages: ConciergeMessage[];
  progress: string[];
};

// ----------------------------------------------------------------------------- watch for me

export type Watch = {
  id: string;
  request: string;
  status: "active" | "paused" | "expired";
  facts: string[];
  shop: { slug: string; name: string } | null;
  expires_at: string;
  last_notified_at: string | null;
  matches_sent: number;
  created_at: string;
};

export type WatchAlert = {
  id: string;
  shop: { slug: string; name: string };
  label: string;
  lines: { name: string; qty: number }[];
  summary: string;
  total_minor: number;
  currency: string;
  pickup_label: string;
  created_at: string;
  seen: boolean;
  opened: boolean;
  watch: { id: string; request: string; status: string } | null;
};

// ----------------------------------------------------------------------------- close-out plan (agent)

export type CloseoutAction = {
  id: string;
  type: "adjust_surplus" | "lower_price" | "pause_listing" | "resume_listing" | "close_slot" | "reopen_slot" | "set_slot_capacity";
  status: "proposed" | "applied" | "skipped" | "failed" | "dropped";
  reason: string;
  title?: string;
  before?: string;
  after?: string;
  note?: string;
  name?: string;
  slot_id?: string;
  slot_label?: string;
  booked?: number;
  old_sale_minor?: number;
  new_sale_minor?: number;
};

export type CloseoutPlan = {
  id: string;
  status: "pending" | "partly_applied" | "applied" | "dismissed" | "expired" | "superseded";
  source: "agent" | "rules";
  summary: string;
  actions: CloseoutAction[];
  created_by: string;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
  expires_label: string;
  run_id: string | null;
};

export type CloseoutState = {
  plan: CloseoutPlan | null;
  schedule: {
    enabled: boolean; lead_minutes: number; runs_at: string | null; runs_at_label: string | null;
    opens_at: string | null; closes_at: string | null; closes_at_label: string | null;
  };
  can_apply: boolean;
};
