# hono-workers-cache

[![npm version](https://img.shields.io/npm/v/hono-workers-cache?style=flat-square)](https://www.npmjs.com/package/hono-workers-cache)
[![npm downloads](https://img.shields.io/npm/dm/hono-workers-cache?style=flat-square)](https://www.npmjs.com/package/hono-workers-cache)
[![CI](https://github.com/nakanoasaservice/hono-workers-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/nakanoasaservice/hono-workers-cache/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/hono-workers-cache?style=flat-square)](https://github.com/nakanoasaservice/hono-workers-cache/blob/main/LICENSE)

Declarative [Cloudflare Workers Cache](https://developers.cloudflare.com/workers/cache/) middleware and purge helpers for [Hono](https://hono.dev) (works with [HonoX](https://github.com/honojs/honox)).

**Next.js [Cache Components](https://nextjs.org/docs/app/getting-started/cache-components) semantics for Hono**: declare a lifetime with the same `stale` / `revalidate` / `expire` vocabulary and the same built-in profiles (`'seconds'` … `'max'`) as Next.js' [`cacheLife()`](https://nextjs.org/docs/app/api-reference/functions/cacheLife), tag what a route renders with `cacheTag()`, and call `revalidateTag()` when the data changes. The difference: the cache is Cloudflare's edge, in front of your Worker — a cache hit costs zero CPU and your code never even runs.

```ts
import { Hono } from 'hono'
import { cacheTag, revalidateTag, workersCache } from 'hono-workers-cache'

const app = new Hono()

// Cached read — same profile names and values as Next.js' cacheLife()
app.get('/posts/:id', workersCache('hours'), async (c) => {
  const post = await getPostById(c.req.param('id'))

  cacheTag(c, `post-${post.id}`) // tag so we can purge after an update

  return c.json(post)
})

// Mutation — persist changes, then purge the tag so the next GET regenerates
app.post('/posts/:id', async (c) => {
  const id = c.req.param('id')
  const { body } = await c.req.json<{ body: string }>()

  await updatePost(id, body)

  await revalidateTag(`post-${id}`, c)

  return c.json({ ok: true })
})
```

## The cache model

Every cached response has one lifetime, described in Next.js' three-value vocabulary and projected onto Cloudflare's two cache tiers (browser and edge):

| Field | Meaning (same as Next.js) | Becomes |
| --- | --- | --- |
| `stale` | How long **clients** reuse a copy without asking the server | `Cache-Control: public, max-age=<stale>` (browser) |
| `revalidate` | How long the **server** serves a copy before regenerating in the background | `CDN-Cache-Control: public, max-age=<revalidate>` (edge) |
| `expire` | Max total lifetime before switching to a blocking fresh fetch | `stale-while-revalidate=<expire − revalidate>` (edge); `'never'` → one year |

So `workersCache('hours')` (stale 5 min / revalidate 1 hour / expire 1 day) emits:

```
Cache-Control:     public, max-age=300                                ← browsers
CDN-Cache-Control: public, max-age=3600, stale-while-revalidate=82800 ← edge
Cache-Tag:         route:/posts/:id
```

Within `revalidate` the edge serves instantly; past it, the edge keeps serving stale while regenerating in the background (exactly Next.js' behavior, implemented by the CDN's SWR); past `expire`, the request blocks and fetches fresh. Browsers hold a copy for at most `stale` seconds before checking back with the edge.

### `stale` and instant purges

`stale` is the one knob that trades Next.js-likeness against purge latency: a purge (`revalidateTag()`) empties the edge immediately, but browsers that hold a fresh copy won't ask again for up to `stale` seconds. Set `stale: 0` and browsers revalidate with the edge on **every** request (`max-age=0, must-revalidate` — conditional 304s keep it cheap), so purges reach every user instantly:

```ts
// Daily content, but updates must be visible the moment you purge
app.get('/news/:id', workersCache({ profile: 'days', stale: 0 }), handler)
```

The edge still absorbs all the traffic — you give up nothing but the browser-local cache.

### Built-in profiles

Same names and values as Next.js (`cacheLifeProfiles` export):

| Profile | `stale` | `revalidate` | `expire` |
| --- | --- | --- | --- |
| `default` | 5 minutes | 15 minutes | never (1 year at the edge) |
| `seconds` | 30 seconds | 1 second | 1 minute |
| `minutes` | 5 minutes | 1 minute | 1 hour |
| `hours` | 5 minutes | 1 hour | 1 day |
| `days` | 5 minutes | 1 day | 1 week |
| `weeks` | 5 minutes | 1 week | 30 days |
| `max` | 5 minutes | 30 days | 1 year |

## What is Workers Cache?

Workers Cache (2026) is an edge cache that runs **in front of** your Worker. Enable it with `"cache": { "enabled": true }` in `wrangler.jsonc` (Wrangler >= 4.69.0) and Cloudflare checks the cache **before** invoking your Worker — on a HIT, your code (including Hono) never executes.

That shapes this package's entire design: it **never reads or writes the cache**. It only does two things:

1. **Declare policy** — `workersCache()` / `cacheLife()` stamp `Cache-Control` / `CDN-Cache-Control` / `Cache-Tag` on responses
2. **Invalidate** — `revalidateTag()` / `revalidatePath()` / `purgeEverything()` wrap [`cache.purge()`](https://developers.cloudflare.com/workers/cache/purge/) in a Next.js-`revalidateTag`-style API

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
import { cacheLife, noCache, revalidateTag, workersCache } from 'hono-workers-cache'

const app = new Hono()

// Zero config: the 'default' profile (stale 5 min / revalidate 15 min / expire never)
app.get('/about', workersCache(), (c) => c.html('<h1>About</h1>'))

// A profile name, exactly like Next.js' cacheLife('hours')
app.get('/posts/:id', workersCache('hours'), (c) => c.json({ id: c.req.param('id') }))

// Custom lifetime — the same object Next.js accepts
app.get('/feed', workersCache({ stale: 60, revalidate: 3600, expire: 86400 }), handler)

// Tighten the lifetime from inside a handler (shortest wins, like Next.js)
app.get('/pages/:slug', workersCache('days'), async (c) => {
  const page = await getPage(c.req.param('slug'))
  if (page.frequentlyUpdated) cacheLife(c, 'minutes')
  return c.html(page.html)
})

// Never cached (also strips cache headers stamped upstream)
app.get('/admin', noCache(), (c) => c.text('admin'))

// Invalidate after a mutation
app.post('/posts/:id', async (c) => {
  await update(c.req.param('id'))
  await revalidateTag('route:/posts/:id', c)
  return c.json({ ok: true })
})
```

### HonoX: per route

This is a plain Hono middleware — HonoX simply provides `_middleware.ts` / `createRoute()` as the places to apply it.

```tsx
// app/routes/blog/[id].tsx
import { createRoute } from 'honox/factory'
import { cacheTag, workersCache } from 'hono-workers-cache'

export default createRoute(
  workersCache({
    profile: 'hours',
    stale: 0, // purges reach users instantly
    tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
  }),
  async (c) => {
    const post = await getPost(c.req.param('id'))
    cacheTag(c, `author-${post.authorId}`) // append tags from inside the handler
    return c.render(<Post post={post} />)
  },
)
```

### HonoX: per directory

```ts
// app/routes/blog/_middleware.ts
import { createRoute } from 'honox/factory'
import { workersCache } from 'hono-workers-cache'

export default createRoute(workersCache({ profile: 'minutes', tags: ['blog'] }))
```

```ts
// app/routes/admin/_middleware.ts
import { createRoute } from 'honox/factory'
import { noCache } from 'hono-workers-cache'

export default createRoute(noCache())
```

### Invalidation

```tsx
import { revalidateTag } from 'hono-workers-cache'

export const POST = createRoute(async (c) => {
  const id = c.req.param('id')
  await updatePost(id, await c.req.parseBody())
  await revalidateTag([`post-${id}`, 'posts'], c) // c is optional
  return c.redirect(`/blog/${id}`)
})
```

`revalidatePath('/blog/')` and `purgeEverything()` work the same way. Outside the Workers runtime (Node during dev, tests) the helpers become a no-op resolving to `{ ok: false, reason: 'cache-unavailable' }` — they never throw and never break dev.

## API

### `workersCache(profile | options): MiddlewareHandler`

Accepts a profile name (`workersCache('hours')`) or an options object. With no arguments, the `default` profile applies.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `profile` | `'default' \| 'seconds' \| 'minutes' \| 'hours' \| 'days' \| 'weeks' \| 'max'` | `'default'` | Base profile — same names and values as Next.js |
| `stale` | `number` | from profile | Browser freshness in seconds. `0` = revalidate with the edge every request (instant purges) |
| `revalidate` | `number` | from profile | Edge freshness in seconds; past it, the edge serves stale while regenerating in the background |
| `expire` | `number \| 'never'` | from profile | Max total lifetime; past it, the edge blocks and fetches fresh. `'never'` = one year |
| `staleIfError` | `number` | — | Serve stale for this many seconds when the origin returns 5xx |
| `tags` | `string[] \| (c: Context) => string[]` | — | `Cache-Tag` values; a function is evaluated per request |
| `routeTag` | `boolean` | `true` | Auto-add a `route:/blog/:id` tag from the matched route pattern |
| `cacheControl` | `string` | — | Escape hatch: emitted **verbatim** as the single `Cache-Control` (no `CDN-Cache-Control`). **Mutually exclusive** with the lifetime options (`profile` / `stale` / `revalidate` / `expire` / `staleIfError`) — the type forbids combining them |

Explicit fields override the profile, e.g. `{ profile: 'days', stale: 0 }` = daily content with instant purges. `tags` / `routeTag` combine with either variant.

The middleware **leaves the response untouched** when any of these hold:

- The request method is not GET/HEAD (Workers Cache only stores GET/HEAD; they share one entry)
- The response carries `Set-Cookie` (the edge auto-BYPASSes it; a `console.warn` fires in dev)
- The status is not in the cacheable whitelist (200/203/204/301/302/304/308/404/410)
- The handler already set `Cache-Control` itself (your explicit header wins)

### `cacheLife(c, profile | { stale?, revalidate?, expire? }): void`

The counterpart of Next.js' `cacheLife()` — declare a lifetime from a handler or deeply nested code (requires a Hono `Context` instead of a `use cache` scope). Fields declared here override the middleware's defaults; across multiple calls for one response, the **shortest value wins per field**, same as nested `cacheLife()` calls in Next.js.

### `cacheTag(c, ...tags): void`

Append tags to the response from a handler or deeply nested code. Merged with `tags` / `routeTag` output by the middleware. Same name as Next.js' `cacheTag`, but requires a Hono `Context` (no async local store).

### `noCache(): MiddlewareHandler`

Sets `Cache-Control: no-store` **and deletes** any upstream-stamped `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`, and `Cache-Tag`.

### Purge helpers

Named after Next.js (`revalidateTag` / `revalidatePath`), with Workers Cache semantics: arrays are accepted for batch purge, `c` is optional, and results are `Promise<PurgeResult>` (not `void`). `revalidatePath` matches Cloudflare **path prefixes**, not App Router `page` / `layout` types.

```ts
revalidateTag(tags: string | string[], c?: Context): Promise<PurgeResult>
revalidatePath(prefixes: string | string[], c?: Context): Promise<PurgeResult>
purgeEverything(c?: Context): Promise<PurgeResult>

interface PurgeResult {
  ok: boolean
  reason?: 'cache-unavailable' | 'purge-failed'
  error?: unknown
}
```

Runtime resolution order: duck-typed `c.executionCtx.cache` → dynamic `import('cloudflare:workers')` → no-op `{ ok: false, reason: 'cache-unavailable' }`. Passing an empty array resolves `{ ok: true }` immediately without touching the cache. `purge()` failures — both rejections and resolved `{ success: false }` results (e.g. rate limiting) — map to `{ ok: false, reason: 'purge-failed', error }`.

## Migrating from 0.2.x

The `maxAge` / `staleWhileRevalidate` / `strategy` options were replaced by the Next.js vocabulary:

| 0.2.x | Now |
| --- | --- |
| `workersCache({ maxAge: 3600, staleWhileRevalidate: 300 })` | `workersCache({ stale: 0, revalidate: 3600, expire: 3900 })` |
| `staleWhileRevalidate: 'unbounded'` | `expire: 'never'` |
| `strategy: 'cdn-split'` (default) | `stale: 0` — the split is now always on; `stale` controls the browser tier |
| `strategy: 'shared'` | a nonzero `stale` (browser-local caching), or `cacheControl` for one verbatim header |
| `cacheControl` (edge policy, browser revalidated) | `cacheControl` (single verbatim `Cache-Control`, both tiers) |

Note the default policy changed with the model: `workersCache()` now applies the Next.js `default` profile, whose `stale: 300` lets browsers hold a copy for up to 5 minutes. Pass `stale: 0` where purges must be instant.

## Caveats

1. **Billing** — enabling Workers Cache makes *every* request billable as a standard request, including static asset requests that are normally free. (No CPU billing on HITs.)
2. **The cache goes cold on every deploy** by default: the Worker version is part of the cache key. If you deploy frequently, consider [`cache.cross_version_cache: true`](https://developers.cloudflare.com/workers/cache/configuration/) combined with tag-based purging.
3. **The hostname is not part of the cache key** (neither is the HTTP method). If one Worker serves multiple domains, partition with [`ctx.props`](https://developers.cloudflare.com/workers/cache/cache-keys/#multi-tenant-safety-with-ctxprops) — otherwise the domains share entries.
4. **`vite dev` does not reproduce edge caching.** Verify on a Preview URL (it has its own cache, independent of production). On a HIT your Worker never runs — loggers won't see cached requests; observe via the `Cf-Cache-Status` header and the Workers dashboard.
5. **Bundling with Vite**: the purge helpers dynamically import `cloudflare:workers`, which must stay external. `@cloudflare/vite-plugin` externalizes it automatically; with other setups add it to `build.rollupOptions.external` (see [examples/honox](./examples/honox/vite.config.ts)).

## Design Notes

- **Next.js vocabulary, CDN mechanics.** `stale` / `revalidate` / `expire` and the built-in profiles are copied verbatim from Next.js (`defaultCacheLifeProfiles`), so knowledge and mental models transfer 1:1. The mechanics differ: Next.js implements them with an in-process cache; here they compile to standard `Cache-Control` / `CDN-Cache-Control` directives that Cloudflare's edge executes — `revalidate` becomes edge `max-age`, `expire − revalidate` becomes the SWR window, `stale` becomes browser `max-age`.
- **The split is always on** (from vinext's CDN adapter): browsers and the edge always get separate policies. The old `strategy` option dissolved into `stale` — `stale: 0` reproduces `cdn-split` (no stale copy survives a purge), a nonzero `stale` approximates `shared` without giving up the edge-side SWR.
- **`expire: 'never'` = one year.** Cloudflare has no infinite window, and follows RFC 5861 in treating a value-less `stale-while-revalidate` as zero-width — so the directive always spells out the seconds. `'never'` uses the full year rather than `year − revalidate`; it declares "serve stale as long as possible", not arithmetic.
- **`cacheLife(c, …)` merges like Next.js**: explicit handler declarations beat the middleware's defaults, and across multiple calls the shortest value wins per field — the same rule Next.js applies to nested `use cache` scopes (`explicitRevalidate` is only ever lowered).
- **`cacheControl` is verbatim** — no `s-maxage` → `max-age` normalization. vinext normalizes because it processes strings *generated by Next.js*; here the string is written by you. It is emitted as the single `Cache-Control`, so the standard `s-maxage` + `max-age` technique works unmodified.
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

Releases are published manually from the **Publish** workflow (`workflow_dispatch` on `main`). Bump `version` in `package.json` before triggering the workflow. Publishing runs with npm provenance.

## License

MIT
