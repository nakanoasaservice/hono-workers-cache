import { workersCache } from 'hono-workers-cache'
import { createRoute } from 'honox/factory'

export default createRoute(workersCache('minutes'), (c) => {
  return c.render(
    <div>
      <h1>hono-workers-cache × HonoX</h1>
      <ul>
        <li>
          <a href="/blog/1">/blog/1 — cached per post with tags</a>
        </li>
        <li>
          <a href="/admin">/admin — never cached</a>
        </li>
      </ul>
    </div>,
  )
})
