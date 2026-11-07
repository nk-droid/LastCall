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
  // The countdown to the end of pickup sits above the plan.
  await expect(card.getByRole("timer")).toContainText(/Pickup ends/);
  if (await card.getByRole("button", { name: "Dismiss" }).count()) await card.getByRole("button", { name: "Dismiss" }).click();
  await card.getByRole("button", { name: /Plan (now|again)/ }).click();
  await expect(card.getByRole("button", { name: /^Apply/ }).or(card.getByText(/Nothing needs changing|Done/)).first()).toBeVisible({ timeout: 120_000 });
  if (await card.getByRole("button", { name: /^Apply/ }).count()) {
    // Each suggestion is a row with its before → after; unticking one changes the button.
    const rows = card.getByRole("row");
    await expect(rows.first()).toContainText(/Change.*After/);
    const boxes = card.getByRole("checkbox");
    if ((await boxes.count()) > 1) {
      await boxes.first().uncheck();
      await expect(card.getByRole("button", { name: /^Apply selected/ })).toBeVisible();
      await boxes.first().check();
    }
  }
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
