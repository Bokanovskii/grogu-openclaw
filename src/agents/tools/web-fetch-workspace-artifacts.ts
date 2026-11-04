import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { normalizeWorkspaceDir } from "../workspace-dir.js";

type Spill = { path: string; chars: number; truncated?: true };
type ArtifactOwner = {
  cacheKey: string;
  path: string;
  relativePath: string;
  rootReal?: string;
  bytes: number;
  sha256: string;
};
const directory = ".openclaw/artifacts/web-fetch";
const owners = new WeakMap<object, ArtifactOwner>();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Trusted tool construction owns spill paths; model arguments can never select their workspace. */
export function createWebFetchArtifactScope(params: {
  workspaceDir?: string;
  agentId?: string;
  readOnly?: boolean;
  sandboxed?: boolean;
  bridge?: SandboxFsBridge;
  signal?: AbortSignal;
  assertInvocationCurrent?: () => void;
}) {
  const rootDir = normalizeWorkspaceDir(params.workspaceDir);
  const bridge = params.sandboxed ? params.bridge : undefined;
  const namespace =
    bridge && rootDir ? bridge.resolvePath({ filePath: ".", cwd: rootDir }).containerPath : null;
  const cacheKey = `workspace-artifacts-v1:${hash(
    JSON.stringify([
      params.agentId ?? null,
      rootDir,
      namespace,
      params.readOnly === true,
      params.sandboxed === true,
    ]),
  )}`;
  const sourceCurrent = captureAgentToolSourceExecutionGuard(params.signal);
  const assertCurrent = () => {
    sourceCurrent();
    params.assertInvocationCurrent?.();
  };
  let filesPromise: ReturnType<typeof root> | undefined;
  const files = () => {
    if (!rootDir) {
      throw new Error("web_fetch full output requires a trusted workspace.");
    }
    return (filesPromise ??= root(rootDir, {
      assertBeforeMutation: assertCurrent,
      hardlinks: "reject",
      symlinks: "reject",
      mutationSymlinks: "reject",
      mode: 0o600,
    }));
  };
  const requireWritable = () => {
    assertCurrent();
    if (!rootDir) {
      throw new Error(
        "web_fetch full output requires a trusted workspace; no global artifact fallback is allowed.",
      );
    }
    if (params.readOnly) {
      throw new Error(
        "web_fetch cannot preserve full output in a read-only workspace. Request a smaller inline result.",
      );
    }
    if (params.sandboxed && !bridge?.createFileExclusive) {
      throw new Error("web_fetch requires a private artifact-capable sandbox filesystem bridge.");
    }
  };
  const readOwned = async (spill: Spill, owner: ArtifactOwner) => {
    assertCurrent();
    if (bridge) {
      return bridge.readFile({
        filePath: spill.path,
        cwd: rootDir ?? undefined,
        maxBytes: owner.bytes,
        signal: params.signal,
      });
    }
    const target = await files();
    assertCurrent();
    if (target.rootReal !== owner.rootReal) {
      throw new Error("web_fetch artifact workspace changed.");
    }
    return target.readBytes(owner.relativePath, {
      maxBytes: owner.bytes,
      hardlinks: "reject",
      symlinks: "reject",
    });
  };
  return {
    cacheKey,
    async write(content: string, metadata: { chars: number; truncated: boolean }): Promise<Spill> {
      requireWritable();
      const relativePath = `${directory}/web-fetch-${randomUUID()}.log`;
      let artifactPath: string;
      let rootReal: string | undefined;
      try {
        if (bridge?.createFileExclusive) {
          artifactPath = bridge.resolvePath({
            filePath: relativePath,
            cwd: rootDir ?? undefined,
          }).containerPath;
          assertCurrent();
          const created = await bridge.createFileExclusive({
            filePath: relativePath,
            cwd: rootDir ?? undefined,
            data: content,
            mkdir: true,
            signal: params.signal,
          });
          if (created !== "created") {
            throw new Error("web_fetch artifact already exists.");
          }
        } else {
          const target = await files();
          assertCurrent();
          rootReal = target.rootReal;
          await target.mkdir(directory, { private: true, mutationSymlinks: "reject" });
          assertCurrent();
          await target.create(relativePath, content, {
            mode: 0o600,
            private: true,
            mkdir: false,
            durable: false,
            mutationSymlinks: "reject",
          });
          artifactPath = path.join(rootReal, relativePath);
        }
        assertCurrent();
        const spill: Spill = {
          path: artifactPath,
          chars: metadata.chars,
          ...(metadata.truncated ? { truncated: true } : {}),
        };
        const owner = {
          cacheKey,
          path: artifactPath,
          relativePath,
          rootReal,
          bytes: Buffer.byteLength(content),
          sha256: hash(content),
        };
        if (hash(await readOwned(spill, owner)) !== owner.sha256) {
          throw new Error("web_fetch artifact verification failed.");
        }
        assertCurrent();
        owners.set(spill, owner);
        return spill;
      } catch (error) {
        assertCurrent();
        throw new Error(
          "web_fetch could not preserve readable full output in its calling workspace.",
          { cause: error },
        );
      }
    },
    async canReuse(value: unknown): Promise<boolean> {
      assertCurrent();
      if (!value || typeof value !== "object" || !("path" in value)) {
        return false;
      }
      const owner = owners.get(value);
      if (
        !rootDir ||
        params.readOnly ||
        !owner ||
        owner.cacheKey !== cacheKey ||
        owner.path !== value.path
      ) {
        return false;
      }
      try {
        const matches =
          hash(await readOwned({ path: owner.path, chars: 0 }, owner)) === owner.sha256;
        assertCurrent();
        return matches;
      } catch {
        assertCurrent();
        return false;
      }
    },
  };
}
