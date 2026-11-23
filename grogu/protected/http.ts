import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import {
  isProtectedAgentSelection,
  isProtectedAutomationPatchRequest,
  isProtectedCreateChat,
  isProtectedAccountIcon,
  isProtectedAccountName,
  isProtectedDirectorySettings,
  isProtectedRenew,
  isProtectedSteer,
  isProtectedTurnRequest,
  type ProtectedAgentCatalogDto,
  type ProtectedAgentCatalogV1,
  type ProtectedAgentSelectionResponse,
  type ProtectedAutomationCatalog,
  type ProtectedAutomationCatalogV1,
  type ProtectedAutomationListResponse,
  type ProtectedAutomationResponse,
  type ProtectedChatStorage,
  type ProtectedMessage,
  type ProtectedTurnRequest,
} from "@openclaw/gateway-protocol/protected";
import {
  isProtectedAuthoringTurnRequest,
  type ProtectedAuthoringTurnEvent,
  type ProtectedAuthoringTurnRequest,
  type ProtectedAutomationAuthoringResponse,
} from "@openclaw/gateway-protocol/protected-authoring";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ALCOVE_CONTENT_STYLES } from "../../packages/widget-host/src/styles.js";
import type { TerminalModelRequestMetadata } from "../../src/agents/model-request-telemetry.js";
import { buildSandboxHostDocument } from "../../src/agents/sandbox-host.js";
import { withTranscriptWriteBudget } from "../../src/agents/sessions/transcript-write-budget.js";
import { readCanvasDocumentHtmlSource } from "../../src/canvas/documents.js";
import { matchesHttpIfNoneMatch } from "../../src/gateway/http-conditional.js";
import { createAuthorizedUserFiles } from "../../src/infra/authorized-user-files.js";
import { FsSafeError } from "../../src/infra/fs-safe.js";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { createLazyRuntimeModule } from "../../src/shared/lazy-runtime.js";
import { protectedFeedbackRetentionMs } from "../../src/state/protected-feedback.js";
import {
  getCanonicalUserPreferences,
  getUserPreferenceValues,
  setCanonicalUserPreferences,
} from "../../src/state/user-preferences.js";
import { updateCanonicalUserProfileAccess } from "../../src/state/user-profile-access.js";
import {
  prepareCurrentUserProfileAliases,
  readVerifiedUserProfileDirectory,
} from "../../src/state/user-profile-reads.js";
import {
  clearCanonicalUserProfileAvatar,
  setCanonicalUserProfileAvatar,
  setCanonicalUserProfileDisplayName,
} from "../../src/state/user-profile-writes.js";
import { createProfileAvatarReader } from "../../src/state/user-profiles-avatar.js";
import { formatUserProfileAvatarEtag } from "../../src/state/user-profiles.js";
import { createSqliteStorageValueEncryptionFromEnvironment } from "../../src/storage/sqlite-encryption.js";
import {
  bindProtectedProfile,
  editProtectedAccessRequest,
  listPendingProtectedPolicy,
  listProtectedAdmissions,
  listProtectedAccessRequests,
  readProtectedAccessRequest,
  removeProtectedAdmission,
  readProtectedProfileStorageLimit,
  readProtectedStorageLimit,
  retryProtectedPolicy,
  setProtectedRequestStatus,
  setProtectedStorageLimit,
  submitProtectedAccessRequest,
  withdrawProtectedAccessRequest,
} from "./admission-store.js";
import { createProtectedAgentCatalog, type ProtectedAgentExtension } from "./agents.js";
import {
  listProtectedArtifacts,
  listProtectedChatFileCandidates,
  validFilename,
  validGeneratedFilename,
} from "./artifacts.js";
import {
  createProtectedAutomationAuthoringBindings,
  createProtectedAutomationsChatBindings,
  savesDraft,
} from "./automations-chat.js";
import {
  createProtectedAutomationRecord,
  listProtectedAutomationRecords,
  readProtectedAutomationRecord,
  readProtectedAutomationStorageUsage,
  saveProtectedAutomationPatch,
} from "./automations-store.js";
import {
  createProtectedAutomationCatalog,
  validateProtectedAutomationDraft,
} from "./automations.js";
import {
  createStorageAdmission,
  measureProtectedStorage,
  storageEntryOverheadBytes,
  type StorageAdmission,
  type StorageLimits,
} from "./capacity.js";
import {
  chatArtifactsDirectory,
  chatGeneratedArtifactsDirectory,
  chatWidgetsDirectory,
  removeChatFilesDirectory,
} from "./chat-files.js";
import { createProtectedChats } from "./chats.js";
import { clientCapabilitiesVary, hasClientCapability } from "./client-capabilities.js";
import { ProtectedError, publicError } from "./errors.js";
import {
  findProtectedFeedbackSubmission,
  findProtectedFeedbackForResponse,
  listProtectedFeedback,
  listProtectedFeedbackReports,
  listProtectedTelemetry,
  readProtectedFeedbackReport,
  readProtectedFeedbackStorageUsage,
  removeProtectedChatFeedback,
  setProtectedFeedback,
  setProtectedFeedbackReportStatus,
  submitProtectedFeedbackReport,
  type ProtectedProducedFile,
  type ProtectedReportRecord,
  type ProtectedTurnTelemetryInput,
} from "./feedback-store.js";
import {
  iconImageMime,
  iconPreference,
  isIconImage,
  maxIconBytes,
  parseStoredIcon,
  projectIcon,
} from "./icons.js";
import {
  protectedAccessProofPath,
  resolveProtectedProfile,
  type ProtectedIdentityVerifier,
} from "./identity.js";
import type { createProtectedMemberMemory } from "./member-memory.js";
import type { createProtectedMemoryReview } from "./memory-review.js";
import { fetchProtectedCopilotModels, withThinking } from "./models.js";
import type { createProviderRelay } from "./provider-relay.js";
import { captureProtectedReportChatReference, projectProtectedReportChat } from "./report-chat.js";
import { protectedTurnTimeoutMs, subjectPattern } from "./settings.js";
import {
  parseStorageLimitBytes,
  parseStorageLimitVersion,
  storageLimitView,
} from "./storage-limit-route.js";
import { widgetIdPattern } from "./tool-events.js";
import { createProtectedTurnTiming } from "./turn-timing.js";
import type { ProtectedTurn, ProtectedTurns, TurnInput } from "./turns.js";
import { listProtectedUsage, recordProtectedUsage } from "./usage-store.js";
import { buildProtectedWidgetMeasurementDocument } from "./widget-measurement.js";

