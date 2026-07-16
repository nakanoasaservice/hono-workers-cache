import { describe, expect, it } from 'vitest'
import { buildEdgeDirective, formatCacheTag } from '../src/index.js'

describe('buildEdgeDirective', () => {
  it('builds public + max-age from options', () => {
    expect(buildEdgeDirective({ maxAge: 3600 })).toBe('public, max-age=3600')
  })

  it('appends stale-while-revalidate and stale-if-error', () => {
    expect(buildEdgeDirective({ maxAge: 60, staleWhileRevalidate: 30, staleIfError: 600 })).toBe(
      'public, max-age=60, stale-while-revalidate=30, stale-if-error=600',
    )
  })

  it("resolves 'unbounded' SWR to one year", () => {
    expect(buildEdgeDirective({ maxAge: 60, staleWhileRevalidate: 'unbounded' })).toBe(
      'public, max-age=60, stale-while-revalidate=31536000',
    )
  })

  it('uses the cacheControl escape hatch verbatim', () => {
    expect(buildEdgeDirective({ maxAge: 999, cacheControl: 's-maxage=300, max-age=0' })).toBe(
      's-maxage=300, max-age=0',
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
