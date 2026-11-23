import type { MemberMemoryFiles, MemberMemoryReadFiles } from "../../extensions/memory-core/api.js";
import type { AuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import type { StorageFiles } from "./capacity.js";

const root = "member-memory";

/** Restrict a member's authorized files to the virtual memory workspace. */
export function createMemberMemoryReadFiles(files: AuthorizedUserFiles): MemberMemoryReadFiles {
  const scoped = (name: string) => (name ? `${root}/${name}` : root);
  const missing = (error: unknown) => {
    files.assertCurrent();
    if (error instanceof FsSafeError && error.code === "not-found") {
      return true;
    }
    throw error;
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    files.assertCurrent();
    const result = await operation();
    files.assertCurrent();
    return result;
  };
  return {
    assertCurrent: files.assertCurrent,
    async list(directory) {
      try {
        return await run(() => files.list(scoped(directory)));
      } catch (error) {
        if (missing(error)) {
          return [];
        }
        throw error;
      }
    },
    async stat(path) {
      try {
        const { isDirectory, isFile, mtimeMs, size } = await run(() => files.stat(scoped(path)));
        return { isDirectory, isFile, mtimeMs, size };
      } catch (error) {
        if (missing(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async read(path) {
      try {
        return await run(() => files.readText(scoped(path)));
      } catch (error) {
        if (missing(error)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

export function createMemberMemoryFiles(files: StorageFiles): MemberMemoryFiles {
  return {
    ...createMemberMemoryReadFiles(files),
    async append(path, text) {
      files.assertCurrent();
      await files.updateText(`${root}/${path}`, (current) => `${current ?? ""}${text}`);
      files.assertCurrent();
    },
  };
}
