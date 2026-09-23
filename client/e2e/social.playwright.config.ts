import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

process.env["ZEP_SOCIAL_TEST_SERVER"] = "1";

export default defineConfig({
  ...base,
  testMatch: ["**/social-live.spec.ts", "**/social-ui.spec.ts"],
  webServer: [
    {
      command: "npx tsx client/e2e/helpers/social-server.ts",
      cwd: "../..",
      port: 2567,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev --workspace=@zep-test/client -- --host 127.0.0.1",
      cwd: "../..",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
