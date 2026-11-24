/**
 * Alcove content styles. The light and dark colors project the client palette
 * for offline documents and script-free previews. Update them with the
 * corresponding tokens in grogu-protected/src/tokens.css.
 */
export const ALCOVE_CONTENT_STYLES = `
:root { --openclaw-card-surface: transparent; }
:root:has(.alcove) { color-scheme: light dark; }
.alcove {
  --alcove-ground: light-dark(oklch(98.4% 0.004 150), oklch(19% 0.013 178));
  --alcove-card: light-dark(oklch(100% 0 0), oklch(23.5% 0.015 176));
  --alcove-ink: light-dark(oklch(23.5% 0.018 58), oklch(94.5% 0.01 120));
  --alcove-muted: light-dark(oklch(43% 0.016 62), oklch(80% 0.012 140));
  --alcove-line: light-dark(oklch(89.5% 0.01 150), oklch(30% 0.014 175));
  --alcove-accent: light-dark(oklch(46% 0.06 172), oklch(80% 0.07 168));
  --alcove-accent-soft: light-dark(oklch(94.2% 0.026 168), oklch(25.5% 0.03 172));
  --alcove-warn: light-dark(oklch(50% 0.1 68), oklch(80% 0.11 75));
  --alcove-warn-soft: light-dark(oklch(95.5% 0.03 80), oklch(27% 0.04 70));
  padding: 1rem;
  background: var(--alcove-ground);
  color: var(--alcove-ink);
  font: 0.9375rem/1.6 "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif;
}
.alcove :where(*, *::before, *::after) { box-sizing: border-box; }
.alcove :where(h1, h2, h3) { color: var(--alcove-ink); line-height: 1.25; margin: 0; }
.alcove :where(h1) { font: 540 1.5rem/1.3 "Literata Variable", Literata, Georgia, serif; }
.alcove :where(h2) { font-size: 1.0625rem; }
.alcove :where(h3) { font-size: 0.9375rem; }
.alcove :where(p) { margin: 0; }
.alcove :where(a) { color: var(--alcove-accent); text-underline-offset: 0.2em; }
.alcove :where(:focus-visible) { outline: 2px solid var(--alcove-accent); outline-offset: 3px; }
.alcove :where(.alcove-stack) { display: grid; gap: 1rem; }
.alcove :where(.alcove-grid) {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: 0.75rem;
}
.alcove :where(.alcove-card) {
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--alcove-line);
  border-radius: 14px;
  background: var(--alcove-card);
}
.alcove :where(.alcove-badge) {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  background: var(--alcove-accent-soft);
  color: var(--alcove-accent);
  font-size: 0.75rem;
  font-weight: 620;
}
.alcove :where(.alcove-badge-warn) { background: var(--alcove-warn-soft); color: var(--alcove-warn); }
.alcove :where(.alcove-muted) { color: var(--alcove-muted); }
.alcove :where(table) { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
.alcove :where(th, td) { padding: 0.5rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--alcove-line); }
.alcove :where(th) { color: var(--alcove-muted); font-weight: 620; }
.alcove :where(img, svg, video) { max-width: 100%; height: auto; }
`;
