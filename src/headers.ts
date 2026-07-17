import type { CacheLife, CacheLifeProfile, ResolvedCacheLife } from './types.js'

/**
 * Finite value substituted for `expire: 'never'` (one year). Cloudflare has no
 * infinite cache window, and follows RFC 5861 in treating a value-less
 * stale-while-revalidate as a zero-width window — so we always spell it out.
 */
export const NEVER_EXPIRE_SECONDS = 31_536_000

/**
 * Built-in cache profiles — identical names and values to Next.js
 * (packages/next/src/server/config-shared.ts, `defaultCacheLifeProfiles`).
 * Next.js' INFINITE_CACHE becomes `'never'` (one year at the edge).
 */
export const cacheLifeProfiles: Record<CacheLifeProfile, ResolvedCacheLife> = {
  default: { stale: 300, revalidate: 900, expire: 'never' },
  seconds: { stale: 30, revalidate: 1, expire: 60 },
  minutes: { stale: 300, revalidate: 60, expire: 3_600 },
  hours: { stale: 300, revalidate: 3_600, expire: 86_400 },
  days: { stale: 300, revalidate: 86_400, expire: 604_800 },
  weeks: { stale: 300, revalidate: 604_800, expire: 2_592_000 },
  max: { stale: 300, revalidate: 2_592_000, expire: 31_536_000 },
}

/**
 * Cloudflare's Cache-Tag limits: 16KB for the whole header / 1024 bytes per
 * tag. Exceeding them drops the header silently, so we cap conservatively at 8KB.
 */
const MAX_CACHE_TAG_BYTES = 8 * 1024
const MAX_SINGLE_TAG_BYTES = 1024

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length

/**
 * Fill in a partial `CacheLife` from its base profile ('default' when none is
 * given). Explicit fields win over the profile's values.
 */
export function resolveCacheLife(
  life: CacheLife & { profile?: CacheLifeProfile } = {},
): ResolvedCacheLife {
  const base = cacheLifeProfiles[life.profile ?? 'default']
  if (!base) {
    throw new TypeError(
      `[workersCache] Unknown cache profile "${life.profile}". ` +
        `Available profiles: ${Object.keys(cacheLifeProfiles).join(', ')}`,
    )
  }
  return {
    stale: life.stale ?? base.stale,
    revalidate: life.revalidate ?? base.revalidate,
    expire: life.expire ?? base.expire,
  }
}

/**
 * Browser-facing `Cache-Control` from `stale`.
 * `stale: 0` keeps browsers revalidating with the edge on every request
 * (conditional 304s allowed) — purges reach users instantly.
 */
export function buildBrowserDirective(stale: number): string {
  return stale > 0 ? `public, max-age=${stale}` : 'public, max-age=0, must-revalidate'
}

/**
 * Edge-facing `CDN-Cache-Control` from `revalidate` / `expire`:
 * fresh for `revalidate` seconds, then stale-while-revalidate until `expire`.
 */
export function buildEdgeDirective(life: ResolvedCacheLife, staleIfError?: number): string {
  // 'never' means "serve stale as long as possible", not arithmetic — use the
  // full one-year window instead of subtracting revalidate from it.
  const swr =
    life.expire === 'never' ? NEVER_EXPIRE_SECONDS : Math.max(0, life.expire - life.revalidate)
  const parts = ['public', `max-age=${life.revalidate}`, `stale-while-revalidate=${swr}`]
  if (staleIfError !== undefined) {
    parts.push(`stale-if-error=${staleIfError}`)
  }
  return parts.join(', ')
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
