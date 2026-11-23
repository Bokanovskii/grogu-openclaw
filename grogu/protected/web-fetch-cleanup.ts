import {
  forEachAuthorizedUserFiles,
  type AuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import type { StorageValueEncryption } from "../../src/storage/encryption.js";
import { chatArtifactsDirectory, chatFilesDirectory } from "./chat-files.js";

const chatIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const spillFilenamePattern =
  /^web-fetch-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.log$/u;

export type WebFetchCleanupAction = { kind: "file" | "directory"; path: string };

async function statIfPresent(files: AuthorizedUserFiles, name: string) {
  try {
    return await files.stat(name);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return undefined;
    }
    throw error;
  }
}

export async function cleanupProtectedWebFetchSpills(options: {
  usersRoot: Parameters<typeof forEachAuthorizedUserFiles>[0]["usersRoot"];
  assertCurrent: () => void;
  maxBytes: number;
  encryption: StorageValueEncryption;
  dryRun: boolean;
}): Promise<{
  actions: WebFetchCleanupAction[];
  filesRemoved: number;
  directoriesRemoved: number;
}> {
  const actions: WebFetchCleanupAction[] = [];
  let filesRemoved = 0;
  let directoriesRemoved = 0;
  await forEachAuthorizedUserFiles(
    {
      usersRoot: options.usersRoot,
      assertCurrent: options.assertCurrent,
      maxBytes: options.maxBytes,
      encryption: options.encryption,
    },
    async (files, userDirectory) => {
      const chats = await statIfPresent(files, "chats");
      if (!chats?.isDirectory) {
        return;
      }
      for (const chatId of await files.list("chats")) {
        if (!chatIdPattern.test(chatId)) {
          continue;
        }
        const chatDirectory = chatFilesDirectory(chatId);
        const chat = await statIfPresent(files, chatDirectory);
        if (!chat?.isDirectory) {
          continue;
        }
        const directory = chatArtifactsDirectory(chatId);
        const webFetch = await statIfPresent(files, directory);
        if (!webFetch?.isDirectory) {
          continue;
        }
        const names = await files.list(directory);
        const spillFiles: string[] = [];
        for (const name of names) {
          if (!spillFilenamePattern.test(name)) {
            continue;
          }
          if ((await files.stat(`${directory}/${name}`)).isFile) {
            spillFiles.push(name);
          }
        }
        const spillSet = new Set(spillFiles);
        for (const name of spillFiles) {
          const relativePath = `${directory}/${name}`;
          if (options.dryRun) {
            actions.push({
              kind: "file",
              path: `users/${userDirectory}/${relativePath}`,
            });
          } else {
            options.assertCurrent();
            await files.remove(relativePath);
            options.assertCurrent();
            filesRemoved++;
          }
        }
        const emptyAfterCleanup = options.dryRun
          ? names.every((name) => spillSet.has(name))
          : (await files.list(directory)).length === 0;
        if (emptyAfterCleanup) {
          if (options.dryRun) {
            actions.push({
              kind: "directory",
              path: `users/${userDirectory}/${directory}`,
            });
          } else {
            options.assertCurrent();
            await files.removeEmptyDirectory(directory);
            options.assertCurrent();
            directoriesRemoved++;
          }
        }
      }
    },
  );
  return { actions, filesRemoved, directoriesRemoved };
}
