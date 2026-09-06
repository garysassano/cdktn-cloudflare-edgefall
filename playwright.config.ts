import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "dist/e2e-artifacts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: "dist/e2e-report.json" }]],
  use: {
    baseURL: "http://127.0.0.1:8788",
    viewport: { width: 1280, height: 720 },
    video: "on",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command:
      "pnpm client:build && pnpm exec wrangler d1 migrations apply RUNS --local --persist-to .wrangler/e2e && pnpm exec wrangler dev --local --port 8788 --persist-to .wrangler/e2e --var PROFILE_COOKIE_SECRET:local-e2e-fixture-only-not-a-production-secret",
    url: "http://127.0.0.1:8788/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
