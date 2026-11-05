import { expect, test } from "@playwright/test";

import { ORIGIN, expectAccessible, uniqueEmail } from "./helpers";

const PASSWORD = "e2e-password-2026";

test("a new owner signs up, creates a shop and invites a teammate", async ({ browser, page }) => {
  const email = uniqueEmail("owner");
  await page.goto("/sell");
  await expectAccessible(page, "sell");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup\?next=(%2F|\/)sell/);
  await page.getByLabel(/^Your name/).fill("Robin Baker");
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/sell$/);
  await page.getByLabel(/^Shop name/).fill(`Robin's Rolls ${Date.now().toString(36)}`);
  await page.getByLabel(/^Street address/).fill("12 Test Lane");
  await page.getByLabel(/^City/).fill("Fernhill");
  await page.getByLabel(/^Phone/).fill("(415) 555-0199");
  await page.getByRole("button", { name: "Create shop and continue setup" }).click();

  await expect(page).toHaveURL(/\/merchant\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up your shop" })).toBeVisible();
  await expect(page.getByText(/2 of 5 done/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeDisabled();
  await expectAccessible(page, "setup");

  await page.goto("/merchant/team");
  const teammate = uniqueEmail("staff");
  await page.getByLabel(/^Email/).fill(teammate);
  await page.getByRole("button", { name: "Send invite" }).click();
  const link = (await page.locator("[role='alert'] .MuiTypography-caption").first().textContent())?.trim() ?? "";
  expect(link).toContain("/invite/");

  const other = await browser.newContext({ baseURL: ORIGIN });
  const invitee = await other.newPage();
  await invitee.goto(new URL(link).pathname);
  await invitee.getByLabel(/^Your name/).fill("Sky Counter");
  await invitee.getByLabel(/^Choose a password/).fill(PASSWORD);
  await invitee.getByRole("button", { name: "Create account and join" }).click();
  await expect(invitee).toHaveURL(/\/merchant$/);
  await expect(invitee.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(invitee.getByRole("link", { name: "Team" })).toHaveCount(0); // staff can't manage the team
});

test("sign in rejects a wrong password with a readable error", async ({ page }) => {
  await page.goto("/signin");
  await expectAccessible(page, "sign in");
  await page.getByLabel(/^Email/).fill("nobody@example.com");
  await page.getByLabel(/^Password/).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Email or password is incorrect" })).toBeVisible();
});
