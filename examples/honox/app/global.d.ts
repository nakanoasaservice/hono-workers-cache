import type {} from 'hono'

declare module 'hono' {
  interface ContextRenderer {
    // biome-ignore lint/style/useShorthandFunctionType: module augmentation requires the call-signature form
    (content: string | Promise<string>): Response | Promise<Response>
  }
}
