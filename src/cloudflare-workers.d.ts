/**
 * Minimal shim for `cloudflare:workers` (purge surface only).
 * Real projects may rely on the declarations shipped by
 * @cloudflare/workers-types instead.
 */
declare module 'cloudflare:workers' {
  export const cache: {
    purge(options: {
      tags?: string[]
      pathPrefixes?: string[]
      purgeEverything?: boolean
    }): Promise<unknown>
  }
}
