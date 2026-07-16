// Everything under /admin must never be cached. noCache() also strips any
// cache headers stamped by upstream middleware.
import { noCache } from 'hono-workers-cache'
import { createRoute } from 'honox/factory'

export default createRoute(noCache())
