# Testing

LastCall is tested at three levels. The backend suite proves the rules about money, stock and allergies against a real PostgreSQL. Static checks keep the web app building. A browser suite drives the real app end to end, including a real payment in the PayPal Sandbox and accessibility scans.

| Layer | Tooling | Size | Runs |
|---|---|---|---|
| Backend suite | pytest, FastAPI `TestClient`, real PostgreSQL | 262 tests in 23 files | Every push to `main` and every pull request (CI) |
| Frontend checks | ESLint, TypeScript, `next build` | | Every push to `main` and every pull request (CI) |
| Browser end to end | Playwright (Chromium), axe-core | 18 tests in 9 spec files | On demand (`e2e` workflow) or locally |

## Commands

```bash
# Backend
cd backend
uv sync                                     # includes the dev group: pytest, ruff, embedded PostgreSQL
uv run pytest                               # the whole suite (about 1.5 minutes on a laptop)
uv run pytest tests/test_checkout.py -k at07   # one area
uv run pytest --collect-only | tail -1      # "262 tests collected"
uv run ruff check .

# Use your own PostgreSQL instead of the embedded one (CI does this)
TEST_DATABASE_ADMIN_URL=postgresql://lastcall:lastcall@localhost:5433/postgres uv run pytest

# Frontend checks (CI runs `npx next typegen` first so route types exist)
cd frontend
npm ci
npx next typegen && npm run lint && npm run typecheck && npm run build

# Browser suite (needs seeded showcase shops and PayPal Sandbox credentials, see below)
cd frontend
npx playwright install chromium
E2E_SHOWCASE_PASSWORD=<SHOWCASE_PASSWORD> npx playwright test
npx playwright test e2e/journey.spec.ts     # one spec
npx playwright test --list                  # list the 18 tests
```

`pyproject.toml` already adds `-q`, so `pytest --collect-only -q` prints per-file counts instead of the total.

## How the backend suite works

The fixtures are in [`backend/tests/conftest.py`](../backend/tests/conftest.py).

**Real PostgreSQL, one database per test.** The session creates a template database and runs every Alembic migration on it once. Each test then gets its own copy (`CREATE DATABASE t_<random> TEMPLATE <template>`), which is dropped afterwards. Row locks, `SKIP LOCKED` job claiming, the append-only audit trigger, `ON CONFLICT` webhook de-duplication and `LISTEN/NOTIFY` all run on the real engine. Without `TEST_DATABASE_ADMIN_URL`, an embedded PostgreSQL (pgserver) is started for the session; CI points the variable at a `postgres:16` service.

**Frozen clock.** Every test starts at 3:00 PM on Tuesday, November 3, 2026, America/Los_Angeles, and moves time explicitly with `clock.advance(...)`. Hold expiry, payment windows, pickup cutoffs, pending PayPal captures and the Monday invoice run are all deterministic.

**Isolated settings.** `override_settings` ignores `backend/.env` and uses test values: `APP_ENV=test`, a fixed secret key, the worker and auto-migration off, `LLM_PROVIDER=none`, and dummy PayPal credentials with a webhook ID. Rate limits are reset per test. Requests go through FastAPI's `TestClient` with an `Origin` header, so the CSRF origin check stays on.

**In-memory PayPal stand-in.** [`backend/tests/fake_paypal.py`](../backend/tests/fake_paypal.py) replaces the Sandbox API for the backend suite (the app itself always talks to the Sandbox). It is wrapped in the same `FaultInjectingClient` as production, and it can play the buyer and the shop:

