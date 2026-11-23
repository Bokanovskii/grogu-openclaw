import type { ProtectedChatSummary } from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import {
  chatArtifactsDirectory,
  chatGeneratedArtifactsDirectory,
  chatWidgetsDirectory,
} from "./chat-files.js";
import { ProtectedError } from "./errors.js";
import { widgetIdPattern } from "./tool-events.js";

type ArtifactKey = {
  updatedAt: number;
  chatId: string;
  kind: "file" | "widget";
  id: string;
};

type Artifact = ArtifactKey & { chatTitle: string } & (
    | { kind: "file"; name: string; size: number }
    | { kind: "widget"; title: string }
  );

const pageSize = 100;

export function validFilename(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name);
}

function generatedSlug(name: string) {
  const match =
    /^artifact-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-([a-z0-9]+(?:-[a-z0-9]+)*)\.html$/u.exec(
      name,
    );
  return match?.[1] && match[1].length <= 48 ? match[1] : undefined;
}

export function validGeneratedFilename(name: string) {
  return generatedSlug(name) !== undefined;
}

function validFileId(chatId: string, id: string) {
  const generatedPrefix = `generated~${chatId}~`;
  if (id.startsWith(generatedPrefix)) {
    return validGeneratedFilename(id.slice(generatedPrefix.length));
  }
  const prefix = `${chatId}~`;
  return id.startsWith(prefix) && validFilename(id.slice(prefix.length));
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareKeys(left: ArtifactKey, right: ArtifactKey) {
  return (
    right.updatedAt - left.updatedAt ||
    compareStrings(left.chatId, right.chatId) ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.id, right.id)
  );
}

function parseCursor(value: string | null): ArtifactKey | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new Error("Invalid cursor");
    }
    const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isRecord(cursor) ||
      typeof cursor.updatedAt !== "number" ||
      !Number.isSafeInteger(cursor.updatedAt) ||
      typeof cursor.chatId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        cursor.chatId,
      ) ||
      (cursor.kind !== "file" && cursor.kind !== "widget") ||
      typeof cursor.id !== "string" ||
      (cursor.kind === "widget"
        ? !widgetIdPattern.test(cursor.id)
        : !validFileId(cursor.chatId, cursor.id))
    ) {
      throw new Error("Invalid cursor");
    }
    return {
      updatedAt: cursor.updatedAt,
      chatId: cursor.chatId,
      kind: cursor.kind,
      id: cursor.id,
    };
  } catch {
    throw new ProtectedError(400, "invalid_request", "The artifact cursor is invalid.");
  }
}

async function listDirectory(files: AuthorizedUserFiles, directory: string) {
  try {
    return await files.list(directory);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return [];
    }
    throw error;
  }
}

export async function listProtectedChatFileCandidates(files: AuthorizedUserFiles, chatId: string) {
  const fileDirectory = chatArtifactsDirectory(chatId);
  const generatedDirectory = chatGeneratedArtifactsDirectory(chatId);
  return [
    ...(await listDirectory(files, fileDirectory)).filter(validFilename).map((name) => ({
      kind: "file" as const,
      id: `${chatId}~${name}`,
      name,
      displayName: name,
      directory: fileDirectory,
    })),
    ...(await listDirectory(files, generatedDirectory)).flatMap((name) => {
      const slug = generatedSlug(name);
      return slug
        ? [
            {
              kind: "file" as const,
              id: `generated~${chatId}~${name}`,
              name,
              displayName: `${slug.replaceAll("-", " ")}.html`,
              directory: generatedDirectory,
            },
          ]
        : [];
    }),
  ];
}

export async function listProtectedArtifacts(options: {
  files: AuthorizedUserFiles;
  chats: ProtectedChatSummary[];
  cursor: string | null;
  maxFileBytes: number;
}) {
  const cursor = parseCursor(options.cursor);
  const artifacts: Artifact[] = [];
  const chats = options.chats.toSorted(
    (left, right) => right.updatedAt - left.updatedAt || compareStrings(left.id, right.id),
  );
  for (const chat of chats) {
    const widgetDirectory = chatWidgetsDirectory(chat.id);
    const candidates = [
      ...(await listProtectedChatFileCandidates(options.files, chat.id)),
      ...(await listDirectory(options.files, widgetDirectory))
        .filter((id) => widgetIdPattern.test(id))
        .map((id) => ({ kind: "widget" as const, id })),
    ];
    for (const candidate of candidates.toSorted(
      (left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id),
    )) {
      const key: ArtifactKey = {
        updatedAt: chat.updatedAt,
        chatId: chat.id,
        kind: candidate.kind,
        id: candidate.id,
      };
      if (cursor && compareKeys(key, cursor) <= 0) {
        continue;
      }
      try {
        if (candidate.kind === "file") {
          const info = await options.files.stat(`${candidate.directory}/${candidate.name}`);
          if (!info.isFile || info.size > options.maxFileBytes) {
            continue;
          }
          artifacts.push({
            ...key,
            kind: "file",
            name: candidate.displayName,
            size: info.size,
            chatTitle: chat.title,
          });
        } else {
          const directory = `${widgetDirectory}/${candidate.id}`;
          const manifest: unknown = JSON.parse(
            await options.files.readText(`${directory}/manifest.json`),
          );
          if (
            !isRecord(manifest) ||
            manifest.id !== candidate.id ||
            manifest.localEntrypoint !== "index.html"
          ) {
            throw new Error("Widget document is not available.");
          }
          if (!(await options.files.stat(`${directory}/index.html`)).isFile) {
            throw new Error("Widget document is not available.");
          }
          artifacts.push({
            ...key,
            kind: "widget",
            title: typeof manifest.title === "string" ? manifest.title.slice(0, 256) : "Widget",
            chatTitle: chat.title,
          });
        }
      } catch (error) {
        if (error instanceof FsSafeError && error.code === "not-found") {
          continue;
        }
        throw error;
      }
      if (artifacts.length > pageSize) {
        const last = artifacts[pageSize - 1]!;
        return {
          artifacts: artifacts.slice(0, pageSize),
          nextCursor: Buffer.from(
            JSON.stringify({
              updatedAt: last.updatedAt,
              chatId: last.chatId,
              kind: last.kind,
              id: last.id,
            }),
          ).toString("base64url"),
        };
      }
    }
  }
  return { artifacts };
}
