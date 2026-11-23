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
