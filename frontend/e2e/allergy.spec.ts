import { expect, test } from "@playwright/test";

import { SHOP, press } from "./helpers";

// AT-05: a strict nut allergy only admits items the shop verified with no nut cross-contact. At Night Owl
// every doughnut shares fryer oil with peanut butter doughnuts, so only the savory biscuit qualifies.
test("strict nut allergy offers only verified items without cross-contact", async ({ page }) => {
  await page.goto(`/shops/${SHOP.slug}`);
  const request = page.getByRole("textbox", { name: "What are you shopping for?" });
  await request.fill("breakfast for 2, severe nut allergy");
  await press(page.getByRole("button", { name: "Build my bundle" }));
  await expect(page.getByRole("button", { name: "Choose bundle" }).first()).toBeVisible({ timeout: 90_000 });
  const offered = page.getByRole("article");
  for (const name of ["Glazed ring doughnut", "Peanut butter & jelly doughnut", "Apple fritter", "Vegan cinnamon sugar doughnut"]) {
    await expect(offered.getByText(name)).toHaveCount(0);
  }
  await expect(offered.getByText(/Bacon, egg & cheese biscuit/).first()).toBeVisible();
});
