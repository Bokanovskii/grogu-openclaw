import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import {
  isProtectedAgentSelection,
  isProtectedCreateChat,
  isProtectedAccountName,
  isProtectedDirectorySettings,
  isProtectedRenew,
  isProtectedSteer,
  isProtectedTurnRequest,
  type ProtectedAgentCatalogDto,
  type ProtectedAgentSelectionResponse,
  type ProtectedChatStorage,
  type ProtectedTurnEvent,
} from "@openclaw/gateway-protocol/protected";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildSandboxHostDocument } from "../../src/agents/sandbox-host.js";
import { withTranscriptWriteBudget } from "../../src/agents/sessions/transcript-write-budget.js";
import { readCanvasDocumentHtmlSource } from "../../src/canvas/documents.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import { createLazyRuntimeModule } from "../../src/shared/lazy-runtime.js";
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
import {
  bindProtectedProfile,
  editProtectedAccessRequest,
  listPendingProtectedPolicy,
  listProtectedAdmissions,
  listProtectedAccessRequests,
  readProtectedAccessRequest,
  removeProtectedAdmission,
  retryProtectedPolicy,
  setProtectedRequestStatus,
  submitProtectedAccessRequest,
  withdrawProtectedAccessRequest,
} from "./admission-store.js";
import { createProtectedAgentCatalog, type ProtectedAgentExtension } from "./agents.js";
import {
  createProtectedAutomationCatalog,
  validateProtectedAutomationDraft,
} from "./automations.js";
import { createStorageAdmission, measureProtectedStorage, type StorageLimits } from "./capacity.js";
import {
  chatArtifactsDirectory,
  chatWidgetsDirectory,
  removeChatFilesDirectory,
} from "./chat-files.js";
import { createProtectedChats } from "./chats.js";
import { ProtectedError, publicError } from "./errors.js";
import {
  protectedAccessProofPath,
  resolveProtectedProfile,
  type ProtectedIdentityVerifier,
} from "./identity.js";
import { fetchProtectedCopilotModels, withThinking } from "./models.js";
import type { createProviderRelay } from "./provider-relay.js";
import { protectedTurnTimeoutMs, subjectPattern } from "./settings.js";
import { widgetIdPattern } from "./tool-events.js";
import { createProtectedTurnTiming } from "./turn-timing.js";
import type { ProtectedTurn, ProtectedTurns, TurnInput } from "./turns.js";
import { listProtectedUsage, recordProtectedUsage } from "./usage-store.js";

const base = "/api/protected/v1";
const commonHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const maxBodyBytes = 48_000;
const directoryPreference = "grogu.protected.directory";
const loadProtectedPush = createLazyRuntimeModule(() => import("./push.js"));
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
function accessReceipt(request: Request): string | undefined {
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("protected_access_receipt="));
  const value = cookie?.slice("protected_access_receipt=".length);
  return value && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}

