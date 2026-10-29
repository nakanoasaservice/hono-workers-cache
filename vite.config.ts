import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  fmt: {},
  lint: {
    ignorePatterns: ["dist/**", "examples/**/dist/**", "**/.wrangler/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  pack: {
    entry: "src/index.ts",
    format: ["esm"],
    unbundle: true,
    exports: true,
    dts: true,
    sourcemap: true,
    clean: true,
    deps: {
      neverBundle: ["cloudflare:workers", "hono"],
    },
  },
});
