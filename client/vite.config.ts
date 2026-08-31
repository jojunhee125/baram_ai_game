import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The map under ../assets is read by the server too (collision validation), so it is
// served from there instead of being duplicated into client/public.
export default defineConfig({
  publicDir: fileURLToPath(new URL("../assets", import.meta.url)),
  server: {
    // Only `vite dev` needs this. In production the game server serves this bundle and `/api` is
    // already same-origin; here the page is :5173 and the server :2567, and reaching across
    // would mean adding CORS to a server that deliberately exposes one origin to the gateway.
    proxy: { "/api": "http://localhost:2567" },
  },
});
