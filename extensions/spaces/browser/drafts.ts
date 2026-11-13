import type { Edit, ItemFields, SpaceFields } from "../src/contracts.js";

export const newSpaceDraftId = "new:space";

export type Draft<T> = {
  fields: T;
  revision: number;
  dirty: boolean;
  conflict: boolean;
};

export type SpacesDraftState = {
  spaceDrafts: Map<string, Draft<SpaceFields>>;
  itemDrafts: Map<string, Draft<ItemFields>>;
  spaceId: string;
  spaceEditorId: string | null;
  itemEditorId: string | null;
  selectedItemId: string | null;
  uncertain: Edit | null;
  importText: string;
  importOpen: boolean;
  importVersion: number;
  importSubmission: { operationId: string; spaceId: string; version: number } | null;
};
