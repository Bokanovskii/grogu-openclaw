export function chatFilesDirectory(chatId: string) {
  return `chats/${chatId}`;
}

export function chatWidgetsDirectory(chatId: string) {
  return `${chatFilesDirectory(chatId)}/widgets`;
}

export function chatArtifactsDirectory(chatId: string) {
  return `${chatFilesDirectory(chatId)}/web-fetch`;
}
