import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cacheLife, cacheTag, noCache, workersCache } from '../src/index.js'

describe('workersCache — split headers from one cacheLife', () => {
  it('emits browser/edge/tag headers, merging option tags, the route tag and cacheTag()', async () => {
    const app = new Hono()
    app.get(
      '/blog/:id',
      workersCache({
        stale: 0,
        revalidate: 3600,
        expire: 3900,
        tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
      }),
      (c) => {
        cacheTag(c, 'from-handler')
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

  it("applies the 'default' profile when called with no options (Next.js values)", async () => {
    const app = new Hono()
    app.get('/defaults', workersCache(), (c) => c.text('d'))

    const res = await app.request('/defaults')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=900, stale-while-revalidate=31536000',
    )
    expect(res.headers.get('Cache-Tag')).toBe('route:/defaults')
  })

  it('accepts a profile name as the sole argument', async () => {
    const app = new Hono()
    app.get('/hourly', workersCache('hours'), (c) => c.text('h'))

    const res = await app.request('/hourly')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=3600, stale-while-revalidate=82800',
    )
  })

  it('lets explicit fields override the profile (instant-purge daily content)', async () => {
    const app = new Hono()
    app.get('/news', workersCache({ profile: 'days', stale: 0, routeTag: false }), (c) =>
      c.text('n'),
    )

    const res = await app.request('/news')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=86400, stale-while-revalidate=518400',
    )
  })

  it('emits stale-if-error when configured', async () => {
    const app = new Hono()
    app.get(
      '/x',
      workersCache({ stale: 0, revalidate: 60, expire: 90, staleIfError: 600, routeTag: false }),
      (c) => c.text('x'),
    )

    const res = await app.request('/x')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=30, stale-if-error=600',
    )
  })

  it('tags with the final route template when applied as directory middleware', async () => {
    const app = new Hono()
    app.use('/blog/*', workersCache('hours'))
    app.get('/blog/:id', (c) => c.text('post'))

    const res = await app.request('/blog/123')
    expect(res.headers.get('Cache-Tag')).toBe('route:/blog/:id')
  })

  it('does not add a route tag for a bare wildcard route', async () => {
    const app = new Hono()
    app.get('/*', workersCache('hours'), (c) => c.text('w'))

    const res = await app.request('/anything')
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })
})

describe('cacheLife — handler-level lifetimes', () => {
  it('overrides the middleware default from inside the handler', async () => {
    const app = new Hono()
    app.get('/posts/:id', workersCache('days'), (c) => {
      cacheLife(c, 'minutes')
      return c.text('breaking')
    })

    const res = await app.request('/posts/1')
    // minutes profile: stale 300 / revalidate 60 / expire 3600
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=3540',
    )
  })

  it('merges partial objects field-by-field over the middleware options', async () => {
    const app = new Hono()
    app.get('/mixed', workersCache({ stale: 0, revalidate: 3600, expire: 7200 }), (c) => {
      cacheLife(c, { revalidate: 60 })
      return c.text('m')
    })

    const res = await app.request('/mixed')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=7140',
    )
  })

  it('takes the shortest value per field across multiple calls (Next.js rule)', async () => {
    const app = new Hono()
    app.get('/multi', workersCache({ routeTag: false }), (c) => {
      cacheLife(c, { stale: 60, revalidate: 600, expire: 'never' })
      cacheLife(c, { stale: 300, revalidate: 60, expire: 3600 })
      return c.text('m')
    })

    const res = await app.request('/multi')
    // stale: min(60, 300) / revalidate: min(600, 60) / expire: min(never, 3600)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=3540',
    )
  })

  it('throws on an unknown profile name', async () => {
    const app = new Hono()
    app.get('/bad', workersCache(), (c) => {
      // @ts-expect-error -- runtime guard for JS users
      cacheLife(c, 'fortnights')
      return c.text('never reached')
    })
    app.onError((err, c) => c.text(err.message, 500))

    const res = await app.request('/bad')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('Unknown cache profile')
  })
})

describe('workersCache — cacheControl escape hatch', () => {
  it('emits the string verbatim as a single Cache-Control (no CDN-Cache-Control)', async () => {
    const app = new Hono()
    app.get(
      '/raw',
      workersCache({ cacheControl: 's-maxage=300, max-age=0', routeTag: false }),
      (c) => c.text('raw'),
    )

    const res = await app.request('/raw')
    expect(res.headers.get('Cache-Control')).toBe('s-maxage=300, max-age=0')
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
  })

  it('forbids combining cacheControl with lifetime options at the type level', () => {
    // @ts-expect-error -- cacheControl is mutually exclusive with revalidate
    workersCache({ cacheControl: 's-maxage=300', revalidate: 60 })
    // @ts-expect-error -- cacheControl is mutually exclusive with profile
    workersCache({ cacheControl: 's-maxage=300', profile: 'hours' })
    // @ts-expect-error -- cacheControl is mutually exclusive with staleIfError
    workersCache({ cacheControl: 's-maxage=300', staleIfError: 600 })
    // tags/routeTag remain allowed alongside cacheControl
    workersCache({ cacheControl: 's-maxage=300', tags: ['a'], routeTag: false })
    expect(true).toBe(true)
  })
})

describe('workersCache — hands-off conditions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves responses with Set-Cookie untouched (and warns in dev)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    app.get('/session', workersCache('hours'), (c) => {
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

  it('warns in dev when expire is shorter than revalidate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    app.get('/odd', workersCache({ revalidate: 600, expire: 60, routeTag: false }), (c) =>
      c.text('odd'),
    )

    const res = await app.request('/odd')
    expect(res.headers.get('CDN-Cache-Control')).toBe(
      'public, max-age=600, stale-while-revalidate=0',
    )
    expect(warn).toHaveBeenCalledOnce()
  })

  it('leaves non-GET/HEAD requests untouched', async () => {
    const app = new Hono()
    app.post('/blog/:id', workersCache('hours'), (c) => c.text('created', 201))

    const res = await app.request('/blog/123', { method: 'POST' })
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  it('leaves non-cacheable statuses untouched', async () => {
    const app = new Hono()
    app.get('/boom', workersCache('hours'), (c) => c.text('boom', 500))

    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  it('respects a Cache-Control already set by the handler', async () => {
    const app = new Hono()
    app.get('/manual', workersCache('hours'), (c) => {
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
    app.get('/admin', workersCache({ profile: 'hours', tags: ['admin'] }), noCache(), (c) =>
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
