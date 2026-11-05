import { expect, test } from "@playwright/test";

import { SHOP, expectAccessible } from "./helpers";

// AT-13: usable at 360px with no sideways scrolling; key screens pass WCAG 2.2 AA scans.
test.use({ viewport: { width: 360, height: 780 } });

for (const path of ["/", `/shops/${SHOP.slug}`, "/signin", "/sell", "/orders"]) {
  test(`fits a 360px screen: ${path}`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expectAccessible(page, `${path} at 360px`);
  });
}

test("unknown shops show a helpful not-found state", async ({ page }) => {
  await page.goto("/shops/no-such-shop");
  await expect(page.getByText(/couldn't find that shop/i)).toBeVisible({ timeout: 20_000 });
});
