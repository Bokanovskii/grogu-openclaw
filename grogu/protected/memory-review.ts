import { createHmac, randomBytes } from "node:crypto";
import type {
  ProtectedMemoryListResponse,
  ProtectedMemoryNote,
  ProtectedMemoryReadResponse,
} from "@openclaw/gateway-protocol/protected";
import { createMemberMemoryNoteReader } from "../../extensions/memory-core/api.js";
import type { AuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { createMemberMemoryReadFiles } from "./memory-files.js";

/** Project Memory Core's canonical member notes into request-scoped opaque references. */
export function createProtectedMemoryReview() {
  const key = randomBytes(32);
  const id = (profileId: string, path: string) =>
    createHmac("sha256", key).update(profileId).update("\0").update(path).digest("base64url");
  const revision = (profileId: string, path: string, content: Buffer) =>
    createHmac("sha256", key)
      .update("revision\0")
      .update(profileId)
      .update("\0")
      .update(path)
      .update("\0")
      .update(content)
      .digest("base64url");
  const open = (profileId: string, files: AuthorizedUserFiles) => {
    const reader = createMemberMemoryNoteReader(createMemberMemoryReadFiles(files));
    const list = async () => {
      const entries = await reader.list();
      return entries.map((entry) => ({
        id: id(profileId, entry.path),
        name: entry.path,
        bytes: entry.size,
        updatedAt: Math.max(0, Math.floor(entry.mtimeMs)),
      })) satisfies ProtectedMemoryNote[];
    };
    return {
      async list(): Promise<ProtectedMemoryListResponse> {
        return { notes: await list() };
      },
      async read(
        reference: string,
        includeRevision = false,
      ): Promise<ProtectedMemoryReadResponse | undefined> {
        const note = (await list()).find((entry) => entry.id === reference);
        if (!note) {
          return undefined;
        }
        const content = await files.read(`member-memory/${note.name}`);
        return {
          note,
          text: content.toString("utf8"),
          ...(includeRevision ? { revision: revision(profileId, note.name, content) } : {}),
        };
      },
      async remove(
        reference: string,
        expectedRevision: string,
        removeIfMatches: (path: string, content: Buffer) => Promise<boolean>,
      ): Promise<"missing" | "changed" | "deleted"> {
        const note = (await list()).find((entry) => entry.id === reference);
        if (!note) {
          return "missing";
        }
        const content = await files.read(`member-memory/${note.name}`);
        if (revision(profileId, note.name, content) !== expectedRevision) {
          return "changed";
        }
        return (await removeIfMatches(`member-memory/${note.name}`, content))
          ? "deleted"
          : "changed";
      },
    };
  };
  return { open };
}
