import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
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
    {
      name: "firefox",
      use: { browserName: "firefox" },
      testIgnore: "rtc.spec.ts",
    },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: [
    {
      command: "node tests/browser/server.mjs",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4175",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      url: "http://127.0.0.1:4175",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
