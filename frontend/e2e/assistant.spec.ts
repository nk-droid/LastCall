import { expect, test } from "@playwright/test";

import { SHOP, expectAccessible, requireShowcase, staffSession } from "./helpers";

// The AI teammates page: what the close-out agent, Ask LastCall and Watch alerts did for the shop, and the switches
// for both agents. A manager can hide the shop from Ask LastCall (and turns it back on); staff only read.
test("a manager reviews the AI teammates and staff can only read them", async ({ browser }) => {
  requireShowcase();
  const { page } = await staffSession(browser, SHOP.manager);
  await page.goto("/merchant");
  await page.getByRole("navigation").getByRole("link", { name: "Assistant" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your AI teammates" })).toBeVisible();
  for (const name of ["Close-out", "Ask LastCall", "Watch alerts"]) await expect(page.getByRole("article", { name })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This week" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Asked for, not on your shelf" })).toBeVisible();
  await expectAccessible(page, "AI teammates");

  const listed = page.getByRole("switch", { name: "Suggest my shop in Ask LastCall" });
  await expect(listed).toBeChecked();
  await listed.click();
  await expect(listed).not.toBeChecked();
  await expect(page.getByRole("article", { name: "Ask LastCall" })).toContainText("hidden");
  await listed.click();
  await expect(listed).toBeChecked();

  const { page: staffPage } = await staffSession(browser, SHOP.staff);
  await staffPage.goto("/merchant/assistant");
  await expect(staffPage.getByText("A manager can change these.")).toBeVisible();
  await expect(staffPage.getByRole("switch", { name: "Close-out plans" })).toBeDisabled();
});
