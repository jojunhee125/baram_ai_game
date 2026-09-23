import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

process.env["ZEP_LEVEL30_TEST_SERVER"] = "1";

export default defineConfig({
  ...base,
  testMatch: ["**/level30-progression.spec.ts", "**/equipment-comparison.spec.ts", "**/social-ui.spec.ts"],
  use: { ...base.use, viewport: { width: 1024, height: 576 } },
  webServer: [
    { command: "npx tsx client/e2e/helpers/level30-server.ts", cwd: "../..", port: 2567, reuseExistingServer: false, timeout: 30000 },
    { command: "npm run dev --workspace=@zep-test/client -- --host 127.0.0.1", cwd: "../..", url: "http://127.0.0.1:5173", reuseExistingServer: false, timeout: 30000 },
  ],
});