| Behaviour | How the stand-in mirrors PayPal |
|---|---|
| `PayPal-Request-Id` idempotency | Replays the stored response for a repeated key, and rejects a key reused for a different operation |
| Order validation | One purchase unit, `CAPTURE` intent, item total and amount breakdown must add up, currencies must match, listed payees can be marked invalid (`PAYEE_ACCOUNT_INVALID`) |
| Order lifecycle | `PAYER_ACTION_REQUIRED` to `APPROVED` (via `approve()`) to `COMPLETED`, with `ORDER_NOT_APPROVED` and `ORDER_ALREADY_CAPTURED` errors |
| Declines | `INSTRUMENT_DECLINED` when the `PayPal-Mock-Response` header is set |
| Pending money | Captures and refunds can come back `PENDING` and complete 10 seconds later on the frozen clock |
| Acting for the shop | Refunds and lookups on a shop's capture fail with `403 PERMISSION_DENIED` unless the `PayPal-Auth-Assertion` names that payee; the assertion on every refund is recorded for tests to inspect |
| Refund limits | Refunds above the captured amount fail with `REFUND_AMOUNT_EXCEEDED` |
| Invoicing v2 | Create, send, read, pay (`pay_invoice`) and cancel invoices; duplicate invoice numbers are rejected |
| Log in with PayPal | `sign_in()` issues a single-use code tied to a payer ID, verification flag and email |
| Webhooks | Events are queued as PayPal would send them (refund events name their capture only in the `up` link) and posted to the app by `deliver_webhooks()` with transmission headers. A test HMAC stands in for PayPal's certificate signature, so forged headers fail verification. |

**Scripted model.** By default AI is off (`LLM_PROVIDER=none`) and every feature runs on its deterministic rules. Tests that exercise the model use the `fixture_llm` fixture, a `FixtureProvider` that returns replies queued per task (JSON, tool calls, text, or an exception such as a timeout) and records every call. This is how tests feed the model invented SKUs, prompt injection, unsafe claims, slow turns and outages.

**Background jobs run inline.** The worker is off in tests. `drain_jobs()` runs whatever is due (reconciliation, webhook processing, emails), and `jobs.run_due(..., include_periodic=True)` also schedules the periodic jobs, such as the weekly invoice run.

**Shared flows.** [`backend/tests/helpers.py`](../backend/tests/helpers.py) drives the HTTP API the way the web app does: `quote_lines`, `reserve`, `start_checkout`, `approve`, `capture`, `buy`, `sell_out`. The `bakery` fixture ([`fixtures.py`](../backend/tests/fixtures.py)) creates a live Juniper & Rye Bakehouse with today's surplus, including nut items, cross-contact and unverified allergen records.

### Test files

| File | Tests | Covers |
|---|---:|---|
| [`test_accounts.py`](../backend/tests/test_accounts.py) | 15 | Sign-up, sessions, lockout, password reset, invites, roles |
| [`test_agent_runtime.py`](../backend/tests/test_agent_runtime.py) | 18 | The tool-calling loop: step and time limits, retries, bad tool calls, redaction, traces |
| [`test_assistant.py`](../backend/tests/test_assistant.py) | 4 | The shop's AI teammates feed and opt-out |
| [`test_bundles.py`](../backend/tests/test_bundles.py) | 16 | Bundle engine, concurrency, quote invalidation, strict allergies, model fallback, claim tracing |
| [`test_catalog.py`](../backend/tests/test_catalog.py) | 12 | Storefront, catalog provenance, pickup slots, stock edits, alerts |
| [`test_checkout.py`](../backend/tests/test_checkout.py) | 24 | PayPal checkout and capture, lost responses, webhooks, expiry during payment, refunds, order ownership |
| [`test_closeout.py`](../backend/tests/test_closeout.py) | 15 | Close-out agent: bounds, approval, partial apply, expiry |
| [`test_concierge.py`](../backend/tests/test_concierge.py) | 22 | Ask LastCall agent across shops, allergens, fallbacks, one turn at a time |
| [`test_fees.py`](../backend/tests/test_fees.py) | 7 | Platform fee maths, refunds, weekly PayPal invoices, credits, cancelled and failed invoices |
| [`test_foundation.py`](../backend/tests/test_foundation.py) | 9 | Health, metrics token, CSRF, production settings, audit trail, job queue |
| [`test_fulfillment.py`](../backend/tests/test_fulfillment.py) | 13 | Pickup codes, handoff, lockouts, cancellations, support drafts, shop isolation |
| [`test_insights.py`](../backend/tests/test_insights.py) | 5 | Today overview and insights from real data |
| [`test_live.py`](../backend/tests/test_live.py) | 3 | `NOTIFY` fan-out and topic authorization for live updates |
| [`test_llm_provider.py`](../backend/tests/test_llm_provider.py) | 8 | The LLM adapter (an LLM served through Ollama via LangChain), keys and fallbacks |
| [`test_media.py`](../backend/tests/test_media.py) | 6 | Photo upload, re-encoding, metadata stripping, visibility rules |
| [`test_notifications.py`](../backend/tests/test_notifications.py) | 5 | Receipts, ready and refund emails, SMTP retries |
| [`test_ops.py`](../backend/tests/test_ops.py) | 3 | Platform ops access, evidence trail, gated failure injection |
| [`test_payouts.py`](../backend/tests/test_payouts.py) | 11 | Payout verification, per-shop payee, `PayPal-Auth-Assertion`, Connect with PayPal |
| [`test_shops.py`](../backend/tests/test_shops.py) | 10 | Onboarding, review, settings validation |
| [`test_showcase.py`](../backend/tests/test_showcase.py) | 8 | Showcase seed, daily relisting, bundled photos |
| [`test_support.py`](../backend/tests/test_support.py) | 6 | Support agent: PayPal lookups as the shop, amount guard, outages |
| [`test_unit.py`](../backend/tests/test_unit.py) | 24 | Money, dietary rules, parsing, engine, sanitizers |
| [`test_watches.py`](../backend/tests/test_watches.py) | 18 | Watch alerts agent, email limits, matching |
| **Total** | **262** | |

