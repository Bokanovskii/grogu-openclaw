# Protected widget host

This source package is owned by the OpenClaw fork and consumed by the separate
Grogu Protected client. Package it with `pnpm --dir packages/widget-host pack`.
Vite compiles the exported TypeScript; it does not import Control UI internals.

`createWidgetHost(frame, {html, theme, themeTokens, onReady, onPrompt, onError})` uses the existing
opaque-iframe MessageChannel transport. The server must serve the fork's
`buildSandboxHostDocument({profile: "protected"}, true)` at
`/api/protected/v1/widget-sandbox`. Do not replace that endpoint with a generic
or less restrictive sandbox. Retained HTML is loaded through this current
policy on every open, never directly as a document URL.

Only bounded resize, viewport top state, display errors, theme, and composer text are supported.
`onPrompt` inserts text for review; it must not send a chat or perform actions.
No RPC, files, credentials, account state, or host execution crosses this bridge.
`draft: true` disables scripts in the untrusted inner frame.
The optional `onReady` callback fires once when the matching content has loaded.
Keep the visible frame until its replacement calls `onReady`. A frame's native
`load` event only means that the sandbox shell loaded, not its widget resource.

Pass `onScrollTopChange(atTop)` to follow the saved document's own viewport.
It reports a boolean when that viewport leaves or returns to the top. The
containing page and lists inside the artifact have separate scroll positions.
Start each viewer at the top. Drafts and older runtime shells do not send the
signal, so keep an accessible way to exit without it.

Supply `themeTokens` on mount and call `host.setTheme(mode, tokens)` on every
theme change. Each call replaces the full snapshot. Omitted values fall back
to the document palette. Token keys omit the `--` prefix. The sandbox accepts
the keys in `src/shared/widget-theme.ts` with nonempty string values up to
256 characters. Values can include `oklch()` colors and quoted font stacks.
The sandbox does not inherit the application's loaded fonts. Embed data fonts
or use local and system fallbacks.
Fixed authored backgrounds do not change with tokens. For a widget that mixes
a white background with theme-dependent text, a client can offer an explicit
light appearance through `setTheme("light", completeLightTokens)`. Do not infer
that policy from arbitrary HTML or recolor all saved widgets.

`host.setHeight(rawHeight)` uses the same finite-number, rounded-up
120–1200 pixel clamp as `openclaw:widget-size` messages, including drafts.
Opaque script-free drafts cannot report their own height. A client can measure
a separate sanitized, script-disabled document and pass that measurement to
`setHeight`. Never place raw draft markup in the application DOM. Preserve the
visible frame's sandbox and account for the measurement document's CSP.

The protected application blocks inline CSS in `srcdoc` through CSP inheritance.
Load `/api/protected/v1/widget-measurement` in a separate hidden, inert iframe
with `sandbox="allow-same-origin"` only. Its response policy permits inline CSS
and data images/fonts but denies scripts, network resources, forms, and child
frames. Read and retain `style[data-widget-base]` before `document.open/write`.
Populate it only with sanitized markup that removes navigation tags and
attributes. Do not grant scripts or put this document in the visible widget slot.
Apply the theme snapshot to its root and measure at the visible widget's width.

Changes to `src/agents/sandbox-host.ts` require a server/runtime release because
`grogu/protected/http.ts` serves the sandbox. Installing this package alone does
not update that endpoint.

To package the source at a pinned commit, run these commands in its checkout:

```sh
git rev-parse HEAD
pnpm --dir packages/widget-host pack --pack-destination /absolute/output/path
```

The output is `grogu-widget-host-0.1.0.tgz`. Vite compiles its TypeScript exports,
so no package build step is required. Keep the source SHA with the vendored
archive. The package includes `src/` and this README, not the server shell.

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
