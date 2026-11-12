import { expect, test } from "@playwright/test";

import { SHOP, expectAccessible, press, relist, requireShowcase, sellOut, staffSession } from "./helpers";
import { expectSandboxConfigured, payWithSandboxCard } from "./paypal";

// The judge-facing story, mostly by keyboard (AT-12): request -> verified bundles -> a live sell-out ->
// explicit approval of the change -> hold -> payment in the PayPal Sandbox -> verified capture ->
// pickup pass -> staff handoff. PayPal's own checkout window is third-party UI, so that step uses the mouse.
test("guest journey with a live substitution, PayPal payment and pickup handoff", async ({ browser, page }) => {
  requireShowcase();
  const staff = await staffSession(browser, SHOP.manager);
  await expectSandboxConfigured(staff.api);
  await relist(staff.api);

  await page.goto("/");
  const shop = page.getByRole("link", { name: SHOP.name, exact: true });
  await expect(shop).toBeVisible();
  await expectAccessible(page, "marketplace");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  await press(shop);
  await expect(page).toHaveURL(new RegExp(`/shops/${SHOP.slug}$`));
  await expectAccessible(page, "storefront");
  const request = page.getByRole("textbox", { name: "What are you shopping for?" });
  await request.focus();
  await page.keyboard.type("sweet snacks for 4 people under $16");
  await press(page.getByRole("button", { name: "Build my bundle" }));

  const choose = page.getByRole("button", { name: "Choose bundle" }).first();
  await expect(choose).toBeVisible({ timeout: 90_000 });
  await expectAccessible(page, "bundle options");
  await press(choose);

  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByRole("heading", { name: "Your basket" })).toBeVisible();
  const quoteId = page.url().split("/review/")[1];
  const quote = await (await page.request.get(`/api/quotes/${quoteId}`)).json();
  await sellOut(staff.api, quote.lines[0].sku);

  // The review page hears about the sale on its own and moves focus to the proposal.
  const change = page.getByRole("heading", { name: "Your bundle needs a change" });
  await expect(change).toBeVisible({ timeout: 20_000 });
  await expect(change).toBeFocused();
  await expect(page.getByRole("button", { name: "Hold items & continue" })).toBeDisabled();
  await expectAccessible(page, "change proposal");
  await press(page.getByRole("button", { name: "Accept updated bundle" }));

  const hold = page.getByRole("button", { name: "Hold items & continue" });
  await expect(hold).toBeEnabled({ timeout: 20_000 });
  await press(hold);
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByText(/Items held for you/)).toBeVisible();

  await page.getByLabel(/Name for the order/).fill("Maya Rivera");
  await page.getByLabel(/^Email/).fill("maya@example.com");
  await page.getByRole("checkbox", { name: /read the pickup, cancellation and refund policy/ }).check();
  await expectAccessible(page, "checkout");
  await payWithSandboxCard(page);

  await expect(page).toHaveURL(/\/orders\//, { timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible({ timeout: 30_000 });
  const codeLabel = await page.locator("[aria-label^='Pickup code']").getAttribute("aria-label");
  const code = (codeLabel ?? "").replace(/\D/g, "");
  expect(code).toHaveLength(4);
  await expect(page.getByText("Paid and verified with PayPal")).toBeVisible();
  await expectAccessible(page, "pickup pass");

  // Staff: the paid order is in the queue; mark ready, reject a wrong code, accept the right one.
  const m = staff.page;
  await m.goto("/merchant/orders");
  await m.getByRole("button", { name: /#LC-/ }).first().click();
  await m.getByRole("button", { name: "Mark ready" }).click();
  const codeInput = m.getByLabel("Customer's pickup code");
  await codeInput.fill(code === "0000" ? "1111" : "0000");
  await m.getByRole("button", { name: /Verify code/ }).click();
  await expect(m.getByText(/doesn't match this order/)).toBeVisible();
  await codeInput.fill(code);
  await m.getByRole("button", { name: /Verify code/ }).click();
  await expect(m.getByText(/Handed off #LC-/)).toBeVisible();

  // The pickup pass updates live, without a reload.
  await expect(page.getByRole("heading", { name: "Picked up" })).toBeVisible({ timeout: 20_000 });
  await relist(staff.api);
});
