import { expect, test } from "@playwright/test";

import { ORIGIN, expectAccessible } from "./helpers";

// Agent runs in Platform ops: filter by agent, pick a run, and read its timeline of model turns and tool calls.
// Needs a platform admin (e.g. `app.cli create-admin`) passed as E2E_OPS_EMAIL / E2E_OPS_PASSWORD.
const EMAIL = process.env.E2E_OPS_EMAIL ?? "";
const PASSWORD = process.env.E2E_OPS_PASSWORD ?? "";

test("ops reads an agent run as a timeline", async ({ browser }) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_OPS_EMAIL and E2E_OPS_PASSWORD to a platform admin");
  const context = await browser.newContext({ baseURL: ORIGIN, reducedMotion: "reduce" });
  const page = await context.newPage();
  const login = await page.request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: { Origin: ORIGIN } });
  expect(login.ok(), await login.text()).toBeTruthy();

  await page.goto("/ops?tab=ai");
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Agent runs" }) }).first();
  await expect(card.getByText("Median time")).toBeVisible();
  const runs = card.getByRole("list", { name: "Runs" }).getByRole("button");
  test.skip((await runs.count()) === 0, "No agent runs recorded yet");

  const timeline = card.getByRole("list", { name: "Timeline" });
  await expect(timeline.getByRole("button").first()).toBeVisible();
  // Picking a step shows what it was called with.
  await timeline.getByRole("button").last().click();
  await expect(timeline.getByRole("button").last()).toHaveAttribute("aria-pressed", "true");
  await expectAccessible(page, "ops agent runs");

  await card.getByRole("button", { name: "Concierge", exact: true }).click();
  await expect(card.getByRole("button", { name: "Concierge", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const label of await card.getByRole("list", { name: "Runs" }).getByRole("button").allInnerTexts()) expect(label).toContain("Concierge");
  await context.close();
});
