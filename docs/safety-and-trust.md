# Safety and trust

The rules that protect shoppers and shops, where the code enforces each one, and the tests that prove it. Acceptance tests are named `test_atNN_*` (AT-01 to AT-15) in [`backend/tests/`](../backend/tests/).

Related: [AI agents](ai-agents.md), [architecture](architecture.md).

## Summary

| Rule | Enforced in | Tests |
|---|---|---|
| Strict allergies fail closed | [`domain.py`](../backend/app/domain.py) `check_dietary`, [`feasibility.py`](../backend/app/services/feasibility.py) | AT-01, AT-05, `test_dietary_rules_fail_closed`, e2e [`allergy.spec.ts`](../frontend/e2e/allergy.spec.ts) |
| Diets are strict, tastes are soft | `check_dietary`, `score_lines` | `test_vegan_requires_verified_flag` |
| Savings only against a documented regular price | `prices` table constraint, [`inventory.py`](../backend/app/services/inventory.py) `set_price`, `price_lines` | AT-14, `test_manager_creates_product_and_prices_never_invent_savings` |
| No fake urgency, no model claims about safety or price | [`ai/sanitize.py`](../backend/app/ai/sanitize.py), [`ai/prompts.py`](../backend/app/ai/prompts.py) | AT-14, AT-15 |
| A changed basket needs the shopper's approval | [`substitution.py`](../backend/app/services/substitution.py), [`quotes.py`](../backend/app/services/quotes.py) | AT-04, `test_price_change_after_quote_requires_customer_approval` |
| Nothing sells twice | [`reservations.py`](../backend/app/services/reservations.py), [`checkout.py`](../backend/app/services/checkout.py) | AT-03, AT-09 |
| Paid means a verified capture | `checkout.apply_capture_result` | AT-06, AT-07, AT-08 |
| Pickup needs the customer's code | [`fulfillment.py`](../backend/app/services/fulfillment.py), [`security.py`](../backend/app/security.py) | AT-10 |
| A refund is complete only when PayPal says so | [`refunds.py`](../backend/app/services/refunds.py) | AT-11 |
| Prompt injection can't change constraints or money | [`intent.py`](../backend/app/services/intent.py), [`recommendation.py`](../backend/app/services/recommendation.py), `sanitize.py` | AT-02, AT-15 |

## 1. Strict allergies fail closed

**From words to a rule.** The deterministic parser in [`intent.py`](../backend/app/services/intent.py) recognises phrases such as "no nuts", "nut-free", "allergic to peanuts", "dairy-free", "gluten free" and "celiac". Groups expand to every allergen they could mean: "nuts" is tree nuts and peanuts, "dairy" is milk, "gluten" is wheat.

* An exclusion is `strict` when allergy wording (allergy, allergic, severe, anaphylaxis, EpiPen, celiac, life-threatening) appears near it.
* Otherwise it is `needs_confirmation`, which is **treated as strict** until the shopper answers "Is avoiding peanuts a strict allergy requirement?".
* The model can add an exclusion but never remove one, and it can make one strict only if the text has allergy wording. Only the shopper's own control removes an exclusion or turns it into a preference.
* In Ask LastCall, allergens from every message in the conversation are applied as strict, whatever the agent passes to its tools.

**The eligibility rule** (`check_dietary` in [`domain.py`](../backend/app/domain.py)):

| The shop's record for the item | Strict, or awaiting confirmation | Preference |
|---|---|---|
| Lists the allergen as an ingredient | Left out: "Contains tree nuts" | Left out |
| Record not verified (needs review, or missing entirely) | Left out: "Allergen information not merchant-verified, so it can't meet a strict tree nuts exclusion" | Allowed, and the bundle notes "allergen info not yet verified for ..." |
| Verified, lists cross-contact | Left out: "May contain tree nuts (cross-contact)" | Allowed |
| Verified, lists neither | Allowed | Allowed |

Missing or uncertain data excludes; there is no default that lets an item through.

**Where it is applied.** Not just once:

* The bundle engine filters every item before it builds any combination (`check_items`).
* `validate_lines` re-checks every basket against the request stored on its quote: model-proposed bundles (L2), quotes, holds (`reservations.acquire`) and accepted substitutions. A hand-built basket with an ineligible item is refused with a `dietary` problem.
* Replacement items for a changed basket come only from eligible items (AT-05: no nut item is offered as a swap).
* Ask LastCall's tool results never contain an ineligible item, so the agent can't pick one.

