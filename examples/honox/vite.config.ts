import build from "@hono/vite-build/cloudflare-workers";
import adapter from "@hono/vite-dev-server/cloudflare";
import honox from "honox/vite";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [
    honox({
      devServer: { adapter },
    }),
    build(),
  ]),
  build: {
    rollupOptions: {
      // The purge helpers dynamically import 'cloudflare:workers'; it must not
      // be bundled. (@cloudflare/vite-plugin externalizes it automatically —
      // with @hono/vite-build, declare it explicitly.)
      external: ["cloudflare:workers"],
    },
  },
});
