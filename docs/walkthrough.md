# Walkthrough

A hands-on tour of the [live app](https://lastcall-web-pqo4.onrender.com) in about ten minutes. Each step says what to do and what to look for. The [demo video](https://youtu.be/fwakWJYfCAw) shows the same flows in three minutes.

## Before you start

* **Payments run in the PayPal Sandbox.** No real money moves. In PayPal's window, choose **Debit or Credit Card** and pay as a guest with a card from [PayPal's card generator](https://developer.paypal.com/tools/sandbox/card-testing/) (any future expiry, any CVV), or sign in with a Sandbox buyer account. If the card form defaults to another country, switch it to **United States**.
* **Staff and admin sign-ins** are in the submission notes. Shop staff accounts follow `<shop>.<role>@example.com`, for example `nightowl.manager@example.com`.
* **Pickup windows are in Pacific time.** Night Owl Doughnuts takes pickups around the clock, so it always works:

| Shop | Kind | Pickup window (PT) |
|---|---|---|
| Night Owl Doughnuts | Doughnut shop | All day |
| Copper Kettle Café | Café | 2:00 PM to 6:00 PM |
| Juniper & Rye Bakehouse | Bakery | 4:00 PM to 7:00 PM |
| Saffron Table | Restaurant | 4:00 PM to 7:00 PM |
| Golden Bun Bakery | Asian bakery | 5:00 PM to 9:00 PM |

Shops relist their surplus each morning, so a shop may show nothing left late in its day.

## 1. Order as a shopper (no account needed)

1. On the home page, ask **Ask LastCall**, for example *breakfast for 2 under $10* (any time), or *dinner for 2 tonight, my partner has a severe nut allergy* (during the evening windows).
2. Watch it check each open shop. In the answer, look for:
   * **"You asked for"**: what it understood. A severe allergy becomes a locked, strict rule the shopper can't loosen by accident.
   * **Itemised bundles** with photos, the shop's own price and the saving against its documented regular price.
   * **How it fits**: each part of the request matched to the bundle, with the allergen evidence and who verified it.
   * **Left out**: which items were excluded and why.
3. Choose **Hold & pay**. The items are reserved for you while you pay, so nothing sells twice.
4. Enter a name and email, accept the policies, and pay in PayPal's window.
5. The order page shows **Paid and verified with PayPal** only after the server has captured the payment. Your pickup pass shows a 4-digit code and a QR code, and it updates live as the shop packs and hands over the order.
6. From the pass, send the shop a message such as *was I charged twice?* (used in step 3).

**Try the fail-closed rule:** open **Night Owl Doughnuts**, press the floating **Ask LastCall** button (on a shop's page it looks only at that shop) and ask for *snacks for 4, my son has a severe milk allergy*. Every item there lists milk, and the one that may not hasn't been verified by the shop, so nothing is offered, and the answer says why instead of guessing.

## 2. Run a shop (staff sign-in)

Sign in as a manager of the shop you ordered from.

| Where | Try | Look for |
|---|---|---|
| **Inventory** | With your bundle open on its review page in another window, mark one of its items **Sold out**. | Within about a second, the shopper's page proposes a replacement and blocks payment until they accept it. |
| **Orders** | Open your order, **Mark ready**, then type the pickup code and **Verify code & hand off**. | The pass changes to Ready, then Picked up, live. Wrong codes are counted and limited. |
| **Orders, Messages** | Open the message you sent. | The support agent's draft, marked **AI draft, checked with PayPal**, with the payment and refund status it read from PayPal. Staff edit and send it. |
| **Orders** | **Refund…** an order. | The refund goes through the shop's own PayPal account. It shows as complete only when PayPal confirms it. |
| **Today** | **Plan close-out**. | The close-out agent's plan for what's left (price cuts, slot changes). Each change is checked against the price floor (30% of the regular price) and live stock, and nothing applies until a manager approves. |
| **Assistant** | Open each AI teammate. | What each of the four agents did today and what is waiting for a person. |
| **Insights** | Any period. | Sales recovered from surplus, what sold out and when, and what to list less of tomorrow. |
| **Settings, Payouts & tax** | Scroll to LastCall's fee. | 10% of each order's items (min $0.25), this week's total and past PayPal invoices. |

## 3. Platform ops (admin sign-in)

Open **Platform ops** from the account menu.

| Tab | Look for |
|---|---|
| **Shops** | New shops wait for review. The reviewer confirms identity, address and allergen records before a shop goes live. |
| **Payments** | Every payment attempt and its state. **Trace** shows an order step by step, from quote to capture to webhook. |
| **Webhooks** | PayPal events, each **Verified** by signature, de-duplicated and matched to its payment. |
| **AI calls** | Every model call with its validation result, and each agent run as a timeline of model turns and tool calls, including rejected tool calls the agent had to correct. |
| **Failure injection** | Choose **Capture succeeds at PayPal but the response is lost**, press **Arm once**, then pay for an order. The order page waits while LastCall asks PayPal what happened, finds the capture and confirms the order exactly once. |
| **Revenue** | Fees earned, invoiced and paid. |
| **Jobs, Emails, Audit log** | The background worker, outgoing email and an append-only record of every change. |

## 4. Read the code

* [PayPal integration](paypal-integration.md): every PayPal API, with sequence diagrams.
* [AI agents](ai-agents.md): what the model decides, what code decides, and the guardrails.
* [Safety and trust](safety-and-trust.md): allergy, pricing and approval rules, and the tests that enforce them.
* [Architecture](architecture.md), [Testing](testing.md), [Deployment](deployment.md).
