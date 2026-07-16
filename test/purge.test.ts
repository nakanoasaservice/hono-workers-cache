import type { Context } from 'hono'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { purgeEverything, revalidatePaths, revalidateTags } from '../src/index.js'

/** Run a handler inside a Hono app with a mocked ExecutionContext carrying `cache`. */
async function withExecutionCtx<T>(cache: unknown, run: (c: Context) => Promise<T>): Promise<T> {
  let result: T | undefined
  const app = new Hono()
  app.get('/', async (c) => {
    result = await run(c)
    return c.text('ok')
  })
  const executionCtx = {
    cache,
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }
  // biome-ignore lint/suspicious/noExplicitAny: Hono's test signature accepts a partial ExecutionContext
  await app.request('/', undefined, undefined, executionCtx as any)
  return result as T
}

describe('purge helpers outside the Workers runtime (Node)', () => {
  it('resolves to a cache-unavailable no-op instead of throwing', async () => {
    await expect(revalidateTags(['posts'])).resolves.toEqual({
      ok: false,
      reason: 'cache-unavailable',
    })
    await expect(revalidatePaths('/blog/')).resolves.toEqual({
      ok: false,
      reason: 'cache-unavailable',
    })
    await expect(purgeEverything()).resolves.toEqual({
      ok: false,
      reason: 'cache-unavailable',
    })
  })
})

describe('purge helpers with empty input', () => {
  it('resolves { ok: true } immediately without touching the cache', async () => {
    await expect(revalidateTags([])).resolves.toEqual({ ok: true })
    await expect(revalidateTags('')).resolves.toEqual({ ok: true })
    await expect(revalidatePaths([])).resolves.toEqual({ ok: true })
  })
})

describe('purge helpers with an injected executionCtx.cache', () => {
  it('revalidateTags calls purge with { tags }', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    const result = await withExecutionCtx({ purge }, (c) => revalidateTags(['post-1', 'posts'], c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ tags: ['post-1', 'posts'] })
    expect(result).toEqual({ ok: true })
  })

  it('revalidateTags normalizes a single string to an array', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => revalidateTags('posts', c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ tags: ['posts'] })
  })

  it('revalidatePaths calls purge with { pathPrefixes }', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => revalidatePaths(['/blog/', '/docs/'], c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ pathPrefixes: ['/blog/', '/docs/'] })
  })

  it('purgeEverything calls purge with { purgeEverything: true }', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => purgeEverything(c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ purgeEverything: true })
  })

  it('maps a resolved { success: false } to purge-failed', async () => {
    const errors = [{ code: 429, message: 'rate limited' }]
    const purge = vi.fn().mockResolvedValue({ success: false, errors })
    const result = await withExecutionCtx({ purge }, (c) => revalidateTags('posts', c))
    expect(result).toEqual({ ok: false, reason: 'purge-failed', error: errors })
  })

  it('maps a rejected purge to purge-failed', async () => {
    const boom = new Error('boom')
    const purge = vi.fn().mockRejectedValue(boom)
    const result = await withExecutionCtx({ purge }, (c) => revalidateTags('posts', c))
    expect(result).toEqual({ ok: false, reason: 'purge-failed', error: boom })
  })

  it('treats a void resolution as success (older runtimes)', async () => {
    const purge = vi.fn().mockResolvedValue(undefined)
    const result = await withExecutionCtx({ purge }, (c) => revalidateTags('posts', c))
    expect(result).toEqual({ ok: true })
  })

  it('falls back to cache-unavailable when executionCtx has no usable cache', async () => {
    const result = await withExecutionCtx(undefined, (c) => revalidateTags('posts', c))
    expect(result).toEqual({ ok: false, reason: 'cache-unavailable' })
  })
})
