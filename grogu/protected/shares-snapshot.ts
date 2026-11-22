import { readCanvasDocumentHtmlSource } from "../../src/canvas/documents.js";
import type { AuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import type {
  ProtectedShareKind,
  ProtectedShareSnapshot,
} from "../../src/state/protected-shares.js";
import { chatArtifactsDirectory, chatWidgetsDirectory } from "./chat-files.js";
import type { ProtectedChatAuthority, createProtectedChats } from "./chats.js";
import { ProtectedError } from "./errors.js";
import { widgetIdPattern } from "./tool-events.js";

type ProtectedShareChats = Pick<
  ReturnType<typeof createProtectedChats>,
  "readEntry" | "readWithUsage"
>;

const chatIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function notFound(): never {
  throw new ProtectedError(404, "not_found", "Not found.");
}

function splitRouteId(routeId: string): { chatId: string; itemId: string } {
  const separator = routeId.indexOf("~");
  if (separator <= 0 || separator === routeId.length - 1) {
    return notFound();
  }
  const chatId = routeId.slice(0, separator);
  const itemId = routeId.slice(separator + 1);
  if (!chatIdPattern.test(chatId)) {
    return notFound();
  }
  return { chatId, itemId };
}

function manifestTitle(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("title" in value)) {
    return undefined;
  }
  const title = value.title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

export async function readProtectedShareSnapshot(options: {
  kind: ProtectedShareKind;
  routeId: string;
  authority: ProtectedChatAuthority;
  chats: ProtectedShareChats;
  withFiles<T>(use: (files: AuthorizedUserFiles) => Promise<T>): Promise<T>;
  maxFileBytes: number;
}): Promise<ProtectedShareSnapshot> {
  const { kind, routeId, authority, chats, withFiles, maxFileBytes } = options;
  authority.assertCurrent();

  if (kind === "chat") {
    if (!chatIdPattern.test(routeId)) {
      return notFound();
    }
    const { chat } = await chats.readWithUsage(authority, routeId);
    authority.assertCurrent();
    return {
      kind,
      title: chat.title,
      chat: {
        id: chat.id,
        title: chat.title,
        version: chat.version,
        updatedAt: chat.updatedAt,
        ...(chat.selectedAgentId ? { selectedAgentId: chat.selectedAgentId } : {}),
        messages: chat.messages,
      },
    };
  }

  const { chatId, itemId } = splitRouteId(routeId);
  await chats.readEntry(authority, chatId);
  authority.assertCurrent();

  if (kind === "file") {
    if (!fileNamePattern.test(itemId)) {
      return notFound();
    }
    return withFiles(async (files) => {
      files.assertCurrent();
      const filePath = `${chatArtifactsDirectory(chatId)}/${itemId}`;
      const stat = await files.stat(filePath);
      if (!stat.isFile || stat.size > maxFileBytes) {
        return notFound();
      }
      const bytes = await files.read(filePath);
      authority.assertCurrent();
      if (bytes.byteLength > maxFileBytes) {
        return notFound();
      }
      return {
        kind,
        title: itemId,
        fileName: itemId,
        sizeBytes: bytes.byteLength,
        contentBase64: bytes.toString("base64"),
      };
    });
  }

  if (!widgetIdPattern.test(itemId)) {
    return notFound();
  }
  return withFiles(async (files) => {
    const directory = chatWidgetsDirectory(chatId);
    const storage = { files, directory };
    const { html, cspSandbox } = await readCanvasDocumentHtmlSource(itemId, {
      storage,
    });
    const manifest = JSON.parse(await files.readText(`${directory}/${itemId}/manifest.json`));
    authority.assertCurrent();
    if (cspSandbox !== "scripts") {
      return notFound();
    }
    return {
      kind,
      title: manifestTitle(manifest) ?? "Widget",
      html,
      cspSandbox,
    };
  });
}
