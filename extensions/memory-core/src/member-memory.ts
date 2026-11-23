import { buildMemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemberMemoryBinding, MemberMemoryReadFiles } from "./member-memory-binding.js";
import type { EphemeralMemoryFile } from "./memory/manager-ephemeral-task.js";
import { EphemeralMemoryIndexes } from "./memory/manager-ephemeral.js";
import type { MemoryIndexPreparationInput } from "./memory/manager-index-preparation.js";

const MAX_ENTRIES = 10_000;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
let indexes = new EphemeralMemoryIndexes();

type MemberNote = { path: string; mtimeMs: number; size: number };

function isMemoryNote(path: string): boolean {
  const parts = path.split("/");
  return (
    !path.includes("\\") &&
    !parts.some((part) => !part || part === "." || part === "..") &&
    path.endsWith(".md") &&
    (path === "MEMORY.md" ||
      path === "memory.md" ||
      path === "USER.md" ||
      (parts[0] === "memory" && parts.length > 1))
  );
}

async function listNotes(files: MemberMemoryReadFiles): Promise<MemberNote[]> {
  const notes: MemberNote[] = [];
  let entries = 0;
  const inspect = async (path: string) => {
    if (++entries > MAX_ENTRIES) {
      throw new Error("Member memory exceeds its catalog capacity.");
    }
    const info = await files.stat(path);
    if (!info) {
      throw new Error("Member memory changed during catalog preparation.");
    }
    return info;
  };
  const root = await files.list("");
  for (const name of ["MEMORY.md", "memory.md", "USER.md"]) {
    if (root.includes(name)) {
      const info = await inspect(name);
      if (info.isFile) {
        notes.push({ path: name, mtimeMs: info.mtimeMs, size: info.size });
      }
    }
  }
  if (root.includes("memory")) {
    const rootInfo = await inspect("memory");
    if (!rootInfo.isDirectory) {
      throw new Error("Member memory directory is unavailable.");
    }
    const directories = ["memory"];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const name of (await files.list(directory)).toSorted()) {
        const path = `${directory}/${name}`;
        const info = await inspect(path);
        if (info.isDirectory && name !== ".openclaw-repair") {
          directories.push(path);
        } else if (info.isFile && isMemoryNote(path)) {
          notes.push({ path, mtimeMs: info.mtimeMs, size: info.size });
        }
      }
    }
  }
  return notes.toSorted((a, b) => a.path.localeCompare(b.path));
}

async function snapshotNotes(files: MemberMemoryReadFiles): Promise<EphemeralMemoryFile[]> {
  const notes = await listNotes(files);
  const snapshot: EphemeralMemoryFile[] = [];
  let bytes = 0;
  for (const note of notes) {
    bytes += note.size;
    if (bytes > MAX_SOURCE_BYTES) {
      throw new Error("Member memory exceeds its index capacity.");
    }
    const content = await files.read(note.path);
    if (content === undefined) {
      throw new Error("Member memory changed during index preparation.");
    }
    snapshot.push({ path: note.path, content, mtimeMs: note.mtimeMs, originClass: "agent" });
  }
  return snapshot;
}

/** Read the same canonical notes used to prepare member search indexes. */
export function createMemberMemoryNoteReader(files: MemberMemoryReadFiles) {
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    files.assertCurrent();
    const result = await operation();
    files.assertCurrent();
    return result;
  };
  const readNote = async (path: string) => {
    if (!isMemoryNote(path)) {
      throw new Error("Path is not an allowed member memory note.");
    }
    return await files.read(path);
  };
  return {
    list: () => run(() => listNotes(files)),
    readFull: (path: string) => run(() => readNote(path)),
    read: (path: string, from = 1, lines = 120) =>
      run(async () => {
        const content = await readNote(path);
        if (content === undefined) {
          return { status: "not_found" as const, text: "", path };
        }
        return buildMemoryReadResult({ content, relPath: path, from, lines });
      }),
  };
}

/** Open a caller-bound lease on Memory Core's member-owned notes and derived index. */
export async function openMemberMemory(
  binding: MemberMemoryBinding,
  audience: MemberMemoryBinding["audience"],
  assertAudienceCurrent: () => void,
  chunking: MemoryIndexPreparationInput["chunking"],
) {
  const assertCurrent = () => {
    if (binding.audience !== audience) {
      throw new Error("Member memory binding belongs to another audience.");
    }
    assertAudienceCurrent();
    binding.files.assertCurrent();
  };
  const index = await indexes.acquire({
    memberKey: binding.memberKey,
    workspaceGeneration: binding.workspaceGeneration,
    assertCurrent,
  });
  const notes = createMemberMemoryNoteReader(binding.files);
  return {
    list: () => index.run(notes.list),
    read: (path: string, from = 1, lines = 120) => index.run(() => notes.read(path, from, lines)),
    search: (query: string, limit: number) =>
      index.run(async () => {
        if (index.isDirty(chunking)) {
          await index.rebuild(await snapshotNotes(binding.files), chunking);
        }
        return await index.search(query, limit);
      }),
    append: (path: string, content: string) =>
      index.run(async () => {
        if (!/^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(path)) {
          throw new Error("Member memory can only append to a daily note.");
        }
        const normalized = content.trim().replace(/\s+/gu, " ").toLowerCase();
        for (const note of await snapshotNotes(binding.files)) {
          if (
            note.content
              .split(/\r?\n/u)
              .some((line) => line.trim().replace(/\s+/gu, " ").toLowerCase() === normalized)
          ) {
            return false;
          }
        }
        index.markDirty();
        await binding.files.append(path, content);
        return true;
      }),
    release: index.release,
  };
}

export async function retireMemberMemory(memberKey: string): Promise<void> {
  await indexes.retire(memberKey);
}

/** Serialize external file mutations with member searches and writes. */
export async function mutateMemberMemory<T>(
  access: { memberKey: string; workspaceGeneration: string; assertCurrent: () => void },
  operation: () => Promise<T>,
): Promise<T> {
  const index = await indexes.acquire(access);
  try {
    return await index.run(async () => {
      index.markDirty();
      return await operation();
    });
  } finally {
    await index.release();
  }
}

export async function closeMemberMemory(): Promise<void> {
  const retiring = indexes;
  await retiring.close();
  if (indexes === retiring) {
    indexes = new EphemeralMemoryIndexes();
  }
}
