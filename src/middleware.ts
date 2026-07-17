import type { Context, MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import {
  buildBrowserDirective,
  buildEdgeDirective,
  cacheLifeProfiles,
  formatCacheTag,
  NEVER_EXPIRE_SECONDS,
  normalizePath,
  resolveCacheLife,
} from './headers.js'
import type { CacheLife, CacheLifeProfile, WorkersCacheOptions } from './types.js'

declare module 'hono' {
  interface ContextVariableMap {
    /** Accumulator for tags appended from handlers via cacheTag(). */
    __workersCacheTags?: string[]
    /** Accumulator for lifetimes declared from handlers via cacheLife(). */
    __workersCacheLife?: CacheLife
  }
}

/**
 * Statuses Workers Cache may store. Cache headers are not applied to anything
 * else. (A conservative subset of Cloudflare's default cacheable statuses.)
 */
const CACHEABLE_STATUS = new Set([200, 203, 204, 301, 302, 304, 308, 404, 410])

const isDev = () =>
  // @ts-expect-error -- replaced by Vite's define; may be undefined when running on workerd
  typeof import.meta.env !== 'undefined' && import.meta.env?.DEV === true

/**
 * Append Cache-Tag values to the response from a handler or deeply nested code.
 * Named after Next.js' `cacheTag` — requires a Hono Context (no async store).
 *
 * ```ts
 * export default createRoute(workersCache('hours'), async (c) => {
 *   const post = await getPost(c.req.param('id'))
 *   cacheTag(c, `post-${post.id}`, `author-${post.authorId}`)
 *   return c.render(<Post post={post} />)
 * })
 * ```
 */
export function cacheTag(c: Context, ...tags: string[]): void {
  const current = c.get('__workersCacheTags') ?? []
  c.set('__workersCacheTags', [...current, ...tags])
}

const expireSeconds = (expire: number | 'never'): number =>
  expire === 'never' ? NEVER_EXPIRE_SECONDS : expire

/**
 * Declare a cache lifetime from a handler or deeply nested code — the
 * counterpart of Next.js' `cacheLife()`, requiring a Hono Context instead of a
 * `use cache` scope.
 *
 * Accepts a profile name (`'hours'`, `'days'`, …) or a `{ stale, revalidate,
 * expire }` object. Fields declared here override the `workersCache()`
 * middleware's defaults; when called multiple times for one response, the
 * **shortest value wins per field** (same rule as nested `cacheLife()` calls
 * in Next.js).
 *
 * ```ts
 * app.get('/posts/:id', workersCache('days'), async (c) => {
 *   const post = await getPost(c.req.param('id'))
 *   if (post.isBreakingNews) cacheLife(c, 'minutes')
 *   return c.json(post)
 * })
 * ```
 */
export function cacheLife(c: Context, life: CacheLifeProfile | CacheLife): void {
  const next = typeof life === 'string' ? cacheLifeProfiles[life] : life
  if (!next) {
    throw new TypeError(
      `[cacheLife] Unknown cache profile "${String(life)}". ` +
        `Available profiles: ${Object.keys(cacheLifeProfiles).join(', ')}`,
    )
  }
  const current = c.get('__workersCacheLife') ?? {}
  const merged: CacheLife = { ...current }
  if (next.stale !== undefined) {
    merged.stale = current.stale === undefined ? next.stale : Math.min(current.stale, next.stale)
  }
  if (next.revalidate !== undefined) {
    merged.revalidate =
      current.revalidate === undefined
        ? next.revalidate
        : Math.min(current.revalidate, next.revalidate)
  }
  if (next.expire !== undefined) {
    merged.expire =
      current.expire === undefined
        ? next.expire
        : expireSeconds(next.expire) < expireSeconds(current.expire)
          ? next.expire
          : current.expire
  }
  c.set('__workersCacheLife', merged)
}

/**
 * Hono middleware that declares a cache policy for Cloudflare Workers Cache,
 * in the Next.js Cache Components vocabulary (`stale` / `revalidate` /
 * `expire`, profiles like `'hours'`).
 *
 * Workers Cache runs *in front of* the Worker, so this middleware never reads
 * or writes the cache. It only does two things:
 *   1. Declares the policy on the response:
 *      - `Cache-Control: public, max-age=<stale>` for browsers
 *      - `CDN-Cache-Control: public, max-age=<revalidate>,
 *         stale-while-revalidate=<expire - revalidate>` for the edge
 *      - `Cache-Tag` for purging
 *   2. Guards against uncacheable conditions (Set-Cookie, non-GET/HEAD, error statuses)
 *
 * ```ts
 * app.get('/blog/:id', workersCache('hours'), handler)          // profile
 * app.get('/', workersCache({ profile: 'days', stale: 0 }))     // profile + override
 * app.get('/feed', workersCache({ revalidate: 60, expire: 300 }))
 * ```
 *
 * Prerequisite: `"cache": { "enabled": true }` in wrangler.jsonc (Wrangler >= 4.69.0)
 */
export function workersCache(
  options: CacheLifeProfile | WorkersCacheOptions = {},
): MiddlewareHandler {
  const opts: WorkersCacheOptions = typeof options === 'string' ? { profile: options } : options
  const useRouteTag = opts.routeTag !== false
  const usePathTag = opts.pathTag !== false

  return async (c, next) => {
    await next()

    // Workers Cache only stores GET/HEAD (GET and HEAD share a cache entry)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return

    const res = c.res

    // Set-Cookie triggers an automatic BYPASS at the edge. Adding headers would
    // be pointless, so leave the response alone — but warn in dev about the
    // "wanted to cache it, but Set-Cookie is present" accident.
    if (res.headers.has('Set-Cookie')) {
      if (isDev()) {
        console.warn(
          `[workersCache] ${c.req.path}: the response carries Set-Cookie, so the edge will BYPASS it. ` +
            'Review your use of session middleware on this route.',
        )
      }
      return
    }

    if (!CACHEABLE_STATUS.has(res.status)) return

    // Respect an explicit Cache-Control set by the handler — do nothing
    if (res.headers.has('Cache-Control')) return

    if (opts.cacheControl) {
      // Escape hatch: one hand-written Cache-Control, verbatim, both tiers.
      res.headers.set('Cache-Control', opts.cacheControl)
    } else {
      // Middleware options are the default; fields declared via cacheLife()
      // in the handler win (already shortest-merged among themselves).
      const handlerLife = c.get('__workersCacheLife')
      const life = resolveCacheLife({ ...opts, ...handlerLife })
      if (isDev() && expireSeconds(life.expire) < life.revalidate) {
        console.warn(
          `[workersCache] ${c.req.path}: expire (${String(life.expire)}) is shorter than ` +
            `revalidate (${life.revalidate}) — the stale-while-revalidate window is clamped to 0.`,
        )
      }
      res.headers.set('Cache-Control', buildBrowserDirective(life.stale))
      res.headers.set('CDN-Cache-Control', buildEdgeDirective(life, opts.staleIfError))
    }

    // Collect tags: option-provided + automatic route/path tags + cacheTag() additions
    const collected: string[] = []
    const optTags = typeof opts.tags === 'function' ? opts.tags(c) : opts.tags
    if (optTags) collected.push(...optTags)
    // Called after next(), so this resolves to the route template of the
    // handler that actually produced the response.
    const matchedRoutePath = routePath(c)
    if (useRouteTag && matchedRoutePath && matchedRoutePath !== '/*') {
      collected.push(`route:${matchedRoutePath}`)
    }
    if (usePathTag) {
      collected.push(`path:${normalizePath(c.req.path)}`)
    }
    const dynamicTags = c.get('__workersCacheTags')
    if (dynamicTags) collected.push(...dynamicTags)

    if (collected.length > 0) {
      const value = formatCacheTag(collected)
      if (value) res.headers.set('Cache-Tag', value)
    }
  }
}

/**
 * For routes/directories that must never be cached. Also actively strips any
 * cache headers stamped by upstream middleware or the route itself (same
 * defense as vinext's non-cached branch).
 */
export function noCache(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const h = c.res.headers
    h.set('Cache-Control', 'no-store')
    h.delete('CDN-Cache-Control')
    h.delete('Cloudflare-CDN-Cache-Control')
    h.delete('Cache-Tag')
  }
}
