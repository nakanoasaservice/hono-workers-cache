import { createRoute } from 'honox/factory'

export default createRoute((c) => {
  return c.render(
    <div>
      <h1>Admin</h1>
      <p>This page is never cached (Cache-Control: no-store).</p>
    </div>,
  )
})
