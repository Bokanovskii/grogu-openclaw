import { html, nothing, render } from "lit";
import type { ControlUiPanel, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import type { HistoryEntry, Item } from "../src/contracts.js";
import { kindLabels, type SpacesController } from "./controller.ts";
import { renderCurrentItem, renderItemForm, renderSpaceForm } from "./forms.ts";

export function createSpacesView(controller: SpacesController, panel: false): ControlUiView;
export function createSpacesView(
  controller: SpacesController,
  panel: true,
): ControlUiPanel["mount"];
export function createSpacesView(
  controller: SpacesController,
  panel: boolean,
): ControlUiView<unknown> {
  return (container, initialContext) => {
    let presented = initialContext.presented;
    const root = document.createElement("section");
    root.className = `spaces-root${panel ? " spaces-root--panel" : ""}`;
    root.dataset.spaces = panel ? "panel" : "page";
    root.setAttribute("aria-label", panel ? "Space details" : "Spaces");
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !controller.saving) {
        controller.itemEditorId = null;
        controller.spaceEditorId = null;
        controller.selectedItemId = null;
        controller.notify();
        root.querySelector<HTMLElement>("input, button")?.focus();
      }
    });
    container.append(root);
    const prefix = `spaces-${panel ? "panel" : "page"}`;
    const update = () => {
      if (!presented) {
        return;
      }
      render(
        html`
          ${renderMessages(controller)}
          ${
            panel
              ? renderDetails(controller, prefix)
              : html`
                  <header class="spaces-header">
                    <div>
                      ${
                        controller.spaceId
                          ? html`<a
                              href="${controller.host.navigation.pageHref({ id: "spaces" })}"
                              @click=${(event: MouseEvent) => navigate(event, controller, "")}
                              >← Spaces</a
                            >`
                          : nothing
                      }
                      <h1>${controller.space?.name ?? "Spaces"}</h1>
                      <p class="spaces-subtitle">
                        ${controller.space?.description ?? "Lists and research, kept across chats."}
                      </p>
                    </div>
                    <div class="spaces-actions">
                      <button
                        @click=${() => void controller.refresh()}
                        ?disabled=${controller.loading || !controller.host.connection.connected}
                      >
                        Refresh
                      </button>
                      ${
                        controller.spaceId
                          ? html`<button
                              ?disabled=${!controller.writable || !controller.space || Boolean(controller.space.deletedAt)}
                              @click=${() => controller.editItem()}
                            >
                              Add item
                            </button>`
                          : html`<button
                              class="spaces-primary"
                              ?disabled=${!controller.writable}
                              @click=${() => controller.editSpace()}
                            >
                              New Space
                            </button>`
                      }
                    </div>
                  </header>
                  <div class="spaces-toolbar">
                    <form
                      class="spaces-search"
                      role="search"
                      @submit=${(event: Event) => {
                        event.preventDefault();
                        void controller.refresh();
                      }}
                    >
                      <label class="spaces-sr-only" for="${prefix}-search"
                        >Search ${controller.spaceId ? "items" : "Spaces"}</label
                      >
                      <input
                        id="${prefix}-search"
                        type="search"
                        maxlength="200"
                        placeholder="${controller.spaceId ? "Search items" : "Search Spaces"}"
                        .value=${controller.search}
                        @input=${(event: Event) => {
                          if (event.currentTarget instanceof HTMLInputElement) {
                            controller.search = event.currentTarget.value;
                          }
                        }}
                      />
                      <button type="submit" ?disabled=${controller.loading}>Search</button>
                    </form>
                    <button
                      aria-pressed="${controller.trash}"
                      @click=${() => {
                        controller.trash = !controller.trash;
                        void controller.refresh();
                      }}
                    >
                      Trash
                    </button>
                    ${
                      controller.space
                        ? html`
                            <button
                              aria-pressed="${controller.historyOpen}"
                              @click=${() => {
                                controller.historyOpen = !controller.historyOpen;
                                void controller.refresh();
                              }}
                            >
                              History
                            </button>
                            <button
                              ?disabled=${!controller.writable || Boolean(controller.space.deletedAt)}
                              @click=${() => controller.editSpace(controller.space)}
                            >
                              Edit Space
                            </button>
                          `
                        : nothing
                    }
                  </div>
                  ${controller.trash ? html`<p class="spaces-hint">Trash keeps deleted content for 30 days. Restore anything you still need.</p>` : nothing}
                  ${renderSpaceForm(controller, `${prefix}-space`)}
                  ${
                    controller.spaceEditorId && controller.space
                      ? html`<details class="spaces-current">
                          <summary>Current saved Space</summary>
                          <h3>${controller.space.name}</h3>
                          <p>${controller.space.description}</p>
                          <pre>${controller.space.rules}</pre>
                          <p>Revision ${controller.space.revision}</p>
                        </details>`
                      : nothing
                  }
                  ${controller.spaceId ? renderSpace(controller, prefix) : renderHome(controller)}
                  ${controller.historyOpen ? renderHistory(controller) : nothing}
                `
          }
        `,
        root,
      );
    };
    const selectFromProps = (props: unknown) => {
      if (panel || typeof props !== "object" || props === null) {
        return;
      }
      const spaceId = "spaceId" in props && typeof props.spaceId === "string" ? props.spaceId : "";
      controller.selectSpace(spaceId);
    };
    const unsubscribe = controller.subscribe(update);
    selectFromProps(initialContext.props);
    update();
    return {
      update(context) {
        const resumed = !presented && context.presented;
        presented = context.presented;
        selectFromProps(context.props);
        if (resumed) {
          void controller.refresh();
        }
        update();
      },
      focus() {
        root.querySelector<HTMLElement>("input, button, a")?.focus();
      },
      dispose() {
        unsubscribe();
        render(nothing, root);
        root.remove();
      },
    };
  };
}

