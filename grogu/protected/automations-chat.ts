import type { ProtectedAutomationCatalog } from "../../packages/gateway-protocol/src/protected.js";
import type {
  AutomationsChatBindings,
  AutomationsChatListParameters,
  AutomationsChatProposePatchParameters,
} from "./automations-chat/contract.js";
import { isAutomationsChatProposalPatch } from "./automations-chat/contract.js";
import {
  listProtectedAutomationRecords,
  readProtectedAutomationRecord,
} from "./automations-store.js";
import { applyProtectedAutomationPatch, validateProtectedAutomationDraft } from "./automations.js";

type Authority = Parameters<typeof listProtectedAutomationRecords>[1];

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

function isExpectedVersion(value: string) {
  return /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
}
