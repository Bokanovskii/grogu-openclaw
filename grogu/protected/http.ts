import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  isProtectedCreateChat,
  isProtectedAccountName,
  isProtectedDirectorySettings,
  isProtectedRenew,
  isProtectedSteer,
  isProtectedTurnRequest,
  type ProtectedTurnEvent,
} from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildSandboxHostDocument } from "../../src/agents/sandbox-host.js";
import { withTranscriptWriteBudget } from "../../src/agents/sessions/transcript-write-budget.js";
import { readCanvasDocumentHtmlSource } from "../../src/canvas/documents.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../src/state/user-preferences.js";
import { updateCanonicalUserProfileAccess } from "../../src/state/user-profile-access.js";
import {
  prepareCurrentUserProfileAliases,
  readVerifiedUserProfileDirectory,
} from "../../src/state/user-profile-reads.js";
import { setCanonicalUserProfileDisplayName } from "../../src/state/user-profile-writes.js";
import { createStorageAdmission, type StorageLimits } from "./capacity.js";
import { chatArtifactsDirectory, chatFilesDirectory, chatWidgetsDirectory } from "./chat-files.js";
import { createProtectedChats } from "./chats.js";
import { ProtectedError, publicError } from "./errors.js";
import {
  protectedAccessProofPath,
  resolveProtectedProfile,
  type ProtectedIdentityVerifier,
} from "./identity.js";
import type { createProviderRelay } from "./provider-relay.js";
import { protectedTurnTimeoutMs, subjectPattern } from "./settings.js";
import { widgetIdPattern } from "./tool-events.js";
import { createProtectedTurnTiming } from "./turn-timing.js";
import type { ProtectedTurns, TurnInput } from "./turns.js";

const base = "/api/protected/v1";
const commonHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const maxBodyBytes = 48_000;
const directoryPreference = "grogu.protected.directory";
type Run = {
  id: string;
  profileId: string;
  sessionHash: string;
  controller: AbortController;
  steering: Map<string, AbortController>;
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: commonHeaders });
}
function notFound(): never {
  throw new ProtectedError(404, "not_found", "Not found.");
}
function unauthorized(): never {
  throw new ProtectedError(401, "unauthorized", "Sign in again to continue.");
}
function invalid(): never {
  throw new ProtectedError(400, "invalid_request", "The request is invalid.");
}
function noContent() {
  return new Response(null, { status: 204, headers: commonHeaders });
}
function validFilename(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name);
}
async function body(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
    !request.body
  ) {
    return invalid();
  }
  const reader = request.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        throw new ProtectedError(413, "request_too_large", "The request is too large.");
      }
      chunks.push(value);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return invalid();
    }
    return isRecord(value) ? value : invalid();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    return invalid();
  }
  return value;
}