function navigate(event: MouseEvent, controller: SpacesController, spaceId: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  controller.host.navigation.openPage({ id: "spaces", params: spaceId ? { spaceId } : {} });
}

function renderMessages(controller: SpacesController) {
  const connection = controller.host.connection;
  return html` ${!connection.connected ? html`<p class="spaces-warning" role="status">Disconnected. Your draft is kept. Reconnect to load and save.</p>` : nothing}
    ${connection.connected && !connection.canRead ? html`<p class="spaces-warning" role="alert">Read access is required to open Spaces.</p>` : nothing}
    ${connection.connected && !connection.canWrite ? html`<p class="spaces-warning" role="status">Read-only access. You can browse, but cannot save.</p>` : nothing}
    ${
      controller.error
        ? html`<div class="spaces-warning" role="alert">
            ${controller.error}
            ${controller.uncertain ? html`<button ?disabled=${controller.saving || !connection.connected || !connection.canWrite} @click=${() => void controller.checkSave()}>Check save</button>` : nothing}
          </div>`
        : nothing
    }
    <div class="spaces-status" role="status" aria-live="polite">
      ${controller.saving ? "Saving…" : controller.loading ? "Loading Spaces…" : controller.notice}
    </div>`;
}

function renderHome(controller: SpacesController) {
  return html` <div class="spaces-grid">
      ${controller.spaces.map(
        (space) => html`<article class="spaces-card">
          <span class="spaces-kind">${kindLabels[space.kind]}</span>
          <h2>
            <a
              href="${controller.host.navigation.pageHref({ id: "spaces", params: { spaceId: space.id } })}"
              @click=${(event: MouseEvent) => navigate(event, controller, space.id)}
              >${space.name}</a
            >
          </h2>
          <p>${space.description}</p>
          ${space.deletedAt ? html`<button ?disabled=${!controller.writable} @click=${() => void controller.mutate({ action: "space.restore", operationId: crypto.randomUUID(), spaceId: space.id, expectedRevision: space.revision })}>Restore ${space.name}</button>` : nothing}
        </article>`,
      )}
    </div>
    ${
      !controller.loading && !controller.spaces.length && !controller.error
        ? html`<div class="spaces-empty">
            <h2>
              ${controller.trash ? "Trash is empty" : controller.search ? "No matching Spaces" : "Make room for what matters"}
            </h2>
            <p>
              ${controller.trash ? "Deleted Spaces appear here." : "Start with To-do or Shopping. Save links and vacation research here too."}
            </p>
          </div>`
        : nothing
    }
    ${renderPagination(controller)}`;
}

