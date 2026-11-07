import { expect, test } from "@playwright/test";

import { HOME_ASK, ORIGIN, expectAccessible, uniqueEmail } from "./helpers";

// A2 Watch for me: a signed-in shopper saves what they asked the concierge for, finds it on their alerts page
// (the bell in the header), and can stop it. (Matching, the inbox and the email are covered by the backend suite.)
test("a shopper watches a concierge request and manages it from their alerts", async ({ page }) => {
  const signup = await page.request.post("/api/auth/signup", {
    data: { name: "Maya Rivera", email: uniqueEmail("watch"), password: "watch-pass-2026!" }, headers: { Origin: ORIGIN },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();

  await page.goto("/");
  const ask = page.getByRole("region", { name: HOME_ASK });
  await ask.getByRole("textbox", { name: "Message the shopping assistant" }).fill("Croissants for 2 people under $8");
  await ask.getByRole("button", { name: "Send" }).click();
  await ask.getByRole("button", { name: "Watch for this" }).click({ timeout: 90_000 });
  await expect(ask.getByText(/Watching\. We'll email you/)).toBeVisible();

  await ask.getByRole("link", { name: "See alerts" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Alerts/ })).toBeVisible(); // the bell
  await expect(page.getByText("No matches yet", { exact: true })).toBeVisible();
  await expectAccessible(page, "alerts");
  const list = page.locator("#watches");
  await expect(list.getByText("“Croissants for 2 people under $8”")).toBeVisible();
  await expect(list.getByText("2 people", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: /Stop watching for/ }).click();
  await expect(list.getByText("Nothing yet")).toBeVisible();
});

test("guests are asked to sign in before watching", async ({ page }) => {
  await page.goto("/");
  const ask = page.getByRole("region", { name: HOME_ASK });
  await ask.getByRole("textbox", { name: "Message the shopping assistant" }).fill("Dinner for 30 people under $5");
  await ask.getByRole("button", { name: "Send" }).click();
  await expect(ask.getByRole("link", { name: "Sign in" })).toBeVisible({ timeout: 90_000 });
  await expect(ask.getByRole("button", { name: "Watch for this" })).toHaveCount(0);
});