**Who vouches for the data.** Only managers and owners edit products and allergen records. Marking a record verified stamps the person's name and the date, and changing what it contains, its cross-contact or its status re-stamps it. Shoppers see "Verified by Jordan at the shop on Nov 5, 2026" next to each item.

**What the shopper sees about what was left out:**

* Each bundle's fit line: "Strict: every item is merchant-verified free of tree nuts, peanuts, with no listed cross-contact", sourced to "Merchant-supplied allergen records".
* On a shop's bundle page, **Not included (N)** lists every left-out item with its reasons, under "Left out on purpose. We never force a match." ([`chooser.tsx`](../frontend/src/app/shops/[slug]/bundles/chooser.tsx)).
* In Ask LastCall, **How we picked this** has a "Left out anything risky" step naming the items ruled out at each shop, and each card ends with "Left out at Juniper & Rye Bakehouse: ... Allergen facts come from each shop's own records." The card's check row reads "Juniper & Rye Bakehouse lists every item free of peanuts and tree nuts, with no cross-contact" ([`reasoning.tsx`](../frontend/src/components/concierge/reasoning.tsx), [`fit-card.tsx`](../frontend/src/components/concierge/fit-card.tsx)).
* When nothing qualifies, the answer says so ("No items available today are merchant-verified to meet your dietary needs (tree nuts, peanuts).") and links to every item with its full allergen details, instead of a near match.

**No model claims.** The model never states that something is safe. Prompts forbid it, and [`sanitize.py`](../backend/app/ai/sanitize.py) drops any sentence of model text that mentions allergens, "safe", diets or a free-from claim. In `test_compares_shops_and_applies_every_allergen_the_shopper_typed` the scripted agent forgets the allergy and writes "They are completely nut-free and safe for your son!": no nut item reaches the agent or the cards, and that sentence is removed. AI-drafted product copy can't name an allergen the product doesn't list or claim "free from" anything.

Tests: [`test_unit.py`](../backend/tests/test_unit.py) `test_dietary_rules_fail_closed` (8 cases) and `test_rule_parser_allergy_severity_and_groups`; [`test_bundles.py`](../backend/tests/test_bundles.py) `test_at01_four_people_under_18_no_nuts_only_eligible_bundles` and `test_at05_strict_allergy_missing_evidence_is_excluded_without_unsafe_substitution`; [`test_concierge.py`](../backend/tests/test_concierge.py) `test_an_allergen_from_an_earlier_message_stays_applied`; e2e [`allergy.spec.ts`](../frontend/e2e/allergy.spec.ts) (at a shop where every doughnut shares fryer oil with a peanut item, only the verified savory biscuit is offered).

## 2. Dietary needs and preferences

| The shopper says | Stored as | Effect |
|---|---|---|
| "severe nut allergy", "celiac", "allergic to milk" | Exclusion, `strict` | The fail-closed rule above |
| "no nuts", "dairy-free" (no allergy wording) | Exclusion, `needs_confirmation` | Treated as strict; the shopper is asked whether it is an allergy |
| Answers "No, just a preference" | Exclusion, `preference` | Only items listing it as an ingredient are left out; unverified items are allowed and flagged |
| "vegan", "vegetarian" | Diet | Strict: the item must be marked with that diet **and** its allergen record verified ("Not merchant-verified as vegan") |
| "sweet", "savory", "chocolate", "for kids", "variety" | Preference | Soft: changes the score only and never excludes an item. A card says "the closest fit" when nothing matches |

Budget, party size and pickup time are hard limits in the bundle engine, but the shopper can change them. Allergens and diets are shown as locked chips in Ask LastCall.

## 3. Honest pricing

