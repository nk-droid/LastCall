import { expect, test } from "@playwright/test";

import { SHOP, expectAccessible, requireShowcase, staffSession } from "./helpers";

// The AI teammates page: a list of the three assistants and the selected one's details (its switch, its rules and
// what it did). A manager can hide the shop from Ask LastCall (and turns it back on); staff only read.
test("a manager reviews the AI teammates and staff can only read them", async ({ browser }) => {
  requireShowcase();
  const { page } = await staffSession(browser, SHOP.manager);
  await page.goto("/merchant");
  await page.getByRole("navigation").getByRole("link", { name: "Assistant" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "AI teammates" })).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Assistants" });
  for (const name of ["Close-out", "Ask LastCall", "Watch alerts"]) await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toBeVisible();
  // Close-out opens first, with what it did today.
  await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Today" })).toBeVisible();
  await expectAccessible(page, "AI teammates");

  await tabs.getByRole("tab", { name: /^Ask LastCall/ }).click();
  await expect(page).toHaveURL(/\?a=ask$/);
  await expect(page.getByRole("heading", { name: "Asked for, not on your shelf" })).toBeVisible();
  const listed = page.getByRole("switch", { name: "Suggest my shop in Ask LastCall" });
  await expect(listed).toBeChecked();
  await listed.click();
  await expect(listed).not.toBeChecked();
  await expect(tabs.getByRole("tab", { name: /^Ask LastCall/ })).toContainText("hidden");
  await listed.click();
  await expect(listed).toBeChecked();

  const { page: staffPage } = await staffSession(browser, SHOP.staff);
  await staffPage.goto("/merchant/assistant");
  await expect(staffPage.getByText("A manager can change these.")).toBeVisible();
  await expect(staffPage.getByRole("switch", { name: "Close-out plans" })).toBeDisabled();
});
