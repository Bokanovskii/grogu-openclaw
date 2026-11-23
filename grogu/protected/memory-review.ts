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
      async read(reference: string): Promise<ProtectedMemoryReadResponse | undefined> {
        const note = (await list()).find((entry) => entry.id === reference);
        if (!note) {
          return undefined;
        }
        const text = await reader.readFull(note.name);
        return text === undefined ? undefined : { note, text };
      },
    };
  };
  return { open };
}
