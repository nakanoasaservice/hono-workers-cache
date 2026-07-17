import type { Context } from 'hono'
import { normalizePath } from './headers.js'
import type { PurgeResult, WorkersCacheLike } from './types.js'

/**
 * Resolve `cloudflare:workers`' cache via dynamic import.
 * Outside workerd (Node during vite dev, tests, …) this returns null so the
 * caller becomes a no-op — never break dev (same policy as vinext).
 */
async function getModuleCache(): Promise<WorkersCacheLike | null> {
  try {
    const mod = (await import('cloudflare:workers')) as { cache?: unknown }
    const cache = mod.cache
    if (cache && typeof (cache as Partial<WorkersCacheLike>).purge === 'function') {
      return cache as WorkersCacheLike
    }
  } catch {
    // Module not resolvable = outside the Workers runtime
  }
  return null
}

/** Fallback: duck-type `ctx.cache` out of the Hono Context. */
function getContextCache(c?: Context): WorkersCacheLike | null {
  if (!c) return null
  try {
    const cache = (c.executionCtx as { cache?: unknown } | undefined)?.cache
    if (cache && typeof (cache as Partial<WorkersCacheLike>).purge === 'function') {
      return cache as WorkersCacheLike
    }
  } catch {
    // Adapter environments where executionCtx does not exist
  }
  return null
}

async function resolveCache(c?: Context): Promise<WorkersCacheLike | null> {
  return getContextCache(c) ?? (await getModuleCache())
}

/**
 * `purge()` resolves to a result object (`{ success, errors }`); it does not
 * necessarily reject on failure (e.g. rate limiting). Map an explicit
 * `success: false` to a failed PurgeResult.
 */
function toPurgeResult(result: unknown): PurgeResult {
  if (
    typeof result === 'object' &&
    result !== null &&
    'success' in result &&
    (result as { success?: unknown }).success === false
  ) {
    return { ok: false, reason: 'purge-failed', error: (result as { errors?: unknown }).errors }
  }
  return { ok: true }
}

async function doPurge(
  options: Parameters<WorkersCacheLike['purge']>[0],
  c?: Context,
): Promise<PurgeResult> {
  const cache = await resolveCache(c)
  if (!cache) return { ok: false, reason: 'cache-unavailable' }
  try {
    return toPurgeResult(await cache.purge(options))
  } catch (error) {
    return { ok: false, reason: 'purge-failed', error }
  }
}

/**
 * Invalidate the edge cache by tag. Named after Next.js' `revalidateTag`, but
 * accepts a tag or list (Cloudflare can purge many at once) and returns a
 * `PurgeResult` instead of void.
 *
 * ```ts
 * export const POST = createRoute(async (c) => {
 *   await updatePost(id)
 *   await revalidateTag([`post-${id}`, 'posts'], c)
 *   return c.redirect(`/blog/${id}`)
 * })
 * ```
 *
 * The second Context argument is optional (when omitted, the purge goes
 * through `cloudflare:workers`).
 */
export function revalidateTag(tags: string | string[], c?: Context): Promise<PurgeResult> {
  const list = (Array.isArray(tags) ? tags : [tags]).filter((t) => t.length > 0)
  if (list.length === 0) return Promise.resolve({ ok: true })
  return doPurge({ tags: list }, c)
}

/** How `revalidatePath` interprets its paths. Default (omitted) = exact path. */
export type RevalidatePathType = 'route' | 'prefix'

/**
 * Invalidate cached responses for a path — Next.js' `revalidatePath`, mapped
 * onto Workers Cache. Three modes:
 *
 * - `revalidatePath('/blog/post-1')` — **exact path**. Purges the
 *   `path:<normalized path>` tag that `workersCache()` stamps on every
 *   response (all query-string variants of the path go together). Requires
 *   the middleware's `pathTag` (default on).
 * - `revalidatePath('/blog/:id', 'route')` — **Hono route template** (the
 *   counterpart of Next.js' `type: 'page'`). Purges the `route:<template>`
 *   tag, i.e. every URL that route produced. Requires `routeTag` (default
 *   on) — with `routeTag: false` the purge silently matches nothing.
 * - `revalidatePath('/blog/', 'prefix')` — **path prefix**, via Cloudflare
 *   `pathPrefixes` (the counterpart of `type: 'layout'`). A pure string
 *   prefix: `/blog` also matches `/blogger`, so end directory prefixes
 *   with `/`.
 *
 * Like Next.js' `revalidatePath`, this only reaches the server-side (edge)
 * cache — browsers keep serving their own copy until `stale` runs out. Use
 * `stale: 0` on routes whose purges must reach users instantly.
 *
 * The tag purges only affect entries cached *after* the middleware started
 * emitting the corresponding tag — mind this right after upgrading.
 */
export function revalidatePath(paths: string | string[], c?: Context): Promise<PurgeResult>
export function revalidatePath(
  paths: string | string[],
  type: RevalidatePathType,
  c?: Context,
): Promise<PurgeResult>
export function revalidatePath(
  paths: string | string[],
  typeOrContext?: RevalidatePathType | Context,
  context?: Context,
): Promise<PurgeResult> {
  const type = typeof typeOrContext === 'string' ? typeOrContext : undefined
  const c = typeof typeOrContext === 'string' ? context : typeOrContext
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => p.length > 0)
  if (list.length === 0) return Promise.resolve({ ok: true })
  if (type === 'prefix') return doPurge({ pathPrefixes: list }, c)
  if (type === 'route') return doPurge({ tags: list.map((p) => `route:${p}`) }, c)
  return doPurge({ tags: list.map((p) => `path:${normalizePath(p)}`) }, c)
}

/**
 * Purge everything cached by the calling entrypoint — the counterpart of
 * Next.js' `revalidatePath('/', 'layout')`.
 */
export function revalidateEverything(c?: Context): Promise<PurgeResult> {
  return doPurge({ purgeEverything: true }, c)
}
