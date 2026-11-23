import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import type { MemoryIndexPreparationInput } from "./manager-index-preparation.js";
import type { searchKeyword } from "./manager-search.js";

export type EphemeralMemoryIdentity = {
  memberKey: string;
  workspaceGeneration: string;
  incarnation: string;
};

export type EphemeralMemoryFile = {
  path: string;
  content: string;
  mtimeMs: number;
  originClass: MemoryEntryProvenance["originClass"];
};

export type EphemeralMemoryTask =
  | { kind: "open"; identity: EphemeralMemoryIdentity }
  | {
      kind: "rebuild";
      identity: EphemeralMemoryIdentity;
      files: EphemeralMemoryFile[];
      chunking: MemoryIndexPreparationInput["chunking"];
    }
  | { kind: "search"; identity: EphemeralMemoryIdentity; query: string; limit: number };

export type EphemeralMemoryResult =
  | { kind: "open" }
  | { kind: "rebuild" }
  | { kind: "search"; rows: Awaited<ReturnType<typeof searchKeyword>> };
