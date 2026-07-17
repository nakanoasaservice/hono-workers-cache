import type { Context } from 'hono'

/** Built-in profile names — same names and values as Next.js `cacheLife()`. */
export type CacheLifeProfile =
  | 'default'
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days'
  | 'weeks'
  | 'max'

/**
 * A cache lifetime in the Next.js Cache Components vocabulary, mapped onto
 * Cloudflare's two cache tiers:
 *
 * - `stale`      → how long **browsers** reuse a copy without asking the edge
 *                  (`Cache-Control: max-age`). `0` means every request
 *                  revalidates with the edge, so purges reach users instantly.
 * - `revalidate` → how long the **edge** serves without regenerating
 *                  (`CDN-Cache-Control: max-age`). Past it, the edge serves
 *                  stale and refreshes in the background (SWR).
 * - `expire`     → total lifetime. Past it, the edge blocks and fetches fresh
 *                  (`stale-while-revalidate = expire - revalidate`).
 *                  `'never'` resolves to one year (31,536,000 s) — Cloudflare
 *                  has no truly infinite window.
 */
export interface CacheLife {
  /** Browser freshness window in seconds. `0` = revalidate with the edge every request. */
  stale?: number
  /** Edge freshness window in seconds; after this the edge serves stale while regenerating. */
  revalidate?: number
  /** Max total lifetime in seconds (or `'never'`); after this the edge fetches fresh. */
  expire?: number | 'never'
}

/** A `CacheLife` with every field filled in (profile defaults applied). */
export type ResolvedCacheLife = Required<CacheLife>

export interface WorkersCacheOptions extends CacheLife {
  /**
   * Base profile — same names and values as Next.js. Explicit `stale` /
   * `revalidate` / `expire` fields override the profile's values, e.g.
   * `{ profile: 'days', stale: 0 }` = daily content with instant purges.
   * Default: 'default' (stale 5 min / revalidate 15 min / expire never).
   */
  profile?: CacheLifeProfile
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
  /**
   * Escape hatch for hand-writing the policy. When set, the string is emitted
   * as the single `Cache-Control` header **verbatim, with no processing
   * whatsoever** (no `CDN-Cache-Control` is emitted), and the lifetime options
   * are ignored. Tags are still emitted.
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
