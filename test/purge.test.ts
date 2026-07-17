import type { Context } from 'hono'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { revalidateEverything, revalidatePath, revalidateTag } from '../src/index.js'

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
    await expect(revalidateTag(['posts'])).resolves.toEqual({
      ok: false,
      reason: 'cache-unavailable',
    })
    await expect(revalidatePath('/blog/')).resolves.toEqual({
      ok: false,
      reason: 'cache-unavailable',
    })
    await expect(revalidateEverything()).resolves.toEqual({
      ok: false,
      reason: 'cache-unavailable',
    })
  })
})

describe('purge helpers with empty input', () => {
  it('resolves { ok: true } immediately without touching the cache', async () => {
    await expect(revalidateTag([])).resolves.toEqual({ ok: true })
    await expect(revalidateTag('')).resolves.toEqual({ ok: true })
    await expect(revalidatePath([])).resolves.toEqual({ ok: true })
  })
})

describe('purge helpers with an injected executionCtx.cache', () => {
  it('revalidateTag calls purge with { tags }', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    const result = await withExecutionCtx({ purge }, (c) => revalidateTag(['post-1', 'posts'], c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ tags: ['post-1', 'posts'] })
    expect(result).toEqual({ ok: true })
  })

  it('revalidateTag normalizes a single string to an array', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => revalidateTag('posts', c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ tags: ['posts'] })
  })

  it('revalidatePath (no type) purges the normalized path: tag', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => revalidatePath('/blog/post-1', c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ tags: ['path:/blog/post-1'] })
  })

  it('revalidatePath normalizes trailing slashes and query strings for path: tags', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) =>
      revalidatePath(['/blog/post-1/', '/docs?page=2', 'about'], c),
    )
    expect(purge).toHaveBeenCalledExactlyOnceWith({
      tags: ['path:/blog/post-1', 'path:/docs', 'path:/about'],
    })
  })

  it("revalidatePath 'route' purges the route: tag verbatim", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => revalidatePath('/blog/:id', 'route', c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ tags: ['route:/blog/:id'] })
  })

  it("revalidatePath 'prefix' calls purge with { pathPrefixes }", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => revalidatePath(['/blog/', '/docs/'], 'prefix', c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ pathPrefixes: ['/blog/', '/docs/'] })
  })

  it('revalidateEverything calls purge with { purgeEverything: true }', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true })
    await withExecutionCtx({ purge }, (c) => revalidateEverything(c))
    expect(purge).toHaveBeenCalledExactlyOnceWith({ purgeEverything: true })
  })

  it('maps a resolved { success: false } to purge-failed', async () => {
    const errors = [{ code: 429, message: 'rate limited' }]
    const purge = vi.fn().mockResolvedValue({ success: false, errors })
    const result = await withExecutionCtx({ purge }, (c) => revalidateTag('posts', c))
    expect(result).toEqual({ ok: false, reason: 'purge-failed', error: errors })
  })

  it('maps a rejected purge to purge-failed', async () => {
    const boom = new Error('boom')
    const purge = vi.fn().mockRejectedValue(boom)
    const result = await withExecutionCtx({ purge }, (c) => revalidateTag('posts', c))
    expect(result).toEqual({ ok: false, reason: 'purge-failed', error: boom })
  })

  it('treats a void resolution as success (older runtimes)', async () => {
    const purge = vi.fn().mockResolvedValue(undefined)
    const result = await withExecutionCtx({ purge }, (c) => revalidateTag('posts', c))
    expect(result).toEqual({ ok: true })
  })

  it('falls back to cache-unavailable when executionCtx has no usable cache', async () => {
    const result = await withExecutionCtx(undefined, (c) => revalidateTag('posts', c))
    expect(result).toEqual({ ok: false, reason: 'cache-unavailable' })
  })
})
