import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The map under ../assets is read by the server too (collision validation), so it is
// served from there instead of being duplicated into client/public.
export default defineConfig({
  publicDir: fileURLToPath(new URL("../assets", import.meta.url)),
});
