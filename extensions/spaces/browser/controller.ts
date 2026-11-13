import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { editSchema } from "../src/contracts.js";
import type {
  Edit,
  EditResult,
  HistoryEntry,
  Item,
  ItemFields,
  Query,
  QueryResult,
  Space,
  SpaceFields,
} from "../src/contracts.js";
import { newSpaceDraftId, type Draft, type SpacesDraftState } from "./drafts.ts";

export const kindLabels: Record<SpaceFields["kind"], string> = {
  todo: "To-do",
  shopping: "Shopping",
  "read-later": "Read Later",
  vacation: "Vacation",
};

function newItemFields(): ItemFields {
  return {
    title: "",
    notes: "",
    status: "open",
    quantity: null,
    unit: "",
    category: "",
    dueDate: null,
    url: null,
    sourceDate: null,
    estimate: null,
    currency: null,
    parentId: null,
  };
}

export class SpacesController {
  spaceId = "";
  spaces: Space[] = [];
  space: Space | undefined;
  items: Item[] = [];
  history: HistoryEntry[] = [];
  historyNextOffset: number | null = null;
  historyLoading = false;
  selectedItemId: string | null = null;
  search = "";
  trash = false;
  historyOpen = false;
  loading = false;
  saving = false;
  error = "";
  notice = "";
  nextOffset: number | null = null;
  total = 0;
  spaceEditorId: string | null = null;
  itemEditorId: string | null = null;
  readonly spaceDrafts: Map<string, Draft<SpaceFields>>;
  readonly itemDrafts: Map<string, Draft<ItemFields>>;
  importText = "";
  importItems: Extract<Edit, { action: "read-later.import" }>["items"] = [];
  preview: NonNullable<QueryResult["preview"]> | null = null;
  importOpen = false;
  duplicates: "skip" | "reject" = "skip";
  combineSourceId = "";
  uncertain: Edit | null = null;
  private generation = 0;
  private connectionGeneration = 0;
  private connected: boolean;
  private canRead: boolean;
  private canWrite: boolean;
  private selectionInitialized = false;
  private activeEdit: Edit | null = null;
  private importVersion = 0;
  private importSubmission: SpacesDraftState["importSubmission"] = null;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void>;

