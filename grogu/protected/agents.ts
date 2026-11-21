import type { ProtectedAgent, ProtectedAgentTool } from "@openclaw/gateway-protocol/protected";

export type ProtectedAgentDefinition = Omit<ProtectedAgent, "tools"> & {
  instructions: string;
  tools: readonly ProtectedAgentTool[];
};

export type ProtectedAgentExtension = ProtectedAgentDefinition;

const allowedTools = new Set<ProtectedAgentTool>([
  "web_fetch",
  "show_widget",
  "sessions_list",
  "sessions_history",
  "sessions_send",
]);
const travelAgent: ProtectedAgentDefinition = {
  id: "travel",
  name: "Travel",
  description: "Plan trips using sources the user selects.",
  instructions:
    "Help the user plan travel. Use only the tools available in this chat. Session tools are limited to chats owned by this profile; sessions_send can only steer an active permitted chat. Do not book, purchase, or claim to make arrangements on the user's behalf.",
  tools: ["web_fetch", "show_widget", "sessions_list", "sessions_history", "sessions_send"],
};
const generalAgent: ProtectedAgentDefinition = {
  id: "general",
  name: "Just chat",
  description: "Ask general questions without choosing a specialist.",
  instructions:
    "Help with general questions and everyday tasks. Use only the tools available in this chat. Session tools are limited to chats owned by this profile; sessions_send can only steer an active permitted chat. Do not claim capabilities or arrangements beyond the available tools.",
  tools: travelAgent.tools,
};

export const protectedResearchAgent: ProtectedAgentExtension = {
  id: "research",
  name: "Research",
  description: "Summarize sources the user selects.",
  instructions: "Use concise, evidence-based summaries.",
  tools: ["web_fetch"],
};

export const defaultProtectedAgentId = travelAgent.id;

export function createProtectedAgentCatalog(extensions: readonly ProtectedAgentExtension[] = []) {
  const entries = new Map<string, Readonly<ProtectedAgentDefinition>>([
    [travelAgent.id, freezeAgent(travelAgent)],
    [generalAgent.id, freezeAgent(generalAgent)],
  ]);
  for (const candidate of extensions) {
    if (
      !/^[a-z][a-z0-9-]{0,47}$/u.test(candidate.id) ||
      !candidate.name.trim() ||
      candidate.name.length > 80 ||
      !candidate.description.trim() ||
      candidate.description.length > 240 ||
      !candidate.instructions.trim() ||
      candidate.instructions.length > 8_000 ||
      candidate.tools.some((tool) => !allowedTools.has(tool)) ||
      new Set(candidate.tools).size !== candidate.tools.length ||
      entries.has(candidate.id)
    ) {
      throw new TypeError("Protected agent catalog entries must be valid and uniquely named.");
    }
    entries.set(candidate.id, freezeAgent(candidate));
  }
  const agents = [...entries.values()];
  return {
    defaultAgentId: defaultProtectedAgentId,
    get(agentId: string): Readonly<ProtectedAgentDefinition> | undefined {
      return entries.get(agentId);
    },
    list(): ProtectedAgent[] {
      return agents.map(({ id, name, description, tools }) => ({
        id,
        name,
        description,
        tools: [...tools],
      }));
    },
  };
}

function freezeAgent(agent: ProtectedAgentDefinition): Readonly<ProtectedAgentDefinition> {
  return Object.freeze({ ...agent, tools: Object.freeze([...agent.tools]) });
}

export type ProtectedAgentCatalog = ReturnType<typeof createProtectedAgentCatalog>;
