import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createCanvasDocument } from "../../src/canvas/documents.js";
import {
  createAuthorizedUserFiles,
  type AuthorizedUserFiles,
} from "../../src/infra/authorized-user-files.js";
import { root } from "../../src/infra/fs-safe.js";
import { createStorageValueEncryption } from "../../src/storage/encryption.js";
import { PROTECTED_STORAGE_KEY_FILE_ENV } from "../../src/storage/sqlite-encryption.js";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import { createProtectedAgentCatalog, protectedResearchAgent } from "./agents.js";
import { chatArtifactsDirectory, chatWidgetsDirectory } from "./chat-files.js";
import { createProtectedChats } from "./chats.js";
import { readProtectedShareSnapshot } from "./shares-snapshot.js";

void test("share snapshots copy chat, file, and Canvas content from their owners", async () => {
  await withTempDir("protected-sharing-snapshots-", async (testDir) => {
    const stateDir = path.join(testDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const usersDir = path.join(stateDir, "users");
    await fs.mkdir(usersDir, { recursive: true });
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousKeyPath = process.env[PROTECTED_STORAGE_KEY_FILE_ENV];
    const keyPath = path.join(testDir, "storage-key");
    await fs.writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env[PROTECTED_STORAGE_KEY_FILE_ENV] = keyPath;
    try {
      const currentProfileId = randomUUID();
      const encryption = createStorageValueEncryption(randomBytes(32));
      const usersRoot = await root(usersDir);
      const chats = createProtectedChats({
        stateDir,
        maxChatsPerUser: 3,
        agentCatalog: createProtectedAgentCatalog([protectedResearchAgent]),
        usersRoot,
        maxFileBytes: 64_000,
      });
      let active = true;
      const authority = {
        profileId: currentProfileId,
        assertCurrent() {
          if (!active) {
            throw new Error("Request authority ended");
          }
        },
      };
      const files = await createAuthorizedUserFiles({
        encryption,
        usersRoot,
        profileId: currentProfileId,
        assertCurrent: authority.assertCurrent,
        maxBytes: 64_000,
      });
      const withFiles = async <T>(use: (owned: AuthorizedUserFiles) => Promise<T>) => use(files);

      try {
        const chat = await chats.create(authority, "Portugal planning");
        const fileName = "itinerary.txt";
        await files.create(`${chatArtifactsDirectory(chat.id)}/${fileName}`, "Day one");
        const widget = await createCanvasDocument(
          { html: "<h1>Lisbon</h1>", title: "Lisbon itinerary" },
          { storage: { files, directory: chatWidgetsDirectory(chat.id) } },
        );

        const chatSnapshot = await readProtectedShareSnapshot({
          kind: "chat",
          routeId: chat.id,
          authority,
          chats,
          withFiles,
          maxFileBytes: 64_000,
        });
        const fileSnapshot = await readProtectedShareSnapshot({
          kind: "file",
          routeId: `${chat.id}~${fileName}`,
          authority,
          chats,
          withFiles,
          maxFileBytes: 64_000,
        });
        const pageSnapshot = await readProtectedShareSnapshot({
          kind: "page",
          routeId: `${chat.id}~${widget.id}`,
          authority,
          chats,
          withFiles,
          maxFileBytes: 64_000,
        });

        assert.deepEqual(chatSnapshot, {
          kind: "chat",
          title: "Portugal planning",
          chat: {
            id: chat.id,
            title: "Portugal planning",
            version: chat.version,
            updatedAt: chat.updatedAt,
            selectedAgentId: chat.selectedAgentId,
            messages: [],
          },
        });
        assert.deepEqual(fileSnapshot, {
          kind: "file",
          title: fileName,
          fileName,
          sizeBytes: Buffer.byteLength("Day one"),
          contentBase64: Buffer.from("Day one").toString("base64"),
        });
        assert.deepEqual(pageSnapshot, {
          kind: "page",
          title: "Lisbon itinerary",
          html: "<h1>Lisbon</h1>",
          cspSandbox: "scripts",
        });

        await files.write(`${chatArtifactsDirectory(chat.id)}/${fileName}`, "Day two");
        const entry = await chats.readEntry(authority, chat.id);
        await chats.saveChildResult(authority, chat.id, {
          runId: randomUUID(),
          agentId: "research",
          text: "Private follow-up",
          timestamp: Date.now(),
          parentLifecycleRevision: entry.lifecycleRevision ?? null,
        });

        assert.equal(
          fileSnapshot.kind === "file" ? fileSnapshot.contentBase64 : undefined,
          Buffer.from("Day one").toString("base64"),
        );
        assert.deepEqual(chatSnapshot.kind === "chat" ? chatSnapshot.chat.messages : undefined, []);
        assert.equal((await chats.read(authority, chat.id)).messages.length, 1);

        active = false;
        await assert.rejects(
          readProtectedShareSnapshot({
            kind: "page",
            routeId: `${chat.id}~${widget.id}`,
            authority,
            chats,
            withFiles,
            maxFileBytes: 64_000,
          }),
          /Request authority ended/u,
        );
      } finally {
        files.dispose();
        encryption.dispose();
      }
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousKeyPath === undefined) {
        delete process.env[PROTECTED_STORAGE_KEY_FILE_ENV];
      } else {
        process.env[PROTECTED_STORAGE_KEY_FILE_ENV] = previousKeyPath;
      }
    }
  });
});