* **Savings only against a documented regular price.** Every price row has a regular price (`reference_minor`) and where it comes from (`reference_source`, required, for example "Regular menu price for the same item"). The database enforces `reference_minor >= sale_minor` and `sale_minor > 0`, and the API refuses a sale price above the regular price (`invalid_price`: "we never invent savings").
* **Code computes the saving.** `price_lines` sets discount to regular minus sale. It is shown as "Saves $X (Y%) vs. regular menu prices", sourced to "Merchant reference prices", and each shop's policies page explains what its regular price means. PayPal line items carry "Surplus pickup item, regular $X".
* **Price history is append-only.** Each change adds a price row, an inventory event and an audit record with the old and new prices.
* **Close-out cuts only the sale price**, never below 30% of the regular price, and never touches the regular price.
* **No fake urgency.** The model is told never to create urgency, and `sanitize.py` drops phrases such as "hurry", "selling fast", "last chance", "only 2 left", "limited time" and "people are viewing" from model text. Stock counts on the page ("Only 2 left", "Last 3 listed today") come from live availability, and the only countdown a shopper sees is the real expiry of their own hold.
* **No invented amounts.** Model text may only repeat amounts code computed (a card's total, a basket's before and after totals, an order's charge or refund).
* **The shopper pays the shop's price.** LastCall's commission is invoiced to the shop weekly, never added to the shopper's total. The PayPal order is built from the server's quote.

Tests: [`test_bundles.py`](../backend/tests/test_bundles.py) `test_at14_savings_and_stock_claims_trace_to_merchant_data` (every price and stock flag traces to the shop's rows, and the scripted rationale "Hurry, only 2 left! These are nut-free and totally safe. A good sweet and savory spread." keeps only its last sentence); [`test_catalog.py`](../backend/tests/test_catalog.py) `test_manager_creates_product_and_prices_never_invent_savings`, `test_catalog_items_carry_price_allergen_and_availability_provenance`; [`test_closeout.py`](../backend/tests/test_closeout.py) `test_applying_a_price_cut_is_exactly_the_manual_change` (regular price untouched).

## 4. A changed basket needs the shopper's approval

A quote is an immutable snapshot of lines, prices and pickup slot. Anything that changes it creates a new version that the shopper must accept.

* **Triggers:** an item sold out or ran short, was paused, stopped meeting the request, or passed its pickup cutoff; a price changed (for a quote that isn't held; a held quote keeps its price until checkout); or the shopper asked to swap an item.
* **Code chooses the replacement** (`replacement_options`): keep every other line, remove the shortfall, add one eligible item that covers the lost servings within the budget, stock and per-item limits, or offer "remove only" if the rest still feeds the party. The model only explains the change (L3).
* **The offer shows the evidence:** before and after lines and totals, the difference, whether it stays within budget, that pickup is unchanged, allergen evidence for added items, and when stock was checked.
* **Nothing changes until the shopper accepts.** The new quote is `PROPOSED`: it can't be held (`offer_pending`) or paid. Accepting re-validates it, makes it `ACTIVE` and marks the old one `SUPERSEDED`; if stock moved again in the meantime, acceptance is refused ("Stock changed again; we'll prepare a new proposal"). Rejecting changes nothing.
* **Checkout checks again.** Payment starts only on an `ACTIVE` quote, and capture refuses if the quote changed (`quote_changed`) or PayPal's approved amount differs from it (`amount_mismatch`).
* **Policies count too.** When a shop edits its policy text, `policy_version` goes up and shoppers must accept the new version before paying (`policy_changed`).
* Close-out price cuts follow the same rule: open quotes ask the shopper to approve the new price; held quotes keep theirs.

Tests: `test_at04_inventory_change_invalidates_quote_and_requires_new_approval`, `test_price_change_after_quote_requires_customer_approval` ([`test_bundles.py`](../backend/tests/test_bundles.py)); `test_at04_superseded_basket_cannot_be_paid`, `test_held_quote_keeps_its_price` ([`test_checkout.py`](../backend/tests/test_checkout.py)); e2e [`journey.spec.ts`](../frontend/e2e/journey.spec.ts) (staff sell out an item while the shopper is on the review page; the page proposes a change on its own and keeps **Hold items & continue** disabled until the shopper accepts).

## 5. Nothing sells twice

* Availability is derived from hold rows, never a counter: surplus minus active holds, minus paid units not yet handed off, minus the shop's buffer.
* A hold locks the products' stock rows in a fixed order and re-checks everything under the lock, so two buyers for the last unit can't both win.
* A hold with a payment in flight is never released by a timer. It is released only when reconciling with PayPal shows the checkout never reached capture, when the capture fails, or when the shopper cancels before paying.
* A stock edit can't take surplus below what is held or paid (`held_stock`).

Details: [architecture: concurrency rules](architecture.md#concurrency-rules). Tests: `test_at03_simultaneous_buyers_for_last_unit_only_one_reserves` (6 buyers), `test_at03_many_buyers_never_oversell` (8 buyers), `test_held_stock_cannot_be_silently_removed`, `test_expired_hold_is_released_by_the_sweeper` ([`test_bundles.py`](../backend/tests/test_bundles.py)); `test_at09_reservation_expiry_during_payment_processing_protects_paid_order`, `test_at09_abandoned_checkout_releases_stock_after_reconciliation` ([`test_checkout.py`](../backend/tests/test_checkout.py)).

## 6. Paid means a verified capture

* An order shows as paid only after a `COMPLETED` capture whose amount and currency match the quote. Approval alone is not payment.
* A lost or failed capture response becomes `OUTCOME_UNKNOWN` and is resolved by asking PayPal; retries reuse the same `PayPal-Request-Id`, so a shopper is never charged twice.
* Webhooks are verified by signature, de-duplicated by event id, and used only as a hint to re-read PayPal.
* Staff can't pack or hand off an order that isn't paid ("Payment isn't verified for this order. Do not hand it off.").
* Each shop is paid into its own PayPal account, and each payment attempt snapshots that payee, so a refund always goes back through the account that was paid.

Tests: `test_at06_approval_without_capture_never_shows_paid`, `test_at07_*`, `test_at08_*` ([`test_checkout.py`](../backend/tests/test_checkout.py)); `test_at10_unpaid_order_cannot_be_handed_off` ([`test_fulfillment.py`](../backend/tests/test_fulfillment.py)); `test_refund_uses_the_payee_that_was_actually_paid` ([`test_payouts.py`](../backend/tests/test_payouts.py)).

## 7. Pickup-code handoff

* **The code.** Four digits, derived as an HMAC of the order id and a per-order salt under the server secret. The code itself is never stored, only a hash of it. The pickup pass shows it (with a QR code) only once the payment is captured and while the order is open.
* **Handoff** ([`fulfillment.py`](../backend/app/services/fulfillment.py) `handoff`) needs a paid order that is ready, or "mark ready" at the counter, which works only with the right code. The check is deterministic; no model is involved.
* **Attempt limit.** Each wrong code is counted and audited. After 5 wrong codes, staff are locked out of that order (`pickup_locked`) and a manager must verify the pickup. A correct code resets the count; a second handoff is refused (`already_picked_up`).
* **Counter check-in.** The Today screen's check-in box finds an order from a scanned pass, an order number with its code, or the code alone, by checking it against the shop's open orders. Because one box tries every order, 5 misses within 10 minutes lock it for 10 minutes for the whole shop, and only a manager can unlock it early. Scanning a pass that was already collected says so and isn't counted as a miss. Looking up an order hands nothing over.
* **Handoff moves stock.** The units leave surplus and on-hand counts in the same transaction.
* **Missed pickups are never marked collected.** They are flagged for the shop, which follows its own no-show policy.

Tests: `test_at10_pickup_code_completes_handoff_and_wrong_code_is_rejected`, `test_at10_repeated_wrong_codes_lock_staff_out`, `test_handoff_can_mark_ready_at_the_counter_but_only_with_the_right_code`, `test_counter_lookup_locks_after_five_misses_until_a_manager_unlocks`, `test_counter_lookup_lock_expires_and_a_double_scan_is_not_a_miss` ([`test_fulfillment.py`](../backend/tests/test_fulfillment.py)); `test_missed_pickup_is_flagged_never_marked_collected` ([`test_checkout.py`](../backend/tests/test_checkout.py)).

## 8. Refunds

* **Who.** Managers and owners, or the shop's own no-show policy (audited as "Shop policy (automatic)"). Staff get `403`.
* **What.** Only against a verified capture, for at most the captured amount minus what was already refunded, one refund at a time per order. Collected items can't be returned to stock.
* **How.** Through PayPal Payments v2, acting as the shop that was paid (`PayPal-Auth-Assertion` with the snapshotted payee), with a unique `PayPal-Request-Id`.
* **Complete only when PayPal confirms.** A `PENDING` answer stays pending and is reconciled in the background. A lost response becomes `OUTCOME_UNKNOWN` and is replayed with the same request id, which returns the original refund. A rejected refund or a different amount at PayPal raises a high-severity alert. The shopper sees "Order cancelled, refund pending: We'll show the refund as complete once PayPal confirms it." and later "PayPal confirmed your refund."
* **Refunds made outside LastCall** arrive by webhook and raise an alert for the shop.
* **Cancellation requests** are allowed until the shop's cutoff (default 60 minutes before pickup) and reviewed by the shop.
* A completed refund reduces LastCall's fee on that order.

Tests: `test_at11_refund_stays_pending_until_provider_confirms_exact_amount`, `test_at08_refund_webhooks_find_the_capture_through_its_link`, `test_cancellation_window_follows_merchant_policy` ([`test_checkout.py`](../backend/tests/test_checkout.py)).

## 9. The shop's allergen disclosure

Every shop publishes two texts, with defaults set in [`shops.py`](../backend/app/services/shops.py):

* `dietary_disclosure_text`: "Allergen and ingredient information is supplied and verified by the shop. LastCall does not independently certify allergen safety or freshness. If you have a strict allergy, only items the shop has verified are offered, and items listing cross-contact are excluded."
* `cross_contact_text`: "Our kitchen handles common allergens on shared equipment. Cross-contact can never be fully ruled out."

Shoppers see them through the **Allergen disclosure** link on each shop's page (its policies page), and again at checkout under **Shop terms** ("Allergen information" plus a "Cross-contact" warning) before they accept the policies. Platform admins see the disclosure when reviewing a shop. Managers edit both texts in settings ("How it's checked", "Shared equipment"); a change bumps `policy_version`, so shoppers accept the new text before paying.

## 10. Data handling

* **A shopper's own words never reach the shop.** Ask LastCall and watch requests are recorded for the shop only as structured facts (party size, budget, allergens, diets, pickup window) on its AI teammates page and in Insights. `test_each_shop_sees_what_ask_lastcall_did_for_it_as_facts` checks that "daughter" and "allergic" from the request never appear in either shop's view. The shop does see what a customer deliberately sends it: the name and contact entered at checkout, and messages sent from the pickup pass.
* **Contact details stay out of models and logs.** Emails and phone numbers are redacted from text before it is sent to the model, and from every log line, agent step and audit record. Model calls are recorded with a hash of their input, never the input. Chat messages and watch requests are stored redacted.
* **Retention.** The `retention.purge` job replaces customer contact details on finished orders after the shop's `data_retention_days` (default 30).
* **Secrets aren't stored in the clear.** Session, invite, reset and order-link tokens are stored as HMACs; pickup codes only as a hash; passwords with argon2id. PayPal credentials never leave the server, and the browser only talks to the web origin. Platform ops lists email metadata but not bodies, because bodies carry secret links.
* **Photos are re-encoded.** Every upload is decoded, verified and re-encoded to WebP, which strips EXIF and GPS metadata; files over 8 MB or 40 megapixels are refused. A product photo must be one its own shop uploaded ([`media.py`](../backend/app/services/media.py)).
* **The audit log is append-only.** A database trigger rejects any `UPDATE` or `DELETE` on `audit_events`, and metadata is redacted before it is written.

Tests: [`test_assistant.py`](../backend/tests/test_assistant.py) `test_each_shop_sees_what_ask_lastcall_did_for_it_as_facts`; [`test_agent_runtime.py`](../backend/tests/test_agent_runtime.py) `test_tool_arguments_are_redacted_in_the_step_log`; [`test_foundation.py`](../backend/tests/test_foundation.py) `test_audit_events_are_append_only`, `test_cross_site_unsafe_requests_are_blocked`; [`test_checkout.py`](../backend/tests/test_checkout.py) `test_payment_actions_leave_an_immutable_audit_trail`; [`test_media.py`](../backend/tests/test_media.py) `test_upload_is_resized_reencoded_and_stripped`, `test_product_photo_must_be_an_uploaded_asset`.

## 11. What LastCall does not guarantee

* **Allergen and ingredient data are the shop's.** LastCall filters strictly on what the shop records and shows who verified it, but it doesn't inspect ingredients, kitchens or freshness, and cross-contact can never be fully ruled out. Vegan and vegetarian flags are the shop's statement too.
* **A regular price is the shop's statement.** LastCall requires a source for it and never shows a saving without one, but it doesn't audit menus.
* **Not reviewed for real food sales.** Before selling real food, LastCall needs local food-sale, labelling, allergen and consumer-protection review.
* **Test money only.** PayPal runs in the Sandbox, and the API host is fixed so test credentials can't move real money.
* **The model is not a source of truth.** It can be slow, wrong or off. Every feature has a rules path, and nothing the model says about safety, stock or price is shown as fact.
* **Scope.** Pickup only, one shop per basket, USD. Rate limits and metrics are kept per API instance.