export function createProtectedHttp(options: {
  origin: string;
  stateDir: string;
  accessIssuer: string;
  ownerSubject?: string;
  onRemoveSubject?: (subject: string) => void;
  onPolicyChanged?: () => void;
  isPolicyInFlight?: (id: string) => boolean;
  verifyIdentity: ProtectedIdentityVerifier;
  directory: { issuer: string; allowedSubjects: readonly string[] };
  answerAccessProof?: (request: Request) => Promise<Response>;
  usersRoot: Parameters<typeof createAuthorizedUserFiles>[0]["usersRoot"];
  encryption?: Parameters<typeof createAuthorizedUserFiles>[0]["encryption"];
  turns: ProtectedTurns;
  agentExtensions?: readonly ProtectedAgentExtension[];
  providerRelay?: ReturnType<typeof createProviderRelay>;
  maxChatsPerUser: number;
  maxFileBytes: number;
  storageLimits?: StorageLimits;
}) {
  if (new URL(options.origin).origin !== options.origin) {
    throw new TypeError("Configure the exact protected client origin.");
  }
  const agentCatalog = createProtectedAgentCatalog(options.agentExtensions);
  const automationCatalog = createProtectedAutomationCatalog({
    agents: { defaultAgentId: agentCatalog.defaultAgentId, agents: agentCatalog.list() },
    models: options.turns.models,
    calendarDraftValidationAvailable: true,
  });
  const chats = createProtectedChats({ ...options, agentCatalog });
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
  const invalidateProfile = (profileId: string) => {
    deniedProfiles.add(profileId);
    options.providerRelay?.invalidate({ profileId });
    for (const run of runs.values()) {
      if (run.profileId === profileId) {
        run.controller.abort();
      }
    }
  };
  let publicSubmissionWindow = 0;
  let publicSubmissionCount = 0;
  let publicApiWindow = 0;
  let publicApiCount = 0;
  const rateKey = randomBytes(32);
  const publicSources = new Map<string, { startedAt: number; count: number }>();
  const publicApiSources = new Map<string, { startedAt: number; count: number }>();
  const sourceKey = (request: Request) => {
    const address = request.headers.get("cf-connecting-ip")?.trim() ?? "";
    const version = isIP(address);
    const normalized =
      version === 6 ? new URL(`http://[${address}]/`).hostname : version === 4 ? address : "";
    return normalized ? createHmac("sha256", rateKey).update(normalized).digest("hex") : "unknown";
  };
  const incrementSource = (
    sources: Map<string, { startedAt: number; count: number }>,
    request: Request,
    now: number,
    lifetimeMs: number,
  ) => {
    for (const [source, window] of sources) {
      if (now - window.startedAt >= lifetimeMs) {
        sources.delete(source);
      }
    }
    const key = sourceKey(request);
    const bucket = sources.has(key) || sources.size < 256 ? key : "unknown";
    const window = sources.get(bucket) ?? { startedAt: now, count: 0 };
    window.count += 1;
    sources.set(bucket, window);
    return window.count;
  };
  const limitPublicSubmission = (request: Request) => {
    const now = Date.now();
    if (now - publicSubmissionWindow >= 60_000) {
      publicSubmissionWindow = now;
      publicSubmissionCount = 0;
    }
    if (++publicSubmissionCount > 60) {
      throw new ProtectedError(429, "request_limit", "Try again later.");
    }
    if (incrementSource(publicSources, request, now, 3_600_000) > 10) {
      throw new ProtectedError(429, "request_limit", "Try again later.");
    }
  };
  const limitPublicApi = (request: Request) => {
    const now = Date.now();
    if (now - publicApiWindow >= 60_000) {
      publicApiWindow = now;
      publicApiCount = 0;
    }
    if (++publicApiCount > 600 || incrementSource(publicApiSources, request, now, 60_000) > 60) {
      throw new ProtectedError(429, "request_limit", "Try again later.");
    }
  };

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
      const publicBase = "/request-access/api";
      if (
        !path.startsWith(`${base}/`) &&
        path !== publicBase &&
        !path.startsWith(`${publicBase}/`)
      ) {
        return notFound();
      }
      const pathname = path.startsWith(`${base}/`) ? path.slice(base.length) : "";
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
      if (path === publicBase || path.startsWith(`${publicBase}/`)) {
        limitPublicApi(request);
      }
      if (path === `${publicBase}/status` && method === "GET") {
        const receipt = accessReceipt(request);
        if (!receipt) {
          return json({ request: null }, 200);
        }
        const requestStatus = await readProtectedAccessRequest(options.stateDir, receipt);
        const {
          policyState,
          subject: _subject,
          profileId: _profileId,
          ...publicRequest
        } = requestStatus ?? {};
        return json({
          request:
            requestStatus === undefined
              ? null
              : requestStatus.status === "approved" && policyState !== "synced"
                ? { ...publicRequest, status: "approving" }
                : publicRequest,
        });
      }
      if (path === publicBase && method === "POST") {
        limitPublicSubmission(request);
        const value = await body(request);
        const email = text(value.email, 254);
        const name = text(value.name, 80);
        const note = value.note;
        if (typeof note !== "string" || note.length > 1000) {
          return invalid();
        }
        const result = await submitProtectedAccessRequest(options.stateDir, {
          email,
          name,
          note,
          receipt: accessReceipt(request),
        });
        if (!result) {
          throw new ProtectedError(429, "request_limit", "Try again later.");
        }
        const headers = new Headers(commonHeaders);
        headers.set(
          "set-cookie",
          `protected_access_receipt=${result.receipt}; Max-Age=31536000; Path=/request-access; HttpOnly; Secure; SameSite=Strict`,
        );
        if (result.created) {
          void track(
            loadProtectedPush()
              .then(({ notifyProtectedAccessRequest }) =>
                notifyProtectedAccessRequest({
                  stateDir: options.stateDir,
                  issuer: options.accessIssuer,
                  ownerSubject: options.ownerSubject,
                }),
              )
              .catch(() => {
                process.stderr.write("Alcove could not deliver a new-request notification.\n");
              }),
          );
        }
        return Response.json({ accepted: true }, { status: 201, headers });
      }
      if (path === `${publicBase}/edit` && method === "POST") {
        const receipt = accessReceipt(request);
        if (!receipt) {
          throw new ProtectedError(401, "receipt_required", "Sign in with this browser's receipt.");
        }
        const current = await readProtectedAccessRequest(options.stateDir, receipt);
        if (!current || (current.status !== "open" && current.status !== "denied")) {
          throw new ProtectedError(404, "request_not_found", "Request not found.");
        }
        const value = await body(request);
        const name = text(value.name, 80);
        const note = value.note;
        if (typeof note !== "string" || note.length > 1000) {
          return invalid();
        }
        const updated = await editProtectedAccessRequest(options.stateDir, {
          receipt,
          name,
          note,
        });
        if (updated === "rate_limit") {
          throw new ProtectedError(429, "edit_limit", "Try again later.");
        }
        if (!updated) {
          throw new ProtectedError(404, "request_not_found", "Request not found.");
        }
        return json({ request: { id: updated.id, status: updated.status } });
      }
      if (path === `${publicBase}/withdraw` && method === "POST") {
        const receipt = accessReceipt(request);
        if (!receipt) {
          throw new ProtectedError(401, "receipt_required", "Sign in with this browser's receipt.");
        }
        const withdrawn = await withdrawProtectedAccessRequest(options.stateDir, receipt);
        if (!withdrawn) {
          throw new ProtectedError(404, "request_not_found", "Request not found.");
        }
        return noContent();
      }
      if (path === publicBase || path.startsWith(`${publicBase}/`)) {
        return notFound();
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
      const isOwner =
        identity.issuer === options.accessIssuer &&
        options.ownerSubject !== undefined &&
        identity.subject === options.ownerSubject;
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
      await bindProtectedProfile(options.stateDir, {
        issuer: identity.issuer,
        subject: identity.subject,
        profileId: profile.id,
      });
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
      if (pathname === "/admin/push/key" && method === "GET") {
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        await revalidate();
        const { protectedPushPublicKey } = await loadProtectedPush();
        return json({ publicKey: await protectedPushPublicKey(options.stateDir, assertCurrent) });
      }
      if (pathname === "/admin/push/subscribe" && method === "POST") {
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        const data = await body(request);
        if (!isRecord(data.keys)) {
          return invalid();
        }
        await revalidate();
        const { subscribeProtectedPush } = await loadProtectedPush();
        const subscriptionId = await subscribeProtectedPush({
          stateDir: options.stateDir,
          profileId: profile.id,
          endpoint: text(data.endpoint, 2048),
          keys: { p256dh: text(data.keys.p256dh, 512), auth: text(data.keys.auth, 512) },
          assertCurrent,
        });
        return json({ subscriptionId });
      }
      if (pathname === "/admin/push/unsubscribe" && method === "POST") {
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        const data = await body(request);
        await revalidate();
        const { unsubscribeProtectedPush } = await loadProtectedPush();
        const removed = await unsubscribeProtectedPush({
          stateDir: options.stateDir,
          profileId: profile.id,
          endpoint: text(data.endpoint, 2048),
          assertCurrent,
        });
        return json({ removed });
      }
      if (pathname === "/admin/requests" && method === "GET") {
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        await revalidate();
        const requests = await listProtectedAccessRequests(options.stateDir);
        const { blocked: policyBlocked, blockedPersonId } = await listPendingProtectedPolicy(
          options.stateDir,
        );
        assertCurrent();
        return json({ requests, policyBlocked, blockedPersonId });
      }
      if (pathname === "/admin/people" && method === "GET") {
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        await revalidate();
        const people = await listProtectedAdmissions(options.stateDir);
        assertCurrent();
        return json({ people });
      }
      const usagePerson = /^\/admin\/people\/([a-f0-9-]{36})\/usage$/u.exec(pathname);
      if (usagePerson && method === "GET") {
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        await revalidate();
        const people = await listProtectedAdmissions(options.stateDir);
        const person = people.find((entry) => entry.id === usagePerson[1]);
        if (!person) {
          throw new ProtectedError(404, "person_not_found", "Person not found.");
        }
        const daily = person.profileId
          ? await listProtectedUsage(options.stateDir, person.profileId, Date.now())
          : [];
        const storage = person.profileId
          ? await measureProtectedStorage(
              {
                usersRoot: options.usersRoot,
                chats,
                maxFileBytes: options.maxFileBytes,
                encryption: options.encryption,
              },
              person.profileId,
              assertCurrent,
              false,
            )
          : undefined;
        assertCurrent();
        return json({
          daily,
          chatCount: storage?.chatCount ?? null,
          approximateStorageBytes: storage?.personalBytes ?? null,
          lastActiveAt: person.lastActiveAt ?? null,
          lastChatActivityAt: storage?.lastChatActivityAt ?? null,
        });
      }
      const adminRequest = /^\/admin\/requests\/([a-f0-9-]{36})\/(approve|deny)$/u.exec(pathname);
      if (adminRequest && method === "POST") {
        if (!isOwner || !options.ownerSubject) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        await revalidate();
        const status = adminRequest[2] === "approve" ? "approved" : "denied";
        const requestStatus = await setProtectedRequestStatus(
          options.stateDir,
          {
            id: adminRequest[1]!,
            status,
            issuer: options.accessIssuer,
          },
          assertCurrent,
          () => options.onPolicyChanged?.(),
        );
        if (requestStatus === "admission_conflict") {
          throw new ProtectedError(
            409,
            "admission_conflict",
            "This person was removed or belongs to a different Access issuer.",
          );
        }
        if (!requestStatus) {
          throw new ProtectedError(404, "request_not_found", "Request not found.");
        }
        return json({
          request: requestStatus,
          ...(status === "approved" ? { policy: "sync_pending" } : {}),
        });
      }
      const adminPerson = /^\/admin\/people\/([a-f0-9-]{36})\/remove$/u.exec(pathname);
      if (adminPerson && method === "POST") {
        if (!isOwner || !options.ownerSubject) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        await revalidate();
        const person = await removeProtectedAdmission(
          options.stateDir,
          { id: adminPerson[1]!, issuer: options.accessIssuer, ownerSubject: options.ownerSubject },
          assertCurrent,
          (subject, profileId) => {
            if (subject) {
              options.onRemoveSubject?.(subject);
            }
            if (profileId) {
              invalidateProfile(profileId);
            }
          },
          () => options.onPolicyChanged?.(),
        );
        if (person === "owner_protected") {
          throw new ProtectedError(403, "owner_protected", "The owner cannot be removed.");
        }
        if (!person) {
          throw new ProtectedError(404, "person_not_found", "Person not found.");
        }
        if (person.profileId) {
          await updateCanonicalUserProfileAccess(
            { action: "revoke", profileId: person.profileId },
            { env: chats.env, assertCurrent },
          );
        }
        return json({
          person,
          policy: person.email ? "removal_pending" : "identity_unavailable",
        });
      }
      const retryPolicy = /^\/admin\/people\/([a-f0-9-]{36})\/retry-policy$/u.exec(pathname);
      if (retryPolicy && method === "POST") {
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        await revalidate();
        const assertRetryCurrent = () => {
          assertCurrent();
          if (options.isPolicyInFlight?.(retryPolicy[1]!)) {
            throw new ProtectedError(
              409,
              "policy_in_progress",
              "The policy update is still running.",
            );
          }
        };
        assertRetryCurrent();
        const queued = await retryProtectedPolicy(
          options.stateDir,
          { id: retryPolicy[1]!, issuer: options.accessIssuer },
          assertRetryCurrent,
          () => options.onPolicyChanged?.(),
        );
        if (!queued) {
          throw new ProtectedError(
            409,
            "policy_not_retryable",
            "This policy update cannot be retried.",
          );
        }
        return json({ queued: true });
      }
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
        const { chat, usage } = await chats.readWithUsage(authority, id);
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
        return { chat, usage };
      };
      if (pathname === "/me" && method === "GET") {
        return json({
          user: { id: profile.id, displayName: profile.displayName ?? "User" },
          disclosure:
            "Your chats and generated files are stored on the server until you delete them. The server operator can read them. They are stored unencrypted, with no backups, so a disk failure can lose your history. The server records your last app activity, including automatic refreshes, and keeps daily message counts, token totals, model names, and error counts for up to 90 days. The server uses personal provider credentials only for the current request. The service can fetch known public URLs, but it does not search the web.",
          models: options.turns.models.map((model) => withThinking(model)),
          capabilities: {
            copilotConnect: options.providerRelay !== undefined,
            openaiConnect: options.providerRelay !== undefined,
            admin: isOwner,
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
        const directorySubjects = options.directory.allowedSubjects.filter((subject) =>
          subjectPattern.test(subject),
        );
        const result = await readVerifiedUserProfileDirectory(
          {
            issuer: options.directory.issuer,
            subjects: directorySubjects,
            preferenceKey: directoryPreference,
            after: cursor,
            limit: 100,
          },
          { env: chats.env },
        );
        await revalidate();
        const currentSubjects = new Set(options.directory.allowedSubjects);
        if (
          !result.isCurrent() ||
          directorySubjects.some((subject) => !currentSubjects.has(subject)) ||
          result.people.some((person) => deniedProfiles.has(person.id))
        ) {
          throw new ProtectedError(409, "directory_changed", "The directory changed. Try again.");
        }
        return json({ people: result.people, nextCursor: result.nextCursor });
      }
      if (pathname === "/agents" && method === "GET") {
        await revalidate();
        const catalog: ProtectedAgentCatalogDto = {
          defaultAgentId: agentCatalog.defaultAgentId,
          agents: agentCatalog.list(),
        };
        return json(catalog);
      }
      if (pathname === "/automations/catalog" && method === "GET") {
        if (!automationCatalog) {
          return notFound();
        }
        await revalidate();
        return json(automationCatalog);
      }
      if (pathname === "/automations/drafts/validate" && method === "POST") {
        if (!automationCatalog) {
          return notFound();
        }
        const draft = await body(request);
        assertCurrent();
        const result = validateProtectedAutomationDraft(draft, automationCatalog);
        await revalidate();
        assertCurrent();
        return json(result);
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
      if (pathname === "/providers/github-copilot/models" && method === "POST") {
        requireProfile();
        const data = await body(request);
        if (!isProtectedRenew(data)) {
          return invalid();
        }
        const models = await fetchProtectedCopilotModels(data.credential, {
          signal: request.signal,
          revalidate,
        });
        return json({ models: models.map(({ model }) => model) });
      }
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
      if (pathname === "/storage/chats" && method === "GET") {
        const items: ProtectedChatStorage["chats"] = [];
        const { personalBytes } = await measureProtectedStorage(
          { ...options, chats },
          profile.id,
          assertCurrent,
          false,
          (item) => items.push(item),
        );
        await revalidate();
        return json({
          limitBytes: options.storageLimits?.userBytes ?? null,
          usedBytes: personalBytes,
          chats: items.toSorted(
            (a, b) => b.approximateBytes - a.approximateBytes || a.id.localeCompare(b.id),
          ),
        } satisfies ProtectedChatStorage);
      }
      if (pathname === "/chats" && method === "GET") {
        const result = await chats.list(authority);
        await revalidate();
        for (const chat of result) {
          const active = runs.get(chat.id);
          if (active?.profileId === profile.id && active.sessionHash === identity.sessionId) {
            chat.activeRun = { id: active.id };
          }
        }
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
          const selectedAgentId = data.selectedAgentId ?? agentCatalog.defaultAgentId;
          if (!agentCatalog.get(selectedAgentId)) {
            throw new ProtectedError(422, "agent_unavailable", "This agent is not available.");
          }
          await revalidate();
          storage = await admitStorage?.(profile.id, assertCurrent, "create");
          const chat = await chats.create(
            authority,
            data.title === undefined ? undefined : text(data.title, 160),
            selectedAgentId,
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
          result.push((await readChat(chat.id)).chat);
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
        const { chat, usage } = await readChat(id);
        await revalidate();
        const active = runs.get(id);
        return json({
          chat,
          ...(usage ? { usage } : {}),
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
            await files((owned) => removeChatFilesDirectory(owned, id));
            await revalidate();
          });
          await revalidate();
          return noContent();
        } finally {
          mutations.delete(id);
        }
      }
      if (rest === "agent" && method === "PATCH") {
        const data = await body(request);
        if (!isProtectedAgentSelection(data)) {
          return invalid();
        }
        if (!agentCatalog.get(data.selectedAgentId)) {
          throw new ProtectedError(422, "agent_unavailable", "This agent is not available.");
        }
        const version = request.headers.get("if-match");
        if (!version) {
          throw new ProtectedError(
            428,
            "version_required",
            "Reload the chat before changing its agent.",
          );
        }
        if (runs.has(id) || mutations.has(id)) {
          throw new ProtectedError(409, "busy", "Stop the current work before changing its agent.");
        }
        mutations.add(id);
        try {
          await revalidate();
          await chats.selectAgent(authority, id, version, data.selectedAgentId);
          const { chat } = await readChat(id);
          await revalidate();
          const result: ProtectedAgentSelectionResponse = { chat };
          return json(result);
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
        const fixedModel = options.turns.models.find(
          (candidate) =>
            candidate.provider === data.provider &&
            (data.model === undefined || candidate.id === data.model),
        );
        const credential = data.credential;
        if (credential !== undefined && (!isRecord(credential) || data.provider === "sparky")) {
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
        let copilotModel:
          | Awaited<ReturnType<typeof fetchProtectedCopilotModels>>[number]
          | undefined;
        if (data.provider === "github-copilot") {
          if (!credential) {
            throw new ProtectedError(
              401,
              "provider_credential_required",
              "Connect this provider first.",
            );
          }
          const models = await fetchProtectedCopilotModels(credential, {
            signal: request.signal,
            revalidate,
          });
          const requested = data.model ?? fixedModel?.id;
          copilotModel = models.find(({ model }) => model.id === requested);
        }
        const model =
          copilotModel?.model ??
          (data.provider === "github-copilot" ? undefined : fixedModel && withThinking(fixedModel));
        if (!model) {
          throw new ProtectedError(422, "model_unavailable", "This model is not available.");
        }
        if (data.thinking !== undefined && !model.thinking?.levels.includes(data.thinking)) {
          throw new ProtectedError(
            422,
            "thinking_unavailable",
            "This reasoning level is not available.",
          );
        }
        const input: TurnInput = {
          provider: model.provider,
          model: model.id,
          text: text(data.text, 16_000),
          ...(data.mentions ? { mentions: data.mentions } : {}),
          thinking: data.thinking ?? model.thinking?.default,
          ...(copilotModel ? { copilotModel } : {}),
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
        // Reserve the chat while its persisted selection and turn storage are admitted.
        mutations.add(id);
        const admission = await (async () => {
          let storage: Awaited<ReturnType<NonNullable<typeof admitStorage>>> | undefined;
          try {
            const profileAuthority = await prepareCurrentUserProfileAliases(profile.id, {
              env: chats.env,
            });
            if (profileAuthority.profileId !== profile.id) {
              unauthorized();
            }
            profileAuthority.assertCurrent();
            // Storage charges continue after the client disconnects, so they check only the grant.
            storage = await admitStorage?.(profile.id, assertGrant, "turn");
            if (shutdown.signal.aborted || runs.has(id)) {
              throw new ProtectedError(409, "busy", "A turn is already running in this chat.");
            }
            if (request.signal.aborted) {
              request.signal.throwIfAborted();
            }
            const currentEntry = await chats.readEntry(authority, id);
            const selectedAgentId = currentEntry.protectedAgentId ?? agentCatalog.defaultAgentId;
            const selectedAgent = agentCatalog.get(selectedAgentId);
            if (!selectedAgent) {
              throw new ProtectedError(
                422,
                "agent_unavailable",
                "This chat's agent is unavailable.",
              );
            }
            const mentionedAgents = (data.mentions ?? []).map((mention) => {
              const agent = agentCatalog.get(mention.agentId);
              if (!agent || agent.id === selectedAgentId) {
                throw new ProtectedError(
                  422,
                  "agent_unavailable",
                  "One or more mentioned agents are unavailable.",
                );
              }
              return agent;
            });
            if (!currentEntry.sessionId) {
              throw new ProtectedError(
                409,
                "session_unavailable",
                "This chat cannot start a request-scoped agent.",
              );
            }
            await revalidate();
            profileAuthority.assertCurrent();
            if (shutdown.signal.aborted || runs.has(id)) {
              throw new ProtectedError(409, "busy", "A turn is already running in this chat.");
            }
            const run: Run = {
              id: randomUUID(),
              ...session,
              controller: new AbortController(),
              steering: new Map(),
            };
            runs.set(id, run);
            return {
              run,
              selectedAgent,
              mentionedAgents,
              storage,
              profileAuthority,
              parentLifecycleRevision: currentEntry.lifecycleRevision ?? null,
              parentSessionId: currentEntry.sessionId,
            };
          } catch (error) {
            storage?.release();
            throw error;
          } finally {
            mutations.delete(id);
          }
        })();
        const {
          run,
          selectedAgent,
          mentionedAgents,
          storage,
          profileAuthority,
          parentLifecycleRevision,
          parentSessionId,
        } = admission;
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
          profileAuthority.assertCurrent();
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
        const parentSessionKey = chats.scope(runAuthority, id).sessionKey;
        const profileSessionPrefix = chats.scope(runAuthority, "").sessionKey;
        const ownedChildSessionKeys = new Set<string>();
        const saveChildResult: ProtectedTurn["saveChildResult"] = async (result) => {
          await checkRun();
          const save = () =>
            chats.saveChildResult(runAuthority, id, {
              ...result,
              parentLifecycleRevision,
            });
          await (storage ? withTranscriptWriteBudget(storage.charge, save) : save());
          await checkRun();
        };
        const sessionAccess = {
          creatorProfileId: profile.id,
          assertCurrent: assertRun,
          revalidate: checkRun,
          signal,
          resolve: async ({
            requesterSessionKey,
            reference,
          }: {
            requesterSessionKey: string;
            reference: string;
          }) => {
            await checkRun();
            if (
              requesterSessionKey !== parentSessionKey &&
              !ownedChildSessionKeys.has(requesterSessionKey)
            ) {
              return undefined;
            }
            const targetId = reference.startsWith(profileSessionPrefix)
              ? reference.slice(profileSessionPrefix.length)
              : reference;
            try {
              const entry = await chats.readEntry(runAuthority, targetId);
              await checkRun();
              return {
                sessionKey: chats.scope(runAuthority, targetId).sessionKey,
                sessionId: entry.sessionId,
                agentId: chats.agentId,
              };
            } catch (error) {
              if (error instanceof ProtectedError && error.status === 404) {
                await checkRun();
                return undefined;
              }
              throw error;
            }
          },
        };
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
              let tokens: number | null = null;
              let messageCount: number | null = null;
              let failed = true;
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
                        target: {
                          ...chats.scope(runAuthority, id),
                          nativeSessionId: parentSessionId,
                          lifecycleRevision: parentLifecycleRevision,
                        },
                        input,
                        mentionedAgents,
                        agent: selectedAgent,
                        sessionAccess,
                        files: storage?.files(owned) ?? owned,
                        signal,
                        assertCurrent: assertRun,
                        revalidate: checkRun,
                        markTiming: timing.mark,
                        saveChildResult,
                        cleanupChildFiles: (sessionId) =>
                          chats.removeTransientFiles(
                            {
                              profileId: profile.id,
                              assertCurrent: () => profileAuthority.assertCurrent(),
                            },
                            sessionId,
                          ),
                        chargeChildCreation: () => storage?.chargeChatCreation(),
                        registerChildSession: (sessionKey) => {
                          ownedChildSessionKeys.add(sessionKey);
                          return () => ownedChildSessionKeys.delete(sessionKey);
                        },
                        childResult: (result) => {
                          send({
                            type: "child-result",
                            runId: result.runId,
                            agentId: result.agentId,
                            text: result.text,
                          });
                        },
                        usage: (value) => {
                          tokens = value;
                        },
                        delta: async (value) => {
                          send({ type: "delta", text: value });
                        },
                        reasoning: async (value) => {
                          send({ type: "reasoning", text: value });
                        },
                        activity: async (item) => {
                          send({ type: "activity", ...item });
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
                const { chat, usage } = await chats.readWithUsage(runAuthority, id);
                await checkRun();
                const newMessages = chat.messages.slice(before.messages.length);
                messageCount = newMessages.length;
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
                failed = false;
                if (usage && usage.provider === input.provider && usage.model === input.model) {
                  send({
                    type: "usage",
                    contextTokens: usage.contextTokens,
                    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                    ...(usage.outputTokens !== undefined
                      ? { outputTokens: usage.outputTokens }
                      : {}),
                  });
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
                try {
                  await recordProtectedUsage(options.stateDir, {
                    runId: run.id,
                    profileId: profile.id,
                    model: `${input.provider}/${input.model}`,
                    messages: messageCount,
                    tokens,
                    failed,
                    now: Date.now(),
                  });
                } catch {
                  process.stderr.write(
                    "Protected usage could not be recorded for a completed run.\n",
                  );
                }
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
    recoverTransient(assertCurrent: () => void) {
      return chats.recoverTransient(assertCurrent);
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
      invalidateProfile(profileId);
      return updateCanonicalUserProfileAccess({ action: "revoke", profileId }, { env: chats.env });
    },
  };
}
