# hono-workers-cache

[![npm version](https://img.shields.io/npm/v/hono-workers-cache?style=flat-square)](https://www.npmjs.com/package/hono-workers-cache)
[![npm downloads](https://img.shields.io/npm/dm/hono-workers-cache?style=flat-square)](https://www.npmjs.com/package/hono-workers-cache)
[![CI](https://github.com/nakanoasaservice/hono-workers-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/nakanoasaservice/hono-workers-cache/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/hono-workers-cache?style=flat-square)](https://github.com/nakanoasaservice/hono-workers-cache/blob/main/LICENSE)

[Cloudflare Workers Cache](https://developers.cloudflare.com/workers/cache/) を [Hono](https://hono.dev)([HonoX](https://github.com/honojs/honox) でも動作)から宣言的に使うためのミドルウェアと purge ヘルパー。

**Next.js [Cache Components](https://nextjs.org/docs/app/getting-started/cache-components) のセマンティクスを Hono に**: Next.js の [`cacheLife()`](https://nextjs.org/docs/app/api-reference/functions/cacheLife) と同じ `stale` / `revalidate` / `expire` の語彙・同じビルトインプロファイル(`'seconds'` … `'max'`)で寿命を宣言し、`cacheTag()` でレンダリング内容にタグを付け、データが変わったら `revalidateTag()` を呼ぶ。違いはキャッシュが Worker の前段、Cloudflare のエッジで行われること。HIT は CPU コストゼロで、あなたのコードは一切実行されません。

[English README](./README.md)

```ts
import { Hono } from 'hono'
import { cacheTag, revalidateTag, workersCache } from 'hono-workers-cache'

const app = new Hono()

// キャッシュ対象の GET — プロファイル名と値は Next.js の cacheLife() と同一
app.get('/posts/:id', workersCache('hours'), async (c) => {
  const post = await getPostById(c.req.param('id'))

  cacheTag(c, `post-${post.id}`) // 更新後に purge できるようタグを付ける

  return c.json(post)
})

// 更新 — DB に保存したあと、タグを purge して次の GET で再生成させる
app.post('/posts/:id', async (c) => {
  const id = c.req.param('id')
  const { body } = await c.req.json<{ body: string }>()

  await updatePost(id, body)

  await revalidateTag(`post-${id}`, c)

  return c.json({ ok: true })
})
```

> `stale` / `revalidate` / `expire` やプロファイル名の意味、エッジキャッシュヘッダへの写像は [キャッシュモデル](#キャッシュモデル) を参照してください。

## Workers Cache とは

Workers Cache(2026 年登場)は Worker の**前段**で動くエッジキャッシュです。`wrangler.jsonc` に `"cache": { "enabled": true }`(Wrangler >= 4.69.0)を書くと、Cloudflare は Worker を起動する**前に**キャッシュを照合します。HIT 時は Hono を含むあなたのコードは一切実行されません。

この事実がパッケージ全体の設計を規定します。このパッケージは**キャッシュを読み書きしません**。仕事は 2 つだけです。

1. **ポリシー宣言** — `workersCache()` / `cacheLife()` がレスポンスに `Cache-Control` / `CDN-Cache-Control` / `Cache-Tag` を付与
2. **無効化** — `revalidateTag()` / `revalidatePath()` / `revalidateEverything()` が [`cache.purge()`](https://developers.cloudflare.com/workers/cache/purge/) を Next.js の `revalidateTag` 風 API で抽象化

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
import { cacheLife, noCache, revalidatePath, workersCache } from 'hono-workers-cache'

const app = new Hono()

// 設定ゼロ: 'default' プロファイル(stale 5 分 / revalidate 15 分 / expire never)
app.get('/about', workersCache(), (c) => c.html('<h1>About</h1>'))

// プロファイル名 — Next.js の cacheLife('hours') と同じ感覚で
app.get('/posts/:id', workersCache('hours'), (c) => c.json({ id: c.req.param('id') }))

// カスタム寿命 — Next.js が受け取るのと同じオブジェクト
app.get('/feed', workersCache({ stale: 60, revalidate: 3600, expire: 86400 }), handler)

// ハンドラ内から寿命を短縮(最短が勝つ — Next.js と同じルール)
app.get('/pages/:slug', workersCache('days'), async (c) => {
  const page = await getPage(c.req.param('slug'))
  if (page.frequentlyUpdated) cacheLife(c, 'minutes')
  return c.html(page.html)
})

// キャッシュさせない(上流がスタンプしたキャッシュ系ヘッダも除去)
app.get('/admin', noCache(), (c) => c.text('admin'))

// 更新後に無効化
app.post('/posts/:id', async (c) => {
  const id = c.req.param('id')
  await update(id)
  await revalidatePath(`/posts/${id}`, c) // 完全一致パス
  return c.json({ ok: true })
})
```

### HonoX: ルート単位

本体は素の Hono ミドルウェアです。HonoX は `_middleware.ts` / `createRoute()` という適用の場を提供しているだけです。

```tsx
// app/routes/blog/[id].tsx
import { createRoute } from 'honox/factory'
import { cacheTag, workersCache } from 'hono-workers-cache'

export default createRoute(
  workersCache({
    profile: 'hours',
    stale: 0, // purge を全ユーザーへ即時反映
    tags: (c) => [`post-${c.req.param('id')}`, 'posts'],
  }),
  async (c) => {
    const post = await getPost(c.req.param('id'))
    cacheTag(c, `author-${post.authorId}`) // ハンドラ内から追記も可能
    return c.render(<Post post={post} />)
  },
)
```

### HonoX: ディレクトリ単位

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

### 更新時の無効化

```tsx
import { revalidateTag } from 'hono-workers-cache'

export const POST = createRoute(async (c) => {
  const id = c.req.param('id')
  await updatePost(id, await c.req.parseBody())
  await revalidateTag([`post-${id}`, 'posts'], c) // c は省略可
  return c.redirect(`/blog/${id}`)
})
```

`revalidatePath()`、`revalidateEverything()` も同様です。Workers ランタイム外(Node での dev、テスト)では `{ ok: false, reason: 'cache-unavailable' }` を返す no-op になり、throw せず開発を壊しません。

```ts
await revalidatePath('/blog/post-1')          // 完全一致パス(path: タグ)
await revalidatePath('/blog/:id', 'route')    // そのルートが生成した全 URL(route: タグ)
await revalidatePath('/blog/', 'prefix')      // /blog/ 配下すべて(Cloudflare pathPrefixes)
await revalidateEverything()                  // エントリポイントのキャッシュ全体
```

## キャッシュモデル

キャッシュされる各レスポンスは 1 つの寿命を持ちます。Next.js と同じ 3 値の語彙で記述し、Cloudflare の 2 層(ブラウザとエッジ)に射影します。

| フィールド | 意味(Next.js と同じ) | 変換先 |
| --- | --- | --- |
| `stale` | **クライアント**がサーバーに確認せずコピーを使い続ける時間 | `Cache-Control: public, max-age=<stale>`(ブラウザ) |
| `revalidate` | **サーバー**が再生成せずに配信する時間。過ぎたら stale を配信しつつ裏で再生成 | `CDN-Cache-Control: public, max-age=<revalidate>`(エッジ) |
| `expire` | 総寿命の上限。過ぎたらブロッキングで新規取得 | `stale-while-revalidate=<expire − revalidate>`(エッジ)。`'never'` は 1 年 |

したがって `workersCache('hours')`(stale 5 分 / revalidate 1 時間 / expire 1 日)の出力は:

```
Cache-Control:     public, max-age=300                                ← ブラウザ
CDN-Cache-Control: public, max-age=3600, stale-while-revalidate=82800 ← エッジ
Cache-Tag:         route:/posts/:id,path:/posts/123
```

`revalidate` 以内はエッジが即答。過ぎたら stale を配信しつつバックグラウンドで再生成(まさに Next.js の挙動を CDN の SWR で実装)。`expire` を過ぎたらブロッキングで新規取得します。ブラウザは最長 `stale` 秒だけ手元のコピーを使い、その後エッジに確認しに来ます。

### `stale` と purge の即時性

`stale` は「Next.js らしさ」と「purge の反映速度」を交換する唯一のつまみです。purge(`revalidateTag()`)はエッジを即座に空にしますが、フレッシュなコピーを持つブラウザは最長 `stale` 秒間、再確認しに来ません。`stale: 0` にするとブラウザは**毎回**エッジへ再検証し(`max-age=0, must-revalidate` — 条件付き 304 で軽量)、purge が全ユーザーへ即時に届きます:

```ts
// 日次コンテンツ。ただし purge した瞬間に更新が見えてほしい
app.get('/news/:id', workersCache({ profile: 'days', stale: 0 }), handler)
```

トラフィックは引き続きエッジが吸収します — 失うのはブラウザローカルのキャッシュだけです。

### ビルトインプロファイル

名前も値も Next.js と同一です(`cacheLifeProfiles` としてエクスポート)。

| プロファイル | `stale` | `revalidate` | `expire` |
| --- | --- | --- | --- |
| `default` | 5 分 | 15 分 | never(エッジでは 1 年) |
| `seconds` | 30 秒 | 1 秒 | 1 分 |
| `minutes` | 5 分 | 1 分 | 1 時間 |
| `hours` | 5 分 | 1 時間 | 1 日 |
| `days` | 5 分 | 1 日 | 1 週間 |
| `weeks` | 5 分 | 1 週間 | 30 日 |
| `max` | 5 分 | 30 日 | 1 年 |

## API

### `workersCache(profile | options): MiddlewareHandler`

プロファイル名(`workersCache('hours')`)またはオプションオブジェクトを受け取ります。引数なしなら `default` プロファイルが適用されます。

| オプション | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `profile` | `'default' \| 'seconds' \| 'minutes' \| 'hours' \| 'days' \| 'weeks' \| 'max'` | `'default'` | ベースプロファイル。名前も値も Next.js と同一 |
| `stale` | `number` | プロファイル値 | ブラウザのフレッシュ期間(秒)。`0` で毎回エッジへ再検証(purge 即時反映) |
| `revalidate` | `number` | プロファイル値 | エッジのフレッシュ期間(秒)。過ぎたら stale を配信しつつ裏で再生成 |
| `expire` | `number \| 'never'` | プロファイル値 | 総寿命の上限。過ぎたらブロッキングで新規取得。`'never'` = 1 年 |
| `staleIfError` | `number` | — | オリジンが 5xx を返した際に stale を配信する秒数 |
| `tags` | `string[] \| (c: Context) => string[]` | — | `Cache-Tag` の値。関数はリクエストごとに評価 |
| `routeTag` | `boolean` | `true` | マッチしたルートパターンから `route:/blog/:id` タグを自動付与。`revalidatePath(path, 'route')` を可能にする |
| `pathTag` | `boolean` | `true` | 実際のリクエストパスから `path:/blog/123` タグを自動付与(クエリ除外、末尾スラッシュ正規化)。完全一致の `revalidatePath(path)` を可能にする |
| `cacheControl` | `string` | — | エスケープハッチ。単一の `Cache-Control` として **verbatim** で出力(`CDN-Cache-Control` は出力しない)。寿命系オプション(`profile` / `stale` / `revalidate` / `expire` / `staleIfError`)とは**排他** — 型レベルで併用を禁止 |

明示したフィールドはプロファイルより優先されます。例: `{ profile: 'days', stale: 0 }` = 日次コンテンツ + purge 即時反映。`tags` / `routeTag` / `pathTag` はどちらの形とも併用できます。`route:` / `path:` プレフィックスは自動タグの予約領域なので、自前の `tags` / `cacheTag()` では避けてください。

以下のいずれかに該当する場合、ミドルウェアは**レスポンスに一切触れません**。

- GET/HEAD 以外のメソッド(Workers Cache が保存するのは GET/HEAD のみ。両者はエントリを共有)
- `Set-Cookie` があるレスポンス(エッジが自動 BYPASS。dev では `console.warn` で警告)
- キャッシュ可能ステータス外(ホワイトリスト: 200/203/204/301/302/304/308/404/410)
- ハンドラが自分で `Cache-Control` を設定済み(ユーザーの明示を尊重)

### `cacheLife(c, profile | { stale?, revalidate?, expire? }): void`

Next.js の `cacheLife()` に対応 — ハンドラや深い階層のコードから寿命を宣言します(`use cache` スコープの代わりに Hono の `Context` が必要)。ここで宣言したフィールドはミドルウェアのデフォルトを上書きし、1 レスポンス内で複数回呼ばれた場合は**フィールドごとに最短値が勝ちます**。Next.js のネストした `cacheLife()` と同じルールです。

### `cacheTag(c, ...tags): void`

ハンドラや深い階層のコードからレスポンスにタグを追記します。ミドルウェアの `tags` と自動の `route:` / `path:` タグにマージされます。Next.js の `cacheTag` と同じ名前ですが、Hono の `Context` が必要です(async local store はありません)。

### `noCache(): MiddlewareHandler`

`Cache-Control: no-store` を設定し、さらに上流がスタンプした `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control` / `Cache-Tag` を**削除**します。

### purge ヘルパー

名前は Next.js(`revalidateTag` / `revalidatePath`)に合わせていますが、意味は Workers Cache です。配列での一括 purge、省略可能な `c`、戻り値は `Promise<PurgeResult>`(`void` ではない)。

```ts
revalidateTag(tags: string | string[], c?: Context): Promise<PurgeResult>
revalidatePath(paths: string | string[], type?: 'route' | 'prefix', c?: Context): Promise<PurgeResult>
revalidateEverything(c?: Context): Promise<PurgeResult>

interface PurgeResult {
  ok: boolean
  reason?: 'cache-unavailable' | 'purge-failed'
  error?: unknown
}
```

`revalidatePath` は Next.js の `revalidatePath(path, type?)` を Hono の語彙に読み替えた 3 モードを持ちます。

| 呼び出し | Next.js の対応物 | purge されるもの |
| --- | --- | --- |
| `revalidatePath('/blog/post-1')` | `revalidatePath('/blog/post-1')` | `path:` タグ — そのパスだけ(クエリ文字列バリアントはまとめて)。ミドルウェアの `pathTag`(デフォルト有効)が前提 |
| `revalidatePath('/blog/:id', 'route')` | `revalidatePath('/blog/[slug]', 'page')` | `route:` タグ — その Hono ルートが生成した全 URL。`routeTag`(デフォルト有効)が前提。`routeTag: false` だと何にもマッチせず静かに空振りする |
| `revalidatePath('/blog/', 'prefix')` | `revalidatePath('/blog', 'layout')` | Cloudflare `pathPrefixes` — プレフィックスで始まる全パス。純粋な文字列プレフィックスなので `/blog` は `/blogger` にもマッチする。ディレクトリは `/` で終わらせること |

Next.js の `revalidatePath` と同様、届くのは**サーバー側(エッジ)のキャッシュだけ**です — ブラウザは `stale` が切れるまで手元のコピーを使い続けます([`stale` と purge の即時性](#stale-と-purge-の即時性)参照)。またタグ purge が効くのは、ミドルウェアがそのタグを出力し始めた*後*にキャッシュされたエントリのみです — `pathTag` / `routeTag` の有効化直後やアップグレード直後の移行期に注意してください。

ランタイム解決の順序: `c.executionCtx.cache` の duck typing → `import('cloudflare:workers')` の動的 import → どちらも不可なら `{ ok: false, reason: 'cache-unavailable' }` の no-op。空配列を渡すとキャッシュに触れず即座に `{ ok: true }` で解決します。`purge()` の失敗は、reject と、解決値の `{ success: false }`(レート制限など)の両方を `{ ok: false, reason: 'purge-failed', error }` にマップします。

## 0.3.x からの移行

| 0.3.x | 現在 |
| --- | --- |
| `revalidatePath('/blog/')`(path-prefix purge) | `revalidatePath('/blog/', 'prefix')` — デフォルトは**完全一致パス**のタグ purge に変更 |
| `purgeEverything()` | `revalidateEverything()` |

またミドルウェアが自動タグを 1 本追加で出力するようになりました(`path:<リクエストパス>`)。`pathTag: false` で無効化できます。

## 0.2.x からの移行

`maxAge` / `staleWhileRevalidate` / `strategy` オプションは Next.js の語彙に置き換わりました。

| 0.2.x | 現在 |
| --- | --- |
| `workersCache({ maxAge: 3600, staleWhileRevalidate: 300 })` | `workersCache({ stale: 0, revalidate: 3600, expire: 3900 })` |
| `staleWhileRevalidate: 'unbounded'` | `expire: 'never'` |
| `strategy: 'cdn-split'`(デフォルト) | `stale: 0` — split は常時有効になり、`stale` がブラウザ層を制御 |
| `strategy: 'shared'` | 非ゼロの `stale`(ブラウザローカルキャッシュ)、または verbatim 単一ヘッダの `cacheControl` |
| `cacheControl`(エッジポリシー、ブラウザは再検証) | `cacheControl`(単一の `Cache-Control` を verbatim 出力、両層に適用) |

モデル変更に伴いデフォルトポリシーも変わりました: `workersCache()` は Next.js の `default` プロファイルを適用し、その `stale: 300` によりブラウザは最長 5 分コピーを保持します。purge の即時反映が必須の箇所では `stale: 0` を指定してください。

## 注意点

1. **課金** — Workers Cache を有効化すると、通常無料の静的アセットリクエストを含む*すべての*リクエストが標準リクエスト課金の対象になります(HIT 時の CPU 課金はなし)。
2. **デプロイごとにキャッシュが冷える**のがデフォルトです(キャッシュキーに Worker バージョンが含まれます)。頻繁にデプロイする場合は [`cache.cross_version_cache: true`](https://developers.cloudflare.com/workers/cache/configuration/) とタグ purge の併用を検討してください。
3. **ホスト名はキャッシュキーに含まれません**(HTTP メソッドも同様)。1 つの Worker で複数ドメインを配信する構成では [`ctx.props`](https://developers.cloudflare.com/workers/cache/cache-keys/#multi-tenant-safety-with-ctxprops) でパーティショニングしないとドメイン間でエントリを共有してしまいます。
4. **`vite dev` ではエッジキャッシュの挙動は再現されません。** Preview URL で検証してください(本番と独立したキャッシュを持ちます)。HIT 時は Worker が動かないため、ロガーはキャッシュ済みリクエストを観測できません。観測は `Cf-Cache-Status` ヘッダと Workers ダッシュボードで。
5. **Vite でのバンドル**: purge ヘルパーは `cloudflare:workers` を動的 import するため、external にする必要があります。`@cloudflare/vite-plugin` は自動で external にします。それ以外の構成では `build.rollupOptions.external` に追加してください([examples/honox](./examples/honox/vite.config.ts) 参照)。

## Design Notes

- **語彙は Next.js、機構は CDN。** `stale` / `revalidate` / `expire` とビルトインプロファイルは Next.js(`defaultCacheLifeProfiles`)からそのまま転写しており、知識とメンタルモデルが 1:1 で移植できます。機構は異なります: Next.js はプロセス内キャッシュで実装しますが、ここでは標準の `Cache-Control` / `CDN-Cache-Control` ディレクティブにコンパイルし、Cloudflare のエッジが実行します — `revalidate` はエッジの `max-age` に、`expire − revalidate` は SWR ウィンドウに、`stale` はブラウザの `max-age` になります。
- **split は常時有効**(vinext の CDN アダプタ由来): ブラウザとエッジには常に別々のポリシーを渡します。旧 `strategy` オプションは `stale` に溶けました — `stale: 0` が旧 `cdn-split`(purge 後に stale コピーがどこにも残らない)を再現し、非ゼロの `stale` はエッジ側 SWR を保ったまま旧 `shared` を近似します。
- **`expire: 'never'` = 1 年。** Cloudflare に無限のウィンドウはなく、RFC 5861 に従い値なしの `stale-while-revalidate` はゼロ幅として扱われるため、秒数は常に明記します。`'never'` は `1 年 − revalidate` ではなくまるごと 1 年を使います — これは算術ではなく「可能な限り stale を配信し続けよ」という宣言だからです。
- **`cacheLife(c, …)` のマージは Next.js 準拠**: ハンドラでの明示宣言がミドルウェアのデフォルトに勝ち、複数回の呼び出し間ではフィールドごとに最短値が勝ちます — Next.js がネストした `use cache` スコープに適用するのと同じルールです(`explicitRevalidate` は下げる方向にしか更新されない)。
- **`cacheControl` は verbatim** — `s-maxage` → `max-age` の正規化は行いません。vinext の正規化は *Next.js が生成する文字列*への対処です。ここではユーザー自身が書く文字列であり、単一の `Cache-Control` として出力されるため、`s-maxage` + `max-age` 併記という標準テクニックがそのまま機能します。
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

リリースは **Publish** ワークフロー(`main` 上の `workflow_dispatch`)から手動実行します。実行前に `package.json` の `version` を更新してください。npm publish は provenance 付きで行います。

## License

MIT
