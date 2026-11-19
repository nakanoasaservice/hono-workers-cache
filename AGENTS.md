# AGENTS.md

## Toolchain

- Node 22 or 24 (CI tests both; see `engines`) and pnpm (version from `packageManager` in `package.json`). Vite+ (`vp`) provides check, test and pack.
- Verify with `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, `pnpm build`. CI runs the same (`.github/workflows/ci.yml`, job `check` on Node 22 and 24).
- pnpm workspace: the library at the root plus `examples/*`, sharing the root `pnpm-lock.yaml`.

## Library compatibility

- This is a library published to npm. Keep the public API (`src/index.ts` exports) backward compatible unless a breaking release is intended.
- `hono` is a peer dependency (`>=4.8.0`). Do not narrow or raise the peer range as a side effect of dependency updates; the `hono` devDependency only sets the version tests run against.

## Dependency updates

- Dependabot opens update PRs (`.github/dependabot.yml`). `.github/workflows/dependabot-triage.yml` enables auto-merge for patch/minor updates on versions >= 1.0; GitHub merges them once the required CI check passes.
- Not managed by Dependabot: `vite`, `vite-plus`, `vitest`. They come from the `catalog` in `pnpm-workspace.yaml` (`vite` is an npm alias for `@voidzero-dev/vite-plus-core`), and `vite`/`vitest` are forced via `overrides`. Update all three together in the catalog, keeping them on matching Vite+ releases, then refresh the lockfile.

## Releases

- Merging to `main` does not publish or deploy anything; CI only checks.
- Publishing is manual: the `Publish` workflow (`.github/workflows/release.yml`, `workflow_dispatch` on `main`) runs `pnpm publish` for the version in `package.json` and creates the `v<version>` GitHub release. Do not run `pnpm publish`, `wrangler deploy`, or trigger that workflow.
