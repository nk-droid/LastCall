import { expect, test } from "@playwright/test";

import { SHOP, expectAccessible, requireShowcase, staffSession } from "./helpers";

// A3 Close-out plan. A manager asks for a plan on Today, sees each suggestion with its before → after and
// reason, and dismisses it (so test runs never change the showcase prices). Staff see the plan read-only.
test("a manager plans the close-out and staff can only read it", async ({ browser }) => {
  requireShowcase();
  const { page } = await staffSession(browser, SHOP.manager);
  await page.goto("/merchant");
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Close-out plan" }) }).first();
  await expect(card).toBeVisible();
  if (await card.getByRole("button", { name: "Dismiss" }).count()) await card.getByRole("button", { name: "Dismiss" }).click();
  await card.getByRole("button", { name: /Plan (now|again)/ }).click();
  await expect(card.getByRole("button", { name: /^Apply/ }).or(card.getByText(/Nothing needs changing|Done/)).first()).toBeVisible({ timeout: 120_000 });
  await expectAccessible(page, "close-out plan");

  const { page: staffPage } = await staffSession(browser, SHOP.staff);
  await staffPage.goto("/merchant");
  const staffCard = staffPage.locator("section").filter({ has: staffPage.getByRole("heading", { name: "Close-out plan" }) }).first();
  await expect(staffCard).toBeVisible();
  await expect(staffCard.getByRole("button", { name: /^Apply|Plan|Dismiss/ })).toHaveCount(0);

  if (await card.getByRole("button", { name: "Dismiss" }).count()) {
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card.getByText("Dismissed")).toBeVisible();
  }
});
