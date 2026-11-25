import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  ProtectedAutomationIdSchema,
  ProtectedAutomationPatchRequestSchema,
  protectedAutomationPacingLimits,
} from "../../packages/gateway-protocol/src/protected-automation.js";
import { root } from "../../src/infra/fs-safe.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db-cache.js";
import { normalizeProtectedEmail } from "../../src/state/protected-admission.js";
import { readVerifiedUserProfileDirectory } from "../../src/state/user-profile-reads.js";
import { isProtectedAdmissionCurrent, listProtectedAdmissions } from "./admission-store.js";
import { admitProtectedPhysicalAgentStorage } from "./agent-storage.js";
import { createProtectedAgentCatalog, protectedResearchAgent } from "./agents.js";
import {
  listProtectedAutomationLifecycleRuns,
  writeProtectedAutomationLifecycle,
  type ProtectedAutomationLifecycleAuthority,
} from "./automation-lifecycle-store.js";
import { readProtectedAutomationRunRecord } from "./automation-results-read.js";
import { createProtectedAutomationStorageRecoveryOwner } from "./automation-storage-recovery.js";
import {
  createProtectedAutomationRecord,
  listOwnedProtectedAutomationStorageRecords,
  projectProtectedAutomationRecord,
  readOwnedProtectedAutomationStorageRecord,
  saveProtectedAutomationPatch,
} from "./automations-store.js";
import {
  createProtectedAutomationCatalog,
  validateProtectedAutomationDraft,
} from "./automations.js";
import { createStorageAdmission } from "./capacity.js";
import { createProtectedChats } from "./chats.js";
import { ProtectedError } from "./errors.js";
import { withThinking } from "./models.js";
import { configureProtectedRuntimeWorkers } from "./runtime-workers.js";
import {
  protectedMaxFileBytes,
  sparky,
  subjectPattern,
  type parseRuntimeSettings,
} from "./settings.js";
import { acquireProtectedStateOwner } from "./state-owner.js";
import {
  captureProtectedStateWorkerContext,
  prepareProtectedSharedState,
} from "./state-worker-context.js";
import { requireProtectedStorageEncryption } from "./storage-key.js";
import { protectedStorageLimitFor, protectedStorageMeasurement } from "./storage-measurement.js";

const emailSchema = Type.String({ minLength: 1, maxLength: 254 });
const inputSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("inspect"),
      email: emailSchema,
      automationId: Type.Optional(ProtectedAutomationIdSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("create"),
      email: emailSchema,
      automationId: ProtectedAutomationIdSchema,
      definition: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("patch"),
      email: emailSchema,
      automationId: ProtectedAutomationIdSchema,
      expectedVersion: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 16 }),
      patch: ProtectedAutomationPatchRequestSchema,
    },
    { additionalProperties: false },
  ),
]);

function refuse(code: string, message: string): never {
  throw new ProtectedError(409, code, message);
}

