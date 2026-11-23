import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

/** A host-owned, invocation-bound view of one member's encrypted memory files. */
export type MemberMemoryReadFiles = {
  assertCurrent(): void;
  list(directory: string): Promise<string[]>;
  stat(path: string): Promise<
    | {
        isDirectory: boolean;
        isFile: boolean;
        mtimeMs: number;
        size: number;
      }
    | undefined
  >;
  read(path: string): Promise<string | undefined>;
};

export type MemberMemoryFiles = MemberMemoryReadFiles & {
  append(path: string, text: string): Promise<void>;
};

/** Identity and file authority are supplied by the authenticated host, not tool arguments. */
export type MemberMemoryBinding = {
  audience: Extract<
    NonNullable<OpenClawPluginToolContext["memoryAudience"]>,
    { kind: "member-private" }
  >;
  memberKey: string;
  workspaceGeneration: string;
  files: MemberMemoryFiles;
};

export function isMemberMemoryBinding(value: unknown): value is MemberMemoryBinding {
  if (!value || typeof value !== "object") {
    return false;
  }
  const binding = value as Partial<MemberMemoryBinding>;
  const files = binding.files;
  return (
    binding.audience?.kind === "member-private" &&
    typeof binding.memberKey === "string" &&
    binding.memberKey.length > 0 &&
    typeof binding.workspaceGeneration === "string" &&
    binding.workspaceGeneration.length > 0 &&
    typeof files?.assertCurrent === "function" &&
    typeof files.list === "function" &&
    typeof files.stat === "function" &&
    typeof files.read === "function" &&
    typeof files.append === "function"
  );
}
