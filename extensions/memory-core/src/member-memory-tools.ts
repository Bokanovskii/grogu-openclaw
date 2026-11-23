import {
  asToolParamsRecord,
  jsonResult,
  readFiniteNumberParam,
  readPositiveIntegerParam,
  readStringParam,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveMemoryNotePath } from "./flush-plan.js";
import { isMemberMemoryBinding } from "./member-memory-binding.js";
import {
  MEMORY_GET_TOOL_CONTRACT,
  MEMORY_SEARCH_TOOL_CONTRACT,
  resolveMemoryToolContext,
  type MemoryToolOptions,
} from "./memory-tool-contract.js";

type MemberToolName = "memory_search" | "memory_get" | "memory_store";

export function createMemberMemoryTool(params: {
  name: MemberToolName;
  binding: unknown;
  context: OpenClawPluginToolContext<2>;
  options: MemoryToolOptions;
}): AnyAgentTool | null {
  const { name, context, options } = params;
  const initial = resolveMemoryToolContext(options);
  if (!initial) {
    return null;
  }
  const contract =
    name === "memory_search" ? MEMORY_SEARCH_TOOL_CONTRACT : MEMORY_GET_TOOL_CONTRACT;
  return {
    label: name === "memory_store" ? "Memory Store" : contract.label,
    name,
    description:
      name === "memory_search"
        ? "Before answering questions about prior work or preferences, search this member's private memory by keywords. Results do not include chat transcripts."
        : name === "memory_get"
          ? "Read a bounded excerpt from this member's private memory."
          : "Save one short, useful and durable personal preference or fact. Do not save chat summaries, travel plans, automation instructions, or run details. Search for an existing memory first.",
    parameters:
      name === "memory_store"
        ? {
            type: "object",
            properties: { content: { type: "string", minLength: 1, maxLength: 500 } },
            required: ["content"],
            additionalProperties: false,
          }
        : contract.parameters,
    ...(name === "memory_search"
      ? { prepareArguments: MEMORY_SEARCH_TOOL_CONTRACT.prepareArguments }
      : {}),
    execute: async (_callId, raw, signal) => {
      const current = resolveMemoryToolContext(options);
      if (!current) {
        throw new Error("Member memory is disabled for this agent.");
      }
      if (
        context.memoryAudience?.kind !== "member-private" ||
        !context.assertMemoryAudienceCurrent ||
        !isMemberMemoryBinding(params.binding) ||
        params.binding.audience !== context.memoryAudience
      ) {
        throw new Error("Member memory authority is unavailable.");
      }
      const assertCurrent = () => {
        signal?.throwIfAborted();
        context.assertInvocationCurrent();
        context.assertMemoryAudienceCurrent!();
      };
      assertCurrent();
      const args = asToolParamsRecord(raw);
      if (name !== "memory_store" && args.corpus !== undefined && args.corpus !== "memory") {
        throw new Error("This member memory supports only the memory corpus.");
      }
      const { openMemberMemory } = await import("./member-memory.js");
      const owner = await openMemberMemory(
        params.binding,
        context.memoryAudience,
        assertCurrent,
        current.settings.chunking,
      );
      try {
        if (name === "memory_search") {
          const query = readStringParam(args, "query", { required: true });
          const limit =
            readPositiveIntegerParam(args, "maxResults", { max: 1000 }) ??
            current.settings.query.maxResults;
          const minScore = readFiniteNumberParam(args, "minScore");
          const results = await owner.search(query, limit);
          return jsonResult({
            results:
              minScore === undefined ? results : results.filter((row) => row.score >= minScore),
            provider: "none",
            mode: "keyword",
          });
        }
        if (name === "memory_get") {
          const path = readStringParam(args, "path", { required: true });
          return jsonResult(
            await owner.read(
              path,
              readPositiveIntegerParam(args, "from"),
              readPositiveIntegerParam(args, "lines"),
            ),
          );
        }
        const content = readStringParam(args, "content", { required: true });
        if (content.length > 500) {
          throw new Error("Member memory content exceeds its limit.");
        }
        const stored = await owner.append(
          resolveMemoryNotePath(current.cfg, Date.now()),
          `\n${content.trim().replace(/\s+/gu, " ")}\n`,
        );
        return jsonResult({ stored });
      } finally {
        await owner.release();
      }
    },
  };
}
