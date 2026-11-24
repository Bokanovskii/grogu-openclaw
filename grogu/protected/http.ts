import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  isProtectedAgentSelection,
  isProtectedAutomationPatchRequest,
  protectedAutomationPacingLimits,
  isProtectedCreateChat,
  isProtectedCreateSideChat,
  isProtectedAccountIcon,
  isProtectedAccountName,
  isProtectedDirectorySettings,
  isProtectedRenew,
  isProtectedReturnSideChat,
  isProtectedSteer,
  isProtectedTurnRequest,
  type ProtectedAgentCatalogDto,
  type ProtectedAgentCatalogV1,
  type ProtectedAgentSelectionResponse,
  type ProtectedAutomationCatalog,
  type ProtectedAutomationCatalogV1,
  type ProtectedAutomationListResponse,
  type ProtectedAutomationRecord,
  type ProtectedAutomationResponse,
  type ProtectedChat,
  type ProtectedChatStorage,
  type ProtectedChatSummary,
  type ProtectedCreateSideChatResponse,
  type ProtectedDeleteChatResponse,
  type ProtectedMessage,
  type ProtectedReturnSideChatResponse,
  type ProtectedTurnRequest,
} from "@openclaw/gateway-protocol/protected";
import {
  isProtectedAuthoringCheckpoint,
  isProtectedAuthoringCreate,
  isProtectedAuthoringTurnRequest,
  type ProtectedAuthoringDraft,
  type ProtectedAuthoringTurnEvent,
  type ProtectedAuthoringTurnRequest,
  type ProtectedAutomationAuthoringResponse,
} from "@openclaw/gateway-protocol/protected-authoring";
import {
  isProtectedAutomationFollowRequest,
  isProtectedAutomationNotificationsRequest,
  type ProtectedChatShareResponse,
  type ProtectedPublicAutomationResponse,
  type ProtectedPublicAutomationsResponse,
  type ProtectedShareClaimResponse,
  type ProtectedSharedChatResponse,
  type ProtectedSharedChatSummary,
  type ProtectedSharedChatsResponse,
} from "@openclaw/gateway-protocol/protected-sharing";
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
import type { ProtectedAutomationRunError } from "../../src/state/protected-automation-lifecycle.types.js";
import type { ProtectedAutomationCheckDecision } from "../../src/state/protected-automation-pacing.js";
import type { ProtectedAutomationResultAdmission } from "../../src/state/protected-automation-results.types.js";
import { protectedFeedbackRetentionMs } from "../../src/state/protected-feedback.js";
import type { ProtectedSharingWorkerOperations } from "../../src/state/protected-sharing.worker.js";
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
  isProtectedAdmissionCurrent,
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
  listProtectedAutomationLifecycleRuns,
  listProtectedAutomationOwnerInbox,
  readProtectedAutomationLastScheduledAttempt,
  readProtectedAutomationInterruptedRunForOwner,
  readProtectedAutomationLifecycleStorageUsage,
  readProtectedAutomationRunChat,
  writeProtectedAutomationLifecycle,
  writeProtectedAutomationLifecycleForOwner,
  type ProtectedAutomationLifecycleAuthority,
  type ProtectedAutomationLifecycleOwnerAuthority,
} from "./automation-lifecycle-store.js";
import { handleProtectedAutomationResultsRoute } from "./automation-results-http.js";
import { readProtectedAutomationResultStorageUsage } from "./automation-results-read.js";
import { commitProtectedAutomationFinishedResult } from "./automation-results-store.js";
import {
  createProtectedAutomationScheduler,
  type ProtectedScheduledAutomation,
} from "./automation-scheduler.js";
import { createProtectedAutomationStorageRecoveryOwner } from "./automation-storage-recovery.js";
import {
  createProtectedAutomationAuthoringBindings,
  createProtectedAutomationsChatBindings,
  savesDraft,
} from "./automations-chat.js";
import {
  createProtectedAutomationRecord,
  listOwnedProtectedAutomationStorageRecords,
  listProtectedAutomationRecords,
  readOwnedProtectedAutomationStorageRecord,
  readProtectedAutomationRecord,
  readProtectedAutomationStorageUsage,
  saveProtectedAutomationPatch,
  type StoredAutomationRecord,
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
import {
  createProtectedChats,
  draftMismatch,
  readAuthoringDraft,
  type ProtectedChatAuthority,
} from "./chats.js";
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
  authorizeProtectedChatRead,
  projectProtectedChatShare,
  projectProtectedPublicAutomation,
  runProtectedSharing,
} from "./sharing-store.js";
import type { StoredDataEntry } from "./storage-entry-quota.js";
import {
  parseStorageLimitBytes,
  parseStorageLimitVersion,
  storageLimitView,
} from "./storage-limit-route.js";
import { createWidgetChain, widgetIdPattern, type Widget } from "./tool-events.js";
import { createProtectedTurnTiming, type ProtectedTurnTimer } from "./turn-timing.js";
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
const automationResultsCapability = "automation-results-v1";
const automationRunsCapability = "automation-runs-v1";
const automationContextCapability = "automations-context-v1";
const automationPacingCapability = "automations-pacing-v1";
const sideChatsCapability = "side-chats-v1";

