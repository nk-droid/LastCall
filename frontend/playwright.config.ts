import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the real app: Next.js (3787) proxying to the FastAPI backend (8787).
// Existing servers are reused; otherwise both are started. They need the showcase shops seeded
// (python -m app.cli seed-showcase with SHOWCASE_PASSWORD, passed here as E2E_SHOWCASE_PASSWORD) and
// run serially. The journey pays in the real PayPal Sandbox, so the API needs PayPal credentials.
export default defineConfig({
  testDir: "./e2e",
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3787",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "uv run uvicorn app.main:app --host 127.0.0.1 --port 8787",
      cwd: "../backend",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:3787",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
