import { jsxRenderer } from 'hono/jsx-renderer'

export default jsxRenderer(({ children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>hono-workers-cache × HonoX</title>
      </head>
      <body>{children}</body>
    </html>
  )
})