## Acceptance tests (AT-01 to AT-15)

Backend tests are named `test_atNN_*`. "e2e" refers to the Playwright specs below.

| ID | Requirement | Backend tests | Browser |
|---|---|---|---|
| AT-01 | Eligible, under-budget bundles, or an explicit no-match | `test_bundles.py`: `test_at01_four_people_under_18_no_nuts_only_eligible_bundles`, `test_at01_impossible_budget_returns_explicit_no_match`, `test_at01_budget_pick_is_cheapest_feasible_bundle` | |
| AT-02 | A model-proposed unavailable SKU is rejected | `test_bundles.py`: `test_at02_model_proposed_unavailable_sku_is_rejected` | |
| AT-03 | Simultaneous buyers for the last unit | `test_bundles.py`: `test_at03_simultaneous_buyers_for_last_unit_only_one_reserves` (6 concurrent buyers), `test_at03_many_buyers_never_oversell` (8 buyers, 2 units), real row locks | |
| AT-04 | Stock change invalidates the quote and needs re-approval | `test_bundles.py`: `test_at04_inventory_change_invalidates_quote_and_requires_new_approval`; `test_checkout.py`: `test_at04_superseded_basket_cannot_be_paid` | `journey.spec.ts` |
| AT-05 | Strict allergy with missing evidence is excluded | `test_bundles.py`: `test_at05_strict_allergy_missing_evidence_is_excluded_without_unsafe_substitution` | `allergy.spec.ts`, `concierge.spec.ts` |
| AT-06 | Approval without capture never shows paid | `test_checkout.py`: `test_at06_approval_without_capture_never_shows_paid` | |
| AT-07 | Capture succeeds but the response is lost | `test_checkout.py`: `test_at07_capture_succeeds_but_response_lost_reconciles_without_double_charge`, `test_at07_background_reconciliation_resolves_unknown_outcome` | |
| AT-08 | Duplicate webhook causes a single transition | `test_checkout.py`: `test_at08_duplicate_webhook_causes_single_transition_and_allocation`, `test_at08_unsigned_webhook_is_rejected`, `test_at08_refund_webhooks_find_the_capture_through_its_link` | |
| AT-09 | Hold expires during payment | `test_checkout.py`: `test_at09_reservation_expiry_during_payment_processing_protects_paid_order`, `test_at09_abandoned_checkout_releases_stock_after_reconciliation` | |
| AT-10 | Pickup code handoff, wrong code rejected | `test_fulfillment.py`: `test_at10_pickup_code_completes_handoff_and_wrong_code_is_rejected`, `test_at10_repeated_wrong_codes_lock_staff_out`, `test_at10_unpaid_order_cannot_be_handed_off` | `journey.spec.ts` |
| AT-11 | Refund stays pending until PayPal confirms | `test_checkout.py`: `test_at11_refund_stays_pending_until_provider_confirms_exact_amount` | |
| AT-12 | Keyboard-only selection, substitution and checkout | `test_checkout.py`: `test_at12_validation_errors_are_field_level_and_readable` | `journey.spec.ts` (keyboard) |
| AT-13 | Empty, loading and error states; 360px layout | `test_bundles.py`: `test_at13_model_timeout_falls_back_to_rules` | `layout.spec.ts` |
| AT-14 | Savings and stock claims trace to merchant data | `test_bundles.py`: `test_at14_savings_and_stock_claims_trace_to_merchant_data` | |
| AT-15 | Prompt injection in the catalog | `test_checkout.py`: `test_at15_prompt_injection_in_catalog_cannot_alter_constraints_or_payment` | |

