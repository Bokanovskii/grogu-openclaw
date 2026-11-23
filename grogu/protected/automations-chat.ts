import { isDeepStrictEqual } from "node:util";
import type { ProtectedAuthoringTurnEvent } from "../../packages/gateway-protocol/src/protected-authoring.js";
import type {
  ProtectedAutomationCatalog,
  ProtectedAutomationDraft,
  ProtectedAutomationRecord,
} from "../../packages/gateway-protocol/src/protected.js";
import type {
  AutomationsAuthoringBindings,
  AutomationsChatBindings,
  AutomationsChatListParameters,
  AutomationsChatProposePatchParameters,
} from "./automations-chat/contract.js";
import { isAutomationsChatProposalPatch } from "./automations-chat/contract.js";
import {
  createProtectedAutomationRecord,
  listProtectedAutomationRecords,
  readProtectedAutomationRecord,
  saveProtectedAutomationPatch,
} from "./automations-store.js";
import { applyProtectedAutomationPatch, validateProtectedAutomationDraft } from "./automations.js";

type Authority = Parameters<typeof listProtectedAutomationRecords>[1];
type AdmitStorage = () => Promise<
  NonNullable<Parameters<typeof createProtectedAutomationRecord>[3]> &
    Awaited<
      ReturnType<NonNullable<Parameters<typeof saveProtectedAutomationPatch>[3]["admitStorage"]>>
    >
>;
type AuthoringEvent = Extract<
  ProtectedAuthoringTurnEvent,
  { type: "automation-draft-update" | "automation-saved" | "automation-save-refused" }
>;

export function createProtectedAutomationsChatBindings(input: {
  stateDir: string;
  catalog: ProtectedAutomationCatalog;
  authority: Authority;
  revalidate: () => Promise<void>;
}): AutomationsChatBindings {
  const runCurrent = async <T>(run: () => Promise<T>): Promise<T> => {
    input.authority.assertCurrent();
    await input.revalidate();
    input.authority.assertCurrent();
    const result = await run();
    await input.revalidate();
    input.authority.assertCurrent();
    return result;
  };
  const readOwned = async (automationId: string) =>
    readProtectedAutomationRecord(
      input.stateDir,
      { profileId: input.authority.profileId, automationId },
      input.authority,
    );
  return {
    async list(params: AutomationsChatListParameters) {
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      return runCurrent(async () => {
        const automations = await listProtectedAutomationRecords(input.stateDir, input.authority);
        return {
          status: "ok",
          writeApplied: false,
          total: automations.length,
          offset,
          limit,
          automations: automations.slice(offset, offset + limit),
        };
      });
    },
    async read({ automationId }) {
      return runCurrent(async () => {
        const automation = await readOwned(automationId);
        return automation
          ? { status: "found" as const, writeApplied: false as const, automation }
          : { status: "not_found" as const, writeApplied: false as const };
      });
    },
    async proposeCreate({ draft }) {
      return runCurrent(async () => {
        const validation = validateProtectedAutomationDraft(draft, input.catalog);
        if (!validation.valid) {
          return {
            status: "invalid" as const,
            writeApplied: false as const,
            errors: validation.errors,
          };
        }
        return {
          status: "proposed" as const,
          writeApplied: false as const,
          draft: validation.draft,
        };
      });
    },
    async proposePatch(params: AutomationsChatProposePatchParameters) {
      return runCurrent(async () => {
        const { automationId, expectedVersion, patch } = params;
        if (!isAutomationsChatProposalPatch(patch)) {
          return {
            status: "invalid" as const,
            writeApplied: false as const,
            errors: [
              {
                field: "patch",
                code: "invalid_value",
                message: "Enter a valid set of proposed changes.",
              },
            ],
          };
        }
        const current = await readOwned(automationId);
        if (!current) {
          return { status: "not_found" as const, writeApplied: false as const };
        }
        if (!isExpectedVersion(expectedVersion) || current.version !== expectedVersion) {
          return {
            status: "version_mismatch" as const,
            writeApplied: false as const,
            currentVersion: current.version,
          };
        }
        if (current.enabled) {
          return {
            status: "unavailable" as const,
            writeApplied: false as const,
            reason: "automation_active" as const,
          };
        }
        const definition = applyProtectedAutomationPatch(current, patch);
        const validation = validateProtectedAutomationDraft(definition, input.catalog, {
          id: current.agentId,
        });
        if (!validation.valid) {
          return {
            status: "invalid" as const,
            writeApplied: false as const,
            errors: validation.errors,
          };
        }
        return {
          status: "proposed" as const,
          writeApplied: false as const,
          automationId,
          expectedVersion,
          draft: validation.draft,
        };
      });
    },
  };
}

