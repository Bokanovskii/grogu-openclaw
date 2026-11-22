import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runtimeProcessEntrypoints,
  setRuntimeProcessEntrypointsRoot,
} from "../../src/infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { configureProtectedRuntimeWorkers } from "./runtime-workers.js";

void test("protected runtime selects complete production workers and retains source fallback", async (t) => {
  const serviceRoot = path.resolve(".artifacts", `protected-workers-${randomUUID()}`);
  await mkdir(serviceRoot, { recursive: true });
  t.after(async () => {
    setRuntimeProcessEntrypointsRoot(undefined);
    await rm(serviceRoot, { recursive: true, force: true });
  });
  const worker = runtimeProcessEntrypoints.sessionTranscript;
  await configureProtectedRuntimeWorkers(serviceRoot);
  assert.match(fileURLToPath(resolveRuntimeWorkerUrl(worker)), /session-transcript\.worker\.ts$/u);

  const dist = path.join(serviceRoot, "dist");
  for (const name of [
    "build-info.json",
    ...Object.values(runtimeProcessEntrypoints).map((e) => e.distWorkerPath),
  ]) {
    const file = path.join(dist, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
  }
  await configureProtectedRuntimeWorkers(serviceRoot);
  assert.equal(
    fileURLToPath(resolveRuntimeWorkerUrl(worker)),
    path.join(dist, "config/sessions/session-transcript.worker.js"),
  );
  await rm(path.join(dist, worker.distWorkerPath));
  await assert.rejects(
    configureProtectedRuntimeWorkers(serviceRoot),
    /worker build is incomplete/u,
  );
});
