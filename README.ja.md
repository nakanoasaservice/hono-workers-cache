# hono-workers-cache

[Cloudflare Workers Cache](https://developers.cloudflare.com/workers/cache/) を [Hono](https://hono.dev)([HonoX](https://github.com/honojs/honox) でも動作)から宣言的に使うためのミドルウェアと purge ヘルパー。

**Next.js の [Cache Components](https://nextjs.org/docs/app/getting-started/cache-components) のような体験を Hono に**: ルートのフレッシュ期間を宣言し、レンダリング内容にタグを付け、データが変わったら `revalidateTags()` を呼ぶ — 次のリクエストだけが再生成され、それ以外はキャッシュから配信され続けます。違いはキャッシュが Worker の前段、Cloudflare のエッジで行われること。HIT は CPU コストゼロで、あなたのコードは一切実行されません。

[English README](./README.md)

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

## Workers Cache とは

Workers Cache(2026 年登場)は Worker の**前段**で動くエッジキャッシュです。`wrangler.jsonc` に `"cache": { "enabled": true }`(Wrangler >= 4.69.0)を書くと、Cloudflare は Worker を起動する**前に**キャッシュを照合します。HIT 時は Hono を含むあなたのコードは一切実行されません。

この事実がパッケージ全体の設計を規定します。このパッケージは**キャッシュを読み書きしません**。仕事は 2 つだけです。

1. **ポリシー宣言** — `workersCache()` がレスポンスに `Cache-Control` / `CDN-Cache-Control` / `Cache-Tag` を付与
2. **無効化** — `revalidateTags()` / `revalidatePaths()` / `purgeEverything()` が [`cache.purge()`](https://developers.cloudflare.com/workers/cache/purge/) を Next.js の `revalidateTag` 風 API で抽象化

### `hono/cache` との違い

`hono/cache` は旧 Cache API(`caches.default`)ベースで、両者は独立したシステムです。

|  | Workers Cache(本パッケージ) | Cache API(`hono/cache`) |
| --- | --- | --- |
| 動作する場所 | Worker の前段 | Worker の内部 |
| HIT 時に Worker が動くか | 動かない(CPU ゼロ) | 毎リクエスト動く |
| リードスルー | 自動 | 手動 `put()` / `match()` |
| リクエスト collapsing | 自動 | なし |
| Tiered cache | 自動 | なし |
| 無効化 | `ctx.cache.purge()`(タグ / パスプレフィックス / 全消去) | `cache.delete()`(単一データセンターのみ) |
| purge のスコープ | Worker エントリポイント単位 | URL 単位 |

新規 Worker には Cloudflare は Workers Cache を推奨しています。Worker 内から細かくプログラマブルに制御したい場合は引き続き `hono/cache` を使ってください。

## インストール

```sh
npm i hono-workers-cache
# pnpm add hono-workers-cache / bun add hono-workers-cache
```

## セットアップ

Wrangler 設定で Workers Cache を有効化します(Wrangler >= 4.69.0)。ここだけはランタイムコードから設定できません。

```jsonc
// wrangler.jsonc
{
  "cache": { "enabled": true }
}
```

## 使い方

### 素の Hono

```ts
import { Hono } from 'hono'
import { noCache, revalidateTags, workersCache } from 'hono-workers-cache'

const app = new Hono()

// キャッシュ対象: エッジは SWR で配信、ブラウザは毎回エッジへ再検証
app.get('/posts/:id', workersCache({ maxAge: 3600, staleWhileRevalidate: 300 }), (c) =>
  c.json({ id: c.req.param('id') }),
)

// キャッシュさせない(上流がスタンプしたキャッシュ系ヘッダも除去)
app.get('/admin', noCache(), (c) => c.text('admin'))

// 更新後に無効化
app.post('/posts/:id', async (c) => {
  await update(c.req.param('id'))
  await revalidateTags('route:/posts/:id', c)
  return c.json({ ok: true })
})
```

デフォルトの `cdn-split` 戦略で出力されるヘッダ:

```
Cache-Control:     public, max-age=0, must-revalidate
CDN-Cache-Control: public, max-age=3600, stale-while-revalidate=300
Cache-Tag:         route:/posts/:id
```

エッジは SWR で配信・バックグラウンド再検証し、ブラウザは毎回エッジへ再検証しに来るため、**purge した瞬間にユーザーへ反映**されます。単一ヘッダで済ませたい場合は `strategy: 'shared'` を使ってください。

### HonoX: ルート単位

本体は素の Hono ミドルウェアです。HonoX は `_middleware.ts` / `createRoute()` という適用の場を提供しているだけです。

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
    addCacheTags(c, `author-${post.authorId}`) // ハンドラ内から追記も可能
    return c.render(<Post post={post} />)
  },
)
```

### HonoX: ディレクトリ単位

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

### 更新時の無効化

```tsx
import { revalidateTags } from 'hono-workers-cache'

export const POST = createRoute(async (c) => {
  const id = c.req.param('id')
  await updatePost(id, await c.req.parseBody())
  await revalidateTags([`post-${id}`, 'posts'], c) // c は省略可
  return c.redirect(`/blog/${id}`)
})
```

`revalidatePaths('/blog/')`、`purgeEverything()` も同様です。Workers ランタイム外(Node での dev、テスト)では `{ ok: false, reason: 'cache-unavailable' }` を返す no-op になり、throw せず開発を壊しません。

## API

### `workersCache(options): MiddlewareHandler`

| オプション | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `maxAge` | `number` | —(必須) | エッジでのフレッシュ期間(秒) |
| `staleWhileRevalidate` | `number \| 'unbounded'` | — | SWR ウィンドウ。`'unbounded'` は 31,536,000 秒(1 年)に解決 |
| `staleIfError` | `number` | — | オリジンが 5xx を返した際に stale を配信する秒数 |
| `tags` | `string[] \| (c: Context) => string[]` | — | `Cache-Tag` の値。関数はリクエストごとに評価 |
| `routeTag` | `boolean` | `true` | マッチしたルートパターンから `route:/blog/:id` タグを自動付与 |
| `strategy` | `'cdn-split' \| 'shared'` | `'cdn-split'` | ヘッダ戦略(後述) |
| `cacheControl` | `string` | — | エスケープハッチ。時間系オプションを無視し **verbatim** でエッジポリシーに使用 |

以下のいずれかに該当する場合、ミドルウェアは**レスポンスに一切触れません**。

- GET/HEAD 以外のメソッド(Workers Cache が保存するのは GET/HEAD のみ。両者はエントリを共有)
- `Set-Cookie` があるレスポンス(エッジが自動 BYPASS。dev では `console.warn` で警告)
- キャッシュ可能ステータス外(ホワイトリスト: 200/203/204/301/302/304/308/404/410)
- ハンドラが自分で `Cache-Control` を設定済み(ユーザーの明示を尊重)

### `noCache(): MiddlewareHandler`

`Cache-Control: no-store` を設定し、さらに上流がスタンプした `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control` / `Cache-Tag` を**削除**します。

### `addCacheTags(c, ...tags): void`

ハンドラや深い階層のコードからレスポンスにタグを追記します。ミドルウェアの `tags` / `routeTag` の出力とマージされます。

### purge ヘルパー

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

ランタイム解決の順序: `c.executionCtx.cache` の duck typing → `import('cloudflare:workers')` の動的 import → どちらも不可なら `{ ok: false, reason: 'cache-unavailable' }` の no-op。空配列を渡すとキャッシュに触れず即座に `{ ok: true }` で解決します。`purge()` の失敗は、reject と、解決値の `{ success: false }`(レート制限など)の両方を `{ ok: false, reason: 'purge-failed', error }` にマップします。

## 戦略

### `cdn-split`(デフォルト)

```
Cache-Control:     public, max-age=0, must-revalidate   ← ブラウザ
CDN-Cache-Control: public, max-age=…, swr=…             ← エッジ
```

ブラウザは毎回エッジへ再検証し、エッジは SWR で配信します。stale コピーがどのブラウザにも残らないため、purge は即座にユーザーへ反映されます。Cloudflare の [vinext](https://github.com/cloudflare/vinext) CDN アダプタと同じ戦略です。コンテンツが更新され purge が重要な場合はこちらを選んでください。

### `shared`

単一の `Cache-Control` をブラウザとエッジの両方に適用します。ブラウザにも `max-age` が効くため、フレッシュなブラウザコピーを持つユーザーには purge が届きませんが、ヘッダ出力は最小になります。イミュータブルなレスポンスや purge を気にしない用途に。`cacheControl` エスケープハッチと組み合わせれば、1 つのヘッダで `s-maxage`(共有キャッシュ)+ `max-age`(ブラウザ)を併記する分離も可能です。

## 注意点

1. **課金** — Workers Cache を有効化すると、通常無料の静的アセットリクエストを含む*すべての*リクエストが標準リクエスト課金の対象になります(HIT 時の CPU 課金はなし)。
2. **デプロイごとにキャッシュが冷える**のがデフォルトです(キャッシュキーに Worker バージョンが含まれます)。頻繁にデプロイする場合は [`cache.cross_version_cache: true`](https://developers.cloudflare.com/workers/cache/configuration/) とタグ purge の併用を検討してください。
3. **ホスト名はキャッシュキーに含まれません**(HTTP メソッドも同様)。1 つの Worker で複数ドメインを配信する構成では [`ctx.props`](https://developers.cloudflare.com/workers/cache/cache-keys/#multi-tenant-safety-with-ctxprops) でパーティショニングしないとドメイン間でエントリを共有してしまいます。
4. **`vite dev` ではエッジキャッシュの挙動は再現されません。** Preview URL で検証してください(本番と独立したキャッシュを持ちます)。HIT 時は Worker が動かないため、ロガーはキャッシュ済みリクエストを観測できません。観測は `Cf-Cache-Status` ヘッダと Workers ダッシュボードで。
5. **Vite でのバンドル**: purge ヘルパーは `cloudflare:workers` を動的 import するため、external にする必要があります。`@cloudflare/vite-plugin` は自動で external にします。それ以外の構成では `build.rollupOptions.external` に追加してください([examples/honox](./examples/honox/vite.config.ts) 参照)。

## Design Notes

- **デフォルトは `cdn-split`**(vinext 由来): ブラウザには `max-age=0, must-revalidate` を返して stale コピーを残さず、エッジには `CDN-Cache-Control` で本来のポリシーを渡します。purge の即時反映が目的です。
- **`cacheControl` は verbatim** — `s-maxage` → `max-age` の正規化は行いません。vinext の正規化は *Next.js が生成する文字列*への対処です。ここではユーザー自身が書く文字列であり、正規化すると `shared` 戦略での `s-maxage` + `max-age` 併記という標準テクニックを潰してしまいます。
- **触らない条件**(非 GET/HEAD、`Set-Cookie`、キャッシュ不能ステータス、設定済み `Cache-Control`)を設けているのは、これらの場合のヘッダ付与が無意味(どのみちエッジで BYPASS される)か、ユーザーの明示的な意図の上書きになるためです。
- **`Cache-Tag` サイズガード**: Cloudflare の制限はヘッダ全体 16KB / 1 タグ 1024 バイトで、超過は**サイレントに破棄**されます。保守的に 8KB で打ち切り、カンマ入り・1024 バイト超のタグをスキップ、重複を除去し、バイト長は `TextEncoder` で計測します(マルチバイト対応)。
- **ルート自動タグ** `route:/blog/:id` をマッチしたルートテンプレート(`routePath()` ルートヘルパー)から生成し、ルートテンプレート単位の purge を可能にします。`/*` のみの場合は付与しません。
- **purge のランタイム解決**は Workers 外で決して throw しません — `ctx.cache` の duck typing → 動的 import → `cache-unavailable` の no-op、の順で解決し、Node ベースの dev やテストを壊しません。
- **purge 結果の検査**(当初設計への拡張): [公式ドキュメント](https://developers.cloudflare.com/workers/cache/purge/#return-value)のとおり、`purge()` はレート制限などの失敗時に reject するのではなく `{ success, errors }` に*解決*します。ヘルパーは reject の捕捉に加えて、明示的な `success: false` を検査し `{ ok: false, reason: 'purge-failed', error: errors }` にマップします。
- **`noCache()` は上流のキャッシュヘッダを削除**します(`no-store` を設定するだけではありません)。vinext の非キャッシュ分岐と同じ防御で、上流ミドルウェアの `CDN-Cache-Control` が残っているとエッジでキャッシュされてしまうためです。

## Examples

- [`examples/hono-minimal`](./examples/hono-minimal) — 素の Hono + `wrangler.jsonc`。`wrangler deploy` 可能
- [`examples/honox`](./examples/honox) — HonoX の `_middleware.ts` / `createRoute()` パターンと Vite バンドル

## 開発

```sh
pnpm install
pnpm test           # ユニットテスト (Node)
pnpm test:workerd   # @cloudflare/vitest-pool-workers による workerd 上の統合テスト
pnpm typecheck
pnpm lint
pnpm build
```

リリースは [Changesets](https://github.com/changesets/changesets) で管理し、npm publish は provenance 付きで行います。

## License

MIT