const base = "/api/protected/v1";
const commonHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const maxBodyBytes = 48_000;
const directoryPreference = "grogu.protected.directory";
const loadProtectedPush = createLazyRuntimeModule(() => import("./push.js"));
const automationsChatCapability = "automations-chat-v1";
const automationsAuthoringCapability = "automations-authoring-v1";
const authoringAgentId = "grogu";
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
function profileJson(data: unknown) {
  return Response.json(data, {
    headers: { ...commonHeaders, vary: clientCapabilitiesVary },
  });
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
async function listChatArtifactFiles(
  files: Awaited<ReturnType<typeof createAuthorizedUserFiles>>,
  chatId: string,
  maxFileBytes: number,
): Promise<ProtectedProducedFile[]> {
  const result: ProtectedProducedFile[] = [];
  for (const candidate of await listProtectedChatFileCandidates(files, chatId)) {
    const { id, displayName: name } = candidate;
    try {
      const info = await files.stat(`${candidate.directory}/${candidate.name}`);
      if (
        info.isFile &&
        info.size <= maxFileBytes &&
        id.length <= 200 &&
        redactFeedbackText(id) === id &&
        redactFeedbackText(name) === name
      ) {
        result.push({ id, name, size: info.size, origin: "produced" });
      }
    } catch (error) {
      if (!(error instanceof FsSafeError && error.code === "not-found")) {
        throw error;
      }
    }
  }
  return result;
}

function assistantResponse(messages: readonly ProtectedMessage[], id: string) {
  return messages.find(
    (message) => message.id === id && message.role === "assistant" && message.status === "complete",
  );
}
const feedbackCategories = new Set(["wrong", "ignored", "broken", "slow", "unsafe", "other"]);
function isFeedbackRating(value: unknown): value is "up" | "down" | null {
  return value === null || value === "up" || value === "down";
}
function isFeedbackCategory(
  value: unknown,
): value is "wrong" | "ignored" | "broken" | "slow" | "unsafe" | "other" {
  return typeof value === "string" && feedbackCategories.has(value);
}
function redactFeedbackText(value: string) {
  return redactSensitiveText(value, { mode: "tools" });
}
function feedbackReportSummary(report: ProtectedReportRecord) {
  return {
    id: report.id,
    status: report.status,
    category: report.category,
    excerpt: redactFeedbackText(report.description).slice(0, 160),
    createdAt: report.createdAt,
    member: {
      personId: report.member.personId,
      displayName: redactFeedbackText(report.member.displayName),
    },
    provider: report.provider,
    model: report.model,
    agentId: report.agentId,
    evidence: report.evidence,
  };
}
type FeedbackReportInput = Pick<
  Parameters<typeof submitProtectedFeedbackReport>[1],
  "submissionId" | "category" | "description"
> & { includeChat: boolean };
function parseFeedbackReportInput(
  input: Record<string, unknown>,
  reportChatCapability: boolean,
): FeedbackReportInput {
  const includeChat = reportChatCapability && input.includeChat === true;
  if (
    Object.keys(input).length !== (includeChat ? 5 : 4) ||
    (!includeChat && input.includeChat !== undefined) ||
    typeof input.submissionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.submissionId,
    ) ||
    !isFeedbackCategory(input.category) ||
    typeof input.description !== "string" ||
    input.description.length > 2000 ||
    (input.category === "other" && !input.description.trim()) ||
    input.includeEvidence !== true
  ) {
    invalid();
  }
  return {
    submissionId: input.submissionId,
    category: input.category,
    description: input.description,
    includeChat,
  };
}
function replayFeedbackReport(responseId: string, prior: { id: string; createdAt: number }) {
  return json({
    report: { id: prior.id, status: "open", createdAt: prior.createdAt },
    feedback: { responseId, rating: "down", reportId: prior.id },
  });
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
function supportsAutomationsChat(request: Request) {
  return hasClientCapability(request.headers, automationsChatCapability);
}

/** Authoring events and routes exist only for clients that negotiated both capabilities. */
function supportsAutomationsAuthoring(request: Request) {
  return (
    supportsAutomationsChat(request) &&
    hasClientCapability(request.headers, automationsAuthoringCapability)
  );
}

export function createProtectedHttp(options: {
  origin: string;
  stateDir: string;
  accessIssuer: string;
  ownerSubject?: string;
  onRemoveSubject?: (subject: string) => void;
  onPolicyChanged?: () => void;
  isPolicyInFlight?: (id: string) => boolean;
  getPolicyStatus?: () => Promise<{ blocked: boolean; blockedPersonId?: string }>;
  verifyIdentity: ProtectedIdentityVerifier;
  directory: { issuer: string; allowedSubjects: readonly string[] };
  answerAccessProof?: (request: Request) => Promise<Response>;
  usersRoot: Parameters<typeof measureProtectedStorage>[0]["usersRoot"];
  encryption?: Parameters<typeof createAuthorizedUserFiles>[0]["encryption"];
  turns: ProtectedTurns;
  agentExtensions?: readonly ProtectedAgentExtension[];
  providerRelay?: ReturnType<typeof createProviderRelay>;
  memberMemory?: ReturnType<typeof createProtectedMemberMemory>;
  memoryReview?: ReturnType<typeof createProtectedMemoryReview>;
  maxChatsPerUser: number;
  maxFileBytes: number;
  storageLimits?: StorageLimits;
}) {
  if (new URL(options.origin).origin !== options.origin) {
    throw new TypeError("Configure the exact protected client origin.");
  }
  const ownedEncryption = createSqliteStorageValueEncryptionFromEnvironment();
  if (!ownedEncryption) {
    throw new Error(
      "Protected storage encryption requires OPENCLAW_PROTECTED_STORAGE_KEY_FILE; provision the private key before starting the service.",
    );
  }
  const encryption = options.encryption ?? ownedEncryption;
  const agentCatalog = createProtectedAgentCatalog(options.agentExtensions);
  const agentRouting = {
    tool: agentCatalog.routeTool,
    briefMaxChars: agentCatalog.routeBriefMaxChars,
    resolve: agentCatalog.getSelectable,
  };
  const chats = createProtectedChats({ ...options, agentCatalog });
  const storageMeasurement = {
    ...options,
    chats,
    automationUsage: (profileId: string, assertCurrent: () => void) =>
      readProtectedAutomationStorageUsage(options.stateDir, profileId, assertCurrent),
    storedDataUsage: (_profileId: string, assertCurrent: () => void) =>
      readProtectedFeedbackStorageUsage(options.stateDir, storageEntryOverheadBytes, assertCurrent),
  };
  const admitStorage = options.storageLimits
    ? createStorageAdmission({ ...storageMeasurement, limits: options.storageLimits })
    : undefined;
  // The effective admit() member limit: null exempts the owner from member and shared budgets;
  // members use their override or the default.
  const storageLimitFor = async (
    profile: { id: string; owner: boolean },
    assertCurrent: () => void,
  ) => {
    if (profile.owner || !options.storageLimits) {
      return null;
    }
    const custom = await readProtectedProfileStorageLimit(options.stateDir, {
      profileId: profile.id,
      issuer: options.accessIssuer,
    });
    assertCurrent();
    return custom ?? options.storageLimits.userBytes;
  };
  const automationCatalog = createProtectedAutomationCatalog({
    agents: { defaultAgentId: agentCatalog.defaultAgentId, agents: agentCatalog.list() },
    models: options.turns.models,
    calendarDraftValidationAvailable: true,
    persistenceAvailable: Boolean(admitStorage),
  });
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
    if (options.memberMemory) {
      void track(options.memberMemory.retire(profileId)).catch(() => {});
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
    const path = new URL(request.url).pathname;
    try {
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
      if (
        (pathname === "/widget-sandbox" || pathname === "/widget-measurement") &&
        method === "GET"
      ) {
        const doc =
          pathname === "/widget-sandbox"
            ? buildSandboxHostDocument({ profile: "protected" }, true, {
                protectedWidgetStyles: ALCOVE_CONTENT_STYLES,
              })
            : buildProtectedWidgetMeasurementDocument();
        const headers = new Headers(doc.headers);
        for (const [name, value] of Object.entries(commonHeaders)) {
          headers.set(name, value);
        }
        return new Response(doc.html, { headers });
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
      const feedbackCapability = hasClientCapability(request.headers, "feedback-v1");
      const reportChatCapability =
        feedbackCapability && hasClientCapability(request.headers, "report-chat-v1");
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
      const storageLimit = (assert: () => void) =>
        storageLimitFor({ id: profile.id, owner: isOwner }, assert);
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
        const { blocked: policyBlocked, blockedPersonId } = await (options.getPolicyStatus
          ? options.getPolicyStatus()
          : listPendingProtectedPolicy(options.stateDir));
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
              storageMeasurement,
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
      const storageLimitPerson = /^\/admin\/people\/([a-f0-9-]{36})\/storage-limit$/u.exec(
        pathname,
      );
      if (storageLimitPerson && ["GET", "PUT", "DELETE"].includes(method)) {
        if (!isOwner || !options.ownerSubject) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        const limits = options.storageLimits;
        const target = {
          id: storageLimitPerson[1]!,
          issuer: options.accessIssuer,
          ownerSubject: options.ownerSubject,
        };
        let next: number | null | undefined;
        let expectedLimitBytes: number | null = null;
        if (method !== "GET") {
          expectedLimitBytes = parseStorageLimitVersion(request.headers.get("if-match"));
          next =
            method === "PUT" && limits ? parseStorageLimitBytes(await body(request), limits) : null;
        }
        await revalidate();
        let limit = limits ? await readProtectedStorageLimit(options.stateDir, target) : undefined;
        if (!limit || !limits) {
          throw new ProtectedError(404, "person_not_found", "Person not found.");
        }
        if (next !== undefined) {
          if (limit.exempt) {
            throw new ProtectedError(409, "limit_exempt", "Admins have no storage limit.");
          }
          await revalidate();
          const result = await setProtectedStorageLimit(
            options.stateDir,
            { ...target, expectedLimitBytes, limitBytes: next },
            assertCurrent,
          );
          if (result === "exempt") {
            throw new ProtectedError(409, "limit_exempt", "Admins have no storage limit.");
          }
          if (result === "version_conflict") {
            throw new ProtectedError(
              409,
              "version_conflict",
              "The storage limit changed. Reload it.",
            );
          }
          if (!result) {
            throw new ProtectedError(404, "person_not_found", "Person not found.");
          }
          limit = result;
        }
        const storage = limit.profileId
          ? await measureProtectedStorage(storageMeasurement, limit.profileId, assertCurrent, false)
          : undefined;
        assertCurrent();
        return json(storageLimitView(limit, limits, storage?.personalBytes ?? null));
      }
      if (pathname === "/admin/reports" && method === "GET") {
        if (!feedbackCapability) {
          return notFound();
        }
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        const url = new URL(request.url);
        const statusValues = url.searchParams.getAll("status");
        if (
          [...url.searchParams.keys()].some((key) => key !== "status") ||
          statusValues.length > 1 ||
          (statusValues[0] !== undefined && statusValues[0] !== "open" && statusValues[0] !== "all")
        ) {
          return invalid();
        }
        await revalidate();
        const result = await listProtectedFeedbackReports(
          options.stateDir,
          statusValues[0] === "all" ? "all" : "open",
        );
        await revalidate();
        return json({
          reports: result.reports.map(feedbackReportSummary),
          openCount: result.openCount,
        });
      }
      const adminReportChat = /^\/admin\/reports\/([^/]+)\/chat$/u.exec(pathname);
      if (adminReportChat && method === "GET") {
        if (!reportChatCapability) {
          return notFound();
        }
        if (!isOwner) {
          return json({ error: "owner_required" }, 403);
        }
        const url = new URL(request.url);
        if (
          [...url.searchParams.keys()].some((key) => key !== "cursor") ||
          url.searchParams.getAll("cursor").length > 1 ||
          adminReportChat[1]!.length > 200
        ) {
          return invalid();
        }
        await revalidate();
        const reportId = adminReportChat[1]!;
        const report = await readProtectedFeedbackReport(options.stateDir, reportId);
        await revalidate();
        if (!report) {
          return notFound();
        }
        if (report.createdAt + protectedFeedbackRetentionMs <= Date.now()) {
          return json({ chat: { state: "expired" } });
        }
        if (report.evidence !== "available") {
          return json({ chat: { state: report.evidence } });
        }
        if (report.chatIncluded !== true) {
          return json({ chat: { state: "unavailable", reason: "not_included" } });
        }
        if (!report.chatReference) {
          return json({ chat: { state: "unavailable", reason: "not_retained" } });
        }
        try {
          const source = await chats.readReportChatSource(
            { profileId: report.member.personId, assertCurrent },
            report.chatId,
            report.chatReference.eventCount,
          );
          await revalidate();
          const chat = projectProtectedReportChat({
            ...source,
            reference: report.chatReference,
            responseId: report.responseId,
            reportedFileIds: report.files.map((file) => file.id),
            ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
          });
          const current = await readProtectedFeedbackReport(options.stateDir, reportId);
          await revalidate();
          if (!current) {
            return notFound();
          }
          if (current.createdAt + protectedFeedbackRetentionMs <= Date.now()) {
            return json({ chat: { state: "expired" } });
          }
          if (current.evidence !== "available") {
            return json({ chat: { state: current.evidence } });
          }
          return json({ chat });
        } catch (error) {
          if (!(error instanceof ProtectedError && error.status === 404)) {
            throw error;
          }
          const current = await readProtectedFeedbackReport(options.stateDir, reportId);
          await revalidate();
          if (!current) {
            return notFound();
          }
          if (current.createdAt + protectedFeedbackRetentionMs <= Date.now()) {
            return json({ chat: { state: "expired" } });
          }
          return json({
            chat: {
              state: current.evidence === "member_removed" ? "member_removed" : "deleted",
            },
          });
        }
      }
      const adminReport = /^\/admin\/reports\/([^/]+)$/u.exec(pathname);
      if (adminReport && (method === "GET" || method === "PATCH")) {
        if (!feedbackCapability) {
          return notFound();
        }
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        const reportId = adminReport[1]!;
        if (reportId.length > 200) {
          return notFound();
        }
        if (method === "PATCH") {
          const input = await body(request);
          if (
            Object.keys(input).length !== 1 ||
            (input.status !== "open" && input.status !== "reviewed")
          ) {
            return invalid();
          }
          await revalidate();
          const updated = await setProtectedFeedbackReportStatus(
            options.stateDir,
            reportId,
            input.status,
            Date.now(),
          );
          await revalidate();
          if (!updated) {
            return json({ error: "not_found" }, 404);
          }
          return json({ report: feedbackReportSummary(updated) });
        }
        await revalidate();
        const report = await readProtectedFeedbackReport(options.stateDir, reportId);
        await revalidate();
        if (!report) {
          return json({ error: "not_found" }, 404);
        }
        let evidence:
          | {
              state: "available";
              prompt: string;
              response: string;
              sources: Array<{ title: string; url: string }>;
              widgets: Array<{ id: string; title: string }>;
              files: Array<{
                id: string;
                name: string;
                size: number;
                origin: "sent" | "produced";
              }>;
            }
          | { state: "deleted" | "member_removed" };
        let evidenceState = report.evidence;
        if (report.evidence === "available") {
          try {
            const { chat } = await chats.readWithUsage(
              { profileId: report.member.personId, assertCurrent },
              report.chatId,
            );
            await revalidate();
            const responseIndex = chat.messages.findIndex(
              (message) =>
                message.id === report.responseId &&
                message.role === "assistant" &&
                message.status === "complete",
            );
            const response = chat.messages[responseIndex];
            const prompt = chat.messages
              .slice(0, responseIndex)
              .toReversed()
              .find((message) => message.role === "user");
            if (!response || !prompt) {
              evidenceState = "deleted";
              evidence = { state: "deleted" };
            } else {
              evidence = {
                state: "available",
                prompt: redactFeedbackText(prompt.text),
                response: redactFeedbackText(response.text),
                sources: (response.sources ?? []).map((source) => ({
                  title: redactFeedbackText(source.title),
                  url: redactFeedbackText(source.url),
                })),
                widgets: (response.widgets ?? []).map((widget) => ({
                  id: widget.id,
                  title: redactFeedbackText(widget.title),
                })),
                files: report.files.map((file) => ({
                  id: redactFeedbackText(file.id),
                  name: redactFeedbackText(file.name),
                  size: file.size,
                  origin: file.origin,
                })),
              };
            }
          } catch (error) {
            if (!(error instanceof ProtectedError && error.status === 404)) {
              throw error;
            }
            await revalidate();
            evidenceState = "deleted";
            evidence = { state: "deleted" };
          }
        } else {
          evidence = { state: report.evidence };
        }
        const summary = feedbackReportSummary({ ...report, evidence: evidenceState });
        return json({
          report: {
            ...summary,
            description: redactFeedbackText(report.description).slice(0, 2000),
            chatId: report.chatId,
            responseId: report.responseId,
            metrics: report.metrics,
            evidence,
          },
        });
      }
      if (pathname === "/admin/telemetry" && method === "GET") {
        if (!feedbackCapability) {
          return notFound();
        }
        if (!isOwner) {
          throw new ProtectedError(403, "owner_required", "Owner access is required.");
        }
        const url = new URL(request.url);
        const allowed = new Set(["days", "member", "feature", "provider", "model", "cursor"]);
        const keys = [...url.searchParams.keys()];
        if (
          keys.some((key) => !allowed.has(key)) ||
          keys.some((key) => url.searchParams.getAll(key).length !== 1)
        ) {
          return invalid();
        }
        const rawDays = url.searchParams.get("days") ?? "7";
        const days =
          rawDays === "1"
            ? 1
            : rawDays === "7"
              ? 7
              : rawDays === "30"
                ? 30
                : rawDays === "90"
                  ? 90
                  : null;
        const member = url.searchParams.get("member") ?? undefined;
        const feature = url.searchParams.get("feature") ?? undefined;
        const provider = url.searchParams.get("provider") ?? undefined;
        const model = url.searchParams.get("model") ?? undefined;
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const validCursor = (value: string) => {
          if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
            return false;
          }
          const decoded = Buffer.from(value, "base64url").toString("utf8");
          const split = decoded.indexOf(":");
          const at = Number(decoded.slice(0, split));
          const id = decoded.slice(split + 1);
          return (
            split > 0 &&
            Number.isSafeInteger(at) &&
            at >= 0 &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) &&
            Buffer.from(decoded, "utf8").toString("base64url") === value
          );
        };
        if (
          days === null ||
          (member !== undefined &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              member,
            )) ||
          (feature !== undefined && feature !== "chat") ||
          (provider !== undefined &&
            provider !== "unattributed" &&
            !/^[a-z][a-z0-9._-]{0,63}$/iu.test(provider)) ||
          (model !== undefined &&
            model !== "unattributed" &&
            !/^[a-z][a-z0-9._-]{0,63}\/.{1,128}$/iu.test(model)) ||
          (cursor !== undefined && !validCursor(cursor))
        ) {
          return invalid();
        }
        await revalidate();
        const result = await listProtectedTelemetry(options.stateDir, {
          now: Date.now(),
          days,
          ...(member !== undefined ? { member } : {}),
          ...(feature !== undefined ? { feature } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        await revalidate();
        return json(result);
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
          (subject, profileId, retiredAutomations) => {
            if (subject) {
              options.onRemoveSubject?.(subject);
            }
            if (profileId) {
              invalidateProfile(profileId);
            }
            admitStorage?.deletedAutomations(retiredAutomations);
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
      const requireProfile = (message = "Reload before using a device credential.") => {
        if (request.headers.get("x-grogu-profile") !== profile.id) {
          throw new ProtectedError(403, "profile_mismatch", message);
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
          encryption,
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
        if (!supportsAutomationsAuthoring(request)) {
          delete chat.authoring;
        }
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
      const saveIcon = async (icon: unknown) => {
        const saved = await setCanonicalUserPreferences(
          profile.id,
          { [iconPreference]: icon },
          { env: chats.env, assertCurrent, requireExactProfile: true },
        );
        if (!saved?.ok) {
          throw new ProtectedError(409, "account_settings_not_saved", "Could not save your icon.");
        }
      };
      const readAccountIcon = async () => {
        const preferences = await getCanonicalUserPreferences(profile.id, [iconPreference], {
          env: chats.env,
          requireExactProfile: true,
        });
        await revalidate();
        if (!preferences) {
          return unauthorized();
        }
        return projectIcon(profile.id, preferences.entries[iconPreference]);
      };
      const profileCapability = hasClientCapability(request.headers, "profile-v1");
      // Setup completes only through a saved canonical name, never a rendered fallback.
      const accountUser = (displayName: string | null, icon: unknown) => {
        const name = displayName?.trim() ?? "";
        return { id: profile.id, displayName: name.slice(0, 40), setupRequired: !name, icon };
      };
      if (pathname === "/me" && method === "GET") {
        const disclosure =
          "Encrypted on Grogu's server. The server admin can read your chats. Your chats and generated files are stored on the server until you delete them, with no backups, so a disk failure can lose your history. The server records your last app activity, including automatic refreshes, and keeps daily message counts, token totals, model names, and error counts for up to 90 days. The server uses personal provider credentials only for the current request. Agents can search the public web through DuckDuckGo, which receives the search words, and can fetch public URLs.";
        return profileJson({
          user: profileCapability
            ? accountUser(profile.displayName, await readAccountIcon())
            : { id: profile.id, displayName: profile.displayName ?? "User" },
          disclosure: feedbackCapability
            ? `${disclosure} If you submit a feedback report, it includes the prompt and response, their sources and widgets, files created during that turn, and request metadata by reference.${reportChatCapability ? " If you explicitly include the full chat, the admin can also read retained messages, tool inputs and outputs, compaction summaries, model metadata and file references up to submission time, never later additions. Secrets and private model reasoning are excluded; file references do not provide downloads." : ""} Report descriptions${reportChatCapability ? " and full-chat references" : ""} are encrypted at rest. Reports and detailed per-turn metadata are kept for 90 days. Deleting a chat or removing a member removes ratings and makes report evidence unavailable; the report description remains visible to the admin until expiry.`
            : disclosure,
          models: options.turns.models.map((model) => withThinking(model)),
          capabilities: {
            copilotConnect: options.providerRelay !== undefined,
            openaiConnect: options.providerRelay !== undefined,
            admin: isOwner,
            ...(feedbackCapability ? { feedback: true, telemetry: isOwner } : {}),
            ...(reportChatCapability ? { reportChat: true } : {}),
            ...(hasClientCapability(request.headers, "memory-v1")
              ? { memory: { review: options.memoryReview !== undefined } }
              : {}),
          },
        });
      }
      const memoryReference = pathname.match(/^\/memory\/([A-Za-z0-9_-]{43})$/u);
      if (method === "GET" && (pathname === "/memory" || memoryReference)) {
        const requireMemoryProfile = () =>
          requireProfile("Reload before viewing the current account's memory.");
        requireMemoryProfile();
        const memoryReview = options.memoryReview;
        if (!memoryReview) {
          throw new ProtectedError(503, "unavailable", "Member memory is not available.");
        }
        const profileAuthority = await prepareCurrentUserProfileAliases(profile.id, {
          env: chats.env,
        });
        if (profileAuthority.profileId !== profile.id) {
          unauthorized();
        }
        const assertMemoryCurrent = () => {
          assertCurrent();
          profileAuthority.assertCurrent();
          requireMemoryProfile();
        };
        assertMemoryCurrent();
        const result = await files(async (owned) => {
          const review = memoryReview.open(profile.id, owned);
          if (!memoryReference) {
            return await review.list();
          }
          const note = await review.read(memoryReference[1]!);
          return note ?? notFound();
        }, assertMemoryCurrent);
        await revalidate();
        assertMemoryCurrent();
        return json(result);
      }
      if (pathname === "/account" && method === "GET") {
        const profileAuthority = await prepareCurrentUserProfileAliases(profile.id, {
          env: chats.env,
        });
        const preferences = await getCanonicalUserPreferences(
          profile.id,
          profileCapability ? [directoryPreference, iconPreference] : [directoryPreference],
          { env: chats.env, requireExactProfile: true },
        );
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
        return profileJson({
          user: profileCapability
            ? accountUser(
                profile.displayName,
                projectIcon(profile.id, preferences.entries[iconPreference]),
              )
            : {
                id: profile.id,
                displayName: (profile.displayName?.trim() || "Family member").slice(0, 40),
              },
          directory: {
            description:
              saved?.hidden && identity.kind !== "development" ? "" : (saved?.description ?? ""),
            hidden: identity.kind === "development",
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
        return profileJson({
          user: profileCapability
            ? accountUser(updated.profile.displayName, await readAccountIcon())
            : { id: updated.profile.id, displayName: updated.profile.displayName },
        });
      }
      if (pathname === "/account/icon" && method === "PUT") {
        const input = await body(request);
        if (
          !isProtectedAccountIcon(input) ||
          (input.icon !== null && !parseStoredIcon(input.icon))
        ) {
          return invalid();
        }
        await revalidate();
        await saveIcon(input.icon);
        // Replaced image bytes are not retained once another icon is chosen.
        await clearCanonicalUserProfileAvatar(profile.id, { env: chats.env, assertCurrent });
        assertCurrent();
        return json({ icon: projectIcon(profile.id, input.icon) });
      }
      if (pathname === "/account/icon/image" && method === "PUT") {
        const mime = iconImageMime(request.headers.get("content-type"));
        if (!mime) {
          throw new ProtectedError(415, "icon_unsupported_type", "Use a PNG, JPEG, or WebP image.");
        }
        const tooLarge = () =>
          new ProtectedError(413, "icon_too_large", "Choose an image under 512 KiB.");
        if (Number(request.headers.get("content-length") ?? 0) > maxIconBytes) {
          throw tooLarge();
        }
        if (!request.body) {
          return invalid();
        }
        const bytes = await readByteStreamWithLimit(request.body, {
          maxBytes: maxIconBytes,
          onOverflow: tooLarge,
        });
        if (!isIconImage(bytes, mime)) {
          throw new ProtectedError(415, "icon_unsupported_type", "Use a PNG, JPEG, or WebP image.");
        }
        await revalidate();
        const saved = await setCanonicalUserProfileAvatar(profile.id, bytes, mime, {
          env: chats.env,
          assertCurrent,
        });
        if (!saved.ok) {
          throw new ProtectedError(415, "icon_unsupported_type", "Use a PNG, JPEG, or WebP image.");
        }
        const icon = { kind: "image", revision: saved.value.display.avatarRevision };
        await saveIcon(icon);
        assertCurrent();
        return json({ icon: projectIcon(profile.id, icon) });
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
        if (identity.kind !== "development" && input.hidden) {
          throw new ProtectedError(
            400,
            "directory_visibility_required",
            "Members cannot hide from the people list. Save your description without Hide me.",
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
          return profileJson({ people: [], nextCursor: null });
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
        const icons = profileCapability
          ? await getUserPreferenceValues(
              result.people.map((person) => person.id),
              iconPreference,
              { env: chats.env },
            )
          : undefined;
        await revalidate();
        const currentSubjects = new Set(options.directory.allowedSubjects);
        if (
          !result.isCurrent() ||
          (icons && !icons.isCurrent()) ||
          directorySubjects.some((subject) => !currentSubjects.has(subject)) ||
          result.people.some((person) => deniedProfiles.has(person.id))
        ) {
          throw new ProtectedError(409, "directory_changed", "The directory changed. Try again.");
        }
        return profileJson({
          people: icons
            ? result.people.map((person) => ({
                ...person,
                icon: projectIcon(person.id, icons.values.get(person.id)),
              }))
            : result.people,
          nextCursor: result.nextCursor,
        });
      }
      const personIcon = /^\/people\/([a-f0-9-]{36})\/icon$/u.exec(pathname);
      if (personIcon && method === "GET") {
        const targetId = personIcon[1]!;
        let targetVisible = () => true;
        if (targetId !== profile.id) {
          if (identity.kind === "development") {
            return notFound();
          }
          const directorySubjects = options.directory.allowedSubjects.filter((subject) =>
            subjectPattern.test(subject),
          );
          const visible = await readVerifiedUserProfileDirectory(
            {
              issuer: options.directory.issuer,
              subjects: directorySubjects,
              preferenceKey: directoryPreference,
              after: null,
              limit: 1,
              profileId: targetId,
            },
            { env: chats.env },
          );
          await revalidate();
          const currentSubjects = new Set(options.directory.allowedSubjects);
          if (
            !visible.isCurrent() ||
            directorySubjects.some((subject) => !currentSubjects.has(subject)) ||
            visible.people[0]?.id !== targetId ||
            deniedProfiles.has(targetId)
          ) {
            return notFound();
          }
          // Removal during later awaited reads must still hide the icon.
          targetVisible = () => visible.isCurrent() && !deniedProfiles.has(targetId);
        }
        const selected = await getUserPreferenceValues([targetId], iconPreference, {
          env: chats.env,
        });
        await revalidate();
        if (
          !targetVisible() ||
          !selected.isCurrent() ||
          parseStoredIcon(selected.values.get(targetId))?.kind !== "image"
        ) {
          return notFound();
        }
        const reader = createProfileAvatarReader(targetId, { env: chats.env });
        for (;;) {
          const prepared = await reader.inspect();
          await revalidate();
          const uploaded = prepared.avatar;
          if (!uploaded || prepared.profile?.id !== targetId) {
            return notFound();
          }
          const etag = formatUserProfileAvatarEtag(uploaded.sha256, uploaded.mime);
          const headers = {
            "cache-control": "private, no-cache",
            "x-content-type-options": "nosniff",
            etag,
          };
          const matches = matchesHttpIfNoneMatch(
            request.headers.get("if-none-match") ?? undefined,
            etag,
          );
          const loaded = matches ? undefined : await prepared.loadBytes();
          assertCurrent();
          if (!targetVisible()) {
            return notFound();
          }
          if (!prepared.isCurrent() || (!matches && !loaded)) {
            continue;
          }
          if (matches || !loaded) {
            return new Response(null, { status: 304, headers });
          }
          return new Response(Buffer.from(loaded.bytes), {
            headers: { ...headers, "content-type": uploaded.mime },
          });
        }
      }
      if (pathname === "/agents" && method === "GET") {
        await revalidate();
        const { defaultAgentId } = agentCatalog;
        const catalog: ProtectedAgentCatalogDto | ProtectedAgentCatalogV1 = hasClientCapability(
          request.headers,
          "agents-v1",
        )
          ? { defaultAgentId, agents: agentCatalog.listV1() }
          : { defaultAgentId, agents: agentCatalog.list() };
        return profileJson(catalog);
      }
      if (pathname === "/automations/catalog" && method === "GET") {
        if (!automationCatalog) {
          return notFound();
        }
        await revalidate();
        const catalog: ProtectedAutomationCatalog | ProtectedAutomationCatalogV1 =
          hasClientCapability(request.headers, "agents-v1")
            ? { ...automationCatalog, agents: agentCatalog.listV1() }
            : automationCatalog;
        const chatAvailable =
          supportsAutomationsChat(request) && catalog.capabilities.automations.list;
        return profileJson(
          chatAvailable
            ? {
                ...catalog,
                capabilities: {
                  ...catalog.capabilities,
                  automations: {
                    ...catalog.capabilities.automations,
                    chat: {
                      list: true,
                      read: true,
                      proposeCreate: true,
                      proposePatch: true,
                      ...(supportsAutomationsAuthoring(request) &&
                      catalog.capabilities.automations.create &&
                      admitStorage &&
                      agentCatalog.get(authoringAgentId)
                        ? { authoring: true }
                        : {}),
                    },
                  },
                },
              }
            : catalog,
        );
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
      if (pathname === "/automations" && method === "GET") {
        if (!automationCatalog?.capabilities.automations.list) {
          return notFound();
        }
        await revalidate();
        const automations = await listProtectedAutomationRecords(options.stateDir, authority);
        assertCurrent();
        const result: ProtectedAutomationListResponse = { automations };
        return json(result);
      }
      if (pathname === "/automations" && method === "POST") {
        if (!automationCatalog?.capabilities.automations.create) {
          return notFound();
        }
        const draft = await body(request);
        assertCurrent();
        const validation = validateProtectedAutomationDraft(draft, automationCatalog);
        if (!validation.valid) {
          return json(validation, 422);
        }
        await revalidate();
        if (!admitStorage) {
          return notFound();
        }
        // A form save from an unsaved authoring chat saves under that chat's key and binds it, so
        // the chat cannot later create a second record.
        const authoringChatId = request.headers.get("x-alcove-authoring-chat") ?? undefined;
        if (authoringChatId !== undefined) {
          if (!supportsAutomationsAuthoring(request)) {
            return notFound();
          }
          const entry = await chats.readEntry(authority, authoringChatId);
          if (entry.protectedAuthoringKind !== "automation") {
            return notFound();
          }
          if (entry.protectedAutomationId !== undefined) {
            throw new ProtectedError(
              409,
              "authoring_bound",
              "This chat already saved its automation. Reload it before saving.",
            );
          }
          if (runs.has(authoringChatId) || mutations.has(authoringChatId)) {
            throw new ProtectedError(409, "busy", "Wait for the chat to finish before saving.");
          }
          mutations.add(authoringChatId);
        }
        let storage;
        try {
          storage = await admitStorage(
            profile.id,
            assertCurrent,
            "automation",
            await storageLimit(assertCurrent),
          );
          const automation = await createProtectedAutomationRecord(
            options.stateDir,
            {
              profileId: profile.id,
              definition: validation.draft,
              now: Date.now(),
              ...(authoringChatId === undefined ? {} : { automationId: authoringChatId }),
            },
            authority,
            storage,
          );
          if (!automation) {
            unauthorized();
          }
          if (authoringChatId !== undefined) {
            await chats.bindAutomation(authority, authoringChatId, automation.id);
            if (!savesDraft(automation, validation.draft)) {
              throw new ProtectedError(
                412,
                "version_mismatch",
                "This chat already saved a different version. Reload it before saving.",
              );
            }
          }
          assertCurrent();
          const result: ProtectedAutomationResponse = { automation };
          return json(result, 201);
        } finally {
          storage?.release();
          if (authoringChatId !== undefined) {
            mutations.delete(authoringChatId);
          }
        }
      }
      const authoringMatch = /^\/automations\/(?:([^/]+)\/)?authoring$/u.exec(pathname);
      if (authoringMatch && method === "POST") {
        if (
          !supportsAutomationsAuthoring(request) ||
          !automationCatalog?.capabilities.automations.create ||
          !admitStorage ||
          !agentCatalog.get(authoringAgentId)
        ) {
          return notFound();
        }
        const automationId = authoringMatch[1];
        if (creating.has(profile.id)) {
          throw new ProtectedError(409, "busy", "Another chat is being created.");
        }
        // One creation at a time per member keeps one bound chat per saved automation.
        creating.add(profile.id);
        let storage;
        try {
          await revalidate();
          let automation;
          if (automationId !== undefined) {
            automation = await readProtectedAutomationRecord(
              options.stateDir,
              { profileId: profile.id, automationId },
              authority,
            );
            if (!automation) {
              return notFound();
            }
            if (automation.enabled) {
              throw new ProtectedError(
                409,
                "automation_enabled",
                "Pause this automation before editing it in chat.",
              );
            }
            const owned = await chats.list(authority);
            let bound = owned.find((chat) => chat.authoring?.automationId === automationId);
            // A first save that stopped before binding left its record under the chat's own id.
            const unbound = owned.find(
              (chat) => chat.id === automationId && chat.authoring && !chat.authoring.automationId,
            );
            if (!bound && unbound) {
              bound = await chats.bindAutomation(authority, unbound.id, automationId);
            }
            if (bound) {
              const { chat } = await readChat(bound.id);
              await revalidate();
              const result: ProtectedAutomationAuthoringResponse = { chat, automation };
              return json(result);
            }
          }
          storage = await admitStorage(
            profile.id,
            assertCurrent,
            "create",
            await storageLimit(assertCurrent),
          );
          const chat = await chats.create(
            authority,
            automation ? text(automation.name, 160) : "New automation",
            authoringAgentId,
            { kind: "automation", ...(automationId === undefined ? {} : { automationId }) },
          );
          storage.recordCreatedChat(chat.id, chats.scope(authority, chat.id).sessionKey);
          await revalidate();
          const result: ProtectedAutomationAuthoringResponse = {
            chat,
            ...(automation ? { automation } : {}),
          };
          return json(result, 201);
        } finally {
          storage?.release();
          creating.delete(profile.id);
        }
      }
      const automationMatch = /^\/automations\/([^/]+)$/u.exec(pathname);
      if (automationMatch && method === "GET") {
        if (!automationCatalog?.capabilities.automations.list) {
          return notFound();
        }
        await revalidate();
        const automation = await readProtectedAutomationRecord(
          options.stateDir,
          { profileId: profile.id, automationId: automationMatch[1]! },
          authority,
        );
        if (!automation) {
          return notFound();
        }
        assertCurrent();
        const result: ProtectedAutomationResponse = { automation };
        return json(result);
      }
      if (automationMatch && method === "PATCH") {
        if (!automationCatalog?.capabilities.automations.create) {
          return notFound();
        }
        const patch = await body(request);
        if (!isProtectedAutomationPatchRequest(patch) || Object.keys(patch).length === 0) {
          return invalid();
        }
        const version = request.headers.get("if-match");
        if (!version) {
          throw new ProtectedError(
            428,
            "version_required",
            "Reload the automation before saving changes.",
          );
        }
        const saved = await saveProtectedAutomationPatch(
          options.stateDir,
          {
            automationId: automationMatch[1]!,
            expectedVersion: version,
            patch,
            catalog: automationCatalog,
            retainedAgent: (agentId) => agentCatalog.get(agentId),
          },
          authority,
          {
            revalidate,
            ...(admitStorage
              ? {
                  admitStorage: async () =>
                    admitStorage(
                      profile.id,
                      assertCurrent,
                      "automation",
                      await storageLimit(assertCurrent),
                    ),
                }
              : {}),
          },
        );
        switch (saved.status) {
          case "updated": {
            const result: ProtectedAutomationResponse = { automation: saved.automation };
            return json(result);
          }
          case "invalid":
            return json(saved.validation, 422);
          case "member_inactive":
            return unauthorized();
          case "version_mismatch":
            throw new ProtectedError(
              412,
              "version_mismatch",
              "This automation changed. Reload it before saving.",
            );
          case "scheduler_required":
            throw new ProtectedError(
              503,
              "scheduler_unavailable",
              "Automation scheduling is not available yet. Your changes were not saved.",
            );
          default:
            return notFound();
        }
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
        const models = await fetchProtectedCopilotModels(
          data.credential,
          {
            signal: request.signal,
            revalidate,
          },
          {
            includeVendor: hasClientCapability(request.headers, "model-vendor-v1"),
            includeContextSizes: hasClientCapability(request.headers, "model-context-v1"),
          },
        );
        return profileJson({ models: models.map(({ model }) => model) });
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
          storageMeasurement,
          profile.id,
          assertCurrent,
          false,
          (item) => items.push(item),
        );
        const limitBytes = await storageLimit(assertCurrent);
        await revalidate();
        return json({
          limitBytes,
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
          // Clients that did not negotiate authoring parse chats against strict V1 schemas.
          if (!supportsAutomationsAuthoring(request)) {
            delete chat.authoring;
          }
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
          if (!agentCatalog.getSelectable(selectedAgentId)) {
            throw new ProtectedError(422, "agent_unavailable", "This agent is not available.");
          }
          await revalidate();
          storage = await admitStorage?.(
            profile.id,
            assertCurrent,
            "create",
            await storageLimit(assertCurrent),
          );
          const chat = await chats.create(
            authority,
            data.title === undefined ? undefined : text(data.title, 160),
            selectedAgentId,
          );
          storage?.recordCreatedChat(chat.id, chats.scope(authority, chat.id).sessionKey);
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
      if (pathname === "/artifacts" && method === "GET") {
        requireProfile();
        const ownedChats = await chats.list(authority);
        return await files(async (owned) => {
          const result = await listProtectedArtifacts({
            files: owned,
            chats: ownedChats,
            cursor: new URL(request.url).searchParams.get("cursor"),
            maxFileBytes: options.maxFileBytes,
          });
          await revalidate();
          return json(result);
        });
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
      const generatedFileId = /^\/files\/generated~([^/~]+)~([^/~]+)$/u.exec(pathname);
      const fileId = /^\/files\/([^/~]+)~([^/~]+)$/u.exec(pathname);
      const selectedFile = generatedFileId ?? fileId;
      if (
        selectedFile?.[1] &&
        selectedFile[2] &&
        (generatedFileId
          ? validGeneratedFilename(selectedFile[2])
          : validFilename(selectedFile[2])) &&
        method === "GET"
      ) {
        if (request.headers.has("x-grogu-profile")) {
          requireProfile();
        }
        const [, chatId, filename] = selectedFile;
        await chats.readEntry(authority, chatId);
        await revalidate();
        return await files(async (owned) => {
          const directory = generatedFileId
            ? chatGeneratedArtifactsDirectory(chatId)
            : chatArtifactsDirectory(chatId);
          const bytes = await owned.read(`${directory}/${filename}`);
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
      const feedbackReport = /^responses\/([^/]+)\/reports$/u.exec(rest ?? "");
      try {
        await chats.readEntry(authority, id);
      } catch (error) {
        const responseId = feedbackReport?.[1];
        if (
          !(error instanceof ProtectedError && error.status === 404) ||
          method !== "POST" ||
          !feedbackCapability ||
          !responseId ||
          responseId.length > 200
        ) {
          throw error;
        }
        let input: FeedbackReportInput;
        try {
          input = parseFeedbackReportInput(await body(request), reportChatCapability);
        } catch (inputError) {
          if (
            inputError instanceof ProtectedError &&
            (inputError.status === 400 || inputError.status === 413)
          ) {
            throw error;
          }
          throw inputError;
        }
        await revalidate();
        const prior = await findProtectedFeedbackSubmission(
          options.stateDir,
          profile.id,
          input.submissionId,
        );
        await revalidate();
        if (prior?.chatId === id && prior.responseId === responseId) {
          return replayFeedbackReport(responseId, prior);
        }
        throw error;
      }
      await revalidate();
      if (!rest && method === "GET") {
        const { chat, usage } = await readChat(id);
        await revalidate();
        if (usage && !hasClientCapability(request.headers, "model-context-v1")) {
          delete usage.contextSize;
        }
        const active = runs.get(id);
        return profileJson({
          chat,
          ...(usage ? { usage } : {}),
          ...(active?.profileId === profile.id && active.sessionHash === identity.sessionId
            ? { activeRun: { id: active.id } }
            : {}),
        });
      }
      if (rest === "feedback" && method === "GET") {
        if (!feedbackCapability) {
          return notFound();
        }
        const { chat } = await readChat(id);
        await revalidate();
        const responseIds = new Set(
          chat.messages
            .filter((message) => message.role === "assistant" && message.status === "complete")
            .map((message) => message.id),
        );
        const feedback = await listProtectedFeedback(options.stateDir, profile.id, id);
        await revalidate();
        return json({
          feedback: feedback
            .filter((entry) => responseIds.has(entry.responseId))
            .map(({ responseId, rating, reportId }) => ({ responseId, rating, reportId })),
        });
      }
      const feedbackResponse = /^responses\/([^/]+)\/feedback$/u.exec(rest ?? "");
      if (feedbackResponse && method === "PUT") {
        if (!feedbackCapability) {
          return notFound();
        }
        const responseId = feedbackResponse[1]!;
        if (responseId.length > 200) {
          return notFound();
        }
        const input = await body(request);
        if (Object.keys(input).length !== 1 || !isFeedbackRating(input.rating)) {
          return invalid();
        }
        const { chat } = await readChat(id);
        if (!assistantResponse(chat.messages, responseId)) {
          return notFound();
        }
        await revalidate();
        let storage: StorageAdmission | undefined;
        let reservation: ReturnType<StorageAdmission["reserveStoredData"]> | undefined;
        let reservationSettled = false;
        try {
          const current = await listProtectedFeedback(options.stateDir, profile.id, id);
          await revalidate();
          if (input.rating !== null && !current.some((entry) => entry.responseId === responseId)) {
            storage = await admitStorage?.(
              profile.id,
              assertCurrent,
              "stored-data",
              await storageLimit(assertCurrent),
            );
            reservation = storage?.reserveStoredData(storageEntryOverheadBytes + 1024);
          }
          const result = await setProtectedFeedback(options.stateDir, {
            profileId: profile.id,
            chatId: id,
            responseId,
            rating: input.rating,
            now: Date.now(),
            storageOverheadBytes: storageEntryOverheadBytes,
          });
          reservation?.settle({
            created: result.created,
            entries: result.entry ? [result.entry] : [],
          });
          reservationSettled = reservation !== undefined;
          await revalidate();
          return json({ feedback: result.feedback });
        } catch (error) {
          if (reservation && !reservationSettled) {
            try {
              const stored = await readProtectedFeedbackStorageUsage(
                options.stateDir,
                storageEntryOverheadBytes,
                assertCurrent,
              );
              const entry = stored.find(
                (candidate) =>
                  candidate.profileId === profile.id &&
                  candidate.id === `feedback:${id}:${responseId}`,
              );
              if (entry) {
                reservation.settle({ created: true, entries: [entry] });
              } else {
                reservation.release();
              }
            } catch {
              process.stderr.write(
                "Protected feedback write outcome is unknown; its storage reservation remains held.\n",
              );
            }
          }
          throw error;
        } finally {
          storage?.release();
        }
      }
      if (feedbackReport && method === "POST") {
        if (!feedbackCapability) {
          return notFound();
        }
        const responseId = feedbackReport[1]!;
        if (responseId.length > 200) {
          return notFound();
        }
        const input = parseFeedbackReportInput(await body(request), reportChatCapability);
        await revalidate();
        const priorSubmission = await findProtectedFeedbackSubmission(
          options.stateDir,
          profile.id,
          input.submissionId,
        );
        await revalidate();
        if (priorSubmission) {
          if (priorSubmission.chatId !== id || priorSubmission.responseId !== responseId) {
            return json({ error: "submission_conflict" }, 409);
          }
          return replayFeedbackReport(responseId, priorSubmission);
        }
        const { chat } = await readChat(id);
        const responseIndex = chat.messages.findIndex(
          (message) =>
            message.id === responseId &&
            message.role === "assistant" &&
            message.status === "complete",
        );
        const response = chat.messages[responseIndex];
        const prompt = chat.messages
          .slice(0, responseIndex)
          .toReversed()
          .find((message) => message.role === "user");
        if (!response || !prompt) {
          return notFound();
        }
        await revalidate();
        const priorReport = await findProtectedFeedbackForResponse(
          options.stateDir,
          profile.id,
          id,
          responseId,
        );
        await revalidate();
        if (priorReport) {
          return json({ error: "already_reported" }, 409);
        }
        let chatReference: Parameters<typeof submitProtectedFeedbackReport>[1]["chatReference"];
        if (input.includeChat) {
          const artifacts = await files((owned) =>
            listChatArtifactFiles(owned, id, options.maxFileBytes),
          );
          await revalidate();
          const source = await chats.readReportChatSource(authority, id);
          await revalidate();
          const capturedAt = Date.now();
          chatReference = captureProtectedReportChatReference(
            source.events,
            artifacts,
            capturedAt,
            source.chat.title,
          );
        }
        let storage: StorageAdmission | undefined;
        let reservation: ReturnType<StorageAdmission["reserveStoredData"]> | undefined;
        let reservationSettled = false;
        try {
          storage = await admitStorage?.(
            profile.id,
            assertCurrent,
            "stored-data",
            await storageLimit(assertCurrent),
          );
          const referenceBytes = chatReference
            ? Math.ceil((Buffer.byteLength(JSON.stringify(chatReference)) * 4) / 3) + 1024
            : 0;
          reservation = storage?.reserveStoredData(16 * 1024 + referenceBytes);
          const result = await submitProtectedFeedbackReport(options.stateDir, {
            profileId: profile.id,
            memberLabel: redactFeedbackText(profile.displayName?.trim() || "User"),
            chatId: id,
            responseId,
            submissionId: input.submissionId,
            category: input.category,
            description: input.description,
            now: Date.now(),
            storageOverheadBytes: storageEntryOverheadBytes,
            ...(chatReference ? { chatReference } : {}),
          });
          if (result.kind === "already_reported") {
            reservation?.settle({ created: false, entries: [] });
            reservationSettled = reservation !== undefined;
            return json({ error: "already_reported" }, 409);
          }
          if (result.kind === "submission_conflict") {
            reservation?.settle({ created: false, entries: [] });
            reservationSettled = reservation !== undefined;
            return json({ error: "submission_conflict" }, 409);
          }
          reservation?.settle({
            created: result.kind === "created",
            entries: result.entries,
          });
          reservationSettled = reservation !== undefined;
          await revalidate();
          if (result.kind === "created") {
            void track(
              loadProtectedPush()
                .then(({ notifyProtectedIssueReport }) =>
                  notifyProtectedIssueReport({
                    stateDir: options.stateDir,
                    issuer: options.accessIssuer,
                    ownerSubject: options.ownerSubject,
                  }),
                )
                .catch(() => {
                  process.stderr.write("Alcove could not deliver a report notification.\n");
                }),
            );
          }
          return json({ report: result.report, feedback: result.feedback }, 201);
        } catch (error) {
          if (reservation && !reservationSettled) {
            try {
              const committed = await findProtectedFeedbackSubmission(
                options.stateDir,
                profile.id,
                input.submissionId,
              );
              await revalidate();
              const stored = await readProtectedFeedbackStorageUsage(
                options.stateDir,
                storageEntryOverheadBytes,
                assertCurrent,
              );
              const entries =
                committed?.chatId === id && committed.responseId === responseId
                  ? stored.filter(
                      (entry) =>
                        entry.profileId === profile.id &&
                        (entry.id === `report:${committed.id}` ||
                          entry.id === `report-chat:${committed.id}` ||
                          entry.id === `feedback:${id}:${responseId}`),
                    )
                  : [];
              if (entries.length > 0) {
                reservation.settle({ created: true, entries });
                reservationSettled = true;
              } else {
                reservation.release();
                reservationSettled = true;
              }
            } catch {
              process.stderr.write(
                "Protected report write outcome is unknown; its storage reservation remains held.\n",
              );
            }
          }
          throw error;
        } finally {
          storage?.release();
        }
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
          await removeProtectedChatFeedback(options.stateDir, profile.id, id);
          await revalidate();
          admitStorage?.deletedChat(profile.id, id);
          await revalidate();
          return noContent();
        } finally {
          mutations.delete(id);
        }
      }
      if (rest === "title" && method === "PATCH") {
        const version = request.headers.get("if-match");
        if (!version) {
          throw new ProtectedError(428, "version_required", "Reload the chat before renaming.");
        }
        const data = await body(request);
        if (typeof data.title !== "string" || !data.title.trim() || data.title.length > 160) {
          throw new ProtectedError(
            422,
            "invalid_title",
            "Enter a chat title of at most 160 characters.",
          );
        }
        if (runs.has(id) || mutations.has(id)) {
          throw new ProtectedError(409, "busy", "Stop the current work before renaming.");
        }
        mutations.add(id);
        try {
          await revalidate();
          await chats.rename(authority, id, version, data.title.trim());
          const { chat } = await readChat(id);
          await revalidate();
          return json({ chat });
        } finally {
          mutations.delete(id);
        }
      }
      if (rest === "agent" && method === "PATCH") {
        const data = await body(request);
        if (!isProtectedAgentSelection(data)) {
          return invalid();
        }
        if (!agentCatalog.getSelectable(data.selectedAgentId)) {
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
        if (request.headers.has("x-grogu-profile")) {
          requireProfile();
        }
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
        const requestBody = await body(request);
        let data: ProtectedTurnRequest;
        let authoringInput: ProtectedAuthoringTurnRequest["authoring"] | undefined;
        if (isProtectedAuthoringTurnRequest(requestBody)) {
          const { authoring, ...turnRequest } = requestBody;
          data = turnRequest;
          authoringInput = authoring;
        } else if (isProtectedTurnRequest(requestBody)) {
          data = requestBody;
        } else {
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
          const models = await fetchProtectedCopilotModels(
            credential,
            { signal: request.signal, revalidate },
            { includeContextSizes: data.contextSize !== undefined },
          );
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
        if (
          data.contextSize !== undefined &&
          !copilotModel?.model.contextSizes?.options.includes(data.contextSize)
        ) {
          throw new ProtectedError(
            422,
            "context_size_unavailable",
            "This context size is not available.",
          );
        }
        const input: TurnInput = {
          provider: model.provider,
          model: model.id,
          text: text(data.text, 16_000),
          ...(data.mentions ? { mentions: data.mentions } : {}),
          thinking: data.thinking ?? model.thinking?.default,
          ...(data.contextSize === undefined ? {} : { contextSize: data.contextSize }),
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
        // The server-held binding decides authoring; the body only carries the client-held draft.
        const admitAuthoringTurn = async (entry: Awaited<ReturnType<typeof chats.readEntry>>) => {
          if (entry.protectedAuthoringKind !== "automation") {
            if (authoringInput) {
              invalid();
            }
            return undefined;
          }
          if (
            !authoringInput ||
            !supportsAutomationsAuthoring(request) ||
            model.provider !== "sparky" ||
            data.mentions?.length ||
            !automationCatalog?.capabilities.automations.create ||
            !admitStorage
          ) {
            throw new ProtectedError(
              409,
              "authoring_required",
              "Update Alcove to continue this automation chat.",
            );
          }
          const automationId = entry.protectedAutomationId;
          if (automationId === undefined) {
            if (authoringInput.automationVersion !== undefined) {
              invalid();
            }
            return { input: authoringInput, catalog: automationCatalog, admitStorage };
          }
          if (authoringInput.automationVersion === undefined) {
            throw new ProtectedError(
              428,
              "version_required",
              "Reload the automation before continuing.",
            );
          }
          const saved = await readProtectedAutomationRecord(
            options.stateDir,
            { profileId: profile.id, automationId },
            authority,
          );
          if (!saved) {
            throw new ProtectedError(
              409,
              "automation_unavailable",
              "This automation was deleted. Your unsaved draft was not changed.",
            );
          }
          if (saved.enabled) {
            throw new ProtectedError(
              409,
              "automation_enabled",
              "Pause this automation before editing it in chat.",
            );
          }
          if (saved.version !== authoringInput.automationVersion) {
            throw new ProtectedError(
              412,
              "version_mismatch",
              "This automation changed. Reload it before continuing.",
            );
          }
          return { input: authoringInput, catalog: automationCatalog, admitStorage, automationId };
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
            storage = await admitStorage?.(
              profile.id,
              assertGrant,
              "turn",
              await storageLimit(assertGrant),
            );
            if (shutdown.signal.aborted || runs.has(id)) {
              throw new ProtectedError(409, "busy", "A turn is already running in this chat.");
            }
            if (request.signal.aborted) {
              request.signal.throwIfAborted();
            }
            const currentEntry = await chats.readEntry(authority, id);
            const authoring = await admitAuthoringTurn(currentEntry);
            const selectedAgentId =
              currentEntry.protectedAgentId ?? agentCatalog.legacyDefaultAgentId;
            const selectedAgent = agentCatalog.get(selectedAgentId);
            if (!selectedAgent) {
              throw new ProtectedError(
                422,
                "agent_unavailable",
                "This chat's agent is unavailable.",
              );
            }
            const mentionedAgents = (data.mentions ?? []).map((mention) => {
              const agent = agentCatalog.getSelectable(mention.agentId);
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
              authoring,
              selectedAgent,
              mentionedAgents,
              storage,
              profileAuthority,
              sessionEntry: currentEntry,
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
          authoring,
          selectedAgent,
          mentionedAgents,
          storage,
          profileAuthority,
          sessionEntry,
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
        // Assigned when the stream starts; authoring tools run only inside that stream.
        let publishAuthoring: ((event: ProtectedAuthoringTurnEvent) => Promise<void>) | undefined;
        const automationChat = authoring
          ? createProtectedAutomationAuthoringBindings({
              stateDir: options.stateDir,
              catalog: authoring.catalog,
              retainedAgent: (agentId) => agentCatalog.get(agentId),
              authority: runAuthority,
              revalidate: checkRun,
              chatId: id,
              ...(authoring.automationId === undefined
                ? {}
                : { boundAutomationId: authoring.automationId }),
              sent: authoring.input,
              admitStorage: async () =>
                authoring.admitStorage(
                  profile.id,
                  assertRun,
                  "automation",
                  await storageLimit(assertRun),
                ),
              bind: async (automationId) => {
                await chats.bindAutomation(runAuthority, id, automationId);
              },
              publish: async (event) => {
                if (!publishAuthoring) {
                  throw new ProtectedError(409, "busy", "This automation chat is not streaming.");
                }
                await publishAuthoring(event);
              },
            })
          : supportsAutomationsChat(request) &&
              model.provider === "sparky" &&
              automationCatalog?.capabilities.automations.list
            ? createProtectedAutomationsChatBindings({
                stateDir: options.stateDir,
                catalog: automationCatalog,
                authority: runAuthority,
                revalidate: checkRun,
              })
            : undefined;
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
            const send = (event: ProtectedAuthoringTurnEvent) => {
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
            if (authoring) {
              publishAuthoring = async (event) => {
                send(event);
              };
            }
            // Silent reasoning can last minutes. A blank NDJSON line keeps the Cloudflare tunnel
            // from closing an idle response; clients skip blank lines.
            const keepalive = setInterval(() => write("\n"), 15_000);
            keepalive.unref();
            const complete = async () => {
              let outcome: "complete" | "failed" | "interrupted" = "failed";
              let tokens: number | null = null;
              let contextBudget: number | undefined;
              let messageCount: number | null = null;
              let failed = true;
              let errorCode: string | null = null;
              let responseId: string | null = null;
              let producedFiles: ProtectedProducedFile[] = [];
              let reasoningSummaryChars = input.thinking === "off" ? 0 : null;
              const modelRequests: TerminalModelRequestMetadata[] = [];
              try {
                assertRun();
                send({ type: "start", runId: run.id });
                const before = await chats.read(runAuthority, id);
                await files(
                  async (owned) => {
                    const beforeArtifacts = await listChatArtifactFiles(
                      owned,
                      id,
                      options.maxFileBytes,
                    );
                    const storageFiles = storage?.files(owned);
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
                        ...(automationChat ? { automationChat } : {}),
                        mentionedAgents,
                        agent: selectedAgent,
                        ...(authoring ? {} : { routing: agentRouting }),
                        sessionAccess,
                        sessionEntry,
                        files: storageFiles ?? owned,
                        memoryFiles: storageFiles,
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
                        contextBudget: (value) => {
                          contextBudget = value;
                        },
                        modelRequest: (record) => {
                          modelRequests.push(record);
                        },
                        reasoningLength: (length) => {
                          if (reasoningSummaryChars !== null) {
                            const next = reasoningSummaryChars + length;
                            reasoningSummaryChars = Number.isSafeInteger(next) ? next : null;
                          } else if (length > 0) {
                            reasoningSummaryChars = length;
                          }
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
                    const result = await (storage
                      ? withTranscriptWriteBudget(storage.charge, execute)
                      : execute());
                    const beforeIds = new Set(beforeArtifacts.map((file) => file.id));
                    producedFiles = (
                      await listChatArtifactFiles(owned, id, options.maxFileBytes)
                    ).filter((file) => !beforeIds.has(file.id));
                    return result;
                  },
                  assertRun,
                  signal,
                );
                storage?.assertResult();
                let { chat, usage } = await chats.readWithUsage(runAuthority, id);
                await checkRun();
                const newMessages = chat.messages.slice(before.messages.length);
                messageCount = newMessages.length;
                const latestMessage = newMessages.at(-1);
                responseId =
                  latestMessage?.role === "assistant" && latestMessage.status === "complete"
                    ? latestMessage.id
                    : null;
                if (responseId === null) {
                  producedFiles = [];
                }
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
                if (
                  contextBudget !== undefined &&
                  responseId !== null &&
                  usage?.provider === input.provider &&
                  usage.model === input.model
                ) {
                  const size = contextBudget;
                  const completedResponseId = responseId;
                  const saveBudget = () =>
                    chats.saveContextBudget(runAuthority, id, {
                      runId: run.id,
                      responseId: completedResponseId,
                      contextSize: size,
                      lifecycleRevision: parentLifecycleRevision,
                    });
                  await (storage
                    ? withTranscriptWriteBudget(storage.charge, saveBudget)
                    : saveBudget());
                  ({ chat, usage } = await chats.readWithUsage(runAuthority, id));
                  await checkRun();
                  if (usage?.contextSize !== size) {
                    throw new ProtectedError(
                      500,
                      "save_failed",
                      "The context budget could not be confirmed as saved.",
                    );
                  }
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
                    ...(usage.contextSize !== undefined &&
                    hasClientCapability(request.headers, "model-context-v1")
                      ? { contextSize: usage.contextSize }
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
                errorCode = issue.code;
                send({ type: "error", code: issue.code, message: issue.message });
              } finally {
                const timingMetrics = timing.finish(outcome);
                const telemetryRequests = modelRequests.map((record) => ({
                  requestId: record.requestId,
                  provider: record.provider,
                  model: record.model,
                  outcome: record.outcome,
                  usageSource: record.usageSource,
                  wallDurationMs:
                    record.wallDurationMs === null ? null : Math.round(record.wallDurationMs),
                  inputTokens: record.inputTokens,
                  outputTokens: record.outputTokens,
                  cacheReadTokens: record.cacheReadTokens,
                  cacheWriteTokens: record.cacheWriteTokens,
                  reasoningTokens: record.reasoningTokens,
                }));
                const telemetry: ProtectedTurnTelemetryInput = {
                  id: run.id,
                  profileId: profile.id,
                  memberLabel: redactFeedbackText(profile.displayName?.trim() || "User"),
                  createdAt: Date.now(),
                  agentId: selectedAgent.id,
                  status:
                    outcome === "complete"
                      ? "complete"
                      : outcome === "interrupted"
                        ? "stopped"
                        : "failed",
                  chatId: id,
                  responseId,
                  errorCode,
                  reasoningSummaryChars,
                  admissionMs: timingMetrics.admissionMs,
                  providerStartMs: timingMetrics.providerRequestStartMs,
                  firstOutputMs: timingMetrics.firstProviderOutputMs,
                  firstVisibleMs: timingMetrics.firstClientVisibleOutputMs,
                  completionMs: timingMetrics.completionMs,
                  files: producedFiles,
                  requests: telemetryRequests,
                  storageOverheadBytes: storageEntryOverheadBytes,
                };
                const telemetryBytes =
                  storageEntryOverheadBytes +
                  Buffer.byteLength(JSON.stringify(telemetry.files), "utf8") +
                  Buffer.byteLength(telemetry.memberLabel, "utf8") +
                  telemetry.id.length +
                  telemetry.requests.reduce(
                    (total, record) =>
                      total +
                      storageEntryOverheadBytes +
                      Buffer.byteLength(JSON.stringify(record), "utf8") +
                      record.requestId.length,
                    0,
                  );
                let recordTelemetry = true;
                let telemetryReservation:
                  | ReturnType<NonNullable<typeof storage>["reserveStoredData"]>
                  | undefined;
                if (storage) {
                  try {
                    telemetryReservation = storage.reserveStoredData(telemetryBytes);
                  } catch {
                    recordTelemetry = false;
                    process.stderr.write(
                      "Protected telemetry was not recorded because storage capacity was unavailable.\n",
                    );
                  }
                }
                try {
                  const storedEntries = await recordProtectedUsage(options.stateDir, {
                    runId: run.id,
                    profileId: profile.id,
                    model: `${input.provider}/${input.model}`,
                    messages: messageCount,
                    tokens,
                    failed,
                    now: telemetry.createdAt,
                    ...(recordTelemetry ? { telemetry } : {}),
                  });
                  telemetryReservation?.settle({
                    created: storedEntries.length > 0,
                    entries: storedEntries,
                  });
                } catch {
                  if (telemetryReservation) {
                    try {
                      const expected = new Set([
                        `run:${run.id}`,
                        ...telemetryRequests.map((record) => `request:${record.requestId}`),
                      ]);
                      const storedEntries = (
                        await readProtectedFeedbackStorageUsage(
                          options.stateDir,
                          storageEntryOverheadBytes,
                          assertGrant,
                        )
                      ).filter((entry) => entry.profileId === profile.id && expected.has(entry.id));
                      telemetryReservation.settle({
                        created: storedEntries.some((entry) => entry.id === `run:${run.id}`),
                        entries: storedEntries,
                      });
                    } catch {
                      process.stderr.write(
                        "Protected telemetry write outcome is unknown; its storage reservation remains held.\n",
                      );
                    }
                  }
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
      if (
        /^\/api\/protected\/v1\/(?:chats\/[^/]+\/(?:feedback|responses\/[^/]+\/(?:feedback|reports))|admin\/(?:reports(?:\/[^/]+)?|telemetry))$/u.test(
          path,
        ) &&
        ["already_reported", "not_found", "owner_required"].includes(issue.code)
      ) {
        return json({ error: issue.code }, issue.status);
      }
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
    storageLimitFor,
    async shutdown() {
      shutdown.abort();
      options.providerRelay?.close();
      for (const run of runs.values()) {
        run.controller.abort();
      }
      while (pending.size) {
        await Promise.allSettled(pending);
      }
      try {
        await options.memberMemory?.close();
      } finally {
        ownedEncryption?.dispose();
      }
    },
    async revokeProfile(profileId: string) {
      invalidateProfile(profileId);
      return updateCanonicalUserProfileAccess({ action: "revoke", profileId }, { env: chats.env });
    },
  };
}
