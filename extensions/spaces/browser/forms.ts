import { html, nothing } from "lit";
import {
  itemFieldsSchema,
  spaceFieldsSchema,
  type Item,
  type ItemFields,
} from "../src/contracts.js";
import { kindLabels, type SpacesController } from "./controller.ts";
import { newSpaceDraftId, type Draft } from "./drafts.ts";

export function renderSpaceForm(controller: SpacesController, prefix: string) {
  const id = controller.spaceEditorId;
  const draft = id ? controller.spaceDrafts.get(id) : undefined;
  if (!draft) {
    return nothing;
  }
  const field = (key: "name" | "description" | "rules", label: string, max: number) => html` <label
    class="spaces-field"
    for="${prefix}-${key}"
    >${label}
    ${
      key === "name"
        ? html`<input
            id="${prefix}-${key}"
            required
            maxlength="${max}"
            .value=${draft.fields[key]}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                updateDraft(controller, draft, key, event.currentTarget.value);
              }
            }}
          />`
        : html`<textarea
            id="${prefix}-${key}"
            required
            maxlength="${max}"
            rows="${key === "rules" ? 4 : 2}"
            .value=${draft.fields[key]}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLTextAreaElement) {
                updateDraft(controller, draft, key, event.currentTarget.value);
              }
            }}
          ></textarea>`
    }
  </label>`;
  const current =
    controller.space?.id === id
      ? controller.space
      : controller.spaces.find((space) => space.id === id);
  return html` <section
    class="spaces-editor"
    aria-label="${id === newSpaceDraftId ? "New Space" : "Edit Space"}"
  >
    <h2>${id === newSpaceDraftId ? "New Space" : "Edit Space"}</h2>
    <form
      @submit=${(event: Event) => {
        event.preventDefault();
        void controller.saveSpace();
      }}
    >
      <fieldset
        ?disabled=${(controller.host.connection.connected && !controller.host.connection.canWrite) || controller.saving || Boolean(controller.uncertain)}
      >
        ${field("name", "Name", 200)}
        <label class="spaces-field" for="${prefix}-kind"
          >Type
          <select
            id="${prefix}-kind"
            aria-label="Type"
            .value=${draft.fields.kind}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                const kind = spaceFieldsSchema.shape.kind.safeParse(event.currentTarget.value);
                if (kind.success) {
                  updateDraft(controller, draft, "kind", kind.data);
                }
              }
            }}
          >
            ${Object.entries(kindLabels).map(([kind, label]) => html`<option value="${kind}">${label}</option>`)}
          </select>
        </label>
        ${field("description", "Description", 240)}
        <p class="spaces-hint">What belongs here? Keep the description within 240 bytes.</p>
        ${field("rules", "Interaction rules", 8000)}
        <p class="spaces-hint">
          How should Grogu organize and update this Space? Rules do not grant permissions.
        </p>
        ${draft.conflict ? renderConflict(controller, draft, current?.revision) : nothing}
        <div class="spaces-actions">
          <button
            class="spaces-primary"
            type="submit"
            ?disabled=${!controller.writable || draft.conflict}
          >
            ${controller.saving ? "Saving…" : "Save Space"}
          </button>
          <button
            type="button"
            @click=${() => {
              controller.spaceEditorId = null;
              controller.notify();
            }}
          >
            Close
          </button>
        </div>
      </fieldset>
    </form>
  </section>`;
}

