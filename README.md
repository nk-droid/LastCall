# LastCall

**Surplus bundles from local food shops, paid with PayPal.** A shopper tells a bakery what they need
("snacks for 4 people, under $18, no nuts, pickup after 5"). LastCall builds bundles from that shop's
real end-of-day surplus, holds the stock while they pay with PayPal, and gives them a pickup pass.
Each shop runs its surplus, pickup queue, refunds and team from a tablet-friendly console, and is paid
into its own PayPal business account.

**Live app:** [lastcall-web-pqo4.onrender.com](https://lastcall-web-pqo4.onrender.com)

> Payments run in the **PayPal Sandbox** (test money). The showcase shops, people and addresses are fictional.

## What makes it work

| | |
|---|---|
| **AI where language is the problem** | The model reads the shopper's request, ranks and explains bundles, explains substitutions and drafts product copy. Every output is schema-validated and cross-checked: it can add exclusions but never remove them, can't raise a budget, and can't state allergen safety, prices or urgency. |
| **Agents with tools, not authority** | Four tool-calling agents: **Ask LastCall** compares shops through the bundle engine, **Close-out** drafts price and slot changes a manager approves, **Watch alerts** picks which new bundle to email a waiting shopper, and **Support replies** checks the payment and any refund with PayPal before drafting an answer for staff. Tools wrap existing checks, a slow model turn is retried once, every agent falls back to plain rules, and each run, tool call and model turn is traced in Platform ops. |
| **Code where money and safety are** | Prices, stock, dietary eligibility, pickup capacity, totals and every PayPal amount are deterministic. Strict allergies fail closed: only items the shop verified, with no listed cross-contact. |
| **PayPal end to end** | Shops connect their payout account by signing in with PayPal (Log in with PayPal) or by merchant ID, checked with PayPal before saving. Orders v2 checkout from the server's own quote, server-side capture, per-shop payees, refunds and live payment lookups via Payments v2 with `PayPal-Auth-Assertion`, LastCall's fees billed with Invoicing v2, verified and de-duplicated webhooks, and reconciliation of lost responses without double charging. |
| **Revenue model** | Shoppers pay the shop's price and nothing more, straight to the shop's PayPal account. LastCall keeps **10% of each paid order's items (min $0.25)**: recorded when PayPal confirms the capture, reduced by refunds (waived on a full refund), and billed to each shop every Monday with a **PayPal invoice** (Invoicing v2) it pays in PayPal. No listing or monthly fees. Shops see the fee and what they keep on every order and their invoices in Payouts; **Platform ops → Revenue** shows fees earned, billed and paid. |
| **Honest commerce** | No fake urgency, savings only against a shop's documented regular price, and every changed basket needs the shopper's explicit approval. |

## Try it

The [deployed app](https://lastcall-web-pqo4.onrender.com) opens on four live showcase shops. **Night Owl Doughnuts takes pickups 24 hours a day**, so you can order at any hour.

**As a shopper (no account needed)**
1. Open **Night Owl Doughnuts** (or Juniper & Rye during its 4–7 PM pickup window) and type a request, e.g. *breakfast for 2, severe nut allergy*.
2. Pick a bundle and review it. **Hold items & continue**, enter a name and email, accept the policies and **Pay with PayPal**.
3. In PayPal's window, sign in with a Sandbox buyer account, or choose **Debit or Credit Card** and pay as a guest with a test card from
   [PayPal's card generator](https://developer.paypal.com/tools/sandbox/card-testing/) (any future expiry, any CVV).
4. The pickup pass shows the code once PayPal confirms the capture. It updates live as staff pack and hand off.

**As shop staff**: sign in with the staff credentials in the submission notes. Open an item in someone's basket in **Inventory** and
press **Sold out**: their review page proposes a replacement within a second and won't let them pay until they accept it.
Orders → **Mark ready** → enter the customer's pickup code to hand off. When a customer sends a message from their pickup pass
(e.g. *was I charged twice?*), the order's **Messages** show a reply drafted after checking the payment with PayPal, and what PayPal reported.

**As a new merchant**: **List your shop** → create an account → work through the setup checklist (profile, pickup windows,
policies, **Connect with PayPal**, first products with photos) → submit for review. A platform admin approves it in **Platform ops**.

## Architecture

```mermaid
flowchart LR
  B[Browser] -->|HTTPS| W["Next.js 16 · React 19 · MUI<br/>lastcall-web"]
  W -->|/api/* proxy, private network| A["FastAPI · Python 3.12<br/>lastcall-api"]
  A --> D[(PostgreSQL)]
  A -->|Orders v2 · Payments v2| P[PayPal]
  P -->|verified webhooks| A
  A -->|LangChain ChatOllama| L[LLM]
  A -->|SMTP| M[Email]
  A -. LISTEN/NOTIFY .-> A
  A -->|server-sent events| W
```

* The browser only talks to the Next.js origin; `/api/*` is proxied to the API, so cookies are first-party and no secret reaches the client.
* PostgreSQL is the system of record: money in integer minor units, append-only audit log (enforced by a trigger), durable job queue (`FOR UPDATE SKIP LOCKED`) run by an in-process worker.
* Live updates: every flush that changes an order, a stock lot or a hold emits a `NOTIFY`; each API instance fans them out to subscribers over server-sent events. Clients re-fetch through normal, authorized endpoints.
* Photos are stored in PostgreSQL (re-encoded to WebP, metadata stripped), so they survive deploys on an ephemeral filesystem.

| Area | Where |
|---|---|
| Accounts, sessions, roles, invites, password reset | `backend/app/services/accounts.py`, `team.py`, `access.py` |
| Shop onboarding, review, settings, payouts (Connect with PayPal) | `services/shops.py`, `payouts.py`, `payments/payee.py` |
| Catalog, stock, pickup slots, daily listings | `services/catalog.py`, `inventory.py`, `pickup.py`, `listings.py` |
| Intent parsing (L1), bundles (L2), substitutions (L3) | `services/intent.py`, `feasibility.py`, `recommendation.py`, `substitution.py` |
| Quotes and holds | `services/quotes.py`, `reservations.py`, `holds.py` |
| Checkout, capture, reconciliation, webhooks, refunds | `services/checkout.py`, `webhooks.py`, `refunds.py` |
| LastCall's fees and weekly PayPal invoices | `services/fees.py`, `models/fees.py` |
| Fulfillment, product copy (L4) | `services/fulfillment.py`, `orders.py`, `copywriter.py` |
| Agents: Ask LastCall (A1), Watch alerts (A2), Close-out (A3), Support replies (A4) | `services/concierge.py`, `watches.py`, `closeout.py`, `support.py` |
| LLM adapter and agent loop (versioned prompts, validation, tool calls, retries, traces) | `backend/app/ai/` |
| Live updates | `backend/app/realtime.py`, `api/live.py`, `frontend/src/lib/use-live.ts` |

### Rules enforced in code

* **Stock never oversells.** `available = surplus − active holds − paid-unfulfilled − buffer`, derived from reservation rows. Writers lock inventory rows in a fixed order. Held or paid units can't be removed by a stock edit.
* **"Paid" only after a verified capture.** A timeout or 5xx becomes `OUTCOME_UNKNOWN` and is resolved by looking up the original PayPal order; retries reuse the same `PayPal-Request-Id`. Holds with payment in flight are never released without reconciling first.
* **Each shop is paid directly.** A shop connects its PayPal merchant ID (verified with PayPal before saving; emails aren't accepted because PayPal can't verify them up front). Each payment attempt snapshots its payee, so refunds always go through the account that was paid.
* **Prompt injection can't change constraints or money.** Product text reaches the model as labelled untrusted data; model output that adds unavailable SKUs, unsafe items or prices is rejected.

### Payment and fulfillment states

* Payment: `RESERVED → APPROVAL_PENDING → APPROVED → CAPTURE_REQUESTED → CAPTURED | CAPTURE_PENDING | CAPTURE_FAILED | OUTCOME_UNKNOWN` (`EXPIRED` if abandoned).
* Fulfillment, a separate field: `NEW → PACKING → READY → PICKED_UP`, or `CANCELLED`.
* Refunds: requested → pending → completed only when PayPal confirms; exact amounts and provider IDs kept.

## Run it locally

Requirements: Python 3.12 with [uv](https://docs.astral.sh/uv/), Node 20.9+, a PayPal Sandbox REST app (client ID and secret), and optionally an [Ollama API key](https://ollama.com/settings/keys) (without one the app runs on its deterministic rules).

```bash
# API on :8787. Without DATABASE_URL, an embedded PostgreSQL starts under backend/.data/pg.
cd backend
cp .env.example .env                       # add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (and OLLAMA_API_KEY)
uv sync
SHOWCASE_PASSWORD=choose-a-password uv run python -m app.cli seed-showcase   # four live shops + staff accounts
uv run python -m app.cli create-admin --email you@example.com                # platform admin (prompts for a password)
uv run uvicorn app.main:app --port 8787

# Web app on :3787, proxying /api/* to the API
cd frontend
npm install
npm run dev
```

Staff accounts are `<shop>.<role>@example.com`, e.g. `nightowl.manager@example.com`, `juniperrye.owner@example.com`, with the `SHOWCASE_PASSWORD` you chose. Prefer an external database? `docker compose up -d` and set `DATABASE_URL=postgresql://lastcall:lastcall@localhost:5433/lastcall`.

## Tests

```bash
cd backend && uv run pytest                 # 260 tests on a real PostgreSQL (acceptance tests AT-01…AT-15)
cd frontend && npm run lint && npm run typecheck && npm run build
cd frontend && E2E_SHOWCASE_PASSWORD=<SHOWCASE_PASSWORD> npx playwright test   # real PayPal Sandbox payment, axe WCAG 2.2 AA scans
```

Backend tests clone a migrated template database per test, freeze the clock, use an in-memory stand-in for the PayPal API that plays the buyer (`tests/fake_paypal.py`), and a scripted model. CI runs lint, the backend suite on PostgreSQL 16, and the frontend build on every pull request; the browser suite (which pays in the Sandbox) runs on demand.

| Acceptance test | Covered by |
|---|---|
| AT-01 eligible, under-budget bundles or an explicit no-match | `test_bundles.py::test_at01_*` |
| AT-02 model proposes an unavailable SKU → rejected | `test_at02_*` |
| AT-03 simultaneous buyers for the last unit | `test_at03_*` (6 and 8 concurrent buyers, real row locks) |
| AT-04 stock change → quote invalid, re-approval | `test_at04_*`, e2e journey |
| AT-05 strict allergy + missing evidence → excluded | `test_at05_*`, e2e allergy |
| AT-06 approval without capture never shows paid | `test_checkout.py::test_at06_*` |
| AT-07 capture succeeds, response lost | `test_at07_*` |
| AT-08 duplicate webhook → single transition | `test_at08_*` (+ unsigned-webhook rejection) |
| AT-09 hold expires during payment | `test_at09_*` |
| AT-10 pickup code handoff, wrong code rejected | `test_fulfillment.py::test_at10_*`, e2e journey |
| AT-11 refund pending until the provider confirms | `test_at11_*` |
| AT-12 keyboard-only selection, substitution, checkout | e2e journey |
| AT-13 empty/loading/error states, 360px layout | e2e layout, `test_at13_*` |
| AT-14 savings and stock trace to merchant data | `test_at14_*` |
| AT-15 prompt injection in the catalog | `test_at15_*` |

## Deploy (Render)

`render.yaml` defines the web app, the API and PostgreSQL. In Render: **New → Blueprint**, pick this repository, and fill in the prompted values (`PUBLIC_APP_URL`, PayPal credentials, `OLLAMA_API_KEY`). Migrations run as a pre-deploy step; `SECRET_KEY` and `METRICS_TOKEN` are generated. Then, from the API's Shell:

```bash
SHOWCASE_PASSWORD=... .venv/bin/python -m app.cli seed-showcase      # also attaches the bundled product photos to any product without one
.venv/bin/python -m app.cli create-admin --email you@example.com
```

Finally add a webhook in the PayPal app for `https://<lastcall-api>.onrender.com/api/webhooks/paypal` (events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`) and set its ID as `PAYPAL_WEBHOOK_ID`. For **Connect with PayPal**, turn on *Log in with PayPal* in the same app with the email and PayPal account ID (payer ID) / verification attributes, add `https://<lastcall-web>/merchant/paypal/return` as a return URL, and set `PAYPAL_CONNECT_ENABLED=true` (without it, owners enter their merchant ID). Optional: `PLATFORM_FEE_BPS` / `PLATFORM_FEE_MIN_MINOR` to change the commission (default 1000 = 10%, 25 = $0.25; each order keeps the terms it was paid under); `SMTP_*` for receipts, invites and resets; `SHOWCASE_PAYEE_<SLUG>` to pay each showcase shop's own Sandbox business account.

Operations: `GET /api/health` (database, migrations, worker heartbeat, PayPal), `GET /api/metrics` (Prometheus, bearer `METRICS_TOKEN`), JSON logs with correlation IDs, and **Platform ops** for payments, webhooks, AI calls, jobs, email, traces and the audit log.

## Scope and limits

* PayPal runs in the Sandbox; the API host is fixed so test credentials can never move real money.
* Pickup only, one shop per basket, USD.
* Fees are invoiced weekly rather than split off at checkout: taking a platform fee inside the payment needs PayPal partner onboarding.
* Rate limits are per API instance; sign-in lockout is stored in the database.
* Before selling real food: local food-sale, labelling, allergen and consumer-protection review.

## License

[MIT](LICENSE)
