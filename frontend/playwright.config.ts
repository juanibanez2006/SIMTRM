import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "edge",
      use: { ...devices["Desktop Edge"], channel: "msedge" },
    },
  ],
  webServer: [
    {
      command:
        '"..\\.venv\\Scripts\\python.exe" ../backend/tests/e2e_server.py',
      url: "http://127.0.0.1:8001/api/v1/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run dev -- --mode e2e --port 5174",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
