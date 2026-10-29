import type {} from "hono";

declare module "hono" {
  interface ContextRenderer {
    // Call-signature form is required for module augmentation (not a method shorthand).
    (content: string | Promise<string>): Response | Promise<Response>;
  }
}
