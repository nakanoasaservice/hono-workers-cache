import type { SwrWindow, WorkersCacheOptions } from './types.js'

/**
 * Finite value substituted for 'unbounded' SWR (one year).
 * Cloudflare follows RFC 5861 and treats a value-less stale-while-revalidate
 * as a zero-width window.
 */
export const UNBOUNDED_SWR_SECONDS = 31_536_000

/** Browser policy: revalidate with the edge on every request (conditional 304s allowed). */
export const BROWSER_REVALIDATE = 'public, max-age=0, must-revalidate'

/**
 * Default freshness window: 5 minutes. Together with DEFAULT_SWR this is a
 * conservative transposition of Next.js' default `cacheLife` profile
 * (stale 5 min / revalidate 15 min): forget to purge and content still
 * refreshes itself within minutes.
 */
export const DEFAULT_MAX_AGE = 300

/** Default stale-while-revalidate window: 15 minutes. */
export const DEFAULT_SWR = 900

/**
 * Cloudflare's Cache-Tag limits: 16KB for the whole header / 1024 bytes per
 * tag. Exceeding them drops the header silently, so we cap conservatively at 8KB.
 */
const MAX_CACHE_TAG_BYTES = 8 * 1024
const MAX_SINGLE_TAG_BYTES = 1024

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length

/**
 * Build the edge-facing Cache-Control directive string.
 * If the `cacheControl` escape hatch is set, it is used **verbatim, with no
 * processing whatsoever**.
 */
export function buildEdgeDirective(opts: WorkersCacheOptions = {}): string {
  if (opts.cacheControl) return opts.cacheControl

  const parts = [
    'public',
    `max-age=${opts.maxAge ?? DEFAULT_MAX_AGE}`,
    `stale-while-revalidate=${resolveSwr(opts.staleWhileRevalidate ?? DEFAULT_SWR)}`,
  ]
  if (opts.staleIfError !== undefined) {
    parts.push(`stale-if-error=${opts.staleIfError}`)
  }
  return parts.join(', ')
}

function resolveSwr(swr: SwrWindow): number {
  return swr === 'unbounded' ? UNBOUNDED_SWR_SECONDS : swr
}

/**
 * Build a `Cache-Tag` header value from an array of tags.
 * Tags containing commas or exceeding the size limit are skipped, and the
 * whole header is kept within the byte budget.
 */
export function formatCacheTag(tags: readonly string[]): string | null {
  const parts: string[] = []
  const seen = new Set<string>()
  let total = 0
  for (const tag of tags) {
    if (!tag || tag.includes(',') || seen.has(tag)) continue
    const bytes = byteLength(tag)
    if (bytes > MAX_SINGLE_TAG_BYTES) continue
    const next = total + bytes + (parts.length > 0 ? 1 : 0) // +1 for the joining comma
    if (next > MAX_CACHE_TAG_BYTES) break
    parts.push(tag)
    seen.add(tag)
    total = next
  }
  return parts.length > 0 ? parts.join(',') : null
}
