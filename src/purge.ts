import type { Context } from 'hono'
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

/**
 * Invalidate by path prefix via `cache.purge({ pathPrefixes })`. Named after
 * Next.js' `revalidatePath`, but matches Cloudflare path-prefix purge (not
 * App Router page/layout types).
 */
export function revalidatePath(prefixes: string | string[], c?: Context): Promise<PurgeResult> {
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter((p) => p.length > 0)
  if (list.length === 0) return Promise.resolve({ ok: true })
  return doPurge({ pathPrefixes: list }, c)
}

/** Purge everything cached by the calling entrypoint. */
export function purgeEverything(c?: Context): Promise<PurgeResult> {
  return doPurge({ purgeEverything: true }, c)
}