export function createProtectedHttp(options: {
  origin: string;
  stateDir: string;
  verifyIdentity: ProtectedIdentityVerifier;
  directory: { issuer: string; allowedSubjects: readonly string[] };
  answerAccessProof?: (request: Request) => Promise<Response>;
  usersRoot: Parameters<typeof createAuthorizedUserFiles>[0]["usersRoot"];
  encryption?: Parameters<typeof createAuthorizedUserFiles>[0]["encryption"];
  turns: ProtectedTurns;
  providerRelay?: ReturnType<typeof createProviderRelay>;
  maxChatsPerUser: number;
  maxFileBytes: number;
  storageLimits?: StorageLimits;
}) {
  if (new URL(options.origin).origin !== options.origin) {
    throw new TypeError("Configure the exact protected client origin.");
  }
  const chats = createProtectedChats(options);
  const admitStorage = options.storageLimits
    ? createStorageAdmission({ ...options, chats, limits: options.storageLimits })
    : undefined;
  const runs = new Map<string, Run>();
  const pending = new Set<Promise<unknown>>();
  const revokedSessions = new Set<string>();
  const deniedProfiles = new Set<string>();
  const creating = new Set<string>();
  const mutations = new Set<string>();
  const shutdown = new AbortController();

  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const settled = () => pending.delete(work);
    void work.then(settled, settled);
    return work;
  };
  const handle = async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    try {
      const path = new URL(request.url).pathname;
      if (path === "/healthz" && request.method === "GET") {
        return json({ ready: !shutdown.signal.aborted }, shutdown.signal.aborted ? 503 : 200);
      }
      if (shutdown.signal.aborted) {
        throw new ProtectedError(503, "unavailable", "The service is stopping.");
      }
      if (!path.startsWith(`${base}/`)) {
        return notFound();
      }
      const pathname = path.slice(base.length);
      const method = request.method;
      if (pathname === "/widget-sandbox" && method === "GET") {
        const doc = buildSandboxHostDocument({ profile: "protected" }, true);
        return new Response(doc.html, { headers: { ...doc.headers, ...commonHeaders } });
      }
      if (path === protectedAccessProofPath && options.answerAccessProof) {
        return await options.answerAccessProof(request);
      }
      const origin = request.headers.get("origin");
      if (
        (origin !== null && origin !== options.origin) ||
        (method !== "GET" && origin !== options.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      ) {
        throw new ProtectedError(
          403,
          "invalid_origin",
          "Use the protected app to make this request.",
        );
      }
      const identity = await options.verifyIdentity(request);
      if (identity.issuer !== options.directory.issuer) {
        return unauthorized();
      }
      const rawCurrent = () => {
        identity.assertCurrent();
        if (revokedSessions.has(identity.sessionId)) {
          unauthorized();
        }
      };
      rawCurrent();
      const profile = await resolveProtectedProfile(identity, {
        env: chats.env,
        assertCurrent: rawCurrent,
      });
      const assertGrant = () => {
        shutdown.signal.throwIfAborted();
        rawCurrent();
        if (deniedProfiles.has(profile.id)) {
          unauthorized();
        }
      };
      const assertCurrent = () => {
        request.signal.throwIfAborted();
        assertGrant();
      };
      const session = {
        profileId: profile.id,
        sessionHash: identity.sessionId,
        expiresAt: identity.expiresAt,
      };
      const touch = (action: "admit" | "validate" | "logout", assert = assertCurrent) =>
        updateCanonicalUserProfileAccess(
          { action, ...session },
          { env: chats.env, assertCurrent: assert },
        );
      if (!(await touch("admit"))) {
        return unauthorized();
      }
      assertCurrent();
      const checkGrant = async (assert = assertGrant) => {
        assert();
        await identity.revalidate();
        assert();
        if (!(await touch("validate", assert))) {
          unauthorized();
        }
        assert();
      };
      const revalidate = async () => {
        assertCurrent();
        await checkGrant();
        assertCurrent();
      };
      const requireProfile = () => {
        if (request.headers.get("x-grogu-profile") !== profile.id) {
          throw new ProtectedError(
            403,
            "profile_mismatch",
            "Reload before using a device credential.",
          );
        }
      };
      const authority = { profileId: profile.id, assertCurrent };
      const files = <T>(
        use: (scope: Awaited<ReturnType<typeof createAuthorizedUserFiles>>) => Promise<T>,
        assert = assertCurrent,
        signal = request.signal,
      ) =>
        createAuthorizedUserFiles({
          ...options,
          profileId: profile.id,
          assertCurrent: assert,
          signal,
          maxBytes: options.maxFileBytes,
        }).then(async (owned) => {
          try {
            return await use(owned);
          } catch (error) {
            if (error instanceof FsSafeError && error.code === "not-found") {
              return notFound();
            }
            throw error;
          } finally {
            owned.dispose();
          }
        });
      const readChat = async (id: string) => {
        const chat = await chats.read(authority, id);
        if (chat.messages.some((message) => message.widgets?.length)) {
          await files(async (owned) => {
            for (const message of chat.messages) {
              const widgets = [];
              for (const widget of message.widgets ?? []) {
                try {
                  const stat = await owned.stat(
                    `${chatWidgetsDirectory(id)}/${widget.id}/manifest.json`,
                  );
                  if (stat.isFile) {
                    widgets.push(widget);
                  }
                } catch (error) {
                  if (!(error instanceof FsSafeError && error.code === "not-found")) {
                    throw error;
                  }
                }
              }
              if (message.widgets) {
                message.widgets = widgets;
              }
            }
          });
        }
        return chat;
      };
      if (pathname === "/me" && method === "GET") {
        return json({
          user: { id: profile.id, displayName: profile.displayName ?? "User" },
          disclosure:
            "Your chats and generated files are stored on the server until you delete them. The server operator can read them. They are stored unencrypted, with no backups, so a disk failure can lose your history. The server uses personal provider credentials only for the current request. The service can fetch known public URLs, but it does not search the web.",
          models: options.turns.models,
          capabilities: {
            copilotConnect: options.providerRelay !== undefined,
            openaiConnect: options.providerRelay !== undefined,
          },
        });
      }
      if (pathname === "/account" && method === "GET") {
        const profileAuthority = await prepareCurrentUserProfileAliases(profile.id, {
          env: chats.env,
        });
        const preferences = await getCanonicalUserPreferences(profile.id, [directoryPreference], {
          env: chats.env,
          requireExactProfile: true,
        });
        await revalidate();
        profileAuthority.assertCurrent();
        if (!preferences) {
          return unauthorized();
        }
        const saved = preferences.entries[directoryPreference];
        if (saved !== undefined && !isProtectedDirectorySettings(saved)) {
          throw new ProtectedError(
            409,
            "account_settings_invalid",
            "Save your directory settings again.",
          );
        }
        return json({
          user: {
            id: profile.id,
            displayName: (profile.displayName?.trim() || "Family member").slice(0, 40),
          },
          directory: {
            description: saved?.description ?? "",
            hidden: identity.kind === "development" || saved?.hidden === true,
          },
        });
      }
      if (pathname === "/account/name" && method === "PUT") {
        const input = await body(request);
        if (!isProtectedAccountName(input) || !input.displayName.trim()) {
          return invalid();
        }
        await revalidate();
        const updated = await setCanonicalUserProfileDisplayName(
          profile.id,
          input.displayName.trim(),
          {
            env: chats.env,
            assertCurrent,
            requireExactProfile: true,
          },
        );
        assertCurrent();
        return json({ user: { id: updated.profile.id, displayName: updated.profile.displayName } });
      }
      if (pathname === "/account/directory-settings" && method === "PUT") {
        const input = await body(request);
        if (!isProtectedDirectorySettings(input)) {
          return invalid();
        }
        if (identity.kind === "development" && !input.hidden) {
          throw new ProtectedError(
            403,
            "development_hidden",
            "The development account is always hidden.",
          );
        }
        await revalidate();
        const saved = await setCanonicalUserPreferences(
          profile.id,
          { [directoryPreference]: input },
          { env: chats.env, assertCurrent, requireExactProfile: true },
        );
        if (!saved?.ok) {
          throw new ProtectedError(
            409,
            "account_settings_not_saved",
            "Could not save your directory settings.",
          );
        }
        assertCurrent();
        return json({ directory: input });
      }
      if (pathname === "/people" && method === "GET") {
        if (identity.kind === "development") {
          await revalidate();
          return json({ people: [], nextCursor: null });
        }
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (cursor !== null && !subjectPattern.test(cursor)) {
          return invalid();
        }
        const result = await readVerifiedUserProfileDirectory(
          {
            issuer: options.directory.issuer,
            subjects: options.directory.allowedSubjects.filter((subject) =>
              subjectPattern.test(subject),
            ),
            preferenceKey: directoryPreference,
            after: cursor,
            limit: 100,
          },
          { env: chats.env },
        );
        await revalidate();
        if (!result.isCurrent() || result.people.some((person) => deniedProfiles.has(person.id))) {
          throw new ProtectedError(409, "directory_changed", "The directory changed. Try again.");
        }
        return json({ people: result.people, nextCursor: result.nextCursor });
      }
      if (pathname === "/logout" && method === "POST") {
        revokedSessions.add(identity.sessionId);
        options.providerRelay?.invalidate({ sessionHash: identity.sessionId });
        for (const run of runs.values()) {
          if (run.sessionHash === identity.sessionId) {
            run.controller.abort();
          }
        }
        if (!(await touch("logout", identity.assertCurrent))) {
          return unauthorized();
        }
        revokedSessions.delete(identity.sessionId);
        return noContent();
      }
      const connection =
        /^\/providers\/(github-copilot|openai)\/connect(?:\/([a-f0-9-]{36})(\/poll)?)?$/u.exec(
          pathname,
        );
      const relay = options.providerRelay;
      const relayAuthority = {
        ...session,
        signal: request.signal,
        assertCurrent: assertGrant,
        revalidate: checkGrant,
      };
      if (connection && (method === "POST" || method === "DELETE")) {
        requireProfile();
        if (!relay) {
          throw new ProtectedError(
            503,
            "provider_connect_unavailable",
            "This provider connection is not enabled.",
          );
        }
        const provider = connection[1] === "openai" ? "openai" : "github-copilot";
        const id = connection[2];
        if (method === "POST" && !id) {
          return json(await relay.start(provider, relayAuthority));
        }
        if (method === "POST" && id && connection[3]) {
          return json(await relay.poll(provider, id, relayAuthority));
        }
        if (method === "DELETE" && id && !connection[3]) {
          await relay.cancel(provider, id, relayAuthority);
          return noContent();
        }
        return notFound();
      }
      if (pathname === "/providers/openai/renew" && method === "POST") {
        requireProfile();
        if (!relay) {
          throw new ProtectedError(
            503,
            "provider_connect_unavailable",
            "This provider connection is not enabled.",
          );
        }
        const data = await body(request);
        if (!isProtectedRenew(data)) {
          return invalid();
        }
        const { credential } = data;
        const generation = credential.generation;
        if (
          generation !== undefined &&
          (typeof generation !== "number" ||
            !Number.isSafeInteger(generation) ||
            generation < 0 ||
            generation >= Number.MAX_SAFE_INTEGER)
        ) {
          return invalid();
        }
        return json(
          await relay.renew(
            {
              accessToken: text(credential.accessToken, 16_000),
              refreshToken: text(credential.refreshToken, 16_000),
              generation,
            },
            { ...relayAuthority, assertCurrent, revalidate },
          ),
        );
      }
      if (pathname === "/chats" && method === "GET") {
        const result = await chats.list(authority);
        await revalidate();
        return json({ chats: result });
      }
      if (pathname === "/chats" && method === "POST") {
        const data = await body(request);
        if (!isProtectedCreateChat(data)) {
          return invalid();
        }
        if (creating.has(profile.id)) {
          throw new ProtectedError(409, "busy", "Another chat is being created.");
        }
        creating.add(profile.id);
        let storage;
        try {
          await revalidate();
          storage = await admitStorage?.(profile.id, assertCurrent, "create");
          const chat = await chats.create(
            authority,
            data.title === undefined ? undefined : text(data.title, 160),
          );
          await revalidate();
          return json({ chat });
        } finally {
          storage?.release();
          creating.delete(profile.id);
        }
      }
      if (pathname === "/export" && method === "GET") {
        const result = [];
        for (const chat of await chats.list(authority)) {
          await revalidate();
          result.push(await readChat(chat.id));
        }
        await revalidate();
        return json({ chats: result });
      }
      if (pathname === "/files" && method === "GET") {
        try {
          return await files(async (owned) => {
            const result = [];
            for (const chat of await chats.list(authority)) {
              const dir = chatArtifactsDirectory(chat.id);
              try {
                for (const name of (await owned.list(dir)).filter(validFilename)) {
                  const info = await owned.stat(`${dir}/${name}`);
                  if (info.isFile && info.size <= options.maxFileBytes) {
                    result.push({ id: `${chat.id}~${name}`, name, size: info.size });
                  }
                }
              } catch (error) {
                if (!(error instanceof FsSafeError && error.code === "not-found")) {
                  throw error;
                }
              }
            }
            await revalidate();
            return json({ files: result });
          });
        } catch (error) {
          if (error instanceof ProtectedError && error.status === 404) {
            await revalidate();
            return json({ files: [] });
          }
          throw error;
        }
      }
      const fileId = /^\/files\/([^/~]+)~([^/~]+)$/u.exec(pathname);
      if (fileId?.[1] && fileId[2] && validFilename(fileId[2]) && method === "GET") {
        const [, chatId, filename] = fileId;
        await chats.readEntry(authority, chatId);
        await revalidate();
        return files(async (owned) => {
          const bytes = await owned.read(`${chatArtifactsDirectory(chatId)}/${filename}`);
          await revalidate();
          return new Response(new Uint8Array(bytes), {
            headers: {
              ...commonHeaders,
              "content-disposition": `attachment; filename="${filename}"`,
              "content-type": "application/octet-stream",
            },
          });
        });
      }
      const match = /^\/chats\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
      if (!match?.[1]) {
        return notFound();
      }
      const [, id, rest] = match;
      await chats.readEntry(authority, id);
      await revalidate();
      if (!rest && method === "GET") {
        const chat = await readChat(id);
        await revalidate();
        const active = runs.get(id);
        return json({
          chat,
          ...(active?.profileId === profile.id && active.sessionHash === identity.sessionId
            ? { activeRun: { id: active.id } }
            : {}),
        });
      }
      if (!rest && method === "DELETE") {
        const version = request.headers.get("if-match");
        if (!version) {
          throw new ProtectedError(428, "version_required", "Reload the chat before deleting.");
        }
        if (runs.has(id) || mutations.has(id)) {
          throw new ProtectedError(409, "busy", "Stop the current work before deleting.");
        }
        mutations.add(id);
        try {
          await chats.delete(authority, id, version, async () => {
            await files(async (owned) => {
              try {
                await owned.remove(chatFilesDirectory(id));
              } catch (error) {
                if (!(error instanceof FsSafeError && error.code === "not-found")) {
                  throw error;
                }
              }
            });
            await revalidate();
          });
          await revalidate();
          return noContent();
        } finally {
          mutations.delete(id);
        }
      }
      const widgetId = rest?.startsWith("widgets/") ? rest.slice("widgets/".length) : undefined;
      if (widgetId && widgetIdPattern.test(widgetId) && method === "GET") {
        return files(async (owned) => {
          const storage = { files: owned, directory: chatWidgetsDirectory(id) };
          const { html } = await readCanvasDocumentHtmlSource(widgetId, { storage });
          const manifest: unknown = JSON.parse(
            await owned.readText(`${storage.directory}/${widgetId}/manifest.json`),
          );
          await revalidate();
          const title =
            isRecord(manifest) && typeof manifest.title === "string" ? manifest.title : "Widget";
          return json({ id: widgetId, title, html, version: widgetId });
        });
      }
      if (rest === "turns" && method === "POST") {
        requireProfile();
        const data = await body(request);
        if (!isProtectedTurnRequest(data)) {
          return invalid();
        }
        const model = options.turns.models.find(
          (candidate) =>
            candidate.provider === data.provider &&
            (data.model === undefined || candidate.id === data.model),
        );
        if (!model) {
          throw new ProtectedError(422, "model_unavailable", "This model is not available.");
        }
        const credential = data.credential;
        if (credential !== undefined && (!isRecord(credential) || model.provider === "sparky")) {
          return invalid();
        }
        const expiresAt = isRecord(credential) ? credential.expiresAt : undefined;
        if (
          expiresAt !== undefined &&
          (typeof expiresAt !== "number" ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= Date.now())
        ) {
          throw new ProtectedError(
            401,
            "provider_credential_expired",
            "Reconnect or renew this provider first.",
          );
        }
        const input: TurnInput = {
          provider: model.provider,
          model: model.id,
          text: text(data.text, 16_000),
          ...(isRecord(credential)
            ? {
                credential: {
                  accessToken: text(credential.accessToken, 16_000),
                  expiresAt,
                },
              }
            : {}),
        };
        await revalidate();
        if (runs.has(id) || mutations.has(id)) {
          throw new ProtectedError(409, "busy", "A turn is already running in this chat.");
        }
        // Storage charges continue after the client disconnects, so they check only the grant.
        const storage = await admitStorage?.(profile.id, assertGrant, "turn");
        if (shutdown.signal.aborted || runs.has(id) || mutations.has(id)) {
          storage?.release();
          throw new ProtectedError(409, "busy", "A turn is already running in this chat.");
        }
        if (request.signal.aborted) {
          storage?.release();
          request.signal.throwIfAborted();
        }
        const run: Run = {
          id: randomUUID(),
          ...session,
          controller: new AbortController(),
          steering: new Map(),
        };
        runs.set(id, run);
        const timing = createProtectedTurnTiming(startedAt);
        timing.mark("admissionMs");
        // The run does not follow request.signal. A phone that sleeps or loses the tunnel only
        // detaches from the stream, and the reply still finishes and saves.
        const signal = AbortSignal.any([
          shutdown.signal,
          run.controller.signal,
          AbortSignal.timeout(protectedTurnTimeoutMs + 5000),
        ]);
        const assertRun = () => {
          assertGrant();
          signal.throwIfAborted();
          if (runs.get(id) !== run) {
            unauthorized();
          }
        };
        let validation: Promise<void> | undefined;
        const checkRun = async () => {
          assertRun();
          if (!validation) {
            const finishTiming = timing.accessValidation();
            validation = track(checkGrant(assertRun))
              .catch((error: unknown) => {
                run.controller.abort();
                throw error;
              })
              .finally(() => {
                finishTiming();
                validation = undefined;
              });
          }
          await validation;
          assertRun();
        };
        const runAuthority = { profileId: profile.id, assertCurrent: assertRun };
        const liveCheck = setInterval(() => {
          void checkRun().catch(() => run.controller.abort());
        }, 5000);
        liveCheck.unref();
        let attached = true;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const write = (line: string) => {
              if (attached) {
                try {
                  controller.enqueue(encoder.encode(line));
                  return true;
                } catch {
                  attached = false;
                }
              }
              return false;
            };
            const send = (event: ProtectedTurnEvent) => {
              // Only a fixed terminal error may cross the boundary after authority is lost.
              if (event.type !== "error") {
                assertRun();
              }
              const published = write(`${JSON.stringify(event)}\n`);
              if (
                published &&
                event.type !== "start" &&
                event.type !== "done" &&
                event.type !== "error"
              ) {
                timing.mark("firstClientVisibleOutputMs");
              }
            };
            // Silent reasoning can last minutes. A blank NDJSON line keeps the Cloudflare tunnel
            // from closing an idle response; clients skip blank lines.
            const keepalive = setInterval(() => write("\n"), 15_000);
            keepalive.unref();
            const complete = async () => {
              let outcome: "complete" | "failed" | "interrupted" = "failed";
              try {
                assertRun();
                send({ type: "start", runId: run.id });
                const before = await chats.read(runAuthority, id);
                await files(
                  async (owned) => {
                    const execute = () =>
                      options.turns.run({
                        id,
                        runId: run.id,
                        profileId: profile.id,
                        target: chats.scope(runAuthority, id),
                        input,
                        files: storage?.files(owned) ?? owned,
                        signal,
                        assertCurrent: assertRun,
                        revalidate: checkRun,
                        markTiming: timing.mark,
                        delta: async (value) => {
                          send({ type: "delta", text: value });
                        },
                        sources: async (sources) => {
                          send({ type: "sources", sources });
                        },
                        widget: async (widget) => {
                          await owned.stat(
                            `${chatWidgetsDirectory(id)}/${widget.id}/manifest.json`,
                          );
                          send({ type: "widget", ...widget });
                        },
                        widgetDraft: async (draft) => {
                          send(draft);
                        },
                      });
                    return storage ? withTranscriptWriteBudget(storage.charge, execute) : execute();
                  },
                  assertRun,
                  signal,
                );
                storage?.assertResult();
                const chat = await chats.read(runAuthority, id);
                await checkRun();
                const newMessages = chat.messages.slice(before.messages.length);
                if (
                  !newMessages.some(
                    (message) => message.role === "user" && message.text === input.text,
                  ) ||
                  newMessages.at(-1)?.role !== "assistant" ||
                  newMessages.at(-1)?.status !== "complete"
                ) {
                  throw new ProtectedError(
                    500,
                    "save_failed",
                    "The reply could not be confirmed as saved.",
                  );
                }
                send({ type: "done", chatVersion: chat.version });
                outcome = "complete";
              } catch (error) {
                outcome = signal.aborted ? "interrupted" : "failed";
                let failure = error;
                try {
                  storage?.assertResult();
                } catch (capacityError) {
                  failure = capacityError;
                }
                const issue = signal.aborted
                  ? new ProtectedError(409, "interrupted", "The turn was interrupted.")
                  : publicError(failure);
                send({ type: "error", code: issue.code, message: issue.message });
              } finally {
                clearInterval(keepalive);
                storage?.release();
                clearInterval(liveCheck);
                runs.delete(id);
                for (const queued of run.steering.values()) {
                  queued.abort();
                }
                timing.finish(outcome);
                if (attached) {
                  attached = false;
                  controller.close();
                }
              }
            };
            void track(complete());
          },
          cancel() {
            // Stop is an explicit route. A closed connection only detaches the reader.
            attached = false;
          },
        });
        return new Response(stream, {
          headers: { ...commonHeaders, "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }
      const control = /^runs\/([^/]+)\/(steer|stop)(?:\/([^/]+))?$/u.exec(rest ?? "");
      const run = runs.get(id);
      if (
        !control ||
        !run ||
        run.id !== control[1] ||
        run.profileId !== profile.id ||
        run.sessionHash !== identity.sessionId
      ) {
        return notFound();
      }
      if (control[2] === "stop" && !control[3] && method === "POST") {
        run.controller.abort();
        return json({ stopped: true });
      }
      if (control[2] === "steer" && !control[3] && method === "POST") {
        const data = await body(request);
        if (!isProtectedSteer(data)) {
          return invalid();
        }
        const steeringId = text(data.id, 64);
        const message = text(data.text, 16_000);
        if (
          !/^[\da-f-]{36}$/u.test(steeringId) ||
          run.steering.has(steeringId) ||
          run.steering.size >= 16
        ) {
          return invalid();
        }
        await revalidate();
        if (runs.get(id) !== run || run.controller.signal.aborted) {
          return notFound();
        }
        const queued = new AbortController();
        run.steering.set(steeringId, queued);
        const isCurrent = () => runs.get(id) === run && !run.controller.signal.aborted;
        const result = await options.turns.steer({
          id,
          steeringId,
          text: message,
          signal: AbortSignal.any([queued.signal, run.controller.signal]),
          assertCurrent: () => {
            assertGrant();
            if (!isCurrent()) {
              notFound();
            }
          },
          onSettled: () => run.steering.delete(steeringId),
          isCurrent,
        });
        if (!result.queued) {
          run.steering.delete(steeringId);
          throw new ProtectedError(
            409,
            "steering_unavailable",
            "The turn is not accepting steering.",
          );
        }
        return json({ queued: true });
      }
      if (control[2] === "steer" && control[3] && method === "DELETE") {
        const queued = run.steering.get(control[3]);
        if (!queued) {
          return notFound();
        }
        queued.abort();
        run.steering.delete(control[3]);
        return noContent();
      }
      return notFound();
    } catch (error) {
      const issue = publicError(error);
      return json({ error: { code: issue.code, message: issue.message } }, issue.status);
    }
  };
  return {
    fetch(this: void, request: Request) {
      return track(handle(request));
    },
    async shutdown() {
      shutdown.abort();
      options.providerRelay?.close();
      for (const run of runs.values()) {
        run.controller.abort();
      }
      while (pending.size) {
        await Promise.allSettled(pending);
      }
    },
    async revokeProfile(profileId: string) {
      deniedProfiles.add(profileId);
      options.providerRelay?.invalidate({ profileId });
      for (const run of runs.values()) {
        if (run.profileId === profileId) {
          run.controller.abort();
        }
      }
      return updateCanonicalUserProfileAccess({ action: "revoke", profileId }, { env: chats.env });
    },
  };
}
