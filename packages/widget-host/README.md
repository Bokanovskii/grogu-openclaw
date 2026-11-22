# Protected widget host

This source package is owned by the OpenClaw fork and consumed by the separate
Grogu Protected client. Package it with `pnpm --dir packages/widget-host pack`.
Vite compiles the exported TypeScript; it does not import Control UI internals.

`createWidgetHost(frame, {html, theme, onPrompt, onError})` uses the existing
opaque-iframe MessageChannel transport. The server must serve the fork's
`buildSandboxHostDocument({profile: "protected"}, true)` at
`/api/protected/v1/widget-sandbox`. Do not replace that endpoint with a generic
or less restrictive sandbox. Retained HTML is loaded through this current
policy on every open, never directly as a document URL.

Only bounded resize, display errors, theme, and composer text are supported.
`onPrompt` inserts text for review; it must not send a chat or perform actions.
No RPC, files, tokens, account state, or host execution crosses this bridge.
`draft: true` disables scripts in the untrusted inner frame.
The optional `onReady` callback fires once when the matching content has loaded.

## Alcove content styles

The protected sandbox supplies `ALCOVE_CONTENT_STYLES` to widgets and HTML
previews. Wrap content in an element with `class="alcove"` to use the styles.
The classes `alcove-stack`, `alcove-grid`, `alcove-card`, `alcove-badge`,
`alcove-badge-warn`, and `alcove-muted` provide common layouts and treatments.
Use semantic HTML for headings, links, and tables. Custom styles can override
the library. Content without the `alcove` class keeps its existing appearance.

An HTML file generator can embed the same exported CSS in a `<style>` element.
The asset needs no network access and follows the browser's light or dark
appearance when opened outside Alcove. Its fallback colors mirror the client
tokens in `grogu-protected/src/tokens.css`; update both when the palette changes.
The sandbox keeps its existing restrictions on scripts, links, and network access.