What the PayPal-related ones check:

* **AT-07** arms `capture_response_lost`, captures, then retries as the shopper. The order goes `OUTCOME_UNKNOWN` then `CAPTURED`, PayPal received exactly one capture request and holds one capture. A second test lets the background job resolve it.
* **AT-08** delivers the capture webhook, then posts a second event for the same capture twice: one `capture_verified` audit event, one allocation. Forged transmission headers get `400 webhook_rejected`. The refund test checks that `PAYMENT.CAPTURE.REFUNDED`, whose resource is the refund, is matched to its capture through the `up` link: LastCall's own refund is recorded as `refunds:already_recorded`, while a refund made outside LastCall raises one `external_refund` alert.
* **AT-09** arms `capture_timeout` on the last unit, jumps 40 minutes, runs the hold and payment sweepers and shows the hold stays `PAYMENT_IN_FLIGHT`, a rival buyer can't take the unit, and reconciliation captures it once.
* **AT-11** makes PayPal answer `PENDING`: the order shows "refund pending" with the exact amount and PayPal refund ID, staff without the manager role get `403`, and the refund completes only after reconciliation reads `COMPLETED`.
* **AT-15** puts an injection in a product description and the model's reply; the PayPal order amount still equals the server quote.

Other money tests worth reading: `test_payouts.py` (payee verification, refunds through the account that was paid, Connect with PayPal state checks), `test_fees.py` (fee maths, invoices, credits, cancellations), `test_support.py` (lookups as the shop, amount guard) and `test_ops.py` (gated failure injection and the ops Reconcile button).

## Browser suite (Playwright)

The specs in [`frontend/e2e/`](../frontend/e2e/) drive the real app: Next.js on port 3787 proxying to the API on 8787. [`playwright.config.ts`](../frontend/playwright.config.ts) reuses running servers or starts both (`uv run uvicorn app.main:app --host 127.0.0.1 --port 8787` in `backend/`, and `npm run dev`). Tests run serially in one Chromium worker with a 300-second timeout, no retries, and traces and screenshots kept on failure.

Prerequisites:

* Showcase shops seeded (`python -m app.cli seed-showcase` with `SHOWCASE_PASSWORD`). The specs use Night Owl Doughnuts because it takes pickups 24 hours a day.
* `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` for a Sandbox app in `backend/.env` (the journey pays for real in the Sandbox).
* Optional: `OLLAMA_API_KEY` (otherwise the app uses its rules), `E2E_OPS_EMAIL` and `E2E_OPS_PASSWORD` for the ops spec.

| Variable | Purpose |
|---|---|
| `E2E_SHOWCASE_PASSWORD` | The `SHOWCASE_PASSWORD` the shops were seeded with. Specs that sign in as staff are skipped without it. |
| `E2E_OPS_EMAIL`, `E2E_OPS_PASSWORD` | A platform admin (from `app.cli create-admin`). The ops spec is skipped without them. |
| `E2E_BASE_URL` | Web origin, default `http://localhost:3787` |
| `PAYPAL_TEST_CARD` | Overrides the generated test card number |

