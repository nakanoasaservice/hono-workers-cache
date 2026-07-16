import { describe, expect, it } from 'vitest'
import { revalidateTags } from '../src/index.js'

/**
 * Runs on workerd via @cloudflare/vitest-pool-workers.
 *
 * Verifies that the dynamic `import('cloudflare:workers')` inside the purge
 * helpers resolves on the real Workers runtime — the thing Node-based unit
 * tests cannot cover. Whether the purge is actually accepted depends on the
 * runtime exposing Workers Cache, so the assertion only requires a
 * well-formed PurgeResult and no thrown error.
 */
describe('purge helpers on workerd', () => {
  it("resolves the 'cloudflare:workers' import without throwing", async () => {
    const result = await revalidateTags(['integration-test'])
    expect(typeof result.ok).toBe('boolean')
    if (!result.ok) {
      expect(['cache-unavailable', 'purge-failed']).toContain(result.reason)
    }
  })
})
