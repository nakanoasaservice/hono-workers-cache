import { Hono } from 'hono'
import { cacheTag, noCache, purgeEverything, revalidateTag, workersCache } from 'hono-workers-cache'

const app = new Hono()

// Cached route: the edge serves this with stale-while-revalidate, browsers
// revalidate with the edge on every request (default 'cdn-split' strategy).
app.get(
  '/posts/:id',
  workersCache({
    maxAge: 3600,
    staleWhileRevalidate: 300,
    tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
  }),
  (c) => {
    // Tags can also be appended from inside the handler.
    cacheTag(c, 'rendered-html')
    return c.html(`<h1>Post ${c.req.param('id')}</h1>`)
  },
)

// A single Cache-Control shared by browsers and the edge.
app.get('/api/status', workersCache({ maxAge: 60, strategy: 'shared' }), (c) =>
  c.json({ ok: true }),
)

// Mutation: purge the affected tags so the next GET regenerates.
app.post('/posts/:id', async (c) => {
  const id = c.req.param('id')
  // ... write to your data source here ...
  const result = await revalidateTag([`post-${id}`, 'posts'], c)
  return c.json({ updated: id, purge: result })
})

// Never cached; also strips cache headers stamped upstream.
app.get('/admin', noCache(), (c) => c.text('admin'))

// Nuke the whole cache for this Worker entrypoint (use sparingly).
app.post('/admin/purge-all', async (c) => {
  const result = await purgeEverything(c)
  return c.json(result)
})

export default app
