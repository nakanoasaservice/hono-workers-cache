import { describe, expect, it } from 'vitest'
import {
  buildBrowserDirective,
  buildEdgeDirective,
  cacheLifeProfiles,
  formatCacheTag,
  normalizePath,
  resolveCacheLife,
} from '../src/index.js'

describe('normalizePath', () => {
  it('strips query strings and hashes', () => {
    expect(normalizePath('/docs?page=2')).toBe('/docs')
    expect(normalizePath('/docs#intro')).toBe('/docs')
    expect(normalizePath('/docs?page=2#intro')).toBe('/docs')
  })

  it('removes trailing slashes except for the root', () => {
    expect(normalizePath('/blog/post-1/')).toBe('/blog/post-1')
    expect(normalizePath('/blog//')).toBe('/blog')
    expect(normalizePath('/')).toBe('/')
  })

  it('enforces a leading slash', () => {
    expect(normalizePath('about')).toBe('/about')
  })
})

describe('resolveCacheLife', () => {
  it("falls back to the 'default' profile (Next.js: stale 5 min / revalidate 15 min / expire never)", () => {
    expect(resolveCacheLife()).toEqual({ stale: 300, revalidate: 900, expire: 'never' })
    expect(resolveCacheLife({})).toEqual({ stale: 300, revalidate: 900, expire: 'never' })
  })

  it('resolves a named profile', () => {
    expect(resolveCacheLife({ profile: 'hours' })).toEqual({
      stale: 300,
      revalidate: 3600,
      expire: 86400,
    })
  })

  it('lets explicit fields override the profile', () => {
    expect(resolveCacheLife({ profile: 'days', stale: 0 })).toEqual({
      stale: 0,
      revalidate: 86400,
      expire: 604800,
    })
  })

  it('accepts a fully custom lifetime', () => {
    expect(resolveCacheLife({ stale: 60, revalidate: 3600, expire: 86400 })).toEqual({
      stale: 60,
      revalidate: 3600,
      expire: 86400,
    })
  })

  it('throws on an unknown profile', () => {
    // @ts-expect-error -- runtime guard for JS users
    expect(() => resolveCacheLife({ profile: 'fortnights' })).toThrow(TypeError)
  })

  it('ships the same built-in profile values as Next.js', () => {
    expect(cacheLifeProfiles.seconds).toEqual({ stale: 30, revalidate: 1, expire: 60 })
    expect(cacheLifeProfiles.minutes).toEqual({ stale: 300, revalidate: 60, expire: 3600 })
    expect(cacheLifeProfiles.weeks).toEqual({
      stale: 300,
      revalidate: 604800,
      expire: 2592000,
    })
    expect(cacheLifeProfiles.max).toEqual({
      stale: 300,
      revalidate: 2592000,
      expire: 31536000,
    })
  })
})

describe('buildBrowserDirective', () => {
  it('emits max-age=<stale> when stale > 0', () => {
    expect(buildBrowserDirective(300)).toBe('public, max-age=300')
  })

  it('emits the revalidate-every-time policy when stale is 0 (instant purges)', () => {
    expect(buildBrowserDirective(0)).toBe('public, max-age=0, must-revalidate')
  })
})

describe('buildEdgeDirective', () => {
  it('maps revalidate to max-age and (expire - revalidate) to stale-while-revalidate', () => {
    expect(buildEdgeDirective({ stale: 300, revalidate: 3600, expire: 86400 })).toBe(
      'public, max-age=3600, stale-while-revalidate=82800',
    )
  })

  it("resolves expire: 'never' to a one-year SWR window", () => {
    expect(buildEdgeDirective({ stale: 300, revalidate: 900, expire: 'never' })).toBe(
      'public, max-age=900, stale-while-revalidate=31536000',
    )
  })

  it('clamps the SWR window to 0 when expire <= revalidate', () => {
    expect(buildEdgeDirective({ stale: 0, revalidate: 60, expire: 60 })).toBe(
      'public, max-age=60, stale-while-revalidate=0',
    )
    expect(buildEdgeDirective({ stale: 0, revalidate: 60, expire: 30 })).toBe(
      'public, max-age=60, stale-while-revalidate=0',
    )
  })

  it('appends stale-if-error when given', () => {
    expect(buildEdgeDirective({ stale: 0, revalidate: 60, expire: 90 }, 600)).toBe(
      'public, max-age=60, stale-while-revalidate=30, stale-if-error=600',
    )
  })
})

describe('formatCacheTag', () => {
  it('joins tags with commas', () => {
    expect(formatCacheTag(['a', 'b', 'c'])).toBe('a,b,c')
  })

  it('returns null for empty input', () => {
    expect(formatCacheTag([])).toBeNull()
    expect(formatCacheTag([''])).toBeNull()
  })

  it('skips tags containing commas', () => {
    expect(formatCacheTag(['a', 'bad,tag', 'b'])).toBe('a,b')
  })

  it('deduplicates tags', () => {
    expect(formatCacheTag(['a', 'a', 'b', 'a'])).toBe('a,b')
  })

  it('skips single tags over 1024 bytes', () => {
    expect(formatCacheTag(['a', 'x'.repeat(2000), 'b'])).toBe('a,b')
  })

  it('measures tag size in bytes, not code units (multibyte)', () => {
    // 512 chars × 3 bytes = 1536 bytes > 1024, even though .length is only 512
    const multibyte = 'あ'.repeat(512)
    expect(multibyte.length).toBeLessThan(1024)
    expect(formatCacheTag(['a', multibyte, 'b'])).toBe('a,b')
  })

  it('keeps a multibyte tag that fits within 1024 bytes', () => {
    const multibyte = 'あ'.repeat(341) // 1023 bytes
    expect(formatCacheTag([multibyte])).toBe(multibyte)
  })

  it('truncates the whole header at the 8KB budget', () => {
    // 100 tags × ~100 bytes ≈ 10KB — must be cut off before 8192 bytes
    const tags = Array.from({ length: 100 }, (_, i) => `tag-${i}-${'x'.repeat(95)}`)
    const value = formatCacheTag(tags)
    expect(value).not.toBeNull()
    const bytes = new TextEncoder().encode(value as string).length
    expect(bytes).toBeLessThanOrEqual(8 * 1024)
    expect((value as string).split(',').length).toBeLessThan(100)
  })
})
