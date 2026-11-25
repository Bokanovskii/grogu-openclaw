import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { captureEnv } from "../../src/test-utils/env.js";

export async function useTestStorageKey(
  t: TestContext,
  stateDir: string,
  keyFile = `${stateDir}.key`,
) {
  const scope = new AsyncDisposableStack();
  t.after(() => scope.disposeAsync());
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_PROTECTED_STORAGE_KEY_FILE"]);
  await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
  scope.defer(async () => {
    env.restore();
    await rm(keyFile, { force: true });
  });
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_PROTECTED_STORAGE_KEY_FILE = keyFile;
  return scope;
}
