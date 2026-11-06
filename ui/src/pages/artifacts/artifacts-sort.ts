import type { AgentsWorkspaceEntry } from "../../../../packages/gateway-protocol/src/schema/agents-workspace.js";

export type ArtifactSortMode = "recent" | "name";

export function sortArtifactEntries(
  entries: readonly AgentsWorkspaceEntry[],
  mode: ArtifactSortMode,
): AgentsWorkspaceEntry[] {
  return entries.toSorted((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    if (mode === "recent") {
      const delta = (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0);
      if (delta !== 0) {
        return delta;
      }
    }
    return a.name.localeCompare(b.name);
  });
}

export function formatArtifactSize(size: number | undefined): string {
  if (size === undefined) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const kb = size / 1024;
  return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
