import { ALCOVE_CONTENT_STYLES } from "../../packages/widget-host/src/styles.js";

/** Empty, script-disabled document for host-only measurement of sanitized drafts. */
export function buildProtectedWidgetMeasurementDocument() {
  return {
    html: `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<style data-widget-base>${ALCOVE_CONTENT_STYLES}</style><body></body>`,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        "connect-src 'none'",
        "media-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
        "sandbox allow-same-origin",
      ].join("; "),
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-write=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    },
  };
}
