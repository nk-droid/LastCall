import { expect, type APIRequestContext, type Frame, type FrameLocator, type Locator, type Page } from "@playwright/test";

// Payments run in the real PayPal Sandbox (test money): PayPal's own buttons on our checkout page and
// PayPal's own checkout window. Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in backend/.env.

const CARD = { expiry: "12/30", cvv: "123" };
const BILLING = { first: "Maya", last: "Rivera", line1: "1 Market Street", city: "San Francisco", state: "CA", zip: "94105",
  phone: "4155550100", email: "maya.rivera@example.com" };

/**
 * A fresh Luhn-valid Visa test number for each payment (PAYPAL_TEST_CARD overrides it). PayPal's shared
 * Sandbox declines generic numbers like 4111 1111 1111 1111 once they are overused.
 */
function testCardNumber(): string {
  if (process.env.PAYPAL_TEST_CARD) return process.env.PAYPAL_TEST_CARD;
  const digits = [4, 0, 3, 2, 0, 3, ...Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))];
  const sum = [...digits].reverse().reduce((acc, d, i) => acc + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

/** PayPal's Smart Buttons frame on the checkout page. */
export function paypalButtons(page: Page): FrameLocator {
  return page.frameLocator("iframe[name^='__zoid__paypal_buttons']").first();
}

export async function expectSandboxConfigured(api: APIRequestContext): Promise<void> {
  const config = await (await api.get("/api/config")).json();
  expect(config.paypal.client_id, "PayPal Sandbox credentials are missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in backend/.env").toBeTruthy();
}

/**
 * Pays with PayPal's "Debit or Credit Card" button as a guest, with a test card. PayPal shows its card
 * form either in its own window or inline under its buttons (it varies between sessions); both work.
 */
export async function payWithSandboxCard(page: Page): Promise<void> {
  const frame = page.locator("iframe[name^='__zoid__paypal_buttons']").first();
  const card = paypalButtons(page).locator("[data-funding-source='card']");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const opened: { window?: Page } = {};
  const onPage = (p: Page) => (opened.window = p);
  page.context().on("page", onPage);
  try {
    // PayPal sometimes ignores a click while its button is still settling; retry until its form shows.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await frame.evaluate((el) => el.scrollIntoView({ block: "center" })); // clear of our sticky header
      await card.click({ timeout: 10_000 }).catch(() => {});
      for (let waited = 0; waited < 12_000; waited += 250) {
        const inline = opened.window ? null : await inlineCardForm(page);
        if (opened.window || inline) {
          await (opened.window ? payAsGuest(opened.window) : payInline(inline!));
          return await expectApproved(page);
        }
        await page.waitForTimeout(250);
      }
    }
  } finally {
    page.context().off("page", onPage);
  }
  throw new Error("PayPal's card checkout didn't open");
}

/** After PayPal's form is sent, checkout opens the order, or reports PayPal's decline (fail fast, don't wait it out). */
async function expectApproved(page: Page): Promise<void> {
  const declined = page.getByText(/payment method was declined/i).first();
  await expect(page.getByRole("heading", { name: "Order confirmed" }).or(declined)).toBeVisible({ timeout: 90_000 });
  if (await declined.isVisible()) throw new Error("PayPal's Sandbox declined the test card; set PAYPAL_TEST_CARD to try another.");
}

async function inlineCardForm(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    if (frame.url().includes("/smart/card-fields") && (await frame.locator("#credit-card-number").isVisible().catch(() => false))) return frame;
  }
  return null;
}

/** PayPal's inline card form (in a frame under its buttons). */
async function payInline(form: Frame): Promise<void> {
  await selectIfPresent(form.locator("select[name='billingAddress.country']"), "US");
  for (const [selector, value] of [["#credit-card-number", testCardNumber()], ["#expiry-date", CARD.expiry], ["#credit-card-security", CARD.cvv]]) {
    await form.locator(selector).pressSequentially(value, { delay: 25 });
  }
  const fields = [["[name='givenName']", BILLING.first], ["[name='familyName']", BILLING.last], ["[name='line1']", BILLING.line1],
    ["[name='city']", BILLING.city], ["[name='postcode']", BILLING.zip], ["#phone", BILLING.phone], ["#email", BILLING.email]];
  for (const [selector, value] of fields) {
    const field = form.locator(selector);
    if ((await field.count()) && (await field.isVisible())) await field.fill(value);
  }
  await selectIfPresent(form.locator("select[name='state']"), BILLING.state);
  await form.locator("#submit-button").click({ timeout: 15_000 });
}

/** PayPal's checkout window. */
async function payAsGuest(pp: Page): Promise<void> {
  await pp.locator("#cardNumber").waitFor({ timeout: 60_000 });
  // PayPal's cookie banner can appear a few seconds in and cover the form; close it whenever it shows.
  const dismissBanner = async () => {
    const banner = pp.locator("#bannerCloseButton, [data-testid='bannerCloseButton']").first();
    if (await banner.isVisible().catch(() => false)) await banner.click({ timeout: 5_000 }).catch(() => {});
  };
  await selectIfPresent(pp.locator("#country"), "US");
  await pp.waitForTimeout(2_000); // the form re-renders for the chosen country
  await dismissBanner();
  // PayPal A/B-tests the field order and set; fill whatever is present. Card fields format as you type.
  for (const [selector, value] of [["#cardNumber", testCardNumber()], ["#cardExpiry", CARD.expiry], ["#cardCvv", CARD.cvv]]) {
    const field = pp.locator(selector);
    if (await field.count()) await field.pressSequentially(value, { delay: 25 });
  }
  const fields = [["#email", BILLING.email], ["#phone", BILLING.phone], ["#firstName", BILLING.first], ["#lastName", BILLING.last],
    ["#billingLine1", BILLING.line1], ["#billingCity", BILLING.city], ["#billingPostalCode", BILLING.zip]];
  for (const [selector, value] of fields) {
    const field = pp.locator(selector);
    if (await field.count()) await field.fill(value);
  }
  await selectIfPresent(pp.locator("#billingState"), BILLING.state);
  await dismissBanner();
  // Variants: a "Pay now as guest" button, an account switch to turn off, or a guest radio.
  const guest = pp.getByTestId("pomaGuestSubmitButton");
  if ((await guest.count()) && (await guest.isVisible())) {
    await guest.click({ timeout: 15_000 });
    return;
  }
  const toggle = pp.getByTestId("onboard-options-switch");
  const submit = pp.getByTestId("submit-button");
  if ((await toggle.count()) && (await toggle.isChecked())) {
    // The switch's input is visually hidden: uncheck it, or fall back to a DOM click, then its label.
    await toggle.uncheck({ force: true, timeout: 3_000 }).catch(() => toggle.dispatchEvent("click"));
    if (/create account/i.test((await submit.textContent()) ?? "")) {
      const label = await toggle.getAttribute("aria-labelledby");
      if (label) await pp.locator(`[id="${label}"]`).click({ timeout: 3_000 }).catch(() => {});
    }
  } else if (await pp.locator("#onboardOptionGuest").count()) {
    await pp.locator("#onboardOptionGuest").check({ force: true });
  }
  await expect(submit, "PayPal's form should be in guest checkout").not.toHaveText(/create account/i);
  await submit.click({ timeout: 15_000 });
}

/** PayPal varies its forms; an optional dropdown that isn't there is skipped instead of awaited. */
async function selectIfPresent(select: Locator, value: string): Promise<void> {
  if (await select.count()) await select.selectOption(value, { timeout: 5_000 });
}
