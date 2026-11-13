# Grogu app artwork

`app-icon.png` is the approved green pixel-style artwork from the existing Grogu
app. Keep it as the canonical input; the older red resource icon is not the
effective app icon.

`pnpm ui:build` runs `grogu/ui-build.mts`. It copies upstream public assets into
an invocation-owned temporary directory, derives the manifest from the upstream
template, and replaces only its name, short name and referenced icon artwork.
Rastermill, already a repository dependency, generates the PNG sizes without
platform-specific tools.

The existing UI runner and Vite configuration still own build identity,
content-bound public asset hashing, compression, validation and publication.
Upstream public files, manifest start URL and implicit app identity stay
unchanged. This does not export personal themes, alter authentication or browser
profiles, install an app, or change the Dock.

The downstream `ui:build` selection in `package.json` must be preserved during
upstream merges. Full builds and matching-UI test preparation delegate to that
package command through Node's built-in script runner rather than hardcoding
the upstream entrypoint. Those two generic caller repairs contain no Grogu
branding policy; the adapter and artwork otherwise remain under `grogu/`.
Deploy UI and Gateway from a matching build; do not relabel an unrelated UI
build to bypass version admission.
