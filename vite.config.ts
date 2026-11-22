import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  fmt: {},
  lint: {
    // Examples resolve the workspace package via dist/; keep them out of the
    // root type-aware check (same scope as the old root `tsc --noEmit`).
    ignorePatterns: ["dist/**", "examples/**", "**/.wrangler/**"],
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
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
      neverBundle: ["cloudflare:workers", "hono"],
    },
  },
});
