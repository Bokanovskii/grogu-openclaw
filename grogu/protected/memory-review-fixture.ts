import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const fixtureDir = await mkdtemp(path.join(tmpdir(), "alcove-memory-fixture-"));
const stateDir = path.join(fixtureDir, "state");
await mkdir(stateDir, { mode: 0o700 });
const key = randomBytes(32);
const keyPath = path.join(fixtureDir, "synthetic-storage-key");
await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyPath;

const [
  { root },
  { createAuthorizedUserFiles },
  { createStorageValueEncryption },
  { createProtectedHttp },
  { createProtectedMemoryReview },
  { createProtectedServer, closeProtectedServer },
] = await Promise.all([
  import("../../src/infra/fs-safe.js"),
  import("../../src/infra/authorized-user-files.js"),
  import("../../src/storage/encryption.js"),
  import("./http.js"),
  import("./memory-review.js"),
  import("./server.js"),
]);

const uiOrigin = process.env.GROGU_MEMORY_UI_ORIGIN ?? "http://127.0.0.1:4173";
const usersDir = path.join(stateDir, "users");
await mkdir(usersDir, { mode: 0o700 });
const usersRoot = await root(usersDir);
const encryption = createStorageValueEncryption(key);
key.fill(0);
const expiresAt = Date.now() + 60 * 60 * 1000;
const app = createProtectedHttp({
  origin: uiOrigin,
  accessIssuer: "https://synthetic.example",
  stateDir,
  usersRoot,
  encryption,
  memoryReview: createProtectedMemoryReview(),
  directory: { issuer: "https://synthetic.example", allowedSubjects: ["alice", "bob"] },
  verifyIdentity: async (request) => {
    const cookie = request.headers.get("cookie") ?? "";
    const subject = /(?:^|;\s*)synthetic=(alice|bob)(?:;|$)/u.exec(cookie)?.[1];
    if (!subject) {
      throw new Error("Synthetic identity cookie is required.");
    }
    return {
      issuer: "https://synthetic.example",
      subject,
      kind: "human",
      sessionId: createHash("sha256").update(subject).digest("hex"),
      expiresAt,
      assertCurrent() {},
      async revalidate() {},
    };
  },
  maxChatsPerUser: 3,
  maxFileBytes: 64_000,
  turns: {
    models: [],
    async run() {
      throw new Error("The memory review fixture does not run turns.");
    },
    async steer() {
      throw new Error("The memory review fixture does not steer turns.");
    },
  },
});

for (const [subject, content] of [
  ["alice", "Alice remembers the blue lighthouse."],
  ["bob", "Bob remembers the green garden."],
] as const) {
  const response = await app.fetch(
    new Request(`${uiOrigin}/api/protected/v1/me`, {
      headers: { cookie: `synthetic=${subject}` },
    }),
  );
  if (!response.ok) {
    throw new Error(`Could not create synthetic ${subject} profile: ${response.status}`);
  }
  const profile: { user: { id: string } } = await response.json();
  const nameResponse = await app.fetch(
    new Request(`${uiOrigin}/api/protected/v1/account/name`, {
      method: "PUT",
      headers: {
        origin: uiOrigin,
        cookie: `synthetic=${subject}`,
        "content-type": "application/json",
        "x-grogu-profile": profile.user.id,
      },
      body: JSON.stringify({ displayName: subject === "alice" ? "Alice" : "Bob" }),
    }),
  );
  if (!nameResponse.ok) {
    throw new Error(`Could not name synthetic ${subject} profile: ${nameResponse.status}`);
  }
  const files = await createAuthorizedUserFiles({
    usersRoot,
    profileId: profile.user.id,
    assertCurrent() {},
    maxBytes: 64_000,
    encryption,
  });
  try {
    await files.write("member-memory/memory/2026-01-01.md", content);
  } finally {
    files.dispose();
  }
}

const server = createProtectedServer(uiOrigin, async (request) => {
  const pathname = new URL(request.url).pathname;
  if (
    request.method !== "GET" ||
    (pathname !== "/api/protected/v1/me" &&
      !/^\/api\/protected\/v1\/memory(?:\/[A-Za-z0-9_-]+)?$/u.test(pathname))
  ) {
    return new Response(null, { status: 404 });
  }
  return await app.fetch(request);
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Synthetic memory fixture could not bind loopback.");
}
console.log(`GROGU_MEMORY_RUNTIME=http://127.0.0.1:${address.port}`);
console.log(`Synthetic fixture directory: ${fixtureDir}`);

let closing = false;
const close = async () => {
  if (closing) {
    return;
  }
  closing = true;
  try {
    await closeProtectedServer(server, app, stateDir);
    encryption.dispose();
    await rm(fixtureDir, { recursive: true, force: true });
  } catch (error) {
    console.error("Synthetic memory fixture cleanup failed:", error);
    process.exitCode = 1;
  }
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
