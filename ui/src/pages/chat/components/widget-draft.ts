import DOMPurify from "dompurify";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { WIDGET_BASE_STYLES } from "../../../../../src/canvas/wrap.js";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup, ToolCard } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import type { WidgetDraft } from "../../../lib/chat/widget-draft.ts";
import { buildWidgetThemeMessage } from "../../../lib/widget-theme.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";

const sanitizers = new WeakMap<Window, ReturnType<typeof DOMPurify>>();

function draftDocument(code: string): string {
  let sanitizer = sanitizers.get(window);
  if (!sanitizer) {
    sanitizer = DOMPurify(window);
    sanitizers.set(window, sanitizer);
  }
  const clean = sanitizer.sanitize(code, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: [
      "script",
      "meta",
      "base",
      "link",
      "iframe",
      "object",
      "embed",
      "form",
      "audio",
      "video",
      "source",
      "track",
      "foreignObject",
      "animate",
      "set",
    ],
    FORBID_ATTR: ["href", "xlink:href", "action", "formaction", "target", "ping", "srcdoc"],
  });
  const theme = buildWidgetThemeMessage();
  const tokens = Object.entries(theme.tokens)
    .map(([key, value]) => `--${key}:${value.replaceAll("<", "\\3c ")};`)
    .join("");
  // The frame has an opaque origin and no capabilities. Sanitizing also removes
  // declarative navigation, which a script-denying CSP alone does not prevent.
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
    <meta name="referrer" content="no-referrer">
    <style>${WIDGET_BASE_STYLES}
    :root{${tokens}color-scheme:${theme.mode}}body{background:var(--surface)}
    img:not([src^="data:" i]){visibility:hidden}
    *,*::before,*::after{animation:none!important;transition:none!important}</style>
    </head><body>${clean}</body></html>`;
}

class WidgetDraftCard extends OpenClawLitElement {
  @property({ attribute: false }) draft?: WidgetDraft;
  @state() private visible = -1;
  @state() private documents: (string | null)[] = [null, null];
  // Each load gets a fresh frame: re-committing a slot's previous document
  // would not navigate it, so no load event would release the pending update.
  private loads: [number, number] = [0, 0];
  private renderedCode = "";
  private loadingCode: string | null = null;
  private loadTimer?: ReturnType<typeof setTimeout>;
  @state() private previewFailed = false;

  static override styles = css`
    :host {
      display: block;
      min-width: 0;
      margin-block: 8px;
    }
    .header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text);
    }
    .status svg {
      width: 14px;
      height: 14px;
    }
    /* Global spinner keyframes do not reach this shadow root. */
    .status[data-building] svg {
      animation: widget-draft-spin 0.7s linear infinite;
    }
    @keyframes widget-draft-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .status[data-building] svg {
        animation: none;
      }
    }
    .title {
      color: var(--text-strong);
      overflow-wrap: anywhere;
    }
    .measure {
      margin-inline-start: auto;
      font-variant-numeric: tabular-nums;
    }
    /* Opaque frames cannot be measured, so the preview reserves the hosted
       widget frame's starting height (tool-cards.css) for a stable hand-off. */
    .preview {
      min-height: 420px;
      margin-top: 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--bg);
    }
    iframe {
      display: block;
      width: 100%;
      height: 420px;
      border: 0;
      pointer-events: none;
    }
    iframe[hidden] {
      display: none;
    }
    .note {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
  `;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.loadTimer);
    this.loadingCode = null;
    this.renderedCode = "";
    this.documents = [null, null];
    this.visible = -1;
  }

  protected override updated(_changed: PropertyValues): void {
    const draft = this.draft;
    if (!draft || draft.status !== "building" || draft.unavailable || !draft.html) {
      clearTimeout(this.loadTimer);
      this.loadingCode = null;
      if (this.documents.some(Boolean)) {
        this.documents = [null, null];
      }
      return;
    }
    if (this.previewFailed || this.loadingCode !== null || draft.html === this.renderedCode) {
      return;
    }
    const next = draftDocument(draft.html);
    if (next === this.documents[this.visible]) {
      this.renderedCode = draft.html;
      return;
    }
    const slot: 0 | 1 = this.visible === 0 ? 1 : 0;
    this.loadingCode = draft.html;
    this.loads[slot] += 1;
    this.documents = this.documents.map((doc, index) => (index === slot ? next : doc));
    this.loadTimer = setTimeout(() => {
      this.previewFailed = true;
      this.loadingCode = null;
      this.documents = [null, null];
    }, 5000);
  }

  private loaded(slot: number): void {
    if (!this.isConnected || this.loadingCode === null || this.draft?.status !== "building") {
      return;
    }
    clearTimeout(this.loadTimer);
    this.renderedCode = this.loadingCode;
    this.loadingCode = null;
    this.visible = slot;
  }

  override render() {
    const draft = this.draft;
    if (!draft) {
      return nothing;
    }
    const building = draft.status === "building";
    const label = t(`chat.toolCards.widgetDraft.${draft.status}`);
    return html`
      <div class="header">
        <span class="status" role="status" ?data-building=${building}
          >${building ? icons.loader : icons.alertTriangle}${label}</span
        >
        ${draft.title ? html`<span class="title">${draft.title}</span>` : nothing}
        ${
          building
            ? html`<span class="measure"
                >${t("chat.toolCards.widgetDraft.received", { count: draft.receivedChars.toLocaleString() })}
                · <openclaw-elapsed-time .startMs=${draft.startedAt}></openclaw-elapsed-time
              ></span>`
            : nothing
        }
      </div>
      ${
        building && !draft.unavailable && !this.previewFailed && draft.html
          ? html`<div class="preview" aria-label=${t("chat.toolCards.widgetDraft.preview")}>
              ${this.documents.map((document, slot) =>
                document === null
                  ? nothing
                  : keyed(
                      this.loads[slot],
                      html`<iframe
                        sandbox=""
                        inert
                        tabindex="-1"
                        referrerpolicy="no-referrer"
                        title=${t("chat.toolCards.widgetDraft.preview")}
                        ?hidden=${slot !== this.visible}
                        .srcdoc=${document}
                        @load=${() => this.loaded(slot)}
                      ></iframe>`,
                    ),
              )}
            </div>`
          : nothing
      }
      ${
        building
          ? html`<p class="note">
              ${t(
                draft.unavailable || this.previewFailed
                  ? "chat.toolCards.widgetDraft.unavailable"
                  : "chat.toolCards.widgetDraft.note",
              )}
            </p>`
          : draft.error
            ? html`<p class="note">${draft.error}</p>`
            : nothing
      }
    `;
  }
}

if (!customElements.get("openclaw-widget-draft")) {
  customElements.define("openclaw-widget-draft", WidgetDraftCard);
}

export function renderWidgetDraft(card: ToolCard) {
  return card.widgetDraft
    ? keyed(
        JSON.stringify([card.runId, card.callId]),
        html`<openclaw-widget-draft .draft=${card.widgetDraft}></openclaw-widget-draft>`,
      )
    : nothing;
}

export function renderWidgetDrafts(groups: readonly MessageGroup[]) {
  const drafts = new Map<string, ToolCard>();
  for (const group of groups) {
    for (const { message } of group.messages) {
      for (const card of extractToolCardsCached(message)) {
        const key = JSON.stringify([card.runId, card.callId]);
        if (card.widgetDraft) {
          drafts.set(key, card);
        } else if (card.completed) {
          drafts.delete(key);
        }
      }
    }
  }
  return repeat(
    [...drafts],
    ([key]) => key,
    ([, card]) => renderWidgetDraft(card),
  );
}
