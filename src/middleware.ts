import type { Context, MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import { BROWSER_REVALIDATE, buildEdgeDirective, formatCacheTag } from './headers.js'
import type { WorkersCacheOptions } from './types.js'

declare module 'hono' {
  interface ContextVariableMap {
    /** Accumulator for tags appended from handlers via cacheTag(). */
    __workersCacheTags?: string[]
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
 * export default createRoute(workersCache({ maxAge: 3600 }), async (c) => {
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

/**
 * Hono middleware that declares a cache policy for Cloudflare Workers Cache.
 *
 * Workers Cache runs *in front of* the Worker, so this middleware never reads
 * or writes the cache. It only does two things:
 *   1. Declares the policy on the response (Cache-Control / CDN-Cache-Control / Cache-Tag)
 *   2. Guards against uncacheable conditions (Set-Cookie, non-GET/HEAD, error statuses)
 *
 * Prerequisite: `"cache": { "enabled": true }` in wrangler.jsonc (Wrangler >= 4.69.0)
 */
export function workersCache(opts: WorkersCacheOptions = {}): MiddlewareHandler {
  const strategy = opts.strategy ?? 'cdn-split'
  const useRouteTag = opts.routeTag !== false

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

    const edgeDirective = buildEdgeDirective(opts)

    if (strategy === 'cdn-split') {
      // Edge: serve & revalidate with SWR / browser: revalidate with the edge
      // every time. Keeping stale copies out of browsers makes purges take
      // effect immediately (same strategy as vinext).
      res.headers.set('Cache-Control', BROWSER_REVALIDATE)
      res.headers.set('CDN-Cache-Control', edgeDirective)
    } else {
      res.headers.set('Cache-Control', edgeDirective)
    }

    // Collect tags: option-provided + automatic route tag + cacheTag() additions
    const collected: string[] = []
    const optTags = typeof opts.tags === 'function' ? opts.tags(c) : opts.tags
    if (optTags) collected.push(...optTags)
    // Called after next(), so this resolves to the route template of the
    // handler that actually produced the response.
    const matchedRoutePath = routePath(c)
    if (useRouteTag && matchedRoutePath && matchedRoutePath !== '/*') {
      collected.push(`route:${matchedRoutePath}`)
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
