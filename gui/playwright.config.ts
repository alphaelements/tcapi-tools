import { defineConfig } from "@playwright/test";

// E2E suite for the GUI running against the Vite dev server with the
// browser-only mock device (`/?mock=1`, see src/lib/mock-device.ts).
// Real-hardware verification is a separate manual pass (Xvfb + tauri dev).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: true,
  },
});
