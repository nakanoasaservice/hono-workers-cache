import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addCacheTags, noCache, workersCache } from '../src/index.js'

describe('workersCache — cdn-split strategy (default)', () => {
  it('emits the three headers, merging option tags, the route tag and addCacheTags()', async () => {
    const app = new Hono()
    app.get(
      '/blog/:id',
      workersCache({
        maxAge: 3600,
        staleWhileRevalidate: 300,
        tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
      }),
      (c) => {
        addCacheTags(c, 'from-handler')
        return c.html('<h1>post</h1>')
      },
    )

    const res = await app.request('/blog/123')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=3600, stale-while-revalidate=300',
    )
    expect(res.headers.get('Cache-Tag')).toBe('post-123,posts,route:/blog/:id,from-handler')
  })

  it('emits stale-if-error when configured', async () => {
    const app = new Hono()
    app.get('/x', workersCache({ maxAge: 60, staleIfError: 600, routeTag: false }), (c) =>
      c.text('x'),
    )

    const res = await app.request('/x')
    expect(res.headers.get('CDN-Cache-Control')).toBe('public, max-age=60, stale-if-error=600')
  })

  it("resolves staleWhileRevalidate: 'unbounded' to one year", async () => {
    const app = new Hono()
    app.get(
      '/u',
      workersCache({ maxAge: 60, staleWhileRevalidate: 'unbounded', routeTag: false }),
      (c) => c.text('u'),
    )

    const res = await app.request('/u')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=31536000',
    )
  })

  it('tags with the final route template when applied as directory middleware', async () => {
    const app = new Hono()
    app.use('/blog/*', workersCache({ maxAge: 60 }))
    app.get('/blog/:id', (c) => c.text('post'))

    const res = await app.request('/blog/123')
    expect(res.headers.get('Cache-Tag')).toBe('route:/blog/:id')
  })

  it('does not add a route tag for a bare wildcard route', async () => {
    const app = new Hono()
    app.get('/*', workersCache({ maxAge: 60 }), (c) => c.text('w'))

    const res = await app.request('/anything')
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })
})

describe('workersCache — shared strategy', () => {
  it('emits a single Cache-Control and no CDN-Cache-Control', async () => {
    const app = new Hono()
    app.get('/api/data', workersCache({ maxAge: 60, strategy: 'shared', routeTag: false }), (c) =>
      c.json({ ok: true }),
    )

    const res = await app.request('/api/data')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })
})

describe('workersCache — cacheControl escape hatch', () => {
  it('passes the string through verbatim (no s-maxage normalization)', async () => {
    const app = new Hono()
    app.get(
      '/raw',
      workersCache({
        maxAge: 0,
        cacheControl: 's-maxage=300, max-age=0',
        strategy: 'shared',
        routeTag: false,
      }),
      (c) => c.text('raw'),
    )

    const res = await app.request('/raw')
    expect(res.headers.get('Cache-Control')).toBe('s-maxage=300, max-age=0')
  })
})

describe('workersCache — hands-off conditions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves responses with Set-Cookie untouched (and warns in dev)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    app.get('/session', workersCache({ maxAge: 600 }), (c) => {
      c.header('Set-Cookie', 'sid=abc')
      return c.text('hello')
    })

    const res = await app.request('/session')
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
    // vitest runs with import.meta.env.DEV === true
    expect(warn).toHaveBeenCalledOnce()
  })

  it('leaves non-GET/HEAD requests untouched', async () => {
    const app = new Hono()
    app.post('/blog/:id', workersCache({ maxAge: 600 }), (c) => c.text('created', 201))

    const res = await app.request('/blog/123', { method: 'POST' })
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  it('leaves non-cacheable statuses untouched', async () => {
    const app = new Hono()
    app.get('/boom', workersCache({ maxAge: 600 }), (c) => c.text('boom', 500))

    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  it('respects a Cache-Control already set by the handler', async () => {
    const app = new Hono()
    app.get('/manual', workersCache({ maxAge: 600 }), (c) => {
      c.header('Cache-Control', 'private, max-age=10')
      return c.text('mine')
    })

    const res = await app.request('/manual')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=10')
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
  })
})

describe('noCache', () => {
  it('sets no-store and strips upstream cache headers, including CDN-Cache-Control and Cache-Tag', async () => {
    const app = new Hono()
    app.get('/admin', workersCache({ maxAge: 600, tags: ['admin'] }), noCache(), (c) =>
      c.text('secret'),
    )

    const res = await app.request('/admin')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  it('strips headers stamped directly by the route', async () => {
    const app = new Hono()
    app.get('/direct', noCache(), (c) => {
      c.header('CDN-Cache-Control', 'public, max-age=100')
      c.header('Cloudflare-CDN-Cache-Control', 'public, max-age=100')
      c.header('Cache-Tag', 'a,b')
      return c.text('x')
    })

    const res = await app.request('/direct')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })
})
