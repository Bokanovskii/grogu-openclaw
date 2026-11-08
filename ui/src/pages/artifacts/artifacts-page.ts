import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  AgentsWorkspaceEntry,
  AgentsWorkspaceFile,
  AgentsWorkspaceGetResult,
  AgentsWorkspaceListResult,
} from "../../../../packages/gateway-protocol/src/schema/agents-workspace.js";
import type { AgentsListResult } from "../../api/types.ts";
import { subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  formatArtifactSize,
  sortArtifactEntries,
  type ArtifactSortMode,
} from "./artifacts-sort.ts";
import "../../styles/artifacts.css";

type Preview =
  | { kind: "loading"; path: string }
  | { kind: "ready"; file: AgentsWorkspaceFile }
  | { kind: "error"; path: string; message: string };

const LIST_LIMIT = 500;
const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

class ArtifactsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private agents: AgentsListResult["agents"] = [];
  @state() private agentId = "";
  @state() private path = "";
  @state() private entries: AgentsWorkspaceEntry[] = [];
  @state() private listing = false;
  @state() private error: string | null = null;
  @state() private sort: ArtifactSortMode = "recent";
  @state() private preview: Preview | null = null;
  private generation = 0;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.agents = [];
      this.entries = [];
      this.preview = null;
      this.error = null;
    },
    invalidateRequests: () => {
      this.generation += 1;
      this.listing = false;
    },
    ensureInitialData: () => void this.loadAgents(),
  });

  private async loadAgents() {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      return;
    }
    try {
      const result = await client.request<AgentsListResult>("agents.list", {});
      this.agents = result.agents;
      if (!this.agentId || !result.agents.some((agent) => agent.id === this.agentId)) {
        this.agentId = result.defaultId;
        this.path = "";
      }
      await this.loadDirectory(this.path);
    } catch (error) {
      this.error = formatUiError(error);
    }
  }

  private async loadDirectory(path: string) {
    const client = this.gateway.client;
    if (!client || !this.agentId) {
      return;
    }
    const generation = ++this.generation;
    this.listing = true;
    this.error = null;
    try {
      const result = await client.request<AgentsWorkspaceListResult>("agents.workspace.list", {
        agentId: this.agentId,
        ...(path ? { path } : {}),
        limit: LIST_LIMIT,
      });
      if (generation !== this.generation) {
        return;
      }
      this.path = result.path;
      this.entries = result.entries;
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.listing = false;
      }
    }
  }

  private async openFile(path: string) {
    const client = this.gateway.client;
    if (!client || !this.agentId) {
      return;
    }
    const pending: Preview = { kind: "loading", path };
    this.preview = pending;
    try {
      const result = await client.request<AgentsWorkspaceGetResult>("agents.workspace.get", {
        agentId: this.agentId,
        path,
      });
      if (this.preview === pending) {
        this.preview = { kind: "ready", file: result.file };
      }
    } catch (error) {
      if (this.preview === pending) {
        this.preview = { kind: "error", path, message: formatUiError(error) };
      }
    }
  }

  private selectAgent(agentId: string) {
    this.agentId = agentId;
    this.preview = null;
    void this.loadDirectory("");
  }

  private refresh() {
    void this.loadDirectory(this.path);
    if (this.preview?.kind === "ready") {
      void this.openFile(this.preview.file.path);
    }
  }

  private previewPath(): string | null {
    const preview = this.preview;
    if (!preview) {
      return null;
    }
    return preview.kind === "ready" ? preview.file.path : preview.path;
  }

  private renderBreadcrumbs() {
    const segments = this.path ? this.path.split("/") : [];
    const crumb = (label: string, target: string, current: boolean) =>
      current
        ? html`<span class="artifacts-crumb artifacts-crumb--current">${label}</span>`
        : html`<button
            type="button"
            class="artifacts-crumb"
            @click=${() => void this.loadDirectory(target)}
          >
            ${label}
          </button>`;
    return html`<nav class="artifacts-breadcrumbs" aria-label=${t("artifacts.path")}>
      ${crumb(t("artifacts.root"), "", segments.length === 0)}
      ${segments.map(
        (segment, index) =>
          html`<span class="artifacts-crumb-sep" aria-hidden="true">/</span>${crumb(
              segment,
              segments.slice(0, index + 1).join("/"),
              index === segments.length - 1,
            )}`,
      )}
    </nav>`;
  }

  private renderEntry(entry: AgentsWorkspaceEntry, selectedPath: string | null) {
    const directory = entry.kind === "directory";
    const selected = selectedPath === entry.path;
    return html`<li>
      <button
        type="button"
        class="artifacts-entry ${selected ? "artifacts-entry--selected" : ""}"
        aria-current=${selected ? "true" : "false"}
        @click=${() =>
          directory ? void this.loadDirectory(entry.path) : void this.openFile(entry.path)}
      >
        <span class="artifacts-entry__icon" aria-hidden="true">${directory ? "📁" : "📄"}</span>
        <span class="artifacts-entry__name">${entry.name}</span>
        <span class="artifacts-entry__meta">
          ${directory ? "" : formatArtifactSize(entry.size)}
          ${entry.updatedAtMs ? formatRelativeTimestamp(entry.updatedAtMs) : ""}
        </span>
      </button>
    </li>`;
  }

  private renderPreviewBody(file: AgentsWorkspaceFile) {
    if (file.encoding === "base64") {
      return html`<img
        class="artifacts-preview__image"
        alt=${file.name}
        src=${`data:${file.mimeType};base64,${file.content}`}
      />`;
    }
    if (MARKDOWN_FILE.test(file.name)) {
      return html`<div class="artifacts-preview__markdown chat-text">
        ${unsafeHTML(toSanitizedMarkdownHtml(file.content, { mode: "document" }))}
      </div>`;
    }
    return html`<pre class="artifacts-preview__text">${file.content}</pre>`;
  }

  private renderPreview() {
    const preview = this.preview;
    if (!preview) {
      return html`<div class="artifacts-preview__empty">${t("artifacts.selectFile")}</div>`;
    }
    if (preview.kind === "loading") {
      return html`<div class="artifacts-preview__empty" role="status">${t("common.loading")}</div>`;
    }
    if (preview.kind === "error") {
      return html`<div class="callout danger" role="alert">${preview.message}</div>`;
    }
    const { file } = preview;
    return html`
      <header class="artifacts-preview__header">
        <div class="artifacts-preview__title" title=${file.path}>${file.path}</div>
        <div class="artifacts-preview__meta">
          ${formatArtifactSize(file.size)} · ${formatRelativeTimestamp(file.updatedAtMs)}
        </div>
      </header>
      ${this.renderPreviewBody(file)}
    `;
  }

  private renderActions() {
    return html`
      ${
        this.agents.length > 1
          ? html`<select
              class="settings-select artifacts-toolbar__select"
              aria-label=${t("artifacts.agent")}
              @change=${(event: Event) => {
                if (!(event.currentTarget instanceof HTMLSelectElement)) {
                  throw new TypeError("Artifacts agent control must be a select element");
                }
                this.selectAgent(event.currentTarget.value);
              }}
            >
              ${this.agents.map(
                (agent) =>
                  html`<option value=${agent.id} ?selected=${agent.id === this.agentId}>
                    ${agent.name ?? agent.id}
                  </option>`,
              )}
            </select>`
          : nothing
      }
      <select
        class="settings-select artifacts-toolbar__select"
        aria-label=${t("artifacts.sort")}
        @change=${(event: Event) => {
          if (!(event.currentTarget instanceof HTMLSelectElement)) {
            throw new TypeError("Artifacts sort control must be a select element");
          }
          const mode = event.currentTarget.value;
          if (mode !== "recent" && mode !== "name") {
            throw new TypeError(`Invalid artifacts sort mode: ${mode}`);
          }
          this.sort = mode;
        }}
      >
        <option value="recent" ?selected=${this.sort === "recent"}>
          ${t("artifacts.sortRecent")}
        </option>
        <option value="name" ?selected=${this.sort === "name"}>${t("artifacts.sortName")}</option>
      </select>
      <button class="btn" ?disabled=${this.listing} @click=${() => this.refresh()}>
        ${this.listing ? t("common.loading") : t("common.refresh")}
      </button>
    `;
  }

  override render() {
    const entries = sortArtifactEntries(this.entries, this.sort);
    const selectedPath = this.previewPath();
    const body = html`
      ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}
      <div class="artifacts-layout">
        <section class="artifacts-browser" aria-label=${t("artifacts.files")}>
          ${this.renderBreadcrumbs()}
          ${
            entries.length === 0 && !this.listing
              ? html`<div class="artifacts-preview__empty">${t("artifacts.empty")}</div>`
              : html`<ul class="artifacts-list">
                  ${entries.map((entry) => this.renderEntry(entry, selectedPath))}
                </ul>`
          }
        </section>
        <section class="artifacts-preview" aria-label=${t("artifacts.preview")}>
          ${this.renderPreview()}
        </section>
      </div>
    `;
    return html`
      <div class="artifacts-toolbar">
        <p class="artifacts-toolbar__subtitle">${subtitleForRoute("artifacts")}</p>
        <div class="artifacts-toolbar__actions">${this.renderActions()}</div>
      </div>
      ${renderSettingsWorkspace(body, { fillHeight: true })}
    `;
  }
}

if (!customElements.get("openclaw-artifacts-page")) {
  customElements.define("openclaw-artifacts-page", ArtifactsPage);
}
