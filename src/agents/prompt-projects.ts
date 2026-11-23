import { prepareEmbeddedSessionActiveProjectKeys } from "./embedded-agent-runner/session-prompt-state.js";
import { resolveProjectKey } from "./project-memory-scope.js";
import { resolveSystemPromptRepoRoot } from "./system-prompt-params.js";

export async function prepareAgentPromptProjects(
  params: Parameters<typeof resolveSystemPromptRepoRoot>[0] & {
    sessionId: string;
    contextIsolation?: "isolated";
  },
) {
  if (params.contextIsolation === "isolated") {
    return { repoRoot: null, projectKey: null, activeProjectKeys: [] };
  }
  const repoRoot = resolveSystemPromptRepoRoot(params) ?? null;
  const projectKey = repoRoot ? await resolveProjectKey(repoRoot) : null;
  return {
    repoRoot,
    projectKey,
    activeProjectKeys: prepareEmbeddedSessionActiveProjectKeys(params.sessionId, projectKey),
  };
}
