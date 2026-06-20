import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * Web target build (TASK-480).
 *
 * Produces a standalone browser SPA for the web app (Cloudflare Pages), separate
 * from the Electrobun `dist/`. The app hash-routes (TanStack Router), so no
 * server-side SPA fallback is needed — Pages just serves index.html at `/`.
 *
 *   bun run build:web      # -> dist-web/
 *   bun run deploy:web     # wrangler pages deploy dist-web (needs the dev account)
 *
 * The relay/pairing details come from the scanned QR at runtime, so no relay env
 * needs to be baked into this build. Electrobun-only features are gated at
 * runtime via IS_REMOTE (see src/mainview/lib/remote-transport.ts).
 */
export default mergeConfig(
  base,
  defineConfig({
    base: "/",
    build: {
      outDir: "../../dist-web",
      emptyOutDir: true,
    },
  }),
);
