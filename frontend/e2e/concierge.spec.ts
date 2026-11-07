import { expect, test } from "@playwright/test";

import { HOME_ASK, SHOP, expectAccessible } from "./helpers";

// A1 shopping concierge. On the home page it compares shops; on a shop's page it only looks at that shop.
// Either way the allergy rules are the build page's own (at Night Owl only the biscuit has no nut
// cross-contact), and holding the bundle is the shopper's click into the normal review page.
test("the shop-page concierge respects a nut allergy and hands off to review", async ({ page }) => {
  await page.goto(`/shops/${SHOP.slug}`);
  await expect(page.getByRole("button", { name: "Ask LastCall", exact: true })).toBeVisible(); // on every shopping page
  await page.getByRole("button", { name: "Or let LastCall pick for you" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Message the shopping assistant" }).fill("Breakfast for 2 people, my partner has a severe nut allergy");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByLabel("What the assistant is doing")).toBeVisible();

  const cards = dialog.getByRole("article");
  await expect(cards.first()).toBeVisible({ timeout: 90_000 });
  await expect(cards.getByText(/Strict: every item is merchant-verified free of/).first()).toBeVisible();
  for (const name of ["Glazed ring doughnut", "Peanut butter & jelly doughnut", "Apple fritter"]) {
    await expect(cards.getByText(name)).toHaveCount(0);
  }
  await expect(cards.getByText(/Bacon, egg & cheese biscuit/).first()).toBeVisible();
  await expect(dialog.getByText(/nut-free|safe for/i)).toHaveCount(0);
  // How it was picked: only facts code recorded, including the risky items it left out.
  await dialog.getByRole("button", { name: "How we picked this" }).click();
  await expect(dialog.getByText("Left out anything risky")).toBeVisible();
  await expect(dialog.getByText(/that ruled out .*Peanut butter & jelly doughnut/)).toBeVisible();
  await expectAccessible(page, "concierge reply");

  await cards.first().getByRole("button", { name: "Hold & pay" }).click();
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByRole("heading", { name: "Review your bundle" })).toBeVisible();
});

test("the home-page concierge asks how many people when it doesn't know", async ({ page }) => {
  await page.goto("/");
  const ask = page.getByRole("region", { name: HOME_ASK });
  await ask.getByRole("textbox", { name: "Message the shopping assistant" }).fill("Something sweet for later");
  await ask.getByRole("button", { name: "Send" }).click();
  await expect(ask.getByText(/how many/i).first()).toBeVisible({ timeout: 90_000 });
  await expect(ask.getByRole("article")).toHaveCount(0);
});

test("the home page leads with Ask LastCall and shows a board of every shop it checked", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Who are you feeding, and when?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask LastCall", exact: true })).toHaveCount(0); // the page itself is the assistant
  const ask = page.getByRole("region", { name: HOME_ASK });
  await ask.getByRole("textbox", { name: "Message the shopping assistant" }).fill("Breakfast for 2 people, my partner has a severe nut allergy");
  await ask.getByRole("button", { name: "Send" }).click();

  const board = page.getByRole("region", { name: "Shop board" });
  await expect(board.getByText("What I understood · tap to change")).toBeVisible({ timeout: 90_000 });
  await expect(board.getByText("No tree nuts · strict")).toBeVisible();
  await expect(board.getByRole("list", { name: "Shops checked" }).getByRole("listitem").first()).toBeVisible();
  await expect(board.getByRole("article").first()).toContainText("Top pick");
  await expectAccessible(page, "home concierge board");

  // Changing a chip sends a follow-up; allergies stay locked.
  await board.getByRole("button", { name: /^2 people/ }).click();
  await page.getByRole("spinbutton", { name: "How many people?" }).fill("3");
  await page.getByRole("button", { name: "Update" }).click();
  await expect(ask.getByText("Make it for 3 people")).toBeVisible();
  await expect(board.getByRole("button", { name: /No tree nuts/ })).toHaveCount(0);
});