function renderSpace(controller: SpacesController, prefix: string) {
  const space = controller.space;
  if (!space) {
    return nothing;
  }
  return html` <div class="spaces-space-meta">
      <span class="spaces-kind">${kindLabels[space.kind]}</span>
      <details>
        <summary>Interaction rules</summary>
        <pre>${space.rules}</pre>
      </details>
      <button
        class="spaces-danger"
        ?disabled=${!controller.writable}
        @click=${() => void controller.mutate({ action: space.deletedAt ? "space.restore" : "space.delete", operationId: crypto.randomUUID(), spaceId: space.id, expectedRevision: space.revision })}
      >
        ${space.deletedAt ? "Restore Space" : "Move Space to Trash"}
      </button>
    </div>
    ${
      space.kind === "read-later" && !controller.trash && !space.deletedAt
        ? html` <button
              ?disabled=${!controller.writable}
              aria-expanded="${controller.importOpen}"
              @click=${() => {
                controller.importOpen = !controller.importOpen;
                controller.notify();
              }}
            >
              Import links
            </button>
            ${controller.importOpen ? renderImport(controller, prefix) : nothing}`
        : nothing
    }
    <div class="spaces-workspace">
      <section
        class="spaces-list"
        aria-label="${space.kind === "vacation" ? "Vacation comparison" : "Space items"}"
      >
        ${controller.items.map(
          (item) => html`<article
            class="spaces-item ${item.parentId ? "spaces-item--child" : ""} ${item.id === controller.selectedItemId ? "spaces-item--selected" : ""}"
            data-spaces-item="${item.id}"
          >
            <div class="spaces-item-content">
              <button
                class="spaces-item-title"
                aria-pressed="${item.id === controller.selectedItemId}"
                @click=${() => {
                  controller.selectedItemId = item.id;
                  controller.itemEditorId = null;
                  controller.notify();
                }}
              >
                ${item.title}
              </button>
              <div class="spaces-item-meta">
                <span
                  >${item.status === "open" && space.kind === "read-later" ? "Unread" : item.status}</span
                >
                ${item.quantity !== null ? html`<span>${item.quantity} ${item.unit}</span>` : nothing}
                ${item.category ? html`<span>${item.category}</span>` : nothing}
                ${item.dueDate ? html`<span>Due ${item.dueDate}</span>` : nothing}
                ${item.estimate !== null ? html`<span>${item.currency ?? ""} ${item.estimate}</span>` : nothing}
                ${item.sourceDate ? html`<span>Source ${item.sourceDate}</span>` : nothing}
              </div>
            </div>
            ${
              item.deletedAt
                ? html`<button
                    ?disabled=${!controller.writable || Boolean(space.deletedAt)}
                    @click=${() => void controller.mutate({ action: "item.restore", operationId: crypto.randomUUID(), spaceId: space.id, itemId: item.id, expectedRevision: item.revision })}
                  >
                    Restore
                  </button>`
                : html`<button
                    ?disabled=${!controller.writable || Boolean(space.deletedAt)}
                    @click=${() => void setItemStatus(controller, item)}
                  >
                    ${statusAction(item, space.kind)}
                  </button>`
            }
          </article>`,
        )}
        ${
          !controller.loading && !controller.items.length
            ? html`<div class="spaces-empty">
                <h2>
                  ${controller.trash ? "No deleted items" : controller.search ? "No matching items" : "No items yet"}
                </h2>
                <p>
                  ${controller.trash ? "Deleted items appear here." : "Add an item to get started."}
                </p>
              </div>`
            : nothing
        }
        ${renderPagination(controller)}
      </section>
      ${
        controller.itemEditorId || controller.selectedItemId
          ? html`<aside class="spaces-detail" aria-label="Item details">
              ${renderDetails(controller, prefix)}
            </aside>`
          : nothing
      }
    </div>`;
}

