import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";

export const ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3787";
/** Password of the showcase shops' staff accounts (SHOWCASE_PASSWORD used with `app.cli seed-showcase`). */
export const SHOWCASE_PASSWORD = process.env.E2E_SHOWCASE_PASSWORD ?? "";
// Night Owl Doughnuts takes pickups around the clock, so these tests run at any hour.
export const SHOP = { slug: "night-owl", name: "Night Owl Doughnuts", staff: "nightowl.staff@example.com", manager: "nightowl.manager@example.com" };

export function requireShowcase(): void {
  test.skip(!SHOWCASE_PASSWORD, "Set E2E_SHOWCASE_PASSWORD to the SHOWCASE_PASSWORD the showcase shops were seeded with");
}

/** Activate a control the way a keyboard user would: focus it, then press Enter. */
export async function press(locator: Locator): Promise<void> {
  await locator.focus();
  await expect(locator).toBeFocused();
  await locator.page().keyboard.press("Enter");
}

export async function staffSession(browser: Browser, email: string): Promise<{ page: Page; api: APIRequestContext }> {
  // Reduced motion makes MUI color transitions instant, so scans never catch a control mid-fade.
  const context = await browser.newContext({ baseURL: ORIGIN, reducedMotion: "reduce" });
  const page = await context.newPage();
  const login = await page.request.post("/api/auth/login", { data: { email, password: SHOWCASE_PASSWORD }, headers: { Origin: ORIGIN } });
  expect(login.ok(), await login.text()).toBeTruthy();
  return { page, api: page.request };
}

/** Staff record a counter sale of everything left of `sku` (how stock really disappears mid-checkout). */
export async function sellOut(api: APIRequestContext, sku: string): Promise<void> {
  const rows = (await (await api.get("/api/merchant/inventory")).json()).rows as { sku: string; product_id: string; available: number }[];
  const row = rows.find((r) => r.sku === sku);
  expect(row, `no product ${sku}`).toBeTruthy();
  if (!row!.available) return;
  const res = await api.post("/api/merchant/inventory", { data: { product_id: row!.product_id, action: "counter_sale", delta: row!.available }, headers: { Origin: ORIGIN } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Re-list the shop's daily template so later runs start with full stock. */
export async function relist(api: APIRequestContext): Promise<void> {
  const res = await api.post("/api/merchant/listings/publish", { data: {}, headers: { Origin: ORIGIN } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

// Bryntum's grid scaffolding (vendor markup) trips aria-required-children; every other rule, contrast included,
// still runs on everything inside the timelines.
const VENDOR_NODES = [{ rule: "aria-required-children", target: /^(\.b-grid-panel-body|#b-scheduler-\d+-\w+Subgrid)$/ }];

/** WCAG 2.2 A/AA scan of the current page (axe-core). */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
  // PayPal's own frames (its buttons and checkout window) are third-party markup, outside what we can fix.
  const results = await new AxeBuilder({ page })
    .exclude("iframe[name^='__zoid__']")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = results.violations
    .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !VENDOR_NODES.some((x) => x.rule === v.id && n.target.every((t) => x.target.test(String(t))))) }))
    .filter((v) => v.nodes.length);
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@example.com`;
}