/**
 * One authoring turn over a client-held draft. Draft updates stay unsaved; only an explicit save of
 * exactly the revision sent this turn writes a paused record. An unsaved chat's record id is its
 * chat id, so a retried first save finds the same record instead of creating another.
 */
export function createProtectedAutomationAuthoringBindings(input: {
  stateDir: string;
  catalog: ProtectedAutomationCatalog;
  retainedAgent: (agentId: string) => { id: string } | undefined;
  authority: Authority;
  revalidate: () => Promise<void>;
  chatId: string;
  boundAutomationId?: string;
  sent: { draft: ProtectedAutomationDraft; draftRevision: string; automationVersion?: string };
  admitStorage: AdmitStorage;
  bind: (automationId: string) => Promise<void>;
  publish: (event: AuthoringEvent) => Promise<void>;
}): AutomationsAuthoringBindings {
  // The agent runtime may run one message's tool calls in parallel; serialize them so the
  // turn-local revision chain and save decision observe every earlier call.
  let previous: Promise<unknown> = Promise.resolve();
  const runCurrent = <T>(run: () => Promise<T>): Promise<T> => {
    const current = previous.then(async () => {
      input.authority.assertCurrent();
      await input.revalidate();
      input.authority.assertCurrent();
      const result = await run();
      await input.revalidate();
      input.authority.assertCurrent();
      return result;
    });
    previous = current.catch(() => undefined);
    return current;
  };
  const readSaved = async () => {
    const automationId = input.boundAutomationId ?? input.chatId;
    return (
      (await readProtectedAutomationRecord(
        input.stateDir,
        { profileId: input.authority.profileId, automationId },
        input.authority,
      )) ?? null
    );
  };
  const validate = (draft: ProtectedAutomationDraft, saved: ProtectedAutomationRecord | null) =>
    validateProtectedAutomationDraft(
      draft,
      input.catalog,
      saved ? input.retainedAgent(saved.agentId) : undefined,
    );
  let draftRevision = BigInt(input.sent.draftRevision);
  let draft = input.sent.draft;
  let saved:
    | Extract<Awaited<ReturnType<AutomationsAuthoringBindings["save"]>>, { status: "saved" }>
    | undefined;
  const refuse = async (
    reason: Extract<AuthoringEvent, { type: "automation-save-refused" }>["reason"],
    currentVersion?: string,
  ) => {
    await input.publish({
      type: "automation-save-refused",
      draftRevision: input.sent.draftRevision,
      reason,
      ...(currentVersion ? { currentVersion } : {}),
    });
    return {
      status: "refused" as const,
      writeApplied: false as const,
      reason: reason === "invalid" ? ("unavailable" as const) : reason,
    };
  };
  const create = async (definition: ProtectedAutomationDraft) => {
    const storage = await input.admitStorage();
    try {
      return await createProtectedAutomationRecord(
        input.stateDir,
        {
          profileId: input.authority.profileId,
          definition,
          now: Date.now(),
          automationId: input.chatId,
        },
        input.authority,
        storage,
      );
    } finally {
      storage.release();
    }
  };
  return {
    authoring: "automation",
    async read() {
      return runCurrent(async () => ({
        status: "ok" as const,
        writeApplied: false as const,
        draftRevision: String(draftRevision),
        draft,
        saved: await readSaved(),
      }));
    },
    async update(params) {
      return runCurrent(async () => {
        const validation = validate(params.draft, await readSaved());
        if (!validation.valid) {
          return {
            status: "invalid" as const,
            writeApplied: false as const,
            errors: validation.errors,
          };
        }
        const base = draftRevision;
        const next = base + 1n;
        if (String(next).length > 16) {
          return {
            status: "invalid" as const,
            writeApplied: false as const,
            errors: [
              {
                field: "draft",
                code: "invalid_value",
                message: "Reload the draft before editing it.",
              },
            ],
          };
        }
        await input.publish({
          type: "automation-draft-update",
          baseDraftRevision: String(base),
          draftRevision: String(next),
          draft: validation.draft,
        });
        draftRevision = next;
        draft = validation.draft;
        return {
          status: "draft_updated" as const,
          writeApplied: false as const,
          draftRevision: String(next),
          draft,
        };
      });
    },
    async save(params) {
      return runCurrent(async () => {
        if (saved) {
          return saved;
        }
        if (
          params.draftRevision !== input.sent.draftRevision ||
          draftRevision !== BigInt(input.sent.draftRevision)
        ) {
          return refuse("draft_changed");
        }
        let automation: ProtectedAutomationRecord | undefined;
        if (input.boundAutomationId === undefined) {
          const validation = validate(input.sent.draft, null);
          if (!validation.valid) {
            await refuse("invalid");
            return {
              status: "invalid" as const,
              writeApplied: false as const,
              errors: validation.errors,
            };
          }
          automation = await create(validation.draft);
          if (!automation) {
            return refuse("unavailable");
          }
          await input.bind(automation.id);
          // A retried first save finds the record an interrupted save created; it is only this
          // revision's save when the stored definition still equals the sent draft.
          if (!isDeepStrictEqual(definitionOf(automation), withoutUndefined(validation.draft))) {
            return refuse("version_mismatch", automation.version);
          }
        } else {
          if (input.sent.automationVersion === undefined) {
            return refuse("version_mismatch");
          }
          const { draft: sentDraft } = input.sent;
          const result = await saveProtectedAutomationPatch(
            input.stateDir,
            {
              automationId: input.boundAutomationId,
              expectedVersion: input.sent.automationVersion,
              patch: {
                name: sentDraft.name,
                instructions: sentDraft.instructions,
                whenToNotify: sentDraft.whenToNotify,
                doneWhen: sentDraft.doneWhen ?? null,
                agentId: sentDraft.agentId,
                model: sentDraft.model,
                thinking: sentDraft.thinking ?? null,
                schedule: sentDraft.schedule,
              },
              catalog: input.catalog,
              retainedAgent: input.retainedAgent,
            },
            input.authority,
            { revalidate: input.revalidate, admitStorage: input.admitStorage },
          );
          switch (result.status) {
            case "updated":
              automation = result.automation;
              break;
            case "invalid":
              await refuse("invalid");
              return {
                status: "invalid" as const,
                writeApplied: false as const,
                errors: result.validation.errors,
              };
            case "version_mismatch":
              return refuse("version_mismatch", result.currentVersion);
            case "not_found":
              return refuse("not_found");
            case "scheduler_required":
              return refuse("automation_active");
            default:
              return refuse("unavailable");
          }
        }
        input.authority.assertCurrent();
        await input.publish({
          type: "automation-saved",
          draftRevision: input.sent.draftRevision,
          automation,
        });
        saved = { status: "saved" as const, writeApplied: true as const, automation };
        return saved;
      });
    },
  };
}

function withoutUndefined<T extends object>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function definitionOf(automation: ProtectedAutomationRecord) {
  const {
    id: _id,
    version: _version,
    enabled: _enabled,
    state: _state,
    nextCheckAt: _next,
    ...definition
  } = automation;
  return withoutUndefined(definition);
}

function isExpectedVersion(value: string) {
  return /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
}
