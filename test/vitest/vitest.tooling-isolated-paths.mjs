// Tooling tests that need fresh module or process state instead of shared workers.
export const toolingIsolatedTestFiles = [
  // Shipped updater composition belongs to the manual/full-release tooling tier.
  "src/cli/update-cli/update-command-legacy-finalize.test.ts",
  // Sibling threads can fork and retain this fixture's listener sockets until exec.
  "test/helpers/openclaw-test-instance.acquisition.test.ts",
  "test/plugins/bundled-provider-auth-literal-parity.test.ts",
  "test/plugins/bundled-provider-auth-literal-parity.2.test.ts",
  "test/plugins/bundled-provider-auth-literal-parity.3.test.ts",
  "test/scripts/check-extension-package-tsc-boundary.test.ts",
  "test/scripts/check-plugin-sdk-wildcard-reexports.test.ts",
  "test/scripts/control-ui-i18n.test.ts",
  // The research tool opens its SQLite broker on the process main thread.
  "test/scripts/grogu-research-topics.test.ts",
  "test/scripts/managed-child-process.drain.test.ts",
  "test/scripts/managed-child-process.termination.test.ts",
  "test/scripts/openclaw-e2e-instance.test.ts",
  "test/scripts/test-projects-build-admission.test.ts",
  "test/scripts/vitest-fork-shutdown.test.ts",
];

const toolingIsolatedTestFileSet = new Set(toolingIsolatedTestFiles);

export function isToolingIsolatedTestFile(value) {
  return toolingIsolatedTestFileSet.has(value.replaceAll("\\", "/"));
}