| Spec | Tests | What it covers | Needs |
|---|---:|---|---|
| [`journey.spec.ts`](../frontend/e2e/journey.spec.ts) | 1 | The full shopper story, mostly by keyboard: request, bundles, a live sell-out by staff, the review page proposing a change and blocking payment until it is accepted, hold, **real Sandbox payment**, "Paid and verified with PayPal", pickup code, staff mark ready, wrong code rejected, right code hands off, pass updates live | Showcase password, PayPal credentials |
| [`allergy.spec.ts`](../frontend/e2e/allergy.spec.ts) | 1 | "Severe nut allergy" offers only the item with verified allergens and no nut cross-contact | |
| [`concierge.spec.ts`](../frontend/e2e/concierge.spec.ts) | 3 | Ask LastCall on a shop page (allergy respected, "How we picked this", hand-off to review), asking for party size, the home page read-back and follow-up edits | |
| [`layout.spec.ts`](../frontend/e2e/layout.spec.ts) | 6 | No sideways scroll at 360px on five pages, each with an accessibility scan, plus the unknown-shop state | |
| [`accounts.spec.ts`](../frontend/e2e/accounts.spec.ts) | 2 | New owner signs up, creates a shop, sees the setup checklist and invites a teammate who joins as staff; wrong password error | |
| [`assistant.spec.ts`](../frontend/e2e/assistant.spec.ts) | 1 | AI teammates page: a manager hides and re-lists the shop in Ask LastCall; staff can only read | Showcase password |
| [`closeout.spec.ts`](../frontend/e2e/closeout.spec.ts) | 1 | A manager plans the close-out, sees before and after per suggestion, dismisses it; staff read-only | Showcase password |
| [`watch.spec.ts`](../frontend/e2e/watch.spec.ts) | 2 | A signed-in shopper watches a request and stops it from Alerts; guests are asked to sign in | |
| [`ops.spec.ts`](../frontend/e2e/ops.spec.ts) | 1 | Platform ops reads an agent run as a timeline and filters by agent | `E2E_OPS_EMAIL`, `E2E_OPS_PASSWORD` |

**Real Sandbox payment.** [`frontend/e2e/paypal.ts`](../frontend/e2e/paypal.ts) first checks `/api/config` has a client ID, then clicks PayPal's own **Debit or Credit Card** button and pays as a guest, filling either PayPal's checkout window or its inline card form (PayPal varies between the two). Each run generates a fresh Luhn-valid Visa test number, because the shared Sandbox declines generic numbers once they are overused, and fills a US billing address. If PayPal declines the card the test fails fast with a hint to set `PAYPAL_TEST_CARD`.

**Accessibility.** `expectAccessible()` in [`frontend/e2e/helpers.ts`](../frontend/e2e/helpers.ts) runs axe-core with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` tags and fails on any violation. It waits for CSS transitions to finish, and staff sessions use reduced motion. Two exclusions: PayPal's own frames (third-party markup), and the `aria-required-children` rule on the pickup timeline's vendor grid scaffolding only. Scanned screens include the marketplace, storefront, bundle options, change proposal, checkout, pickup pass, five pages at 360px, sign-in, sell, shop setup, AI teammates, close-out plan, concierge answers, alerts and ops agent runs.

**Data effects.** The journey re-lists Night Owl's stock before and after it runs, the close-out spec dismisses its plan and the assistant spec turns its switch back on, so runs leave the showcase as they found it. The accounts and watch specs create new accounts with unique emails.

## Continuous integration

| Workflow | Trigger | What runs |
|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml), job `backend` | Push to `main`, every pull request (a newer run cancels an older one on the same ref) | Ubuntu with a `postgres:16` service and `TEST_DATABASE_ADMIN_URL`; `uv sync --frozen`, `uv run ruff check .`, `uv run pytest` |
| [`ci.yml`](../.github/workflows/ci.yml), job `frontend` | Same | Node 22; `npm ci`, `npx next typegen`, `npm run lint`, `npm run typecheck`, `npm run build` |
| [`e2e.yml`](../.github/workflows/e2e.yml) | Manual only (`workflow_dispatch`), because it makes real Sandbox payments | `postgres:16` service; repository secrets `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and optional `OLLAMA_API_KEY`; seeds the showcase shops with a CI password; installs Chromium; runs every spec; uploads `frontend/test-results` on failure |

The e2e workflow sets no `E2E_OPS_*` variables, so the ops spec is skipped there. It also sets no `PAYPAL_WEBHOOK_ID`: the journey is confirmed from the capture response, not from webhooks.

Deploys are gated on CI: both Render services use `autoDeployTrigger: checksPass`, so a commit deploys only after its checks pass (see [Deployment](deployment.md)).