export function renderItemForm(controller: SpacesController, prefix: string) {
  const id = controller.itemEditorId;
  const draft = id ? controller.itemDrafts.get(id) : undefined;
  if (!draft) {
    return nothing;
  }
  const kind = controller.space?.kind;
  const current = controller.items.find((item) => item.id === id);
  const field = (
    key: "title" | "notes" | "url" | "unit" | "category" | "dueDate" | "sourceDate" | "currency",
    label: string,
    type = "text",
    max?: number,
  ) => html` <label class="spaces-field" for="${prefix}-${key}"
    >${label}
    ${
      key === "notes"
        ? html`<textarea
            id="${prefix}-${key}"
            rows="4"
            maxlength="16000"
            .value=${draft.fields.notes}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLTextAreaElement) {
                updateDraft(controller, draft, key, event.currentTarget.value);
              }
            }}
          ></textarea>`
        : html`<input
            id="${prefix}-${key}"
            type="${type}"
            ?required=${key === "title" || (key === "url" && kind === "read-later")}
            maxlength="${max ?? 200}"
            .value=${draft.fields[key] ?? ""}
            pattern="${key === "currency" ? "[A-Z]{3}" : ".*"}"
            @input=${(event: Event) => {
              if (!(event.currentTarget instanceof HTMLInputElement)) {
                return;
              }
              const value = event.currentTarget.value;
              updateDraft(
                controller,
                draft,
                key,
                key === "dueDate" || key === "sourceDate" || key === "url" || key === "currency"
                  ? value || null
                  : value,
              );
            }}
          />`
    }
  </label>`;
  const numberField = (key: "quantity" | "estimate", label: string) => html` <label
    class="spaces-field"
    for="${prefix}-${key}"
    >${label}
    <input
      id="${prefix}-${key}"
      type="number"
      min="${key === "quantity" ? "0.000000001" : "0"}"
      max="${key === "quantity" ? "1000000000" : "1000000000000"}"
      step="any"
      .value=${draft.fields[key]?.toString() ?? ""}
      @input=${(event: Event) => {
        const input = event.currentTarget;
        if (!(input instanceof HTMLInputElement)) {
          return;
        }
        updateDraft(controller, draft, key, input.value === "" ? null : input.valueAsNumber);
      }}
    />
  </label>`;
  const statuses: Array<[ItemFields["status"], string]> =
    kind === "read-later"
      ? [
          ["open", "Unread"],
          ["read", "Read"],
          ["archived", "Archived"],
        ]
      : kind === "vacation"
        ? [
            ["open", "Candidate"],
            ["selected", "Selected"],
            ["archived", "Archived"],
          ]
        : [
            ["open", "Open"],
            ["done", "Complete"],
          ];
  return html` <section
    class="spaces-editor"
    aria-label="${id?.startsWith("new:") ? "New item" : "Edit item"}"
  >
    <h2>${id?.startsWith("new:") ? "Add item" : "Edit item"}</h2>
    <form
      @submit=${(event: Event) => {
        event.preventDefault();
        void controller.saveItem();
      }}
    >
      <fieldset
        ?disabled=${(controller.host.connection.connected && !controller.host.connection.canWrite) || controller.saving || Boolean(controller.uncertain)}
      >
        ${field("title", "Title")}
        <label class="spaces-field" for="${prefix}-status"
          >Status
          <select
            id="${prefix}-status"
            aria-label="Status"
            .value=${draft.fields.status}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                const status = itemFieldsSchema.shape.status.safeParse(event.currentTarget.value);
                if (status.success) {
                  updateDraft(controller, draft, "status", status.data);
                }
              }
            }}
          >
            ${statuses.map(([value, label]) => html`<option value="${value}">${label}</option>`)}
          </select>
        </label>
        ${kind === "shopping" ? html`<div class="spaces-form-grid">${numberField("quantity", "Quantity")}${field("unit", "Unit", "text", 80)}</div>` : nothing}
        ${field("category", "Category", "text", 120)}
        ${kind === "todo" ? field("dueDate", "Due date", "date") : nothing}
        ${field("url", "Source link", "url", 2048)}
        ${
          kind === "vacation"
            ? html` <div class="spaces-form-grid">
                  ${numberField("estimate", "Estimate")}${field("currency", "Currency (for example, USD)", "text", 3)}
                </div>
                ${field("sourceDate", "Estimate / source date", "date")}`
            : nothing
        }
        <label class="spaces-field" for="${prefix}-parent"
          >Checklist parent
          <select
            id="${prefix}-parent"
            aria-label="Checklist parent"
            .value=${draft.fields.parentId ?? ""}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                updateDraft(controller, draft, "parentId", event.currentTarget.value || null);
              }
            }}
          >
            <option value="">None</option>
            ${controller.items.filter((item) => item.id !== id && !item.deletedAt).map((item) => html`<option value="${item.id}">${item.title}</option>`)}
            ${
              draft.fields.parentId &&
              !controller.items.some((item) => item.id === draft.fields.parentId)
                ? html`<option value="${draft.fields.parentId}">
                    Current parent (outside this view)
                  </option>`
                : nothing
            }
          </select>
        </label>
        ${field("notes", "Notes")}
        ${draft.conflict ? renderConflict(controller, draft, current?.revision) : nothing}
        <div class="spaces-actions">
          <button
            class="spaces-primary"
            type="submit"
            ?disabled=${!controller.writable || draft.conflict}
          >
            ${controller.saving ? "Saving…" : "Save item"}
          </button>
          <button
            type="button"
            @click=${() => {
              controller.itemEditorId = null;
              controller.notify();
            }}
          >
            Close
          </button>
        </div>
      </fieldset>
    </form>
  </section>`;
}

function updateDraft<T, K extends keyof T>(
  controller: SpacesController,
  draft: Draft<T>,
  key: K,
  value: T[K],
) {
  draft.fields[key] = value;
  draft.dirty = true;
  controller.notify();
}

function renderConflict<T>(controller: SpacesController, draft: Draft<T>, revision?: number) {
  return html` <div class="spaces-conflict" role="alert">
    <strong>The saved version changed. Your draft is kept.</strong>
    <p>
      Review the current version below. Keep your draft and use its current revision only when you
      are ready to overwrite it.
    </p>
    <button
      type="button"
      ?disabled=${revision === undefined || !controller.writable}
      @click=${() => {
        if (revision !== undefined) {
          draft.revision = revision;
          draft.conflict = false;
          controller.notify();
        }
      }}
    >
      Keep draft, use current revision
    </button>
  </div>`;
}

export function renderCurrentItem(item: Item) {
  return html`<dl class="spaces-facts">
    <dt>Status</dt>
    <dd>${item.status}</dd>
    ${
      item.quantity !== null
        ? html`<dt>Quantity</dt>
            <dd>${item.quantity} ${item.unit}</dd>`
        : nothing
    }
    ${
      item.category
        ? html`<dt>Category</dt>
            <dd>${item.category}</dd>`
        : nothing
    }
    ${
      item.dueDate
        ? html`<dt>Due</dt>
            <dd>${item.dueDate}</dd>`
        : nothing
    }
    ${
      item.estimate !== null
        ? html`<dt>Estimate</dt>
            <dd>${item.currency ?? ""} ${item.estimate}</dd>`
        : nothing
    }
    ${
      item.sourceDate
        ? html`<dt>Source date</dt>
            <dd>${item.sourceDate}</dd>`
        : nothing
    }
    <dt>Revision</dt>
    <dd>${item.revision}</dd>
  </dl>`;
}