function assertRunChatWritable(
  entry: { protectedAutomationRunId?: string },
  automationId?: string,
) {
  if (entry.protectedAutomationRunId && entry.protectedAutomationRunId !== automationId) {
    throw new ProtectedError(
      409,
      "run_chat_read_only",
      "This chat is a record of an automation run. It is read only.",
    );
  }
}
const authoringAgentId = "grogu";
type Run = {
  id: string;
  profileId: string;
  sessionHash?: string;
  controller: AbortController;
  steering: Map<string, AbortController>;
};
type ProtectedTurnCompletion = {
  runId: string;
  outcome: "complete" | "failed" | "interrupted";
  errorCode: string | null;
  responseId: string | null;
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
async function body(request: Request, optional = false) {
  const isJson = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/json";
  if (!request.body) {
    return optional ? {} : invalid();
  }
  if (!optional && !isJson) {
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
      if (value.byteLength > 0 && !isJson) {
        return invalid();
      }
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        throw new ProtectedError(413, "request_too_large", "The request is too large.");
      }
      chunks.push(value);
    }
    if (optional && bytes === 0) {
      return {};
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

function supportsDraftRecovery(request: Request) {
  return (
    supportsAutomationsAuthoring(request) &&
    hasClientCapability(request.headers, "automations-draft-recovery-v1")
  );
}

/** Side chats are listed and linked to their parents only for clients that negotiated them. */
function supportsSideChats(request: Request) {
  return hasClientCapability(request.headers, sideChatsCapability);
}

/** A returned side reply names its side chat and its widgets live there; only the owner's side-chats-v1 clients can follow it. */
function withoutSideNotes(chat: ProtectedChat) {
  for (const message of chat.messages) {
    if (message.sideNote) {
      delete message.sideNote;
      delete message.widgets;
    }
  }
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
    storedDataUsage: async (_profileId: string, assertCurrent: () => void) => [
      ...(await readProtectedFeedbackStorageUsage(
        options.stateDir,
        storageEntryOverheadBytes,
        assertCurrent,
      )),
      ...(await readProtectedAutomationResultStorageUsage(options.stateDir, assertCurrent)),
      ...(await readProtectedAutomationLifecycleStorageUsage(options.stateDir, assertCurrent)),
      ...(await runProtectedSharing(
        options.stateDir,
        "protectedSharing.storageUsage",
        storageEntryOverheadBytes,
        assertCurrent,
      )),
    ],
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
  const baseAutomationCatalog = createProtectedAutomationCatalog({
    agents: { defaultAgentId: agentCatalog.defaultAgentId, agents: agentCatalog.list() },
    models: options.turns.models,
    calendarDraftValidationAvailable: true,
    persistenceAvailable: Boolean(admitStorage),
  });
  const pacingCatalog = baseAutomationCatalog && {
    ...baseAutomationCatalog,
    schedule: { ...baseAutomationCatalog.schedule, pacing: protectedAutomationPacingLimits },
  };
  const catalogFor = (request: Request) =>
    hasClientCapability(request.headers, automationPacingCapability) &&
    automationSchedulerStarted &&
    !automationStorageRecovery.status().admissionClosed
      ? pacingCatalog
      : baseAutomationCatalog;
  const assertDraftPacingAvailable = (
    catalog: ProtectedAutomationCatalog | undefined,
    draft: { pacing?: unknown } | undefined,
  ) => {
    if (draft?.pacing && !catalog?.schedule.pacing) {
      throw new ProtectedError(
        409,
        "pacing_unavailable",
        "Update Alcove before editing a model-chosen schedule.",
      );
    }
  };
  const bindSavedAutomation = (
    authority: ProtectedChatAuthority,
    chatId: string,
    automation: StoredAutomationRecord,
  ) =>
    chats.bindAutomation(authority, chatId, automation.id, (draft) => {
      const validated = pacingCatalog && validateProtectedAutomationDraft(draft, pacingCatalog);
      return (
        !automation.enabled && validated?.valid === true && savesDraft(automation, validated.draft)
      );
    });
  const runs = new Map<string, Run>();
  const pending = new Set<Promise<unknown>>();
  const revokedSessions = new Set<string>();
  const deniedProfiles = new Set<string>();
  const retiringProfiles = new Set<string>();
  const retiringAdmissions = new Set<string>();
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
  const withProtectedFiles = <T>(
    profileId: string,
    use: (scope: Awaited<ReturnType<typeof createAuthorizedUserFiles>>) => Promise<T>,
    assertCurrent: () => void,
    signal: AbortSignal,
  ) =>
    createAuthorizedUserFiles({
      ...options,
      encryption,
      profileId,
      assertCurrent,
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
  const automationAuthority = (
    member: {
      id: string;
      profileId: string;
      issuer: string;
      subject: string;
      revision: number;
    },
    run?: { automationId: string; version: number; trigger: "scheduled" | "manual" },
  ) => {
    const assertGrant = () => {
      shutdown.signal.throwIfAborted();
      assertAutomationHostCurrent();
      if (deniedProfiles.has(member.profileId) || retiringProfiles.has(member.profileId)) {
        throw new ProtectedError(403, "member_inactive", "This member no longer has access.");
      }
    };
    const checkGrant = async (assert = assertGrant) => {
      assert();
      const current = await isProtectedAdmissionCurrent(options.stateDir, member);
      assert();
      if (!current) {
        throw new ProtectedError(403, "member_inactive", "This member no longer has access.");
      }
      if (run) {
        const automation = await readOwnedProtectedAutomationStorageRecord(
          options.stateDir,
          run.automationId,
          { profileId: member.profileId, assertCurrent: assert },
        );
        assert();
        if (!automation || (run.trigger === "scheduled" && !automation.enabled)) {
          throw new ProtectedError(409, "automation_disabled", "This automation is paused.");
        }
        if (automation.definitionRevision !== run.version) {
          throw new ProtectedError(
            409,
            "definition_changed",
            "This automation changed before the run started.",
          );
        }
      }
    };
    const storageLimit = (assert: () => void) =>
      storageLimitFor(
        {
          id: member.profileId,
          owner: member.issuer === options.accessIssuer && member.subject === options.ownerSubject,
        },
        assert,
      );
    const files = <T>(
      use: (scope: Awaited<ReturnType<typeof createAuthorizedUserFiles>>) => Promise<T>,
      assert = assertGrant,
      signal = shutdown.signal,
    ) => withProtectedFiles(member.profileId, use, assert, signal);
    return {
      profile: { id: member.profileId },
      authority: { profileId: member.profileId, assertCurrent: assertGrant },
      assertCurrent: assertGrant,
      assertGrant,
      revalidate: () => checkGrant(),
      checkGrant,
      storageLimit,
      files,
    };
  };
  let assertAutomationHostCurrent: () => void = () => {
    throw new Error("Protected automation host has not started.");
  };
  const automationStorageRecovery = createProtectedAutomationStorageRecoveryOwner(() => {
    shutdown.signal.throwIfAborted();
    assertAutomationHostCurrent();
  });
  const automationCreationSafety = (authority: {
    profileId: string;
    assertCurrent: () => void;
  }) => ({
    hasRunHistory: (automationId: string) => chats.hasAutomationRunHistory(authority, automationId),
    enrollPublication: automationStorageRecovery.enrollPublication,
    retainUncertainCreateCommit: automationStorageRecovery.retainUncertainCreateCommit,
    reconcile: () => reconcileUncertainAutomationStorage(),
  });
  const createAutomationPublicationAuthority = (
    member: ReturnType<typeof automationAuthority>,
  ): {
    lifecycle: ProtectedAutomationLifecycleAuthority;
    result: ProtectedAutomationResultAdmission;
  } => {
    if (!admitStorage) {
      throw new ProtectedError(503, "storage_unavailable", "Automation storage is unavailable.");
    }
    const storage = admitStorage;
    const common = {
      profileId: member.profile.id,
      revalidate: member.revalidate,
      assertCurrent: member.assertCurrent,
      enrollPublication: automationStorageRecovery.enrollPublication,
      reserveStorage: async (bytes: number) => {
        await member.revalidate();
        const limit = await member.storageLimit(member.assertCurrent);
        return storage.reserveStoredData(member.profile.id, member.assertCurrent, bytes, limit);
      },
    };
    return {
      lifecycle: {
        ...common,
        reserveReplacement: async (change) => {
          await member.revalidate();
          const limit = await member.storageLimit(member.assertCurrent);
          return storage.reserveStoredDataReplacement(
            member.profile.id,
            member.assertCurrent,
            change,
            limit,
          );
        },
        reserveBatchReplacement: async (change) => {
          await member.revalidate();
          const limit = await member.storageLimit(member.assertCurrent);
          return storage.reserveStoredDataBatchReplacement(
            member.profile.id,
            member.assertCurrent,
            change,
            limit,
          );
        },
        retireStorage: (entries) =>
          storage.retiredStoredData(entries.map((removed) => ({ removed }))),
        retireDefinition: (entry) => {
          storage.deletedAutomations([entry]);
          automationRefreshes.set(entry.id, (automationRefreshes.get(entry.id) ?? 0) + 1);
          automationMembers.delete(entry.id);
          automationScheduler.remove(entry.id);
        },
        retainUncertainCommit: automationStorageRecovery.retainUncertainCommit,
      },
      result: {
        ...common,
        retainUncertainCommit: automationStorageRecovery.retainUncertainResultCommit,
      },
    };
  };
  const startProtectedTurn = async (context: {
    request: Request;
    id: string;
    profile: { id: string; displayName?: string | null };
    sessionHash?: string;
    authority: { profileId: string; assertCurrent: () => void };
    assertCurrent: () => void;
    assertGrant: () => void;
    revalidate: () => Promise<void>;
    checkGrant: (assert?: () => void) => Promise<void>;
    storageLimit: (assert: () => void) => Promise<number | null>;
    files: <T>(
      use: (scope: Awaited<ReturnType<typeof createAuthorizedUserFiles>>) => Promise<T>,
      assert?: () => void,
      signal?: AbortSignal,
    ) => Promise<T>;
    timing: ProtectedTurnTimer;
    textLimit?: number;
    automationId?: string;
    automationContextAccess?: "isolated" | "member";
    proposeNextCheck?: (delayMs: number) => void;
  }): Promise<{ response: Response; completion: Promise<ProtectedTurnCompletion> }> => {
    const {
      request,
      id,
      profile,
      sessionHash,
      authority,
      assertGrant,
      revalidate,
      checkGrant,
      storageLimit,
      files,
      timing,
      proposeNextCheck,
      textLimit = 16_000,
    } = context;
    const automationCatalog = catalogFor(request);
    const requestBody = await body(request);
    timing.at("bodyParsed");
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
      (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
    ) {
      throw new ProtectedError(
        401,
        "provider_credential_expired",
        "Reconnect or renew this provider first.",
      );
    }
    let copilotModel: Awaited<ReturnType<typeof fetchProtectedCopilotModels>>[number] | undefined;
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
      text: text(data.text, textLimit),
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
    // Only the server-held binding admits authoring tools.
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
      assertDraftPacingAvailable(automationCatalog, authoringInput.draft);
      if (automationId === undefined) {
        if (authoringInput.automationVersion !== undefined) {
          invalid();
        }
        if (authoringInput.draft.contextAccess === "isolated") {
          throw new ProtectedError(
            503,
            "automation_isolation_unavailable",
            "Isolated automation execution is unavailable until its memory boundary is ready.",
          );
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
      assertDraftPacingAvailable(automationCatalog, saved);
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
    timing.at("turnGrantChecked");
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
        timing.at("aliasesPrepared");
        // Storage charges continue after the client disconnects, so they check only the grant.
        storage = await admitStorage?.(
          profile.id,
          assertGrant,
          "turn",
          await storageLimit(assertGrant),
        );
        if (storage) {
          timing.note("storageQueueMs", storage.queueMs);
          timing.note("storageScanMs", storage.scanMs);
        }
        timing.at("storageAdmitted");
        if (shutdown.signal.aborted || runs.has(id)) {
          throw new ProtectedError(409, "busy", "A turn is already running in this chat.");
        }
        if (request.signal.aborted) {
          request.signal.throwIfAborted();
        }
        const currentEntry = await chats.readEntry(authority, id);
        assertRunChatWritable(currentEntry, context.automationId);
        const authoring = await admitAuthoringTurn(currentEntry);
        timing.at("turnEntryRead");
        // Only interactive member turns get a browser; any automation run or run chat fails closed.
        const browserEligible =
          context.automationId === undefined && currentEntry.protectedAutomationRunId === undefined;
        const selectedAgentId = currentEntry.protectedAgentId ?? agentCatalog.legacyDefaultAgentId;
        const selectedAgent = agentCatalog.get(selectedAgentId);
        if (!selectedAgent) {
          throw new ProtectedError(422, "agent_unavailable", "This chat's agent is unavailable.");
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
        timing.at("admissionGrantChecked");
        const stored =
          authoring && !authoring.automationId ? readAuthoringDraft(currentEntry) : undefined;
        const durableDraft =
          authoring &&
          !authoring.automationId &&
          (supportsDraftRecovery(request) || stored !== undefined);
        if (authoring && durableDraft) {
          const { draft, draftRevision } = authoring.input;
          if (stored) {
            if (stored.draftRevision !== draftRevision || !isDeepStrictEqual(stored.draft, draft)) {
              throw draftMismatch();
            }
          } else {
            if (draftRevision !== "1" || !storage) {
              throw draftMismatch();
            }
            await chats.checkpointDraft(authority, id, null, draft, storage.charge);
            await revalidate();
            profileAuthority.assertCurrent();
          }
        }
        if (shutdown.signal.aborted || runs.has(id)) {
          throw new ProtectedError(409, "busy", "A turn is already running in this chat.");
        }
        const run: Run = {
          id: randomUUID(),
          profileId: profile.id,
          ...(sessionHash === undefined ? {} : { sessionHash }),
          controller: new AbortController(),
          steering: new Map(),
        };
        runs.set(id, run);
        timing.note("activeTurns", runs.size);
        return {
          run,
          authoring,
          durableDraft,
          browserEligible,
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
      durableDraft,
      browserEligible,
      selectedAgent,
      mentionedAgents,
      storage,
      profileAuthority,
      sessionEntry,
      parentLifecycleRevision,
      parentSessionId,
    } = admission;
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
    let checkpointUpdates = durableDraft;
    const automationChat = authoring
      ? createProtectedAutomationAuthoringBindings({
          stateDir: options.stateDir,
          catalog: authoring.catalog,
          retainedAgent: (agentId) => agentCatalog.get(agentId),
          authority: runAuthority,
          revalidate: checkRun,
          present: (automation) => presentAutomation(automation, request),
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
          creationSafety: automationCreationSafety(runAuthority),
          bind: async (automation) => {
            const chat = await bindSavedAutomation(runAuthority, id, automation);
            const bound = chat.authoring?.automationId === automation.id;
            if (bound) {
              checkpointUpdates = false;
            }
            return bound;
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
            present: (automation) => presentAutomation(automation, request),
          })
        : undefined;
    const parentSessionKey = chats.scope(runAuthority, id).sessionKey;
    const profileSessionPrefix = chats.scope(runAuthority, "").sessionKey;
    const ownedChildSessionKeys = new Set<string>();
    const pendingChildResults = new Map<string, { agentId: string; widgets: Widget[] }>();
    const saveChildResult: ProtectedTurn["saveChildResult"] = async (result) => {
      await checkRun();
      const save = () =>
        chats.saveChildResult(runAuthority, id, {
          ...result,
          parentLifecycleRevision,
        });
      await (storage ? withTranscriptWriteBudget(storage.charge, save) : save());
      pendingChildResults.delete(result.runId);
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
    let completion!: Promise<ProtectedTurnCompletion>;
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
            if (checkpointUpdates && event.type === "automation-draft-update" && storage) {
              await checkRun();
              await chats.checkpointDraft(
                runAuthority,
                id,
                event.baseDraftRevision,
                event.draft,
                storage.charge,
              );
            }
            send(event);
          };
        }
        // Silent reasoning can last minutes. A blank NDJSON line keeps the Cloudflare tunnel
        // from closing an idle response; clients skip blank lines.
        const keepalive = setInterval(() => write("\n"), 15_000);
        keepalive.unref();
        const complete = async (): Promise<ProtectedTurnCompletion> => {
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
            timing.at("historyRead");
            // Returned side replies point at another chat's widgets; they never join this chat's chain.
            const widgetChain = createWidgetChain(
              before.messages.flatMap((message) =>
                message.sideNote ? [] : (message.widgets ?? []),
              ),
            );
            await files(
              async (owned) => {
                const beforeArtifacts = await listChatArtifactFiles(
                  owned,
                  id,
                  options.maxFileBytes,
                );
                timing.at("artifactsListed");
                const storageFiles = storage?.files(owned);
                const execute = () =>
                  options.turns.run({
                    id,
                    runId: run.id,
                    profileId: profile.id,
                    automationContextAccess: context.automationContextAccess,
                    ...(proposeNextCheck
                      ? {
                          proposeNextCheck: (delayMs: number) => {
                            assertRun();
                            proposeNextCheck(delayMs);
                          },
                        }
                      : {}),
                    target: {
                      ...chats.scope(runAuthority, id),
                      nativeSessionId: parentSessionId,
                      lifecycleRevision: parentLifecycleRevision,
                    },
                    input,
                    ...(automationChat ? { automationChat } : {}),
                    ...(browserEligible && !authoring ? { browserAccess: "fresh" as const } : {}),
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
                    markStep: timing.at,
                    toolTiming: timing.tool,
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
                    childEvent: (event) => {
                      if (event.type === "child-start") {
                        pendingChildResults.set(event.runId, {
                          agentId: event.agentId,
                          widgets: [],
                        });
                      } else if (event.type === "child-widget") {
                        pendingChildResults.get(event.runId)?.widgets.push({
                          id: event.id,
                          title: event.title,
                        });
                      }
                      if (hasClientCapability(request.headers, "specialist-stream-v1")) {
                        send(event);
                      }
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
                      await owned.stat(`${chatWidgetsDirectory(id)}/${widget.id}/manifest.json`);
                      send({ type: "widget", ...widgetChain(widget) });
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
            timing.at("resultRead");
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
              timing.at("budgetSaved");
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
                ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
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
            // Execution cancellation ends model work, not the owner's obligation to
            // record an unfinished handoff. Membership and the parent generation still gate writes.
            const assertSettlement = () => {
              assertGrant();
              profileAuthority.assertCurrent();
              if (runs.get(id) !== run) {
                unauthorized();
              }
            };
            try {
              for (const [childRunId, child] of pendingChildResults) {
                await checkGrant(assertSettlement);
                assertSettlement();
                const save = () =>
                  chats.saveChildResult(
                    { profileId: profile.id, assertCurrent: assertSettlement },
                    id,
                    {
                      runId: childRunId,
                      agentId: child.agentId,
                      text: "The agent did not finish. Please try again.",
                      timestamp: Date.now(),
                      parentLifecycleRevision,
                      status: "failed",
                      widgets: child.widgets,
                    },
                  );
                await (storage ? withTranscriptWriteBudget(storage.charge, save) : save());
                pendingChildResults.delete(childRunId);
              }
            } catch (saveError) {
              failure = saveError;
              process.stderr.write(
                `Protected specialist failure could not be saved (${publicError(saveError).code}).\n`,
              );
            }
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
            timing.modelRequests(modelRequests);
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
              process.stderr.write("Protected usage could not be recorded for a completed run.\n");
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
          return { runId: run.id, outcome, errorCode, responseId };
        };
        completion = track(complete());
      },
      cancel() {
        // Stop is an explicit route. A closed connection only detaches the reader.
        attached = false;
      },
    });
    return {
      response: new Response(stream, {
        headers: { ...commonHeaders, "content-type": "application/x-ndjson; charset=utf-8" },
      }),
      completion,
    };
  };
  const executeProtectedAutomationTurn = async (
    member: Parameters<typeof automationAuthority>[0],
    automation: NonNullable<Awaited<ReturnType<typeof readOwnedProtectedAutomationStorageRecord>>>,
    chatId: string,
    trigger: "scheduled" | "manual",
  ) => {
    const definition = automation.definition;
    const authority = automationAuthority(member, {
      automationId: automation.id,
      version: automation.definitionRevision,
      trigger,
    });
    const prompt = [
      `Automation: ${definition.name}`,
      definition.instructions,
      `Notification intent: ${definition.whenToNotify}`,
      ...(definition.doneWhen ? [`Completion intent: ${definition.doneWhen}`] : []),
      ...(trigger === "scheduled" && definition.pacing && definition.schedule.kind === "every"
        ? [
            `Choose when to check again with next_check. The member allows delays from ${definition.pacing.minMs} to ${definition.pacing.maxMs} ms after completion. Without a proposal, the next check is in ${definition.schedule.everyMs} ms.`,
          ]
        : []),
    ].join("\n\n");
    const request = new Request(`${options.origin}${base}/chats/${chatId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: definition.model.provider,
        model: definition.model.id,
        text: prompt,
        ...(definition.thinking ? { thinking: definition.thinking } : {}),
      }),
    });
    let proposedDelayMs: number | undefined;
    const turn = await startProtectedTurn({
      request,
      id: chatId,
      ...authority,
      timing: createProtectedTurnTiming(performance.now()),
      textLimit: 32_000,
      automationId: automation.id,
      automationContextAccess: definition.contextAccess ?? "member",
      ...(trigger === "scheduled" && definition.pacing
        ? {
            proposeNextCheck: (delayMs: number) => {
              proposedDelayMs = delayMs;
            },
          }
        : {}),
    });
    await turn.response.body?.cancel();
    const result = await turn.completion;
    return {
      ...result,
      proposedDelayMs: result.outcome === "complete" ? proposedDelayMs : undefined,
    };
  };
  type AutomationMember = Parameters<typeof automationAuthority>[0];
  const automationMembers = new Map<string, AutomationMember>();
  const automationRefreshes = new Map<string, number>();
  const activeAutomations = new Map<
    string,
    { profileId: string; completion?: Promise<ProtectedAutomationCheckDecision | undefined> }
  >();
  const orphanedAutomationRuns = new Map<string, { profileId: string; runId: string }>();
  const recoveringAutomationRuns = new Map<string, Promise<void>>();
  let automationOperator: AutomationMember | undefined;
  const automationOwnerAuthority = (
    profileId: string,
    maintenance: boolean,
  ): ProtectedAutomationLifecycleOwnerAuthority => {
    if (!automationOperator) {
      throw new ProtectedError(
        503,
        "owner_unavailable",
        "The configured owner must be active to recover automation runs.",
      );
    }
    const operator = automationOperator;
    const actor = automationAuthority(operator);
    const target = {
      ...actor,
      profile: { id: profileId },
      storageLimit: (assert: () => void) =>
        storageLimitFor({ id: profileId, owner: profileId === operator.profileId }, assert),
    };
    const publication = createAutomationPublicationAuthority(target).lifecycle;
    return {
      ...publication,
      ...(maintenance ? { enrollPublication: automationStorageRecovery.enrollMaintenance } : {}),
      operator: {
        profileId: operator.profileId,
        issuer: operator.issuer,
        subject: operator.subject,
      },
      assertOwnerCurrent: () => {
        assertAutomationHostCurrent();
        actor.assertCurrent();
      },
      assertRunStopped: (automationId) => {
        assertAutomationHostCurrent();
        if (activeAutomations.has(automationId)) {
          throw new Error("Protected automation run is still active.");
        }
      },
    };
  };
  const reconcileUncertainAutomationStorage = () => {
    const status = automationStorageRecovery.status();
    if (!status.pending || status.enrolled) {
      return;
    }
    if (!automationOperator) {
      process.stderr.write(
        "Protected automation storage recovery requires an active configured owner.\n",
      );
      return;
    }
    const owner = automationAuthority(automationOperator);
    void track(
      owner
        .revalidate()
        .then(() => automationStorageRecovery.reconcile())
        .then((result) => {
          if (result.pending) {
            process.stderr.write(
              "Protected automation storage is awaiting a native write receipt.\n",
            );
          }
        })
        .catch(() => {
          process.stderr.write("Protected automation storage recovery could not be completed.\n");
        }),
    );
  };
  const recoverOrphanedAutomationRun = (automationId: string): Promise<void> => {
    const existing = recoveringAutomationRuns.get(automationId);
    if (existing) {
      return existing;
    }
    const candidate = orphanedAutomationRuns.get(automationId);
    if (!candidate) {
      return Promise.resolve();
    }
    const recovery = (async () => {
      const owner = automationOwnerAuthority(candidate.profileId, false);
      await owner.revalidate();
      await automationStorageRecovery.waitForIdle(shutdown.signal);
      const settled = await automationStorageRecovery.reconcile();
      if (settled.pending || automationStorageRecovery.status().admissionClosed) {
        throw new Error("Protected automation storage is awaiting recovery.");
      }
      const interrupted = await readProtectedAutomationInterruptedRunForOwner(
        options.stateDir,
        automationId,
        owner,
      );
      if (interrupted === undefined) {
        throw new Error("Protected automation recovery lost owner authority.");
      }
      if (interrupted?.runId === candidate.runId) {
        const result = await writeProtectedAutomationLifecycleForOwner(
          options.stateDir,
          {
            kind: "finish",
            profileId: candidate.profileId,
            automationId,
            runId: candidate.runId,
            now: Date.now(),
            outcome: { status: "failed", errorCode: "interrupted" },
          },
          owner,
        );
        if (result.status !== "committed" && result.status !== "unchanged") {
          throw new Error("Protected automation interruption could not be recorded.");
        }
      }
      if (orphanedAutomationRuns.get(automationId) === candidate) {
        orphanedAutomationRuns.delete(automationId);
      }
    })().finally(() => {
      recoveringAutomationRuns.delete(automationId);
    });
    recoveringAutomationRuns.set(automationId, recovery);
    return recovery;
  };
  const recoverOrphanedAutomationRunInBackground = (
    automationId: string,
    profileId: string,
    runId: string,
  ) => {
    orphanedAutomationRuns.set(automationId, { profileId, runId });
    void track(
      recoverOrphanedAutomationRun(automationId).catch(() => {
        process.stderr.write("Protected automation run recovery could not be completed.\n");
      }),
    );
  };
  const findAutomationMember = async (profileId: string): Promise<AutomationMember | undefined> => {
    const admissions = await listProtectedAdmissions(options.stateDir);
    const members = admissions.filter(
      (entry) =>
        entry.profileId === profileId &&
        entry.status === "approved" &&
        entry.issuer === options.accessIssuer &&
        entry.subject !== undefined,
    );
    const member = members.find((entry) => entry.subject === options.ownerSubject) ?? members[0];
    return member?.profileId && member.subject
      ? {
          id: member.id,
          profileId: member.profileId,
          issuer: member.issuer,
          subject: member.subject,
          revision: member.revision,
        }
      : undefined;
  };
  const automationScheduler = createProtectedAutomationScheduler(async (scheduled, due) => {
    const member = automationMembers.get(scheduled.id);
    if (!member) {
      return undefined;
    }
    try {
      const queued = await queueProtectedAutomationRun(member, scheduled, "scheduled", due);
      return await queued.completion;
    } catch (error) {
      if (publicError(error).code !== "member_inactive") {
        throw error;
      }
      const authority = automationOwnerAuthority(member.profileId, false);
      const refused = await writeProtectedAutomationLifecycleForOwner(
        options.stateDir,
        {
          kind: "refuse",
          profileId: member.profileId,
          automationId: scheduled.id,
          runId: randomUUID(),
          definitionRevision: Number(scheduled.version),
          trigger: "scheduled",
          scheduledAtMs: due,
          now: Date.now(),
          errorCode: "member_inactive",
        },
        authority,
      );
      if (refused.status !== "committed" && refused.status !== "unchanged") {
        throw new Error("Protected automation inactive-member refusal could not be recorded.", {
          cause: error,
        });
      }
      return undefined;
    }
  });
  let automationSchedulerStarted = false;
  const presentAutomation = (
    automation: StoredAutomationRecord,
    request: Request,
  ): ProtectedAutomationRecord => {
    const next =
      automation.enabled && automationSchedulerStarted
        ? automationScheduler.nextCheck(automation.id, automation.version)
        : null;
    const { contextAccess, pacing, ...record } = automation;
    const includePacing = hasClientCapability(request.headers, automationPacingCapability);
    return {
      ...record,
      ...(hasClientCapability(request.headers, automationContextCapability)
        ? { contextAccess: contextAccess ?? "member" }
        : {}),
      ...(includePacing && pacing
        ? { pacing, ...(next?.reason ? { nextCheckReason: next.reason } : {}) }
        : {}),
      nextCheckAt: next ? new Date(next.atMs).toISOString() : null,
    };
  };
  const refreshProtectedAutomation = async (member: AutomationMember, automationId: string) => {
    const revision = (automationRefreshes.get(automationId) ?? 0) + 1;
    automationRefreshes.set(automationId, revision);
    const authority = automationAuthority(member);
    await authority.revalidate();
    const automation = await readOwnedProtectedAutomationStorageRecord(
      options.stateDir,
      automationId,
      authority.authority,
    );
    if (automationRefreshes.get(automationId) !== revision) {
      return;
    }
    if (!automation?.enabled) {
      automationMembers.delete(automationId);
      automationScheduler.remove(automationId);
      return;
    }
    const last = await readProtectedAutomationLastScheduledAttempt(options.stateDir, automationId, {
      ...authority.authority,
      revalidate: authority.revalidate,
    });
    await authority.revalidate();
    if (automationRefreshes.get(automationId) !== revision) {
      return;
    }
    if (!last) {
      throw new ProtectedError(404, "not_found", "Automation not found.");
    }
    automationMembers.set(automationId, member);
    automationScheduler.update(
      {
        id: automation.id,
        version: String(automation.definitionRevision),
        ...(automation.definition.pacing && automation.definition.schedule.kind === "every"
          ? { pacing: automation.definition.pacing, schedule: automation.definition.schedule }
          : { schedule: automation.definition.schedule }),
        updatedAt: automation.updatedAt,
        ...(last.scheduledAtMs === null ? {} : { lastScheduledAt: last.scheduledAtMs }),
      },
      last.check,
    );
  };
  const retryProtectedAutomationInbox = async (member: AutomationMember, automationId: string) => {
    const memberAuthority = automationAuthority(member);
    const history = await listProtectedAutomationLifecycleRuns(options.stateDir, automationId, {
      ...memberAuthority.authority,
      revalidate: memberAuthority.revalidate,
    });
    if (!history) {
      return;
    }
    const lifecycle = createAutomationPublicationAuthority(memberAuthority).lifecycle;
    for (const run of history) {
      if (run.delivery !== "pending") {
        continue;
      }
      try {
        const delivered = await writeProtectedAutomationLifecycle(
          options.stateDir,
          {
            kind: "deliver",
            profileId: member.profileId,
            automationId,
            runId: run.id,
            now: Date.now(),
          },
          lifecycle,
        );
        if (delivered.status !== "committed" && delivered.status !== "unchanged") {
          throw new Error("Protected automation inbox retry could not be recorded.");
        }
      } catch (error) {
        if (!["quota_exceeded", "storage_full"].includes(publicError(error).code)) {
          throw error;
        }
        process.stderr.write(
          "Protected automation inbox delivery remains pending because storage is full.\n",
        );
        return;
      }
    }
  };
  async function queueProtectedAutomationRun(
    member: AutomationMember,
    scheduled: ProtectedScheduledAutomation,
    trigger: "scheduled" | "manual",
    scheduledAtMs: number,
  ) {
    const memberAuthority = automationAuthority(member);
    await memberAuthority.revalidate();
    const automation = await readOwnedProtectedAutomationStorageRecord(
      options.stateDir,
      scheduled.id,
      memberAuthority.authority,
    );
    if (!automation || (trigger === "scheduled" && !automation.enabled)) {
      throw new ProtectedError(409, "automation_disabled", "This automation is paused.");
    }
    if (String(automation.definitionRevision) !== scheduled.version) {
      throw new ProtectedError(412, "definition_changed", "Reload the automation before running.");
    }
    if (automation.definition.contextAccess === "isolated") {
      throw new ProtectedError(
        503,
        "automation_isolation_unavailable",
        "Isolated automation execution is unavailable until its memory boundary is ready.",
      );
    }
    await recoverOrphanedAutomationRun(scheduled.id);
    await retryProtectedAutomationInbox(member, scheduled.id);
    const publication = createAutomationPublicationAuthority(memberAuthority);
    const lifecycle = publication.lifecycle;
    const resultAdmission = publication.result;
    const runId = randomUUID();
    const queuedAtMs = Date.now();
    let queued;
    try {
      if (trigger === "manual") {
        const provisioned = await writeProtectedAutomationLifecycle(
          options.stateDir,
          { kind: "provision", profileId: member.profileId, automationId: automation.id },
          lifecycle,
        );
        if (provisioned.status !== "committed" && provisioned.status !== "unchanged") {
          throw new ProtectedError(503, "storage_unavailable", "Automation storage is not ready.");
        }
      }
      queued = await writeProtectedAutomationLifecycle(
        options.stateDir,
        {
          kind: "queue",
          profileId: member.profileId,
          automationId: automation.id,
          definitionRevision: automation.definitionRevision,
          trigger,
          scheduledAtMs,
          runId,
          now: queuedAtMs,
        },
        lifecycle,
      );
    } catch (error) {
      recoverOrphanedAutomationRunInBackground(automation.id, member.profileId, runId);
      throw error;
    } finally {
      reconcileUncertainAutomationStorage();
    }
    if (queued.status !== "committed") {
      if (queued.status === "disabled") {
        throw new ProtectedError(409, "automation_disabled", "This automation is paused.");
      }
      if (queued.status === "definition-changed") {
        throw new ProtectedError(
          412,
          "definition_changed",
          "Reload the automation before running.",
        );
      }
      if (queued.status === "not-provisioned") {
        throw new ProtectedError(503, "storage_unavailable", "Automation storage is not ready.");
      }
      throw new ProtectedError(409, "automation_busy", "This automation cannot start another run.");
    }
    if (retiringProfiles.has(member.profileId)) {
      recoverOrphanedAutomationRunInBackground(automation.id, member.profileId, runId);
      throw new ProtectedError(403, "member_inactive", "This member no longer has access.");
    }
    activeAutomations.set(automation.id, { profileId: member.profileId });
    const completion = track(
      (async () => {
        let started = false;
        let completedTurn = false;
        let succeeded = false;
        let committedCheck: ProtectedAutomationCheckDecision | undefined;
        try {
          const runAuthority = automationAuthority(member, {
            automationId: automation.id,
            version: automation.definitionRevision,
            trigger,
          });
          const binding = await readProtectedAutomationRunChat(options.stateDir, automation.id, {
            ...memberAuthority.authority,
            revalidate: memberAuthority.revalidate,
          });
          if (!binding) {
            throw new ProtectedError(404, "not_found", "Automation not found.");
          }
          const chatId = binding.runChatId ?? randomUUID();
          const start = await writeProtectedAutomationLifecycle(
            options.stateDir,
            {
              kind: "start",
              profileId: member.profileId,
              automationId: automation.id,
              runId,
              chatId,
              now: Date.now(),
            },
            lifecycle,
          );
          if (start.status !== "committed") {
            if (start.status === "disabled" || start.status === "definition-changed") {
              throw new ProtectedError(
                409,
                start.status === "disabled" ? "automation_disabled" : "definition_changed",
                "This automation changed.",
              );
            }
            throw new ProtectedError(409, "automation_unavailable", "This automation changed.");
          }
          started = true;
          let entry;
          try {
            entry = await chats.readEntry(runAuthority.authority, chatId);
          } catch (error) {
            if (!(error instanceof ProtectedError && error.status === 404)) {
              throw error;
            }
            if (!admitStorage || creating.has(member.profileId)) {
              throw new ProtectedError(409, "busy", "Another chat is being created.");
            }
            creating.add(member.profileId);
            let storage;
            try {
              await runAuthority.revalidate();
              storage = await admitStorage(
                member.profileId,
                runAuthority.assertCurrent,
                "create",
                await runAuthority.storageLimit(runAuthority.assertCurrent),
              );
              await chats.create(
                runAuthority.authority,
                automation.definition.name,
                automation.definition.agentId,
                undefined,
                { chatId, automationId: automation.id },
              );
              storage.recordCreatedChat(
                chatId,
                chats.scope(runAuthority.authority, chatId).sessionKey,
              );
            } finally {
              storage?.release();
              creating.delete(member.profileId);
            }
            entry = await chats.readEntry(runAuthority.authority, chatId);
          }
          if (entry.protectedAutomationRunId !== automation.id) {
            throw new ProtectedError(
              409,
              "chat_conflict",
              "This run chat belongs to another task.",
            );
          }
          if (!entry.sessionId) {
            throw new ProtectedError(409, "session_unavailable", "This run chat has no session.");
          }
          if (entry.protectedAgentId !== automation.definition.agentId) {
            await runAuthority.revalidate();
            await chats.selectAgent(
              runAuthority.authority,
              chatId,
              String(entry.updatedAt),
              automation.definition.agentId,
            );
          }
          const turn = await executeProtectedAutomationTurn(member, automation, chatId, trigger);
          if (turn.outcome !== "complete" || !turn.responseId) {
            throw new ProtectedError(500, turn.errorCode ?? "turn_failed", "The run failed.");
          }
          completedTurn = true;
          await runAuthority.revalidate();
          const { chat } = await chats.readWithUsage(runAuthority.authority, chatId);
          const reply = chat.messages.find((message) => message.id === turn.responseId);
          if (!reply || reply.role !== "assistant" || reply.status !== "complete") {
            throw new ProtectedError(500, "result_failed", "The completed reply was not found.");
          }
          const finished = await commitProtectedAutomationFinishedResult(
            options.stateDir,
            {
              automationId: automation.id,
              definitionRevision: automation.definitionRevision,
              centralOwnerProfileId: member.profileId,
              jobId: automation.id,
              runAtMs: scheduledAtMs,
              runId,
              completedAtMs: Date.now(),
              automationName: automation.definition.name,
              privateFinalText: reply.text,
              transcript: {
                sessionKey: chats.scope(runAuthority.authority, chatId).sessionKey,
                sessionId: entry.sessionId,
              },
            },
            resultAdmission,
          );
          if (finished.status !== "created" && finished.status !== "duplicate") {
            throw new ProtectedError(500, "result_failed", "The result could not be saved.");
          }
          const completed = await writeProtectedAutomationLifecycle(
            options.stateDir,
            {
              kind: "finish",
              profileId: member.profileId,
              automationId: automation.id,
              runId,
              now: Date.now(),
              outcome: {
                status: "succeeded",
                resultId: finished.id,
                proposedDelayMs: turn.proposedDelayMs,
              },
            },
            lifecycle,
          );
          if (completed.status !== "committed") {
            throw new ProtectedError(500, "result_failed", "The run result could not be recorded.");
          }
          succeeded = true;
          committedCheck = completed.check;
          const delivered = await writeProtectedAutomationLifecycle(
            options.stateDir,
            {
              kind: "deliver",
              profileId: member.profileId,
              automationId: automation.id,
              runId,
              now: Date.now(),
            },
            lifecycle,
          );
          if (delivered.status !== "committed" && delivered.status !== "unchanged") {
            throw new ProtectedError(
              500,
              "result_failed",
              "The inbox entry could not be recorded.",
            );
          }
          return completed.check;
        } catch (error) {
          if (succeeded) {
            process.stderr.write(
              "Protected automation result was saved but inbox delivery failed.\n",
            );
            // Delivery retries separately; do not replace an already committed deadline.
            if (committedCheck) {
              return committedCheck;
            }
            throw new Error("Protected automation inbox delivery failed.", { cause: error });
          }
          const issue = publicError(error);
          const skipped =
            issue.code === "member_inactive" ||
            (!completedTurn &&
              [
                "automation_disabled",
                "definition_changed",
                "quota_exceeded",
                "storage_full",
              ].includes(issue.code));
          const providerError = [
            "provider_timeout",
            "provider_busy",
            "provider_rejected",
            "provider_failed",
            "plan_limit",
            "model_unavailable",
            "chat_too_long",
          ] as const;
          const providerErrorCode = providerError.find((code) => code === issue.code);
          const errorCode: ProtectedAutomationRunError = skipped
            ? issue.code === "member_inactive"
              ? "member_inactive"
              : issue.code === "automation_disabled"
                ? "automation_disabled"
                : issue.code === "definition_changed"
                  ? "definition_changed"
                  : "quota_exceeded"
            : completedTurn
              ? "result_failed"
              : started
                ? (providerErrorCode ?? "turn_failed")
                : "interrupted";
          const command = {
            kind: "finish" as const,
            profileId: member.profileId,
            automationId: automation.id,
            runId,
            now: Date.now(),
            outcome: { status: skipped ? ("skipped" as const) : ("failed" as const), errorCode },
          };
          if (errorCode === "member_inactive") {
            activeAutomations.delete(automation.id);
          }
          const finished =
            errorCode === "member_inactive"
              ? await writeProtectedAutomationLifecycleForOwner(
                  options.stateDir,
                  command,
                  automationOwnerAuthority(member.profileId, false),
                )
              : await writeProtectedAutomationLifecycle(options.stateDir, command, lifecycle);
          if (finished.status !== "committed" && finished.status !== "unchanged") {
            throw new Error("Protected automation failure could not be recorded.", {
              cause: error,
            });
          }
          return finished.status === "committed" ? finished.check : undefined;
        } finally {
          activeAutomations.delete(automation.id);
          reconcileUncertainAutomationStorage();
        }
      })(),
    );
    const active = activeAutomations.get(automation.id);
    if (active) {
      active.completion = completion;
    }
    void completion.catch(() => {
      recoverOrphanedAutomationRunInBackground(automation.id, member.profileId, runId);
      process.stderr.write("Protected automation could not record its run outcome.\n");
    });
    return { runId, completion };
  }
  const handle = async (request: Request): Promise<Response> => {
    const automationCatalog = catalogFor(request);
    const timing = createProtectedTurnTiming(performance.now());
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
      timing.at("identityVerified");
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
      const sharingCapability = hasClientCapability(request.headers, "sharing-v1");
      const automationsPublicCapability = hasClientCapability(
        request.headers,
        "automations-public-v1",
      );
      const profile = await resolveProtectedProfile(identity, {
        env: chats.env,
        assertCurrent: rawCurrent,
      });
      timing.at("memberResolved");
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
      timing.at("accessAdmitted");
      assertCurrent();
      await bindProtectedProfile(options.stateDir, {
        issuer: identity.issuer,
        subject: identity.subject,
        profileId: profile.id,
      });
      timing.at("accessBound");
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
        const admission = (await listProtectedAdmissions(options.stateDir)).find(
          (entry) => entry.id === adminPerson[1] && entry.issuer === options.accessIssuer,
        );
        await revalidate();
        if (!admission) {
          throw new ProtectedError(404, "person_not_found", "Person not found.");
        }
        if (admission.subject === options.ownerSubject) {
          throw new ProtectedError(403, "owner_protected", "The owner cannot be removed.");
        }
        if (retiringAdmissions.has(admission.id)) {
          throw new ProtectedError(409, "busy", "This member is already being removed.");
        }
        const targetProfileId = admission.profileId ?? null;
        if (targetProfileId === profile.id) {
          throw new ProtectedError(403, "owner_protected", "The owner cannot be removed.");
        }
        const operator = await findAutomationMember(profile.id);
        if (admitStorage && !operator) {
          throw new ProtectedError(503, "owner_unavailable", "The configured owner is not active.");
        }
        if (operator) {
          automationOperator = operator;
        }
        const clearFence = () => {
          retiringAdmissions.delete(admission.id);
          if (targetProfileId) {
            retiringProfiles.delete(targetProfileId);
          }
        };
        retiringAdmissions.add(admission.id);
        if (targetProfileId) {
          retiringProfiles.add(targetProfileId);
          for (const run of runs.values()) {
            if (run.profileId === targetProfileId) {
              run.controller.abort();
            }
          }
        }
        let uncertain = false;
        let revokeAccess: Promise<unknown> | undefined;
        let person;
        try {
          if (admitStorage) {
            const deadline = AbortSignal.timeout(8_000);
            try {
              await automationStorageRecovery.waitForIdle(deadline);
              while (
                [...activeAutomations.values()].some((run) => run.profileId === targetProfileId)
              ) {
                const completions = [...activeAutomations.values()]
                  .filter((run) => run.profileId === targetProfileId && run.completion)
                  .map((run) => run.completion!);
                await Promise.race([
                  Promise.allSettled(completions),
                  new Promise<never>((_, reject) => {
                    deadline.addEventListener("abort", () => reject(deadline.reason), {
                      once: true,
                    });
                  }),
                ]);
              }
              await automationStorageRecovery.waitForIdle(deadline);
            } catch (error) {
              if (deadline.aborted) {
                throw new ProtectedError(409, "busy", "The member's automation is still stopping.");
              }
              throw error;
            }
          }
          person = await removeProtectedAdmission(
            options.stateDir,
            { id: admission.id, issuer: options.accessIssuer, ownerSubject: options.ownerSubject },
            assertCurrent,
            (subject, removedProfileId, retiredAutomations, retiredStoredDataChanges) => {
              admitStorage?.retiredStoredData(retiredStoredDataChanges);
              if (subject) {
                options.onRemoveSubject?.(subject);
              }
              if (removedProfileId) {
                invalidateProfile(removedProfileId);
                for (const [automationId, member] of automationMembers) {
                  if (member.profileId === removedProfileId) {
                    automationScheduler.remove(automationId);
                    automationMembers.delete(automationId);
                  }
                }
                revokeAccess = track(
                  (async () => {
                    if (operator && automationSchedulerStarted) {
                      const owner = automationAuthority(operator);
                      await owner.revalidate();
                      await updateCanonicalUserProfileAccess(
                        { action: "revoke", profileId: removedProfileId },
                        { env: chats.env, assertCurrent: owner.assertCurrent },
                      );
                    } else {
                      await revalidate();
                      await updateCanonicalUserProfileAccess(
                        { action: "revoke", profileId: removedProfileId },
                        { env: chats.env, assertCurrent },
                      );
                    }
                  })(),
                );
                void revokeAccess.catch(() => {
                  process.stderr.write("Protected member profile access could not be retired.\n");
                });
              }
              admitStorage?.deletedAutomations(retiredAutomations);
            },
            () => options.onPolicyChanged?.(),
            admitStorage
              ? {
                  profileId: targetProfileId,
                  admissionRevision: admission.revision,
                  revalidate,
                  assertWritersStopped: (checkedProfileId) => {
                    assertCurrent();
                    if (
                      checkedProfileId &&
                      (!retiringProfiles.has(checkedProfileId) ||
                        [...activeAutomations.values()].some(
                          (run) => run.profileId === checkedProfileId,
                        ))
                    ) {
                      throw new Error("Protected member automation writers have not stopped.");
                    }
                  },
                  enrollPublication: automationStorageRecovery.enrollPublication,
                  retireStorage: (entries) =>
                    admitStorage.retiredStoredData(entries.map((removed) => ({ removed }))),
                  retainUncertainRemovalCommit: (receipt) => {
                    uncertain = true;
                    automationStorageRecovery.retainUncertainRemovalCommit({
                      ...receipt,
                      settleStorage: () => {
                        receipt.settleStorage();
                        clearFence();
                      },
                      releaseStorage: () => {
                        receipt.releaseStorage();
                        clearFence();
                      },
                    });
                  },
                }
              : undefined,
          );
        } finally {
          if (!uncertain) {
            clearFence();
          } else {
            reconcileUncertainAutomationStorage();
          }
        }
        if (person === "owner_protected") {
          throw new ProtectedError(403, "owner_protected", "The owner cannot be removed.");
        }
        if (!person) {
          throw new ProtectedError(404, "person_not_found", "Person not found.");
        }
        if (person.profileId && revokeAccess) {
          await revokeAccess;
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
        profileId = profile.id,
      ) => withProtectedFiles(profileId, use, assert, signal);
      const visibleChats = async () => {
        const owned = await chats.list(authority);
        return supportsSideChats(request) ? owned : owned.filter((chat) => !chat.side);
      };
      const readChat = async (id: string, owner = authority) => {
        const { chat, usage, entry } = await chats.readWithUsage(owner, id);
        if (!hasClientCapability(request.headers, "specialist-stream-v1")) {
          for (const message of chat.messages) {
            delete message.runId;
          }
        }
        if (!supportsAutomationsAuthoring(request)) {
          delete chat.authoring;
        }
        if (!hasClientCapability(request.headers, automationRunsCapability)) {
          delete chat.automationRun;
        }
        if (!supportsSideChats(request)) {
          delete chat.side;
        }
        if (!supportsSideChats(request) || owner.profileId !== authority.profileId) {
          withoutSideNotes(chat);
        }
        if (chat.messages.some((message) => message.widgets?.length)) {
          await files(
            async (owned) => {
              for (const message of chat.messages) {
                const widgets = [];
                for (const widget of message.widgets ?? []) {
                  try {
                    const stat = await owned.stat(
                      `${chatWidgetsDirectory(message.sideNote?.chatId ?? id)}/${widget.id}/manifest.json`,
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
            },
            owner.assertCurrent,
            request.signal,
            owner.profileId,
          );
        }
        return { chat, usage, entry };
      };
      const fileResponse = (
        chatId: string,
        filename: string,
        generated: boolean,
        owner = authority,
        check = revalidate,
      ) =>
        files(
          async (owned) => {
            const directory = generated
              ? chatGeneratedArtifactsDirectory(chatId)
              : chatArtifactsDirectory(chatId);
            const bytes = await owned.read(`${directory}/${filename}`);
            await check();
            return new Response(new Uint8Array(bytes), {
              headers: {
                ...commonHeaders,
                "content-disposition": `attachment; filename="${filename}"`,
                "content-type": "application/octet-stream",
              },
            });
          },
          owner.assertCurrent,
          request.signal,
          owner.profileId,
        );
      const widgetResponse = (
        chatId: string,
        widgetId: string,
        owner = authority,
        check = revalidate,
      ) =>
        files(
          async (owned) => {
            const storage = { files: owned, directory: chatWidgetsDirectory(chatId) };
            const { html } = await readCanvasDocumentHtmlSource(widgetId, { storage });
            const manifest: unknown = JSON.parse(
              await owned.readText(`${storage.directory}/${widgetId}/manifest.json`),
            );
            await check();
            const title =
              isRecord(manifest) && typeof manifest.title === "string" ? manifest.title : "Widget";
            return json({ id: widgetId, title, html, version: widgetId });
          },
          owner.assertCurrent,
          request.signal,
          owner.profileId,
        );
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
      const memoryV2 = hasClientCapability(request.headers, "memory-v2");
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
            ...(sharingCapability ? { sharing: identity.kind !== "development" } : {}),
            ...(supportsSideChats(request) ? { sideChats: true } : {}),
            ...(memoryV2 || hasClientCapability(request.headers, "memory-v1")
              ? {
                  memory: {
                    review: options.memoryReview !== undefined,
                    ...(memoryV2
                      ? {
                          delete:
                            options.memoryReview !== undefined &&
                            options.memberMemory !== undefined,
                        }
                      : {}),
                  },
                }
              : {}),
          },
        });
      }
      const memoryReference = pathname.match(/^\/memory\/([A-Za-z0-9_-]{43})$/u);
      if (
        (method === "GET" && (pathname === "/memory" || memoryReference)) ||
        (method === "DELETE" && memoryReference && memoryV2)
      ) {
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
        if (method === "DELETE" && memoryReference) {
          if (!options.memberMemory) {
            throw new ProtectedError(503, "unavailable", "Member memory is not available.");
          }
          const expected = request.headers.get("if-match");
          if (!expected) {
            throw new ProtectedError(
              428,
              "precondition_required",
              "Reload the memory before deleting it.",
            );
          }
          if (!/^[A-Za-z0-9_-]{43}$/u.test(expected)) {
            invalid();
          }
          const result = await options.memberMemory.mutate(profile.id, assertMemoryCurrent, () =>
            files(async (owned) => {
              const review = memoryReview.open(profile.id, owned);
              return await review.remove(
                memoryReference[1]!,
                expected,
                async (filePath, content) => {
                  await revalidate();
                  assertMemoryCurrent();
                  const storage = await admitStorage?.(
                    profile.id,
                    assertMemoryCurrent,
                    "delete",
                    await storageLimit(assertMemoryCurrent),
                  );
                  try {
                    if (storage) {
                      return await storage
                        .files(owned)
                        .removeFileIfBytesMatch(filePath, content, revalidate);
                    }
                    await revalidate();
                    if (!(await owned.read(filePath)).equals(content)) {
                      return false;
                    }
                    await owned.removeFile(filePath);
                    return true;
                  } finally {
                    storage?.release();
                  }
                },
              );
            }, assertMemoryCurrent),
          );
          if (result === "missing") {
            notFound();
          }
          if (result === "changed") {
            throw new ProtectedError(
              409,
              "memory_changed",
              "Memory changed. Reload it before deleting.",
            );
          }
          return noContent();
        }
        const result = await files(async (owned) => {
          const review = memoryReview.open(profile.id, owned);
          if (!memoryReference) {
            return await review.list();
          }
          const note = await review.read(memoryReference[1]!, memoryV2);
          return note ?? notFound();
        }, assertMemoryCurrent);
        await revalidate();
        assertMemoryCurrent();
        return profileJson(result);
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
      const sharing = <Key extends keyof ProtectedSharingWorkerOperations>(
        type: Key,
        input: ProtectedSharingWorkerOperations[Key]["input"],
      ) => runProtectedSharing(options.stateDir, type, input, assertCurrent);
      const retireSharing = (removed: readonly StoredDataEntry[]) =>
        admitStorage?.retiredStoredData(removed.map((entry) => ({ removed: entry })));
      const requireSharing = () => {
        if (!sharingCapability) {
          notFound();
        }
        requireProfile();
        if (identity.kind === "development") {
          throw sharingUnavailable();
        }
      };
      // Like feedback: an unknown write outcome keeps its reservation unless the entry is absent.
      const storeSharingEntry = async <T extends { created: boolean; entries: StoredDataEntry[] }>(
        entryId: string,
        write: () => Promise<T | undefined>,
      ) => {
        const storage = await admitStorage?.(
          profile.id,
          assertCurrent,
          "stored-data",
          await storageLimit(assertCurrent),
        );
        const reservation = storage?.reserveStoredData(storageEntryOverheadBytes);
        let settled = false;
        try {
          const result = await write();
          reservation?.settle(result ?? { created: false, entries: [] });
          settled = true;
          return result;
        } catch (error) {
          if (reservation && !settled) {
            try {
              const stored = await sharing(
                "protectedSharing.storageUsage",
                storageEntryOverheadBytes,
              );
              const entry = stored.find(
                (candidate) => candidate.profileId === profile.id && candidate.id === entryId,
              );
              if (entry) {
                reservation.settle({ created: true, entries: [entry] });
              } else {
                reservation.release();
              }
            } catch {
              process.stderr.write(
                "Protected sharing write outcome is unknown; its storage reservation remains held.\n",
              );
            }
          }
          throw error;
        } finally {
          storage?.release();
        }
      };
      const sharingUnavailable = () =>
        new ProtectedError(
          403,
          "sharing_unavailable",
          "Sharing is not available for this account.",
        );
      const publicAutomationsUnavailable = () =>
        new ProtectedError(
          503,
          "public_automations_unavailable",
          "Public automations are temporarily unavailable.",
        );
      // automations-public-v1 additions; requests without it keep the earlier automation contract.
      const requirePublicAutomations = () => {
        if (!automationsPublicCapability || !automationCatalog?.capabilities.automations.list) {
          notFound();
        }
        requireProfile();
        throw publicAutomationsUnavailable();
      };
      const withPublication = async (
        automations: StoredAutomationRecord[],
      ): Promise<ProtectedAutomationRecord[]> => {
        if (!automationsPublicCapability) {
          return automations.map((automation) => presentAutomation(automation, request));
        }
        const published = new Map(
          (await sharing("protectedSharing.automationPublications", { profileId: profile.id })).map(
            ({ automationId, ...publication }) => [automationId, publication],
          ),
        );
        return automations.map((automation) => ({
          ...presentAutomation(automation, request),
          publication: published.get(automation.id) ?? null,
        }));
      };
      const readPublicAutomation = async (automationId: string) => {
        const [automation] = await sharing("protectedSharing.publicAutomations", {
          profileId: profile.id,
          automationId,
        });
        await revalidate();
        if (!automation) {
          return notFound();
        }
        const result: ProtectedPublicAutomationResponse = {
          automation: projectProtectedPublicAutomation(automation),
        };
        return json(result);
      };
      if (pathname === "/automations/catalog" && method === "GET") {
        if (!automationCatalog) {
          return notFound();
        }
        await revalidate();
        const baseCatalog: ProtectedAutomationCatalog | ProtectedAutomationCatalogV1 =
          hasClientCapability(request.headers, "agents-v1")
            ? { ...automationCatalog, agents: agentCatalog.listV1() }
            : automationCatalog;
        const deletionCatalog =
          hasClientCapability(request.headers, "automation-delete-v1") &&
          automationSchedulerStarted &&
          !automationStorageRecovery.status().admissionClosed
            ? {
                ...baseCatalog,
                capabilities: {
                  ...baseCatalog.capabilities,
                  automations: { ...baseCatalog.capabilities.automations, delete: true },
                },
              }
            : baseCatalog;
        const catalog =
          automationSchedulerStarted &&
          !automationStorageRecovery.status().admissionClosed &&
          hasClientCapability(request.headers, automationRunsCapability)
            ? {
                ...deletionCatalog,
                capabilities: {
                  ...deletionCatalog.capabilities,
                  automations: {
                    ...deletionCatalog.capabilities.automations,
                    scheduleControl: true,
                    run: true,
                  },
                },
              }
            : deletionCatalog;
        const listing = catalog.capabilities.automations.list;
        const chatAvailable = supportsAutomationsChat(request) && listing;
        const publicAvailable = false;
        return profileJson(
          chatAvailable ||
            automationsPublicCapability ||
            hasClientCapability(request.headers, automationContextCapability)
            ? {
                ...catalog,
                capabilities: {
                  ...catalog.capabilities,
                  automations: {
                    ...catalog.capabilities.automations,
                    ...(hasClientCapability(request.headers, automationContextCapability)
                      ? { contextAccess: false }
                      : {}),
                    ...(chatAvailable
                      ? {
                          chat: {
                            list: true,
                            read: true,
                            proposeCreate: true,
                            proposePatch: true,
                            ...(supportsAutomationsAuthoring(request) &&
                            catalog.capabilities.automations.create &&
                            admitStorage &&
                            agentCatalog.get(authoringAgentId)
                              ? {
                                  authoring: true,
                                  ...(supportsDraftRecovery(request)
                                    ? { draftRecovery: true }
                                    : {}),
                                }
                              : {}),
                          },
                        }
                      : {}),
                    ...(automationsPublicCapability
                      ? {
                          public: {
                            publish: publicAvailable,
                            follow: publicAvailable,
                            notifications: publicAvailable,
                          },
                        }
                      : {}),
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
        const automations = await withPublication(
          await listProtectedAutomationRecords(options.stateDir, authority),
        );
        assertCurrent();
        const result: ProtectedAutomationListResponse = { automations };
        return json(result);
      }
      if (hasClientCapability(request.headers, automationRunsCapability) && method === "GET") {
        if (pathname === "/automations/inbox") {
          const entries = await listProtectedAutomationOwnerInbox(options.stateDir, {
            ...authority,
            revalidate,
          });
          return json({
            entries: entries.map((entry) => Object.assign(entry, { push: "not-started" })),
          });
        }
        const history = /^\/automations\/([^/]+)\/run-history$/u.exec(pathname);
        if (history) {
          const entries = await listProtectedAutomationLifecycleRuns(
            options.stateDir,
            history[1]!,
            { ...authority, revalidate },
          );
          if (!entries) {
            return notFound();
          }
          return json({ runs: entries });
        }
      }
      if (hasClientCapability(request.headers, automationResultsCapability)) {
        const result = await handleProtectedAutomationResultsRoute(
          options.stateDir,
          { method, pathname },
          { ...authority, revalidate },
        );
        if (result) {
          return json(result.body, result.status);
        }
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
        if (validation.draft.contextAccess === "isolated") {
          throw new ProtectedError(
            503,
            "automation_isolation_unavailable",
            "Isolated automation execution is unavailable until its memory boundary is ready.",
          );
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
          if (authoringChatId !== undefined) {
            const latest = await chats.readEntry(authority, authoringChatId);
            const stored = readAuthoringDraft(latest);
            if (
              latest.protectedAutomationId ||
              ((stored || supportsDraftRecovery(request)) &&
                !isDeepStrictEqual(stored?.draft, draft))
            ) {
              throw draftMismatch();
            }
          }
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
            automationCreationSafety(authority),
          );
          if (!automation) {
            unauthorized();
          }
          if (authoringChatId !== undefined) {
            const chat = await bindSavedAutomation(authority, authoringChatId, automation);
            if (!chat.authoring?.automationId || !savesDraft(automation, validation.draft)) {
              throw new ProtectedError(
                412,
                "version_mismatch",
                "This chat already saved a different version. Reload it before saving.",
              );
            }
          }
          const [created] = await withPublication([automation]);
          assertCurrent();
          const result: ProtectedAutomationResponse = { automation: created! };
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
        let snapshot: ProtectedAuthoringDraft | undefined;
        if (automationId === undefined && supportsDraftRecovery(request)) {
          requireProfile("Reload your account before creating an automation draft.");
          const input = await body(request);
          if (!isProtectedAuthoringCreate(input)) {
            return invalid();
          }
          assertDraftPacingAvailable(automationCatalog, input.draft);
          snapshot = { draft: input.draft, draftRevision: "1" };
        }
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
              bound = await bindSavedAutomation(authority, unbound.id, automation);
              if (!bound.authoring?.automationId) {
                throw new ProtectedError(
                  412,
                  "version_mismatch",
                  "The saved automation differs from your unsaved draft. Reopen the draft in Chats.",
                );
              }
            }
            if (bound) {
              const { chat } = await readChat(bound.id);
              await revalidate();
              const result: ProtectedAutomationAuthoringResponse = {
                chat,
                automation: presentAutomation(automation, request),
              };
              return json(result);
            }
          }
          storage = await admitStorage(
            profile.id,
            assertCurrent,
            "create",
            await storageLimit(assertCurrent),
          );
          if (snapshot) {
            storage.charge(Buffer.byteLength(JSON.stringify(snapshot)));
          }
          const chat = await chats.create(
            authority,
            automation ? text(automation.name, 160) : (snapshot?.draft.name ?? "New automation"),
            authoringAgentId,
            {
              kind: "automation",
              ...(automationId === undefined ? {} : { automationId }),
              snapshot,
            },
          );
          storage.recordCreatedChat(chat.id, chats.scope(authority, chat.id).sessionKey);
          await revalidate();
          const result: ProtectedAutomationAuthoringResponse = {
            chat,
            ...(automation
              ? {
                  automation: presentAutomation(automation, request),
                }
              : {}),
          };
          return json(result, 201);
        } finally {
          storage?.release();
          creating.delete(profile.id);
        }
      }
      const runNow = /^\/automations\/([^/]+)\/run$/u.exec(pathname);
      if (runNow && method === "POST") {
        if (!hasClientCapability(request.headers, automationRunsCapability)) {
          return notFound();
        }
        if (!automationSchedulerStarted || automationStorageRecovery.status().admissionClosed) {
          throw new ProtectedError(
            503,
            "scheduler_unavailable",
            "Automation scheduling is unavailable. Check protected storage recovery.",
          );
        }
        await revalidate();
        const automation = await readOwnedProtectedAutomationStorageRecord(
          options.stateDir,
          runNow[1]!,
          authority,
        );
        if (!automation) {
          return notFound();
        }
        const member = await findAutomationMember(profile.id);
        if (!member) {
          throw new ProtectedError(403, "member_inactive", "This member no longer has access.");
        }
        const now = Date.now();
        const queued = await queueProtectedAutomationRun(
          member,
          {
            id: automation.id,
            version: String(automation.definitionRevision),
            schedule: automation.definition.schedule,
            updatedAt: automation.updatedAt,
          },
          "manual",
          now,
        );
        return json({ runId: queued.runId, status: "queued" }, 202);
      }
      if (pathname === "/automations/public" && method === "GET" && automationsPublicCapability) {
        requirePublicAutomations();
        const automations = await sharing("protectedSharing.publicAutomations", {
          profileId: profile.id,
        });
        await revalidate();
        const result: ProtectedPublicAutomationsResponse = {
          automations: automations.map(projectProtectedPublicAutomation),
        };
        return json(result);
      }
      const publicAutomation = automationsPublicCapability
        ? /^\/automations\/([^/]+)\/(publication|follow|notifications)$/u.exec(pathname)
        : null;
      if (publicAutomation && (method === "PUT" || method === "DELETE")) {
        const automationId = publicAutomation[1]!;
        const target = publicAutomation[2];
        requirePublicAutomations();
        const ref = { profileId: profile.id, automationId };
        const storageOverheadBytes = storageEntryOverheadBytes;
        if (target === "publication") {
          if (method === "PUT") {
            const now = Date.now();
            const published = await storeSharingEntry(
              `automation-publication:${automationId}:${now}`,
              () =>
                sharing("protectedSharing.publishAutomation", {
                  ...ref,
                  now,
                  storageOverheadBytes,
                }),
            );
            if (!published) {
              return notFound();
            }
          } else {
            const removed = await sharing("protectedSharing.unpublishAutomation", {
              ...ref,
              storageOverheadBytes,
            });
            if (!removed) {
              return notFound();
            }
            retireSharing(removed);
          }
          const automation = await readProtectedAutomationRecord(options.stateDir, ref, authority);
          if (!automation) {
            return notFound();
          }
          const [record] = await withPublication([automation]);
          await revalidate();
          const result: ProtectedAutomationResponse = { automation: record! };
          return json(result);
        }
        if (target === "follow" && method === "DELETE") {
          retireSharing(
            await sharing("protectedSharing.unfollowAutomation", { ...ref, storageOverheadBytes }),
          );
          await revalidate();
          return noContent();
        }
        if (target === "follow") {
          const input = await body(request, true);
          if (!isProtectedAutomationFollowRequest(input)) {
            return invalid();
          }
          const now = Date.now();
          const followed = await storeSharingEntry(
            `automation-follow:${automationId}:${profile.id}:${now}`,
            () =>
              sharing("protectedSharing.followAutomation", {
                ...ref,
                ...input,
                now,
                storageOverheadBytes,
              }),
          );
          if (!followed) {
            return notFound();
          }
          return await readPublicAutomation(automationId);
        }
        if (target === "notifications" && method === "PUT") {
          const input = await body(request);
          if (!isProtectedAutomationNotificationsRequest(input)) {
            return invalid();
          }
          const changed = await sharing("protectedSharing.automationSubscription", {
            ...ref,
            subscribed: input.subscribed,
            now: Date.now(),
          });
          if (!changed) {
            return notFound();
          }
          return await readPublicAutomation(automationId);
        }
      }
      const automationMatch = /^\/automations\/([^/]+)$/u.exec(pathname);
      if (automationMatch && method === "DELETE") {
        if (!automationCatalog?.capabilities.automations.create || !admitStorage) {
          return notFound();
        }
        const version = request.headers.get("if-match");
        if (!version) {
          throw new ProtectedError(
            428,
            "version_required",
            "Reload the automation before deleting it.",
          );
        }
        await revalidate();
        const current = await readProtectedAutomationRecord(
          options.stateDir,
          { profileId: profile.id, automationId: automationMatch[1]! },
          authority,
        );
        if (!current) {
          return notFound();
        }
        if (version !== current.version) {
          throw new ProtectedError(
            412,
            "version_mismatch",
            "This automation changed. Reload it before deleting it.",
          );
        }
        if (!automationSchedulerStarted || automationStorageRecovery.status().admissionClosed) {
          throw new ProtectedError(
            503,
            "scheduler_unavailable",
            "Automation storage is unavailable. Try again later.",
          );
        }
        const member = await findAutomationMember(profile.id);
        if (!member) {
          return unauthorized();
        }
        const assertDeletionCurrent = () => {
          assertCurrent();
          if (activeAutomations.has(current.id)) {
            throw new ProtectedError(
              409,
              "automation_busy",
              "This automation is busy. Try again after its run finishes.",
            );
          }
        };
        const lifecycle = createAutomationPublicationAuthority({
          ...automationAuthority(member),
          assertCurrent: assertDeletionCurrent,
          revalidate,
          storageLimit,
        }).lifecycle;
        let result;
        try {
          result = await writeProtectedAutomationLifecycle(
            options.stateDir,
            {
              kind: "remove",
              profileId: profile.id,
              automationId: current.id,
              expectedRevision: Number(version),
            },
            lifecycle,
          );
        } finally {
          reconcileUncertainAutomationStorage();
        }
        if (result.status === "not-owner") {
          return notFound();
        }
        if (result.status === "version-mismatch") {
          throw new ProtectedError(
            412,
            "version_mismatch",
            "This automation changed. Reload it before deleting it.",
          );
        }
        if (result.status === "busy") {
          throw new ProtectedError(
            409,
            "automation_busy",
            "This automation is busy. Try again after its run finishes.",
          );
        }
        if (result.status !== "committed") {
          throw new ProtectedError(409, "automation_busy", "This automation cannot be deleted.");
        }
        return noContent();
      }
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
        const [record] = await withPublication([automation]);
        assertCurrent();
        const result: ProtectedAutomationResponse = { automation: record! };
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
            schedulerAvailable:
              automationSchedulerStarted &&
              !automationStorageRecovery.status().admissionClosed &&
              hasClientCapability(request.headers, automationRunsCapability),
            provision: async () => {
              const member = await findAutomationMember(profile.id);
              if (!member) {
                throw new ProtectedError(
                  403,
                  "member_inactive",
                  "This member no longer has access.",
                );
              }
              const lifecycle = createAutomationPublicationAuthority(
                automationAuthority(member),
              ).lifecycle;
              const provisioned = await writeProtectedAutomationLifecycle(
                options.stateDir,
                { kind: "provision", profileId: profile.id, automationId: automationMatch[1]! },
                lifecycle,
              );
              if (provisioned.status !== "committed" && provisioned.status !== "unchanged") {
                throw new ProtectedError(
                  409,
                  "automation_unavailable",
                  "This automation cannot be enabled.",
                );
              }
            },
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
            if (automationSchedulerStarted) {
              const member = await findAutomationMember(profile.id);
              if (!member) {
                automationScheduler.remove(saved.automation.id);
                throw new ProtectedError(
                  403,
                  "member_inactive",
                  "This member no longer has access.",
                );
              }
              await refreshProtectedAutomation(member, saved.automation.id);
            }
            const [automation] = await withPublication([saved.automation]);
            assertCurrent();
            const result: ProtectedAutomationResponse = { automation: automation! };
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
          case "automation_busy":
            throw new ProtectedError(
              409,
              "automation_busy",
              "This automation is running. Try again after its run finishes.",
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
        const result = await visibleChats();
        await revalidate();
        for (const chat of result) {
          // Clients that did not negotiate authoring parse chats against strict V1 schemas.
          if (!supportsAutomationsAuthoring(request)) {
            delete chat.authoring;
          }
          if (!hasClientCapability(request.headers, automationRunsCapability)) {
            delete chat.automationRun;
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
        for (const chat of await visibleChats()) {
          await revalidate();
          result.push((await readChat(chat.id)).chat);
        }
        await revalidate();
        return json({ chats: result });
      }
      const artifactPage = (artifactChats: ProtectedChatSummary[]) =>
        files(async (owned) => {
          const result = await listProtectedArtifacts({
            files: owned,
            chats: artifactChats,
            cursor: new URL(request.url).searchParams.get("cursor"),
            maxFileBytes: options.maxFileBytes,
          });
          await revalidate();
          return json(result);
        });
      if (pathname === "/artifacts" && method === "GET") {
        requireProfile();
        return await artifactPage(await visibleChats());
      }
      if (pathname === "/files" && method === "GET") {
        try {
          return await files(async (owned) => {
            const result = [];
            for (const chat of await visibleChats()) {
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
        return await fileResponse(chatId, filename, Boolean(generatedFileId));
      }
      // Reads use the owner's chat store; the sharing owner decides access before and after.
      const ownerAuthority = (ownerProfileId: string) => ({
        profileId: ownerProfileId,
        assertCurrent,
      });
      const ownerChatSummary = async (ownerProfileId: string, chatId: string) =>
        (await chats.list(ownerAuthority(ownerProfileId))).find((chat) => chat.id === chatId);
      const removeOrphanShare = async (ownerProfileId: string, chatId: string) =>
        retireSharing(
          await sharing("protectedSharing.delete", {
            ownerProfileId,
            chatId,
            storageOverheadBytes: storageEntryOverheadBytes,
          }),
        );
      const shareClaim = /^\/shares\/([A-Za-z0-9_-]{43})\/claim$/u.exec(pathname);
      if (shareClaim?.[1] && method === "POST") {
        requireSharing();
        await revalidate();
        const shareId = shareClaim[1];
        const target = await sharing("protectedSharing.resolve", {
          profileId: profile.id,
          shareId,
        });
        if (!target) {
          throw new ProtectedError(404, "share_not_found", "This link is no longer available.");
        }
        const chat = await ownerChatSummary(target.ownerProfileId, target.chatId);
        if (!chat) {
          await removeOrphanShare(target.ownerProfileId, target.chatId);
          throw new ProtectedError(404, "share_not_found", "This link is no longer available.");
        }
        const now = Date.now();
        const claimed = target.granted
          ? target
          : await storeSharingEntry(
              `chat-share-grant:${target.ownerProfileId}:${target.chatId}:${profile.id}:${now}`,
              () =>
                sharing("protectedSharing.claim", {
                  profileId: profile.id,
                  shareId,
                  now,
                  storageOverheadBytes: storageEntryOverheadBytes,
                }),
            );
        await revalidate();
        if (!claimed) {
          throw new ProtectedError(404, "share_not_found", "This link is no longer available.");
        }
        const response: ProtectedShareClaimResponse = {
          access: claimed.access,
          chat: {
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt,
            owner: { personId: claimed.ownerProfileId, displayName: claimed.ownerDisplayName },
          },
        };
        return json(response);
      }
      if (pathname === "/shared/chats" && method === "GET") {
        requireSharing();
        const grants = await sharing("protectedSharing.sharedChats", { profileId: profile.id });
        const owned = new Map<string, ProtectedChatSummary[]>();
        const shared: ProtectedSharedChatSummary[] = [];
        for (const grant of grants) {
          let ownerChats = owned.get(grant.ownerProfileId);
          if (!ownerChats) {
            ownerChats = await chats.list(ownerAuthority(grant.ownerProfileId));
            owned.set(grant.ownerProfileId, ownerChats);
          }
          const chat = ownerChats.find((candidate) => candidate.id === grant.chatId);
          if (!chat) {
            await removeOrphanShare(grant.ownerProfileId, grant.chatId);
            continue;
          }
          shared.push({
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt,
            owner: { personId: grant.ownerProfileId, displayName: grant.ownerDisplayName },
          });
        }
        await revalidate();
        const response: ProtectedSharedChatsResponse = {
          chats: shared.toSorted((left, right) => right.updatedAt - left.updatedAt),
        };
        return json(response);
      }
      const sharedChat = /^\/shared\/chats\/([^/]+)\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
      if (sharedChat?.[1] && sharedChat[2] && method === "GET") {
        requireSharing();
        const [, ownerProfileId, chatId, sharedRest] = sharedChat;
        const target = { ownerProfileId, chatId };
        const access = await authorizeProtectedChatRead(
          { stateDir: options.stateDir, chats },
          authority,
          target,
        );
        await revalidate();
        if (!access) {
          notFound();
        }
        const owner = ownerAuthority(ownerProfileId);
        const check = async () => {
          if (
            !(await sharing("protectedSharing.chatAccess", { profileId: profile.id, ...target }))
          ) {
            notFound();
          }
          await revalidate();
        };
        if (!sharedRest) {
          const { chat } = await readChat(chatId, owner);
          delete chat.activeRun;
          delete chat.authoring;
          delete chat.side;
          await check();
          const response: ProtectedSharedChatResponse = {
            chat,
            owner: { personId: ownerProfileId, displayName: access.ownerDisplayName },
          };
          return json(response);
        }
        if (sharedRest === "artifacts") {
          const chat = await ownerChatSummary(ownerProfileId, chatId);
          if (!chat) {
            notFound();
          }
          return await files(
            async (owned) => {
              const result = await listProtectedArtifacts({
                files: owned,
                chats: [chat],
                cursor: new URL(request.url).searchParams.get("cursor"),
                maxFileBytes: options.maxFileBytes,
              });
              await check();
              return json(result);
            },
            assertCurrent,
            request.signal,
            ownerProfileId,
          );
        }
        const sharedFile = /^files\/(?:(generated)~)?([^/~]+)~([^/~]+)$/u.exec(sharedRest);
        if (
          sharedFile?.[2] === chatId &&
          sharedFile[3] &&
          (sharedFile[1] ? validGeneratedFilename(sharedFile[3]) : validFilename(sharedFile[3]))
        ) {
          return await fileResponse(chatId, sharedFile[3], Boolean(sharedFile[1]), owner, check);
        }
        const sharedWidget = /^widgets\/(.+)$/u.exec(sharedRest)?.[1];
        if (sharedWidget && widgetIdPattern.test(sharedWidget)) {
          return await widgetResponse(chatId, sharedWidget, owner, check);
        }
        notFound();
      }
      const match = /^\/chats\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
      if (!match?.[1]) {
        return notFound();
      }
      const [, id, rest] = match;
      const feedbackReport = /^responses\/([^/]+)\/reports$/u.exec(rest ?? "");
      let chatEntry: Awaited<ReturnType<typeof chats.readEntry>>;
      try {
        chatEntry = await chats.readEntry(authority, id);
        timing.at("chatEntryRead");
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
      timing.at("routeGrantChecked");
      if (rest === "authoring-draft" && method === "PUT") {
        if (
          !supportsDraftRecovery(request) ||
          !admitStorage ||
          chatEntry.protectedAuthoringKind !== "automation" ||
          chatEntry.protectedAutomationId
        ) {
          return notFound();
        }
        requireProfile("Reload your account before editing this draft.");
        const input = await body(request);
        if (!isProtectedAuthoringCheckpoint(input)) {
          return invalid();
        }
        assertDraftPacingAvailable(automationCatalog, input.draft);
        assertDraftPacingAvailable(automationCatalog, readAuthoringDraft(chatEntry)?.draft);
        if (runs.has(id) || mutations.has(id)) {
          throw new ProtectedError(
            409,
            "busy",
            "Wait for the chat to finish before editing the draft.",
          );
        }
        mutations.add(id);
        let storage;
        try {
          await revalidate();
          storage = await admitStorage(
            profile.id,
            assertCurrent,
            "stored-data",
            await storageLimit(assertCurrent),
          );
          const result = await chats.checkpointDraft(
            authority,
            id,
            input.baseDraftRevision,
            input.draft,
            storage.charge,
          );
          await revalidate();
          return json(result);
        } finally {
          storage?.release();
          mutations.delete(id);
        }
      }
      if (
        (rest === "turns" && method === "POST") ||
        (/^runs\/[^/]+\/(?:steer|stop)$/u.test(rest ?? "") && method === "POST") ||
        (/^runs\/[^/]+\/steer\/[^/]+$/u.test(rest ?? "") && method === "DELETE")
      ) {
        assertRunChatWritable(chatEntry);
      }
      if (!rest && method === "GET") {
        // If a run finishes during the read, keep the client polling for its final transcript.
        const wasBusy = runs.has(id) || mutations.has(id);
        const { chat, usage, entry } = await readChat(id);
        await revalidate();
        if (usage && !hasClientCapability(request.headers, "model-context-v1")) {
          delete usage.contextSize;
        }
        const active = runs.get(id);
        const recoveredDraft =
          supportsDraftRecovery(request) && chat.authoring && !chat.authoring.automationId
            ? readAuthoringDraft(entry)
            : undefined;
        if (
          recoveredDraft?.draft.pacing &&
          !hasClientCapability(request.headers, automationPacingCapability)
        ) {
          throw new ProtectedError(
            409,
            "pacing_unavailable",
            "Update Alcove to recover this model-chosen schedule.",
          );
        }
        return profileJson({
          chat,
          ...(usage ? { usage } : {}),
          ...(supportsDraftRecovery(request) && chat.authoring && !chat.authoring.automationId
            ? {
                authoringDraft: recoveredDraft,
                authoringBusy: wasBusy || active !== undefined || mutations.has(id),
              }
            : {}),
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
      if (rest === "share" || rest?.startsWith("share/")) {
        requireSharing();
        const ref = { ownerProfileId: profile.id, chatId: id };
        const storageOverheadBytes = storageEntryOverheadBytes;
        if (rest === "share" && method === "GET") {
          const share = await sharing("protectedSharing.read", ref);
          await revalidate();
          const response: ProtectedChatShareResponse = {
            share: share ? projectProtectedChatShare(share) : null,
          };
          return json(response);
        }
        if (rest === "share" && method === "POST") {
          if (runs.has(id) || mutations.has(id)) {
            throw new ProtectedError(409, "busy", "Try sharing again in a moment.");
          }
          mutations.add(id);
          try {
            const now = Date.now();
            const existing = await sharing("protectedSharing.read", ref);
            const created = existing
              ? { share: existing }
              : await storeSharingEntry(`chat-share:${id}:${now}`, () =>
                  sharing("protectedSharing.create", { ...ref, now, storageOverheadBytes }),
                );
            await revalidate();
            if (!created) {
              throw new ProtectedError(
                403,
                "sharing_unavailable",
                "Sharing is not available for this account.",
              );
            }
            const response: ProtectedChatShareResponse = {
              share: projectProtectedChatShare(created.share),
            };
            return json(response);
          } finally {
            mutations.delete(id);
          }
        }
        if (rest === "share" && method === "DELETE") {
          retireSharing(await sharing("protectedSharing.delete", { ...ref, storageOverheadBytes }));
          await revalidate();
          return noContent();
        }
        const recipient = /^share\/recipients\/([^/]+)$/u.exec(rest)?.[1];
        if (recipient && method === "DELETE") {
          const result = await sharing("protectedSharing.removeRecipient", {
            ...ref,
            recipientProfileId: recipient,
            storageOverheadBytes,
          });
          if (!result) {
            throw new ProtectedError(404, "share_not_found", "This chat has no link.");
          }
          retireSharing(result.removed);
          await revalidate();
          const response: ProtectedChatShareResponse = {
            share: projectProtectedChatShare(result.share),
          };
          return json(response);
        }
        notFound();
      }
      if (!rest && method === "DELETE") {
        const version = request.headers.get("if-match");
        if (!version) {
          throw new ProtectedError(428, "version_required", "Reload the chat before deleting.");
        }
        if (runs.has(id) || mutations.has(id)) {
          throw new ProtectedError(409, "busy", "Stop the current work before deleting.");
        }
        // Locking the parent first stops a concurrent side chat creation from missing the cascade.
        const locked = [id];
        mutations.add(id);
        const deleteChat = async (chatId: string, chatVersion: string, sideChatIds?: string[]) => {
          await chats.delete(
            authority,
            chatId,
            chatVersion,
            async () => {
              await files((owned) => removeChatFilesDirectory(owned, chatId));
              await revalidate();
            },
            sideChatIds,
          );
          await removeProtectedChatFeedback(options.stateDir, profile.id, chatId);
          retireSharing(
            await sharing("protectedSharing.delete", {
              ownerProfileId: profile.id,
              chatId,
              storageOverheadBytes: storageEntryOverheadBytes,
            }),
          );
          await revalidate();
          admitStorage?.deletedChat(profile.id, chatId);
          await revalidate();
        };
        try {
          const sideChats = await chats.sideChatsOf(authority, id);
          for (const sideChat of sideChats) {
            if (runs.has(sideChat.id) || mutations.has(sideChat.id)) {
              throw new ProtectedError(409, "busy", "Stop the current work before deleting.");
            }
            mutations.add(sideChat.id);
            locked.push(sideChat.id);
          }
          await deleteChat(
            id,
            version,
            sideChats.map((side) => side.id),
          );
          // Side chats go with their parent. The parent's version check comes first, so a stale
          // delete removes nothing. A side chat that is already gone or changed stays deletable alone.
          const deletedSideChats: string[] = [];
          for (const sideChat of sideChats) {
            try {
              await deleteChat(sideChat.id, sideChat.version);
              deletedSideChats.push(sideChat.id);
            } catch (error) {
              if (!(error instanceof ProtectedError && [404, 409].includes(error.status))) {
                throw error;
              }
            }
          }
          if (!supportsSideChats(request)) {
            return noContent();
          }
          const response: ProtectedDeleteChatResponse = { deletedSideChats };
          return json(response);
        } finally {
          for (const chatId of locked) {
            mutations.delete(chatId);
          }
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
        return widgetResponse(id, widgetId);
      }
      if (rest === "artifacts" && method === "GET") {
        requireProfile();
        // The same visibility as the chat list, so a side chat stays hidden without negotiation.
        const chat = (await visibleChats()).find((item) => item.id === id);
        if (!chat) {
          return notFound();
        }
        return await artifactPage([chat]);
      }
      if (rest === "side" && method === "POST") {
        // Only the owner's own chats reach this route; recipients have no side route.
        if (!supportsSideChats(request)) {
          return notFound();
        }
        requireProfile();
        const data = await body(request);
        if (!isProtectedCreateSideChat(data)) {
          return invalid();
        }
        const parentId = chatEntry.protectedSideParentId ?? id;
        if (creating.has(profile.id)) {
          throw new ProtectedError(409, "busy", "Another chat is being created.");
        }
        if (mutations.has(parentId)) {
          throw new ProtectedError(409, "busy", "Try the side chat again in a moment.");
        }
        creating.add(profile.id);
        mutations.add(parentId);
        let storage;
        try {
          await revalidate();
          storage = await admitStorage?.(
            profile.id,
            assertCurrent,
            "create",
            await storageLimit(assertCurrent),
          );
          const { chat, created } = await chats.createSide(authority, id, {
            requestId: data.requestId,
            ...(data.title === undefined ? {} : { title: text(data.title, 160) }),
            ...(data.selectedAgentId === undefined
              ? {}
              : { selectedAgentId: data.selectedAgentId }),
          });
          if (created) {
            storage?.recordCreatedChat(chat.id, chats.scope(authority, chat.id).sessionKey);
          }
          await revalidate();
          const response: ProtectedCreateSideChatResponse = { chat };
          return json(response, 201);
        } finally {
          storage?.release();
          mutations.delete(parentId);
          creating.delete(profile.id);
        }
      }
      if (rest === "side/return" && method === "POST") {
        if (!supportsSideChats(request)) {
          return notFound();
        }
        requireProfile();
        const data = await body(request);
        if (!isProtectedReturnSideChat(data)) {
          return invalid();
        }
        const parentId = chatEntry.protectedSideParentId;
        if (!parentId) {
          throw new ProtectedError(422, "side_unavailable", "This chat is not a side chat.");
        }
        // Nothing is appended to a chat that is replying or changing.
        if (runs.has(parentId) || mutations.has(parentId) || mutations.has(id)) {
          throw new ProtectedError(409, "busy", "The main chat is busy. Try again in a moment.");
        }
        mutations.add(parentId);
        mutations.add(id);
        try {
          await revalidate();
          const sent = await chats.returnSide(
            authority,
            id,
            {
              requestId: data.requestId,
              messageIds: data.messageIds,
              ...(data.note === undefined ? {} : { note: data.note }),
            },
            // Like a turn's transcript writes: admitted against the quotas and charged by size.
            async (append) => {
              const storage = await admitStorage?.(
                profile.id,
                assertCurrent,
                "turn",
                await storageLimit(assertCurrent),
              );
              try {
                return await (storage
                  ? withTranscriptWriteBudget(storage.charge, append)
                  : append());
              } finally {
                storage?.release();
              }
            },
          );
          await revalidate();
          const response: ProtectedReturnSideChatResponse = sent;
          return json(response);
        } finally {
          mutations.delete(parentId);
          mutations.delete(id);
        }
      }
      if (rest === "turns" && method === "POST") {
        requireProfile();
        const turn = await startProtectedTurn({
          request,
          id,
          profile,
          sessionHash: session.sessionHash,
          authority,
          assertCurrent,
          assertGrant,
          revalidate,
          checkGrant,
          storageLimit,
          files,
          timing,
        });
        return turn.response;
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
    async startAutomations(assertHostCurrent: () => void) {
      if (automationSchedulerStarted || !admitStorage) {
        return;
      }
      assertAutomationHostCurrent = assertHostCurrent;
      try {
        const admissions = await listProtectedAdmissions(options.stateDir);
        const owner = admissions.find(
          (member) =>
            member.status === "approved" &&
            member.issuer === options.accessIssuer &&
            member.subject === options.ownerSubject &&
            member.profileId,
        );
        if (owner?.profileId && owner.subject) {
          automationOperator = {
            id: owner.id,
            profileId: owner.profileId,
            issuer: owner.issuer,
            subject: owner.subject,
            revision: owner.revision,
          };
        }
        const members = new Map<string, AutomationMember>();
        for (const member of admissions) {
          if (
            member.status !== "approved" ||
            member.issuer !== options.accessIssuer ||
            !member.profileId ||
            !member.subject
          ) {
            continue;
          }
          if (!members.has(member.profileId) || member.subject === options.ownerSubject) {
            members.set(member.profileId, {
              id: member.id,
              profileId: member.profileId,
              issuer: member.issuer,
              subject: member.subject,
              revision: member.revision,
            });
          }
        }
        automationStorageRecovery.close();
        await automationStorageRecovery.reconcile();
        automationStorageRecovery.assertSettled();
        const profiles = new Set(
          admissions.flatMap((member) => (member.profileId ? [member.profileId] : [])),
        );
        for (const profileId of profiles) {
          const member = members.get(profileId);
          if (!member && !automationOperator) {
            continue;
          }
          const authority = member
            ? automationAuthority(member)
            : automationAuthority(automationOperator!);
          const automations = await listOwnedProtectedAutomationStorageRecords(options.stateDir, {
            profileId,
            assertCurrent: authority.assertCurrent,
          });
          for (const automation of automations) {
            if (!automationOperator) {
              const history = await listProtectedAutomationLifecycleRuns(
                options.stateDir,
                automation.id,
                { ...authority.authority, revalidate: authority.revalidate },
              );
              if (history?.some((run) => run.status === "queued" || run.status === "running")) {
                throw new Error(
                  "The configured owner is required to recover interrupted automations.",
                );
              }
              continue;
            }
            const maintenance = automationOwnerAuthority(profileId, true);
            const interrupted = await readProtectedAutomationInterruptedRunForOwner(
              options.stateDir,
              automation.id,
              maintenance,
            );
            if (interrupted === undefined) {
              throw new Error("Protected automation recovery lost owner authority.");
            }
            if (interrupted) {
              const result = await writeProtectedAutomationLifecycleForOwner(
                options.stateDir,
                {
                  kind: "finish",
                  profileId,
                  automationId: automation.id,
                  runId: interrupted.runId,
                  now: Date.now(),
                  outcome: { status: "failed", errorCode: "interrupted" },
                },
                maintenance,
              );
              if (result.status !== "committed" && result.status !== "unchanged") {
                throw new Error("Protected automation interruption could not be recorded.");
              }
            }
          }
        }
        automationStorageRecovery.reopen();
        for (const member of members.values()) {
          const authority = automationAuthority(member);
          await authority.revalidate();
          const automations = await listOwnedProtectedAutomationStorageRecords(
            options.stateDir,
            authority.authority,
          );
          for (const automation of automations) {
            await retryProtectedAutomationInbox(member, automation.id);
            if (automation.enabled) {
              const publication = createAutomationPublicationAuthority(authority).lifecycle;
              const provisioned = await writeProtectedAutomationLifecycle(
                options.stateDir,
                { kind: "provision", profileId: member.profileId, automationId: automation.id },
                publication,
              );
              if (provisioned.status !== "committed" && provisioned.status !== "unchanged") {
                throw new Error("Protected automation metadata could not be provisioned.");
              }
              await refreshProtectedAutomation(member, automation.id);
            }
          }
        }
        automationSchedulerStarted = true;
      } catch (error) {
        automationSchedulerStarted = false;
        automationScheduler.beginClose();
        throw error;
      }
    },
    recoverTransient(assertCurrent: () => void) {
      return chats.recoverTransient(assertCurrent);
    },
    storageLimitFor,
    async shutdown() {
      automationScheduler.beginClose();
      shutdown.abort();
      options.providerRelay?.close();
      for (const run of runs.values()) {
        run.controller.abort();
      }
      while (pending.size) {
        await Promise.allSettled(pending);
      }
      try {
        await automationScheduler.stop();
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
