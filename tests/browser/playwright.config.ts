import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    command: "node tests/browser/server.mjs",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
  },
});
