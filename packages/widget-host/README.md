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
