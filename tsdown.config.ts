import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['esm'],
  unbundle: true,
  exports: true,
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ['cloudflare:workers', 'hono'],
  },
})
