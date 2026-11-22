# AGENTS.md

## Toolchain

- Development Node.js is pinned only in `package.json#devEngines.runtime`. `mise.toml` provides bootstrap majors; use the global Vite+ CLI with environment management enabled for exact runtime selection. Compatibility CI may override the development pin.

- Node 22 or 24 (CI tests both; see `engines`) and pnpm (version from `packageManager` in `package.json`). Vite+ (`vp`) provides check, test and pack.
- Verify with `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, `pnpm build`. CI runs the same (`.github/workflows/ci.yml`, job `check` on Node 22 and 24).
- pnpm workspace: the library at the root plus `examples/*`, sharing the root `pnpm-lock.yaml`.

## Library compatibility

- This is a library published to npm. Keep the public API (`src/index.ts` exports) backward compatible unless a breaking release is intended.
- `hono` is a peer dependency (`>=4.8.0`). Do not narrow or raise the peer range as a side effect of dependency updates; the `hono` devDependency only sets the version tests run against.

## Dependency updates

- Dependabot opens update PRs (`.github/dependabot.yml`). `.github/workflows/dependabot-triage.yml` enables auto-merge for patch/minor updates on versions >= 1.0; GitHub merges them once the required CI check passes.
- Not managed by Dependabot: the Vite+ toolchain. `vite-plus` and the Vite core alias are pinned in the `pnpm-workspace.yaml` catalog; Vitest is bundled with Vite+. Update them together with `vp migrate` and refresh the lockfile. CI resolves the Vite+ version from the catalog automatically.

## Releases

- Merging to `main` does not publish or deploy anything; CI only checks.
- Publishing is manual: the `Publish` workflow (`.github/workflows/release.yml`, `workflow_dispatch` on `main`) runs `pnpm publish` for the version in `package.json` and creates the `v<version>` GitHub release. Do not run `pnpm publish`, `wrangler deploy`, or trigger that workflow.
