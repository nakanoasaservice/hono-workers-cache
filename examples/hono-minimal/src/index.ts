import { Hono } from 'hono'
import {
  cacheLife,
  cacheTag,
  noCache,
  revalidateEverything,
  revalidatePath,
  revalidateTag,
  workersCache,
} from 'hono-workers-cache'

const app = new Hono()

// Cached route with the Next.js 'hours' profile:
//   browsers reuse for 5 min (stale), the edge stays fresh for 1 hour
//   (revalidate) and serves stale-while-revalidating until 1 day (expire).
app.get(
  '/posts/:id',
  workersCache({
    profile: 'hours',
    tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
  }),
  (c) => {
    // Tags and lifetimes can also be declared from inside the handler.
    cacheTag(c, 'rendered-html')
    if (c.req.param('id') === 'breaking') cacheLife(c, 'minutes')
    return c.html(`<h1>Post ${c.req.param('id')}</h1>`)
  },
)

// stale: 0 keeps browsers revalidating with the edge on every request,
// so a purge reaches users instantly — this library's specialty.
app.get('/api/status', workersCache({ stale: 0, revalidate: 60, expire: 300 }), (c) =>
  c.json({ ok: true }),
)

// Mutation: purge the affected tags so the next GET regenerates.
app.post('/posts/:id', async (c) => {
  const id = c.req.param('id')
  // ... write to your data source here ...
  const result = await revalidateTag([`post-${id}`, 'posts'], c)
  return c.json({ updated: id, purge: result })
})

// Or purge by path — exact, per-route, or by prefix.
app.post('/admin/purge-paths', async (c) => {
  await revalidatePath('/posts/breaking', c) // exactly this path
  await revalidatePath('/posts/:id', 'route', c) // every URL this route produced
  await revalidatePath('/api/', 'prefix', c) // everything under /api/
  return c.json({ ok: true })
})

// Never cached; also strips cache headers stamped upstream.
app.get('/admin', noCache(), (c) => c.text('admin'))

// Nuke the whole cache for this Worker entrypoint (use sparingly).
app.post('/admin/purge-all', async (c) => {
  const result = await revalidateEverything(c)
  return c.json(result)
})

export default app
