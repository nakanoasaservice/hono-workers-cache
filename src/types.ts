import type { Context } from 'hono'

/**
 * Seconds for `stale-while-revalidate`. Passing 'unbounded' resolves to one
 * year (31,536,000 seconds). Cloudflare follows RFC 5861 and treats a
 * value-less SWR directive as a zero-width window (same correction as
 * vinext's cdn-adapter).
 */
export type SwrWindow = number | 'unbounded'

export type CacheStrategy =
  /**
   * Split browser and edge policies (default, recommended).
   * - `Cache-Control: public, max-age=0, must-revalidate` — the browser revalidates with the edge on every request
   * - `CDN-Cache-Control: public, max-age=…, stale-while-revalidate=…` — the edge serves with SWR
   * A purge reaches users immediately. Same strategy as vinext's cdnAdapter.
   */
  | 'cdn-split'
  /**
   * Apply a single `Cache-Control` to both shared caches (edge) and browsers.
   * Browsers also honor max-age, so purges are not immediate, but the header
   * output is minimal.
   */
  | 'shared'

export interface WorkersCacheOptions {
  /**
   * Freshness window at the edge, in seconds.
   * Default: 300 (5 minutes).
   */
  maxAge?: number
  /**
   * stale-while-revalidate window (seconds or 'unbounded').
   * Default: 900 (15 minutes). Pass 0 to disable serving stale.
   */
  staleWhileRevalidate?: SwrWindow
  /** stale-if-error window in seconds. Serves stale content when the origin returns 5xx. */
  staleIfError?: number
  /**
   * Tags to emit in `Cache-Tag`. Pass a function to evaluate per request
   * (e.g. tags derived from path parameters).
   */
  tags?: string[] | ((c: Context) => string[])
  /**
   * Automatically add a `route:/blog/:id`-style tag derived from the matched
   * route pattern, enabling purges per route template. Default: true
   */
  routeTag?: boolean
  /** Header strategy. Default: 'cdn-split' */
  strategy?: CacheStrategy
  /**
   * Escape hatch for hand-writing the directives. When set, maxAge /
   * staleWhileRevalidate / staleIfError are ignored and this string is used
   * as the edge policy **verbatim, with no processing whatsoever**.
   * Note: Cloudflare treats a value-less `stale-while-revalidate` as a
   * zero-width window (RFC 5861) — always spell out the seconds.
   */
  cacheControl?: string
}

/** The purge surface of `ctx.cache` / `cloudflare:workers`' cache (for duck typing). */
export interface WorkersCacheLike {
  purge(options: {
    tags?: string[]
    pathPrefixes?: string[]
    purgeEverything?: boolean
  }): Promise<unknown>
}

export interface PurgeResult {
  /** Whether the purge was executed. False when the runtime has no Workers Cache (e.g. dev). */
  ok: boolean
  /** Why ok is false. */
  reason?: 'cache-unavailable' | 'purge-failed'
  error?: unknown
}
