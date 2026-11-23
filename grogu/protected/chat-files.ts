import type { AuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";

export function chatFilesDirectory(chatId: string) {
  return `chats/${chatId}`;
}

export async function removeChatFilesDirectory(files: AuthorizedUserFiles, chatId: string) {
  try {
    await files.remove(chatFilesDirectory(chatId));
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "not-found")) {
      throw error;
    }
  }
}

export function chatWidgetsDirectory(chatId: string) {
  return `${chatFilesDirectory(chatId)}/widgets`;
}

export function chatArtifactsDirectory(chatId: string) {
  return `${chatFilesDirectory(chatId)}/web-fetch`;
}

export function chatGeneratedArtifactsDirectory(chatId: string) {
  return `${chatFilesDirectory(chatId)}/artifacts`;
}

export function restrictChatFiles(
  files: AuthorizedUserFiles,
  allowedChatIds: ReadonlySet<string>,
): AuthorizedUserFiles {
  const check = (name: string) => {
    const [root, chatId] = name.split("/");
    if (root !== "chats" || !chatId || !allowedChatIds.has(chatId)) {
      throw new FsSafeError("invalid-path", "Files from other chats are unavailable.");
    }
    return name;
  };
  return {
    assertCurrent: files.assertCurrent,
    read: (name) => files.read(check(name)),
    readText: (name) => files.readText(check(name)),
    list: (name = "") => files.list(check(name)),
    stat: (name) => files.stat(check(name)),
    storedSize: files.storedSize,
    mkdir: (name) => files.mkdir(check(name)),
    create: (name, data) => files.create(check(name), data),
    write: (name, data) => files.write(check(name), data),
    move: (from, to) => files.move(check(from), check(to)),
    remove: (name) => files.remove(check(name)),
    removeFile: (name) => files.removeFile(check(name)),
    removeEmptyDirectory: (name) => files.removeEmptyDirectory(check(name)),
    dispose: () => {},
  };
}
