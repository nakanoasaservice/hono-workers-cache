// Directory-wide cache policy: applies to every route under /blog.
// Routes that declare their own workersCache() (or set Cache-Control
// themselves) take precedence — the middleware never overwrites an
// existing Cache-Control. Handlers can also tighten the lifetime with
// cacheLife(c, ...).
import { workersCache } from 'hono-workers-cache'
import { createRoute } from 'honox/factory'

export default createRoute(workersCache({ profile: 'minutes', tags: ['blog'] }))
