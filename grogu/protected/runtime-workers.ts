import { stat } from "node:fs/promises";
import path from "node:path";
import {
  runtimeProcessEntrypoints,
  setRuntimeProcessEntrypointsRoot,
} from "../../src/infra/runtime-process-entrypoints.js";

export class ProtectedWorkerBuildError extends Error {}

const incompleteBuildMessage =
  "Protected worker build is incomplete. Rebuild and include the complete dist directory.";

export async function configureProtectedRuntimeWorkers(serviceRoot: string): Promise<void> {
  const dist = path.join(serviceRoot, "dist");
  try {
    await stat(dist);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      setRuntimeProcessEntrypointsRoot(undefined);
      return;
    }
    throw error;
  }

  await Promise.all(
    [
      "build-info.json",
      ...Object.values(runtimeProcessEntrypoints).map((e) => e.distWorkerPath),
    ].map(async (name) => {
      const info = await stat(path.join(dist, name)).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new ProtectedWorkerBuildError(incompleteBuildMessage, { cause: error });
        }
        throw error;
      });
      if (!info.isFile()) {
        throw new ProtectedWorkerBuildError(incompleteBuildMessage);
      }
    }),
  );
  setRuntimeProcessEntrypointsRoot(serviceRoot);
}