/** One offline operation. No identity, profile, access policy, or run is created here. */
export async function maintainProtectedAutomations(
  settings: ReturnType<typeof parseRuntimeSettings>,
  input: unknown,
) {
  if (
    !Value.Check(inputSchema, input) ||
    (input.operation === "patch" && Object.keys(input.patch).length === 0)
  ) {
    refuse("invalid_input", "Supply one inspect, create, or versioned patch JSON object.");
  }
  const email = normalizeProtectedEmail(input.email);
  if (!email) {
    refuse("invalid_email", "Supply a valid member email.");
  }
  const { stateDir } = settings;
  const owner = await acquireProtectedStateOwner(stateDir);
  if (!owner) {
    refuse("state_busy", "Stop the listener before automation maintenance.");
  }
  let context: ReturnType<typeof captureProtectedStateWorkerContext> | undefined;
  let encryption: ReturnType<typeof requireProtectedStorageEncryption> | undefined;
  const recovery = createProtectedAutomationStorageRecoveryOwner(owner.assertCurrent);
  try {
    await configureProtectedRuntimeWorkers(fileURLToPath(new URL("../..", import.meta.url)));
    owner.assertCurrent();
    encryption = requireProtectedStorageEncryption();
    const workerContext = captureProtectedStateWorkerContext(stateDir);
    context = workerContext;
    await prepareProtectedSharedState(stateDir, owner.assertCurrent);
    const candidates = (await listProtectedAdmissions(stateDir)).filter(
      (entry) => entry.email !== null && normalizeProtectedEmail(entry.email) === email,
    );
    owner.assertCurrent();
    const [candidate] = candidates;
    if (
      candidates.length !== 1 ||
      !candidate ||
      candidate.status !== "approved" ||
      candidate.issuer !== settings.accessIssuer ||
      !candidate.profileId ||
      !candidate.subject ||
      !subjectPattern.test(candidate.subject)
    ) {
      refuse("member_unavailable", "Exactly one active, bound human member must match the email.");
    }
    const member = { ...candidate, profileId: candidate.profileId, subject: candidate.subject };
    let profileCurrent: (() => boolean) | undefined;
    const assertCurrent = () => {
      owner.assertCurrent();
      workerContext.admission.assertCurrent();
      if (!profileCurrent?.()) {
        refuse("member_inactive", "The member profile is unavailable or changed. Inspect again.");
      }
    };
    const revalidate = async () => {
      owner.assertCurrent();
      const current = await isProtectedAdmissionCurrent(stateDir, member);
      owner.assertCurrent();
      if (!current) {
        refuse("member_inactive", "The member admission changed. Inspect again.");
      }
      const profiles = await readVerifiedUserProfileDirectory(
        {
          issuer: member.issuer,
          subjects: [member.subject],
          preferenceKey: "grogu.protected.directory",
          after: null,
          limit: 2,
        },
        { env: workerContext.environment },
      );
      owner.assertCurrent();
      if (
        profiles.people.length !== 1 ||
        profiles.people[0]?.id !== member.profileId ||
        profiles.nextCursor !== null ||
        !profiles.isCurrent()
      ) {
        refuse("member_inactive", "The bound member profile is missing, revoked, or ambiguous.");
      }
      profileCurrent = profiles.isCurrent;
      assertCurrent();
    };
    await revalidate();
    const authority = { profileId: member.profileId, assertCurrent, revalidate };
    const agents = createProtectedAgentCatalog([protectedResearchAgent]);
    const baseCatalog = createProtectedAutomationCatalog({
      agents: { defaultAgentId: agents.defaultAgentId, agents: agents.list() },
      models: [withThinking(sparky, { ...sparky, reasoning: true })],
      calendarDraftValidationAvailable: true,
      persistenceAvailable: true,
    });
    if (!baseCatalog) {
      refuse("catalog_unavailable", "The automation catalog is unavailable.");
    }
    const catalog = {
      ...baseCatalog,
      schedule: { ...baseCatalog.schedule, pacing: protectedAutomationPacingLimits },
    };
    if (input.operation === "inspect") {
      const owned = input.automationId
        ? [await readOwnedProtectedAutomationStorageRecord(stateDir, input.automationId, authority)]
        : await listOwnedProtectedAutomationStorageRecords(stateDir, authority);
      const automations = [];
      for (const record of owned) {
        if (!record) {
          refuse("not_found", "No owned automation matches this ID.");
        }
        const history = await listProtectedAutomationLifecycleRuns(stateDir, record.id, authority);
        if (!history) {
          refuse("not_found", "The owned automation history is unavailable.");
        }
        const runs = history.slice(0, 5);
        const results = [];
        for (const run of runs) {
          if (run.resultId) {
            results.push(
              (
                await readProtectedAutomationRunRecord(
                  stateDir,
                  { automationId: record.id, id: run.resultId },
                  authority,
                )
              ).run,
            );
          }
        }
        automations.push({
          ...projectProtectedAutomationRecord(record),
          visibility: record.visibility,
          runs,
          results,
        });
      }
      assertCurrent();
      return { operation: "inspect", profileId: member.profileId, catalog, automations };
    }
    const validation =
      input.operation === "create"
        ? validateProtectedAutomationDraft(input.definition, catalog)
        : undefined;
    if (validation && !validation.valid) {
      refuse(
        "invalid_definition",
        validation.errors.map((error) => `${error.field}: ${error.message}`).join(" "),
      );
    }
    if (input.operation === "create" && validation?.valid) {
      const existing = await readOwnedProtectedAutomationStorageRecord(
        stateDir,
        input.automationId,
        authority,
      );
      if (existing) {
        if (!isDeepStrictEqual(existing.definition, validation.draft)) {
          refuse(
            "id_conflict",
            "This ID already has a different definition. Inspect it before patching.",
          );
        }
        assertCurrent();
        return {
          operation: "create",
          status: "exists",
          automation: projectProtectedAutomationRecord(existing),
        };
      }
    }
    admitProtectedPhysicalAgentStorage(assertCurrent);
    const chats = createProtectedChats({
      stateDir,
      agentCatalog: agents,
      maxChatsPerUser: 100,
      maxFileBytes: protectedMaxFileBytes,
      usersRoot: await root(path.join(stateDir, "users")),
    });
    const storage = createStorageAdmission({
      ...protectedStorageMeasurement({
        stateDir,
        chats,
        usersRoot: await root(path.join(stateDir, "users")),
        maxFileBytes: protectedMaxFileBytes,
        encryption,
      }),
      limits: settings.storageLimits,
    });
    const limit = () =>
      protectedStorageLimitFor(
        settings,
        {
          id: member.profileId,
          owner: member.subject === settings.ownerSubject,
        },
        assertCurrent,
      );
    const admitStorage = async () => {
      await revalidate();
      return storage(member.profileId, assertCurrent, "automation", await limit());
    };
    if (input.operation === "create" && validation?.valid) {
      const admitted = await admitStorage();
      try {
        await revalidate();
        const automation = await createProtectedAutomationRecord(
          stateDir,
          {
            profileId: member.profileId,
            automationId: input.automationId,
            definition: validation.draft,
            now: Date.now(),
          },
          authority,
          admitted,
          {
            hasRunHistory: (id) => chats.hasAutomationRunHistory(authority, id),
            enrollPublication: recovery.enrollPublication,
            retainUncertainCreateCommit: recovery.retainUncertainCreateCommit,
            // The offline owner awaits reconciliation before closing its worker below.
            reconcile: () => {},
          },
        );
        if (!automation) {
          refuse("member_inactive", "The member cannot create automations.");
        }
        assertCurrent();
        return { operation: "create", status: "created", automation };
      } finally {
        admitted.release();
      }
    }
    if (input.operation !== "patch") {
      refuse("invalid_definition", "Supply a valid automation definition.");
    }
    const lifecycle: ProtectedAutomationLifecycleAuthority = {
      ...authority,
      enrollPublication: recovery.enrollPublication,
      retainUncertainCommit: recovery.retainUncertainCommit,
      reserveStorage: async (bytes) => {
        await revalidate();
        return storage.reserveStoredData(member.profileId, assertCurrent, bytes, await limit());
      },
      reserveReplacement: async (change) => {
        await revalidate();
        return storage.reserveStoredDataReplacement(
          member.profileId,
          assertCurrent,
          change,
          await limit(),
        );
      },
      reserveBatchReplacement: async (change) => {
        await revalidate();
        return storage.reserveStoredDataBatchReplacement(
          member.profileId,
          assertCurrent,
          change,
          await limit(),
        );
      },
      reserveRecipient: async () =>
        refuse("unexpected_write", "Provisioning cannot write to another member."),
      retireStorage: (entries) => {
        if (entries.length) {
          refuse("unexpected_write", "Provisioning cannot retire stored data.");
        }
      },
    };
    const saved = await saveProtectedAutomationPatch(
      stateDir,
      {
        automationId: input.automationId,
        expectedVersion: input.expectedVersion,
        patch: input.patch,
        catalog,
        retainedAgent: agents.get,
      },
      authority,
      {
        revalidate,
        admitStorage,
        // Offline exclusive ownership substitutes for a running listener, not for provisioning.
        schedulerAvailable: true,
        provision: async () => {
          const provisioned = await writeProtectedAutomationLifecycle(
            stateDir,
            {
              kind: "provision",
              profileId: member.profileId,
              automationId: input.automationId,
            },
            lifecycle,
          );
          if (provisioned.status !== "committed" && provisioned.status !== "unchanged") {
            refuse("automation_unavailable", "The automation cannot be provisioned.");
          }
        },
      },
    );
    if (saved.status !== "updated") {
      refuse(
        saved.status,
        saved.status === "invalid"
          ? saved.validation.errors.map((error) => `${error.field}: ${error.message}`).join(" ")
          : "The automation was not patched. Inspect its current state before retrying.",
      );
    }
    assertCurrent();
    return { operation: "patch", ...saved };
  } finally {
    recovery.close();
    try {
      try {
        await recovery.reconcile();
      } finally {
        if (context) {
          await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
        }
        await closeOpenClawAgentDatabasesAsync(stateDir);
      }
      recovery.assertSettled();
    } finally {
      encryption?.dispose();
      owner.release();
    }
  }
}
