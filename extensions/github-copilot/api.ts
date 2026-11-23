/** Pure provider-owned credential scope policy shared with core auth ownership. */
export { normalizeGithubCopilotOAuthScope } from "./domain.js";
export { runGitHubCopilotDeviceFlow } from "./login.js";
export {
  fetchCopilotModelCatalog,
  getCopilotCatalogContextSizes,
  getCopilotCatalogVendor,
  isCopilotCatalogModelVisible,
} from "./models.js";
export { resolveCopilotRuntimeAuth } from "./runtime-auth.js";
export { CopilotRuntimeAuthError } from "./runtime-auth-error.js";