  constructor(
    readonly host: ControlUiHost,
    private retained?: SpacesDraftState,
  ) {
    this.spaceDrafts = retained?.spaceDrafts ?? new Map();
    this.itemDrafts = retained?.itemDrafts ?? new Map();
    this.uncertain = retained?.uncertain ?? null;
    this.importSubmission = retained?.importSubmission ?? null;
    this.connected = host.connection.connected;
    this.canRead = host.connection.canRead;
    this.canWrite = host.connection.canWrite;
    this.disposers = [
      host.subscribe(() => {
        const changed =
          this.connected !== host.connection.connected ||
          this.canRead !== host.connection.canRead ||
          this.canWrite !== host.connection.canWrite;
        this.connected = host.connection.connected;
        this.canRead = host.connection.canRead;
        this.canWrite = host.connection.canWrite;
        if (changed) {
          this.generation += 1;
          this.connectionGeneration += 1;
          this.loading = false;
          if (this.connected && this.canRead) {
            void this.refresh();
          } else {
            if (this.connected) {
              this.spaces = [];
              this.space = undefined;
              this.items = [];
              this.history = [];
              this.historyNextOffset = null;
            }
            this.notify();
          }
        } else {
          this.notify();
        }
      }),
      host.onEvent("spaces.changed", (payload) => {
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("spaceId" in payload) ||
          !("metadata" in payload)
        ) {
          return;
        }
        if (!this.spaceId || payload.spaceId === this.spaceId || payload.metadata === true) {
          void this.refresh();
        }
      }),
    ];
  }

  get writable() {
    return (
      this.host.connection.connected &&
      this.host.connection.canRead &&
      this.host.connection.canWrite &&
      !this.saving &&
      !this.uncertain
    );
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    if (!this.disposed) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  private message(error: unknown) {
    return this.host.redact(error instanceof Error ? error.message : String(error));
  }

  query(query: Query) {
    return this.host.request<QueryResult>("spaces.query", query);
  }

  selectSpace(spaceId: string) {
    if (this.selectionInitialized && this.spaceId === spaceId) {
      return;
    }
    this.selectionInitialized = true;
    this.generation += 1;
    this.importVersion += 1;
    this.spaceId = spaceId;
    this.space = undefined;
    this.spaces = [];
    this.items = [];
    this.history = [];
    this.selectedItemId = null;
    this.spaceEditorId = null;
    this.itemEditorId = null;
    this.search = "";
    this.trash = false;
    this.historyOpen = false;
    this.importOpen = false;
    this.preview = null;
    this.error = this.uncertain
      ? "Save not confirmed. Your draft is kept. Check save before editing again."
      : "";
    this.notice = "";
    if (this.retained?.spaceId === spaceId) {
      this.spaceEditorId = this.retained.spaceEditorId;
      this.itemEditorId = this.retained.itemEditorId;
      this.selectedItemId = this.retained.selectedItemId;
      this.importText = this.retained.importText;
      this.importOpen = this.retained.importOpen;
      this.importVersion = this.retained.importVersion;
      this.retained = undefined;
    }
    void this.refresh();
  }

  async refresh(append = false) {
    const generation = ++this.generation;
    if (this.disposed || !this.host.connection.connected || !this.host.connection.canRead) {
      return;
    }
    this.loading = true;
    this.notify();
    const offset = append ? (this.nextOffset ?? 0) : 0;
    try {
      const result = await this.query(
        this.spaceId
          ? {
              action: "space.read",
              spaceId: this.spaceId,
              search: this.search,
              trash: this.trash,
              offset,
              limit: 40,
            }
          : { action: "spaces.list", search: this.search, trash: this.trash, offset, limit: 40 },
      );
      if (generation !== this.generation || this.disposed) {
        return;
      }
      this.space = result.space;
      this.spaces = append ? [...this.spaces, ...(result.spaces ?? [])] : (result.spaces ?? []);
      this.items = append ? [...this.items, ...(result.items ?? [])] : (result.items ?? []);
      this.nextOffset = result.nextOffset ?? null;
      this.total = result.total ?? 0;
      if (this.spaceId && !result.space) {
        this.error = "This Space is unavailable. Return to Spaces or refresh.";
      } else if (
        this.error.startsWith("Could not load Spaces.") ||
        this.error.startsWith("This Space is unavailable.")
      ) {
        this.error = "";
      }
      this.reconcileDrafts();
      if (this.historyOpen && this.spaceId) {
        const history = await this.query({
          action: "history",
          spaceId: this.spaceId,
          offset: 0,
          limit: 100,
        });
        if (generation !== this.generation || this.disposed) {
          return;
        }
        this.history = history.history ?? [];
        this.historyNextOffset = history.nextOffset ?? null;
      }
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.error = `Could not load Spaces. ${this.message(error)} Refresh to try again.`;
      }
    } finally {
      if (generation === this.generation && !this.disposed) {
        this.loading = false;
        this.notify();
      }
    }
  }

  private reconcileDrafts() {
    for (const record of [...this.spaces, ...(this.space ? [this.space] : [])]) {
      const draft = this.spaceDrafts.get(record.id);
      if (draft && draft.revision !== record.revision) {
        if (draft.dirty) {
          draft.conflict = true;
        } else {
          this.spaceDrafts.set(record.id, {
            fields: this.spaceFields(record),
            revision: record.revision,
            dirty: false,
            conflict: false,
          });
        }
      }
    }
    for (const item of this.items) {
      const draft = this.itemDrafts.get(item.id);
      if (draft && draft.revision !== item.revision) {
        if (draft.dirty) {
          draft.conflict = true;
        } else {
          this.itemDrafts.set(item.id, {
            fields: this.itemFields(item),
            revision: item.revision,
            dirty: false,
            conflict: false,
          });
        }
      }
    }
  }

  async loadMoreHistory() {
    if (
      this.historyNextOffset === null ||
      this.historyLoading ||
      !this.host.connection.connected ||
      !this.host.connection.canRead
    ) {
      return;
    }
    const generation = this.generation;
    this.historyLoading = true;
    this.notify();
    try {
      const result = await this.query({
        action: "history",
        spaceId: this.spaceId,
        offset: this.historyNextOffset,
        limit: 100,
      });
      if (generation === this.generation && !this.disposed) {
        this.history = [...this.history, ...(result.history ?? [])];
        this.historyNextOffset = result.nextOffset ?? null;
      }
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.error = `Could not load history. ${this.message(error)} Try again.`;
      }
    } finally {
      this.historyLoading = false;
      this.notify();
    }
  }

  private spaceFields(space: Space): SpaceFields {
    return {
      name: space.name,
      description: space.description,
      rules: space.rules,
      kind: space.kind,
    };
  }

  private itemFields(item: Item): ItemFields {
    const {
      id: _id,
      spaceId: _spaceId,
      revision: _revision,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      deletedAt: _deletedAt,
      ...fields
    } = item;
    return fields;
  }

  editSpace(space?: Space) {
    const id = space?.id ?? newSpaceDraftId;
    if (!this.spaceDrafts.has(id)) {
      this.spaceDrafts.set(id, {
        fields: space
          ? this.spaceFields(space)
          : { name: "", description: "", rules: "", kind: "todo" },
        revision: space?.revision ?? 0,
        dirty: false,
        conflict: false,
      });
    }
    this.spaceEditorId = id;
    this.notify();
  }

  editItem(item?: Item, parentId: string | null = null) {
    const id = item?.id ?? `new:${this.spaceId}`;
    if (!this.itemDrafts.has(id)) {
      this.itemDrafts.set(id, {
        fields: item ? this.itemFields(item) : { ...newItemFields(), parentId },
        revision: item?.revision ?? 0,
        dirty: false,
        conflict: false,
      });
    }
    this.itemEditorId = id;
    this.selectedItemId = item?.id ?? null;
    this.notify();
  }

  async saveSpace() {
    const id = this.spaceEditorId;
    const spaceId = this.spaceId;
    const draft = id ? this.spaceDrafts.get(id) : undefined;
    if (!id || !draft || draft.conflict) {
      return;
    }
    const result = await this.mutate({
      action: id === newSpaceDraftId ? "space.create" : "space.update",
      operationId: crypto.randomUUID(),
      spaceId: id === newSpaceDraftId ? crypto.randomUUID() : id,
      expectedRevision: draft.revision,
      fields: { ...draft.fields },
    });
    if (result?.status === "applied") {
      this.spaceDrafts.delete(id);
      if (this.spaceId === spaceId && this.spaceEditorId === id) {
        this.spaceEditorId = null;
        if (result.space && id === newSpaceDraftId) {
          this.host.navigation.openPage({ id: "spaces", params: { spaceId: result.space.id } });
        }
      }
      this.notify();
    }
  }

  async saveItem() {
    const id = this.itemEditorId;
    const draft = id ? this.itemDrafts.get(id) : undefined;
    if (!id || !draft || draft.conflict) {
      return;
    }
    const result = await this.mutate({
      action: id.startsWith("new:") ? "item.create" : "item.update",
      operationId: crypto.randomUUID(),
      spaceId: this.spaceId,
      itemId: id.startsWith("new:") ? crypto.randomUUID() : id,
      expectedRevision: draft.revision,
      fields: { ...draft.fields },
    });
    if (result?.status === "applied") {
      this.itemDrafts.delete(id);
      if (this.itemEditorId === id) {
        this.itemEditorId = null;
        this.selectedItemId = result.item?.id ?? this.selectedItemId;
      }
      this.notify();
    }
  }

  async mutate(edit: Edit): Promise<EditResult | undefined> {
    if (!this.writable) {
      this.error = "Cannot save now. Reconnect with write access; your draft is kept.";
      this.notify();
      return undefined;
    }
    const validated = editSchema.safeParse(edit);
    if (!validated.success) {
      this.error = `Cannot save. ${validated.error.issues.map((issue) => issue.message).join(" ")} Your draft is kept.`;
      this.notify();
      return undefined;
    }
    const validatedEdit = validated.data;
    this.saving = true;
    this.activeEdit = validatedEdit;
    this.error = "";
    this.notice = "";
    const spaceId = this.spaceId;
    const connectionGeneration = this.connectionGeneration;
    this.notify();
    try {
      const result = await this.host.request<EditResult>("spaces.edit", validatedEdit);
      if (this.disposed) {
        return undefined;
      }
      if (connectionGeneration !== this.connectionGeneration) {
        this.uncertain = validatedEdit;
        this.error =
          "Connection changed during save. Your draft is kept. Check save before editing again.";
        return undefined;
      }
      if (spaceId === this.spaceId) {
        this.acceptResult(result, validatedEdit);
        await this.refresh();
      }
      return result;
    } catch (error) {
      if (!this.disposed) {
        this.uncertain = validatedEdit;
        this.error = `Save not confirmed. Your draft is kept. ${this.message(error)} Check save before editing again.`;
      }
      return undefined;
    } finally {
      this.saving = false;
      this.activeEdit = null;
      this.notify();
    }
  }

  private acceptResult(result: EditResult, edit: Edit) {
    if (result.status === "applied") {
      this.notice =
        result.imported !== undefined
          ? `Saved ${result.imported} links. Skipped ${result.skipped ?? 0} duplicates.`
          : "Saved.";
      this.error = "";
    } else {
      this.error = this.host.redact(result.message) || "Could not save. Your draft is kept.";
      if (result.status === "conflict") {
        const draft =
          "itemId" in edit ? this.itemDrafts.get(edit.itemId) : this.spaceDrafts.get(edit.spaceId);
        if (draft) {
          draft.conflict = true;
        }
      }
    }
  }

  async checkSave() {
    const edit = this.uncertain;
    if (!edit || !this.host.connection.connected || !this.host.connection.canWrite || this.saving) {
      return;
    }
    this.saving = true;
    const connectionGeneration = this.connectionGeneration;
    this.notify();
    try {
      const lookup = await this.query({ action: "operation", operationId: edit.operationId });
      if (
        this.disposed ||
        connectionGeneration !== this.connectionGeneration ||
        !this.host.connection.connected ||
        !this.host.connection.canWrite
      ) {
        return;
      }
      const result = lookup.operation ?? (await this.host.request<EditResult>("spaces.edit", edit));
      if (this.disposed || connectionGeneration !== this.connectionGeneration) {
        return;
      }
      this.uncertain = null;
      this.acceptResult(result, edit);
      if (result.status === "applied") {
        if (edit.action === "item.create" || edit.action === "item.update") {
          this.itemDrafts.delete(
            edit.action === "item.create" ? `new:${edit.spaceId}` : edit.itemId,
          );
          if (this.itemEditorId === edit.itemId || this.itemEditorId === `new:${edit.spaceId}`) {
            this.itemEditorId = null;
          }
        } else if (edit.action === "space.create" || edit.action === "space.update") {
          this.spaceDrafts.delete(edit.action === "space.create" ? newSpaceDraftId : edit.spaceId);
          if (
            this.spaceEditorId === edit.spaceId ||
            (edit.action === "space.create" && this.spaceEditorId === newSpaceDraftId)
          ) {
            this.spaceEditorId = null;
          }
        }
      }
      this.settleImport(edit, result);
      await this.refresh();
    } catch (error) {
      this.error = `Save still not confirmed. ${this.message(error)} Your draft is kept.`;
    } finally {
      this.saving = false;
      this.notify();
    }
  }

  changeImportText(text: string) {
    this.importText = text;
    this.importVersion += 1;
    this.preview = null;
    this.notify();
  }

  async saveImport() {
    if (!this.space || !this.writable) {
      return;
    }
    const edit: Edit = {
      action: "read-later.import",
      operationId: crypto.randomUUID(),
      spaceId: this.spaceId,
      expectedRevision: this.space.revision,
      items: this.importItems,
      duplicates: this.duplicates,
    };
    this.importSubmission = {
      operationId: edit.operationId,
      spaceId: edit.spaceId,
      version: this.importVersion,
    };
    const result = await this.mutate(edit);
    if (result) {
      this.settleImport(edit, result);
    } else if (this.uncertain?.operationId !== edit.operationId) {
      this.importSubmission = null;
    }
    this.notify();
  }

  private settleImport(edit: Edit, result: EditResult) {
    const submission = this.importSubmission;
    if (edit.action !== "read-later.import" || submission?.operationId !== edit.operationId) {
      return;
    }
    if (
      result.status === "applied" &&
      submission.spaceId === this.spaceId &&
      submission.version === this.importVersion
    ) {
      this.importText = "";
      this.importVersion += 1;
      this.importItems = [];
      this.preview = null;
      this.importOpen = false;
    }
    this.importSubmission = null;
  }

  async previewImport() {
    if (!this.space || this.space.kind !== "read-later") {
      return;
    }
    const spaceId = this.spaceId;
    const text = this.importText;
    const connectionGeneration = this.connectionGeneration;
    try {
      const rows = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (rows.length < 1 || rows.length > 100) {
        throw new Error("Enter between 1 and 100 links, one per line.");
      }
      const items = rows.map((url) => ({
        id: crypto.randomUUID(),
        title: url.slice(0, 200),
        url,
        notes: "",
      }));
      const result = await this.query({ action: "read-later.preview", spaceId, items });
      if (
        this.disposed ||
        connectionGeneration !== this.connectionGeneration ||
        spaceId !== this.spaceId ||
        text !== this.importText
      ) {
        return;
      }
      this.importItems = items;
      this.preview = result.preview ?? [];
      this.error = "";
    } catch (error) {
      if (
        connectionGeneration === this.connectionGeneration &&
        spaceId === this.spaceId &&
        text === this.importText
      ) {
        this.error = this.message(error);
      }
    }
    this.notify();
  }

  async undo(entry: HistoryEntry) {
    if (!this.writable) {
      return;
    }
    const spaceId = this.spaceId;
    const connectionGeneration = this.connectionGeneration;
    try {
      let record: Space | Item | undefined;
      // Undo targets the current record, including items outside the visible search/page.
      for (const trash of [false, true]) {
        let offset: number | null = 0;
        while (offset !== null && !record) {
          const result = await this.query({
            action: "space.read",
            spaceId: entry.spaceId,
            offset,
            limit: 100,
            search: "",
            trash,
          });
          record = entry.itemId
            ? result.items?.find((item) => item.id === entry.itemId)
            : result.space;
          offset = result.nextOffset ?? null;
        }
        if (record) {
          break;
        }
      }
      if (
        this.disposed ||
        connectionGeneration !== this.connectionGeneration ||
        spaceId !== this.spaceId
      ) {
        return;
      }
      if (!record) {
        throw new Error("The record is no longer available to undo.");
      }
      await this.mutate({
        action: "undo",
        operationId: crypto.randomUUID(),
        spaceId: entry.spaceId,
        historyId: entry.id,
        expectedRevision: record.revision,
      });
    } catch (error) {
      this.error = this.message(error);
      this.notify();
    }
  }

  dispose(): SpacesDraftState {
    const drafts: SpacesDraftState = {
      spaceDrafts: this.spaceDrafts,
      itemDrafts: this.itemDrafts,
      spaceId: this.spaceId,
      spaceEditorId: this.spaceEditorId,
      itemEditorId: this.itemEditorId,
      selectedItemId: this.selectedItemId,
      uncertain: this.uncertain ?? this.activeEdit,
      importText: this.importText,
      importOpen: this.importOpen,
      importVersion: this.importVersion,
      importSubmission: this.importSubmission,
    };
    this.disposed = true;
    this.generation += 1;
    for (const dispose of this.disposers) {
      dispose();
    }
    this.listeners.clear();
    return drafts;
  }
}
