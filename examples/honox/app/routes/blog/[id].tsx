import { addCacheTags, revalidateTags, workersCache } from 'hono-workers-cache'
import { createRoute } from 'honox/factory'

// GET /blog/:id — cached for an hour at the edge, served with SWR.
export default createRoute(
  workersCache({
    maxAge: 3600,
    staleWhileRevalidate: 300,
    tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
  }),
  async (c) => {
    const id = c.req.param('id')
    // ... fetch the post from your data source here ...
    addCacheTags(c, 'rendered-html') // tags can be appended from the handler too
    return c.render(
      <article>
        <h1>Post {id}</h1>
        <p>Rendered at {new Date().toISOString()}</p>
        <form method="post">
          <button type="submit">Update (purges this post)</button>
        </form>
      </article>,
    )
  },
)

// POST /blog/:id — mutate, then purge the affected tags.
export const POST = createRoute(async (c) => {
  const id = c.req.param('id')
  // ... write to your data source here ...
  await revalidateTags([`post-${id}`, 'posts'], c)
  return c.redirect(`/blog/${id}`)
})
