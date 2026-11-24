export const WIDGET_THEME_TOKENS = [
  "surface",
  "card",
  "elevated",
  "text",
  "text-strong",
  "muted",
  "border",
  "border-strong",
  "accent",
  "accent-fill",
  "accent-fg",
  "ok",
  "warn",
  "danger",
  "info",
  "radius",
  "radius-full",
  "scrollbar-size",
  "scrollbar-thumb-inset",
  "scrollbar-thumb",
  "scrollbar-thumb-hover",
  "font-body",
  "font-mono",
] as const;

export type WidgetThemeToken = (typeof WIDGET_THEME_TOKENS)[number];

export const WIDGET_THEME_MESSAGE_TYPE = "openclaw:widget-theme";

// Persisted Canvas documents include this rule, so the protected sandbox
// upgrades the shipped form on display rather than rewriting saved files.
export const LEGACY_WIDGET_CARD_RULE =
  ".card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px}";
export const WIDGET_CARD_RULE = LEGACY_WIDGET_CARD_RULE.replace(
  "var(--card)",
  "var(--openclaw-card-surface,var(--card))",
);

export type WidgetThemeMessage = {
  type: typeof WIDGET_THEME_MESSAGE_TYPE;
  mode: "light" | "dark";
  tokens: Record<string, string>;
};
