// Directory-wide cache policy: applies to every route under /blog.
// Routes that declare their own workersCache() (or set Cache-Control
// themselves) take precedence — the middleware never overwrites an
// existing Cache-Control.
import { workersCache } from 'hono-workers-cache'
import { createRoute } from 'honox/factory'

export default createRoute(workersCache({ maxAge: 600, tags: ['blog'] }))