function statusAction(item: Item, kind: string) {
  if (item.status !== "open") {
    return "Reopen";
  }
  return kind === "read-later" ? "Mark read" : kind === "vacation" ? "Select" : "Complete";
}

function setItemStatus(controller: SpacesController, item: Item) {
  return controller.mutate({
    action: "item.update",
    operationId: crypto.randomUUID(),
    spaceId: item.spaceId,
    itemId: item.id,
    expectedRevision: item.revision,
    fields: {
      status:
        item.status !== "open"
          ? "open"
          : controller.space?.kind === "read-later"
            ? "read"
            : controller.space?.kind === "vacation"
              ? "selected"
              : "done",
    },
  });
}

function renderDetails(controller: SpacesController, prefix: string) {
  const item = controller.items.find((record) => record.id === controller.selectedItemId);
  return html` ${renderItemForm(controller, `${prefix}-item`)}
  ${
    item
      ? html`<section class="spaces-current" aria-label="Current saved item">
          <div class="spaces-actions">
            <h2>${item.title}</h2>
            <button
              aria-label="Close item details"
              @click=${() => {
                controller.selectedItemId = null;
                controller.itemEditorId = null;
                controller.notify();
              }}
            >
              Close
            </button>
          </div>
          ${renderCurrentItem(item)}
          ${item.url ? html`<a href="${item.url}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : nothing}
          ${item.notes ? html`<p class="spaces-notes">${item.notes}</p>` : nothing}
          <div class="spaces-actions">
            <button
              ?disabled=${!controller.writable || Boolean(item.deletedAt) || Boolean(controller.space?.deletedAt)}
              @click=${() => controller.editItem(item)}
            >
              Edit item
            </button>
            <button @click=${() => controller.host.ui.openPanel("details")}>
              Open details panel
            </button>
            ${
              !item.deletedAt && !controller.space?.deletedAt
                ? html`
                    <button
                      ?disabled=${!controller.writable}
                      @click=${() => controller.editItem(undefined, item.id)}
                    >
                      Add checklist item
                    </button>
                    ${
                      controller.space?.kind === "read-later" ||
                      controller.space?.kind === "vacation"
                        ? html` <button
                            ?disabled=${!controller.writable}
                            @click=${() => void controller.mutate({ action: "item.update", operationId: crypto.randomUUID(), spaceId: item.spaceId, itemId: item.id, expectedRevision: item.revision, fields: { status: "archived" } })}
                          >
                            Archive
                          </button>`
                        : nothing
                    }
                    <button
                      class="spaces-danger"
                      ?disabled=${!controller.writable}
                      @click=${() => void controller.mutate({ action: "item.delete", operationId: crypto.randomUUID(), spaceId: item.spaceId, itemId: item.id, expectedRevision: item.revision })}
                    >
                      Move to Trash
                    </button>
                  `
                : nothing
            }
          </div>
          ${controller.space?.kind === "shopping" && !item.deletedAt ? renderCombine(controller, item, prefix) : nothing}
        </section>`
      : !controller.itemEditorId
        ? html`<p class="spaces-empty">Select an item in a Space to see its details.</p>`
        : nothing
  }`;
}

function renderCombine(controller: SpacesController, target: Item, prefix: string) {
  const source = controller.items.find(
    (item) => item.id === controller.combineSourceId && item.id !== target.id && !item.deletedAt,
  );
  return html`<section class="spaces-combine">
    <h3>Combine shopping items</h3>
    <p>Keep “${target.title}” as the target. The source item moves to Trash.</p>
    <label class="spaces-field" for="${prefix}-combine"
      >Source item
      <select
        id="${prefix}-combine"
        aria-label="Source item"
        .value=${source?.id ?? ""}
        @change=${(event: Event) => {
          if (event.currentTarget instanceof HTMLSelectElement) {
            controller.combineSourceId = event.currentTarget.value;
            controller.notify();
          }
        }}
      >
        <option value="">Choose an item</option>
        ${controller.items.filter((item) => item.id !== target.id && !item.deletedAt).map((item) => html`<option value="${item.id}">${item.title} · ${item.quantity ?? "no quantity"} ${item.unit}</option>`)}
      </select>
    </label>
    <button
      ?disabled=${!source || !controller.writable || Boolean(controller.space?.deletedAt)}
      @click=${() => {
        if (source) {
          void controller.mutate({
            action: "shopping.combine",
            operationId: crypto.randomUUID(),
            spaceId: target.spaceId,
            itemId: target.id,
            expectedRevision: target.revision,
            sourceId: source.id,
            sourceRevision: source.revision,
          });
        }
      }}
    >
      Combine into ${target.title}
    </button>
  </section>`;
}

function renderImport(controller: SpacesController, prefix: string) {
  return html`<section class="spaces-editor" aria-label="Import Read Later links">
    <h2>Import links</h2>
    <label class="spaces-field" for="${prefix}-import"
      >Links, one per line (up to 100)
      <textarea
        id="${prefix}-import"
        rows="5"
        .value=${controller.importText}
        @input=${(event: Event) => {
          if (event.currentTarget instanceof HTMLTextAreaElement) {
            controller.changeImportText(event.currentTarget.value);
          }
        }}
      ></textarea>
    </label>
    <button ?disabled=${!controller.writable} @click=${() => void controller.previewImport()}>
      Preview import
    </button>
    ${
      controller.preview
        ? html`<ul class="spaces-import-preview">
              ${controller.preview.map((row) => html`<li>${row.url} <strong>${row.duplicate ? "Duplicate" : "New link"}</strong></li>`)}
            </ul>
            <label class="spaces-field" for="${prefix}-duplicates"
              >Duplicates
              <select
                id="${prefix}-duplicates"
                aria-label="Duplicates"
                .value=${controller.duplicates}
                @change=${(event: Event) => {
                  const select = event.currentTarget;
                  if (
                    select instanceof HTMLSelectElement &&
                    (select.value === "skip" || select.value === "reject")
                  ) {
                    controller.duplicates = select.value;
                  }
                }}
              >
                <option value="skip">Skip duplicates</option>
                <option value="reject">Reject the whole import if duplicates exist</option>
              </select>
            </label>
            <button
              class="spaces-primary"
              ?disabled=${!controller.writable || !controller.importItems.length}
              @click=${() => void controller.saveImport()}
            >
              Import ${controller.importItems.length} links
            </button>`
        : nothing
    }
  </section>`;
}

function renderHistory(controller: SpacesController) {
  return html`<section class="spaces-history" aria-label="Space history">
    <h2>History</h2>
    <p class="spaces-hint">
      Recent changes. Undo is available for 30 days and may be rejected if the record changed.
    </p>
    <ol>
      ${controller.history.map(
        (entry: HistoryEntry) => html`<li>
          <div>
            <strong>${entry.action}</strong>
            <p>
              ${entry.after && "title" in entry.after ? entry.after.title : (entry.after?.name ?? (entry.before && ("title" in entry.before ? entry.before.title : entry.before.name)))}
            </p>
            <span class="spaces-hint">${new Date(entry.at).toLocaleString()} · ${entry.actor}</span>
          </div>
          <button ?disabled=${!controller.writable} @click=${() => void controller.undo(entry)}>
            Undo
          </button>
        </li>`,
      )}
    </ol>
    ${!controller.history.length && !controller.loading ? html`<p>No changes yet.</p>` : nothing}
    ${
      controller.historyNextOffset !== null
        ? html`<button
            ?disabled=${controller.historyLoading}
            @click=${() => void controller.loadMoreHistory()}
          >
            Load more history
          </button>`
        : nothing
    }
  </section>`;
}

function renderPagination(controller: SpacesController) {
  return html`<footer class="spaces-pagination">
    <span class="spaces-hint"
      >${controller.spaceId ? controller.items.length : controller.spaces.length} of
      ${controller.total}</span
    >
    ${controller.nextOffset !== null ? html`<button ?disabled=${controller.loading} @click=${() => void controller.refresh(true)}>Load more</button>` : nothing}
  </footer>`;
}
