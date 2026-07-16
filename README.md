# hono-workers-cache

Declarative [Cloudflare Workers Cache](https://developers.cloudflare.com/workers/cache/) middleware and purge helpers for [Hono](https://hono.dev) (works with [HonoX](https://github.com/honojs/honox)).

**A Next.js [Cache Components](https://nextjs.org/docs/app/getting-started/cache-components)-like experience for Hono**: declare how long a route stays fresh, tag what it renders, and call `revalidateTags()` when the data changes — the next request is regenerated, everything else keeps being served from cache. The difference: caching happens at Cloudflare's edge, in front of your Worker, so a cache hit costs zero CPU and your code never even runs.

```ts
import { Hono } from 'hono'
import { revalidateTags, workersCache } from 'hono-workers-cache'

const app = new Hono()

app.get(
  '/posts/:id',
  workersCache({ maxAge: 3600, staleWhileRevalidate: 300, tags: (c) => [`post-${c.req.param('id')}`] }),
  (c) => c.json({ id: c.req.param('id') }),
)

app.post('/posts/:id', async (c) => {
  await updatePost(c.req.param('id'))
  await revalidateTags(`post-${c.req.param('id')}`, c)
  return c.json({ ok: true })
})
```

## What is Workers Cache?

Workers Cache (2026) is an edge cache that runs **in front of** your Worker. Enable it with `"cache": { "enabled": true }` in `wrangler.jsonc` (Wrangler >= 4.69.0) and Cloudflare checks the cache **before** invoking your Worker — on a HIT, your code (including Hono) never executes.

That shapes this package's entire design: it **never reads or writes the cache**. It only does two things:

1. **Declare policy** — `workersCache()` stamps `Cache-Control` / `CDN-Cache-Control` / `Cache-Tag` on responses
2. **Invalidate** — `revalidateTags()` / `revalidatePaths()` / `purgeEverything()` wrap [`cache.purge()`](https://developers.cloudflare.com/workers/cache/purge/) in a Next.js-`revalidateTag`-style API

### Not the same as `hono/cache`

`hono/cache` is built on the older Cache API (`caches.default`). They are independent systems:

|  | Workers Cache (this package) | Cache API (`hono/cache`) |
| --- | --- | --- |
| Where it runs | In front of the Worker | Inside the Worker |
| Worker invoked on HIT | No (zero CPU) | Yes, every request |
| Read-through | Automatic | Manual `put()` / `match()` |
| Request collapsing | Automatic | No |
| Tiered cache | Automatic | No |
| Invalidation | `ctx.cache.purge()` (tags / path prefixes / everything) | `cache.delete()` (single data center only) |
| Purge scope | Per Worker entrypoint | Per URL |

For new Workers, Cloudflare recommends Workers Cache. Keep using `hono/cache` when you need fine-grained programmatic control from inside the Worker.

## Install

```sh
npm i hono-workers-cache
# pnpm add hono-workers-cache / bun add hono-workers-cache
```

## Setup

Enable Workers Cache in your Wrangler configuration (Wrangler >= 4.69.0). This is the only piece that cannot be configured from runtime code:

```jsonc
// wrangler.jsonc
{
  "cache": { "enabled": true }
}
```

## Usage

### Plain Hono

```ts
import { Hono } from 'hono'
import { noCache, revalidateTags, workersCache } from 'hono-workers-cache'

const app = new Hono()

// Zero config: fresh for 5 minutes, then serve stale while revalidating for 15
app.get('/about', workersCache(), (c) => c.html('<h1>About</h1>'))

// Cached: edge serves with SWR, browsers revalidate with the edge every time
app.get('/posts/:id', workersCache({ maxAge: 3600, staleWhileRevalidate: 300 }), (c) =>
  c.json({ id: c.req.param('id') }),
)

// Never cached (also strips cache headers stamped upstream)
app.get('/admin', noCache(), (c) => c.text('admin'))

// Invalidate after a mutation
app.post('/posts/:id', async (c) => {
  await update(c.req.param('id'))
  await revalidateTags('route:/posts/:id', c)
  return c.json({ ok: true })
})
```

Response headers with the default `cdn-split` strategy:

```
Cache-Control:     public, max-age=0, must-revalidate
CDN-Cache-Control: public, max-age=3600, stale-while-revalidate=300
Cache-Tag:         route:/posts/:id
```

The edge serves and background-revalidates with SWR while browsers revalidate with the edge on every request — so **a purge reaches users immediately**. Prefer a single header? Use `strategy: 'shared'`.

### HonoX: per route

This is a plain Hono middleware — HonoX simply provides `_middleware.ts` / `createRoute()` as the places to apply it.

```tsx
// app/routes/blog/[id].tsx
import { createRoute } from 'honox/factory'
import { addCacheTags, workersCache } from 'hono-workers-cache'

export default createRoute(
  workersCache({
    maxAge: 3600,
    staleWhileRevalidate: 300,
    tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
  }),
  async (c) => {
    const post = await getPost(c.req.param('id'))
    addCacheTags(c, `author-${post.authorId}`) // append tags from inside the handler
    return c.render(<Post post={post} />)
  },
)
```

### HonoX: per directory

```ts
// app/routes/blog/_middleware.ts
import { createRoute } from 'honox/factory'
import { workersCache } from 'hono-workers-cache'

export default createRoute(workersCache({ maxAge: 600, tags: ['blog'] }))
```

```ts
// app/routes/admin/_middleware.ts
import { createRoute } from 'honox/factory'
import { noCache } from 'hono-workers-cache'

export default createRoute(noCache())
```

### Invalidation

```tsx
import { revalidateTags } from 'hono-workers-cache'

export const POST = createRoute(async (c) => {
  const id = c.req.param('id')
  await updatePost(id, await c.req.parseBody())
  await revalidateTags([`post-${id}`, 'posts'], c) // c is optional
  return c.redirect(`/blog/${id}`)
})
```

`revalidatePaths('/blog/')` and `purgeEverything()` work the same way. Outside the Workers runtime (Node during dev, tests) the helpers become a no-op resolving to `{ ok: false, reason: 'cache-unavailable' }` — they never throw and never break dev.

## API

### `workersCache(options): MiddlewareHandler`

All options are optional — `workersCache()` with no arguments applies the default policy (fresh for 5 minutes, serve-stale-while-revalidating for 15 minutes).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | `300` (5 min) | Freshness window at the edge, in seconds |
| `staleWhileRevalidate` | `number \| 'unbounded'` | `900` (15 min) | SWR window. `'unbounded'` resolves to 31,536,000 s (1 year); pass `0` to disable serving stale |
| `staleIfError` | `number` | — | Serve stale for this many seconds when the origin returns 5xx |
| `tags` | `string[] \| (c: Context) => string[]` | — | `Cache-Tag` values; a function is evaluated per request |
| `routeTag` | `boolean` | `true` | Auto-add a `route:/blog/:id` tag from the matched route pattern |
| `strategy` | `'cdn-split' \| 'shared'` | `'cdn-split'` | Header strategy (see below) |
| `cacheControl` | `string` | — | Escape hatch: used **verbatim** as the edge policy, ignoring the timing options |

The middleware **leaves the response untouched** when any of these hold:

- The request method is not GET/HEAD (Workers Cache only stores GET/HEAD; they share one entry)
- The response carries `Set-Cookie` (the edge auto-BYPASSes it; a `console.warn` fires in dev)
- The status is not in the cacheable whitelist (200/203/204/301/302/304/308/404/410)
- The handler already set `Cache-Control` itself (your explicit header wins)

### `noCache(): MiddlewareHandler`

Sets `Cache-Control: no-store` **and deletes** any upstream-stamped `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`, and `Cache-Tag`.

### `addCacheTags(c, ...tags): void`

Append tags to the response from a handler or deeply nested code. Merged with `tags` / `routeTag` output by the middleware.

### Purge helpers

```ts
revalidateTags(tags: string | string[], c?: Context): Promise<PurgeResult>
revalidatePaths(prefixes: string | string[], c?: Context): Promise<PurgeResult>
purgeEverything(c?: Context): Promise<PurgeResult>

interface PurgeResult {
  ok: boolean
  reason?: 'cache-unavailable' | 'purge-failed'
  error?: unknown
}
```

Runtime resolution order: duck-typed `c.executionCtx.cache` → dynamic `import('cloudflare:workers')` → no-op `{ ok: false, reason: 'cache-unavailable' }`. Passing an empty array resolves `{ ok: true }` immediately without touching the cache. `purge()` failures — both rejections and resolved `{ success: false }` results (e.g. rate limiting) — map to `{ ok: false, reason: 'purge-failed', error }`.

## Strategies

### `cdn-split` (default)

```
Cache-Control:     public, max-age=0, must-revalidate   ← browsers
CDN-Cache-Control: public, max-age=…, swr=…             ← edge
```

Browsers revalidate with the edge on every request; the edge serves with SWR. Purges take effect for users immediately because no stale copy lives in any browser. Same strategy as Cloudflare's [vinext](https://github.com/cloudflare/vinext) CDN adapter. Choose this when content changes and purges matter.

### `shared`

A single `Cache-Control` applied to both browsers and the edge. Browsers honor `max-age` too, so a purge does not reach users who hold a fresh browser copy — but the output is minimal. Choose this for immutable or purge-indifferent responses. Combine with the `cacheControl` escape hatch for split policies in one header (`s-maxage` for shared caches + `max-age` for browsers).

## Caveats

1. **Billing** — enabling Workers Cache makes *every* request billable as a standard request, including static asset requests that are normally free. (No CPU billing on HITs.)
2. **The cache goes cold on every deploy** by default: the Worker version is part of the cache key. If you deploy frequently, consider [`cache.cross_version_cache: true`](https://developers.cloudflare.com/workers/cache/configuration/) combined with tag-based purging.
3. **The hostname is not part of the cache key** (neither is the HTTP method). If one Worker serves multiple domains, partition with [`ctx.props`](https://developers.cloudflare.com/workers/cache/cache-keys/#multi-tenant-safety-with-ctxprops) — otherwise the domains share entries.
4. **`vite dev` does not reproduce edge caching.** Verify on a Preview URL (it has its own cache, independent of production). On a HIT your Worker never runs — loggers won't see cached requests; observe via the `Cf-Cache-Status` header and the Workers dashboard.
5. **Bundling with Vite**: the purge helpers dynamically import `cloudflare:workers`, which must stay external. `@cloudflare/vite-plugin` externalizes it automatically; with other setups add it to `build.rollupOptions.external` (see [examples/honox](./examples/honox/vite.config.ts)).

## Design Notes

- **Default policy: `maxAge: 300` + `staleWhileRevalidate: 900`** — a conservative transposition of Next.js' default `cacheLife` profile (stale 5 min / revalidate 15 min). The package's philosophy is tag-driven purging, but the default must also be safe for people who forget to purge: with SWR, content refreshes itself within minutes while responses stay instant.
- **`cdn-split` is the default** (from vinext): browsers get `max-age=0, must-revalidate` so no stale copy survives a purge; the edge gets the real policy via `CDN-Cache-Control`.
- **`cacheControl` is verbatim** — no `s-maxage` → `max-age` normalization. vinext normalizes because it processes strings *generated by Next.js*; here the string is written by you, and normalizing would destroy the standard `s-maxage` + `max-age` technique under the `shared` strategy.
- **Hands-off guards** (non-GET/HEAD, `Set-Cookie`, non-cacheable status, pre-set `Cache-Control`) exist because stamping headers in those cases is either pointless (the edge bypasses anyway) or would override explicit user intent.
- **`Cache-Tag` size guard**: Cloudflare's limits are 16KB per header / 1024 bytes per tag, and violations are **silently dropped**. We cap conservatively at 8KB, skip tags containing commas or exceeding 1024 bytes, deduplicate, and measure with `TextEncoder` (multibyte-correct).
- **Automatic route tag** `route:/blog/:id` from the matched route template (via the `routePath()` route helper) enables purging per route template; skipped for the bare `/*` pattern.
- **Purge runtime resolution** never throws outside Workers — duck typing on `ctx.cache`, then dynamic import, then a `cache-unavailable` no-op, so Node-based dev and tests keep working.
- **Purge result inspection** (extension over the initial design): per the [official docs](https://developers.cloudflare.com/workers/cache/purge/#return-value), `purge()` *resolves* to `{ success, errors }` rather than rejecting on failures such as rate limiting. The helpers inspect an explicit `success: false` and map it to `{ ok: false, reason: 'purge-failed', error: errors }` in addition to catching rejections.
- **`noCache()` deletes upstream cache headers** rather than just setting `no-store`, mirroring vinext's defensive non-cached branch — a stray `CDN-Cache-Control` from an upstream middleware would otherwise still cache the response at the edge.

## Examples

- [`examples/hono-minimal`](./examples/hono-minimal) — plain Hono + `wrangler.jsonc`, deployable with `wrangler deploy`
- [`examples/honox`](./examples/honox) — HonoX with `_middleware.ts` / `createRoute()` patterns and Vite bundling

## Development

```sh
pnpm install
pnpm test           # unit tests (Node)
pnpm test:workerd   # integration test on workerd via @cloudflare/vitest-pool-workers
pnpm typecheck
pnpm lint
pnpm build
```

Releases are managed with [Changesets](https://github.com/changesets/changesets); publishing runs with npm provenance.

## License

MIT
