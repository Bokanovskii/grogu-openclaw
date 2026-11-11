import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { captureUpdateRecoveryBaseline } from "./update-recovery-baseline-capture.js";
import { retireCompletedUpdateRecoveryCaptures } from "./update-recovery-capture-retirement.js";
import { completeStandaloneDoctorCapture } from "./update-recovery-doctor-completion.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
import * as processInspection from "./update-run-driver.js";
import { createUpdateRun, finishUpdateRun } from "./update-run-ledger.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(state: OpenClawTestState) {
  openOpenClawStateDatabase({ env: state.env });
  const { databasePath } = installPrivateUpdateHandoffStore(state.root);
  const store = resolveUpdateCaptureRoot(state.stateDir);
  await fs.mkdir(store, { mode: 0o700 });
  await fs.writeFile(
    path.join(store, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
  const deadDriver = { host: hostname(), pid: process.pid, startIdentity: "0" };
  const capture = async (
    status: "succeeded" | "failed" | "running" | "unknown" = "succeeded",
    driver: UpdateRunDriver = deadDriver,
    runId = randomUUID(),
  ) => {
    const directory = path.join(store, runId);
    await fs.mkdir(path.join(directory, "payload"), { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await fs.writeFile(
      path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
    );
    const manifest = {
      schemaVersion: 2,
      kind: "update-recovery",
      generation: { kind: "baseline" },
      databases: [],
      runId,
      installRoot: state.root,
      stateDir: state.stateDir,
      configPath: state.configPath,
      configPaths: [state.configPath],
      creator: driver,
      drivers: [driver],
      createdAt: new Date(Date.now()).toISOString(),
      roots: [state.configPath],
      excludedRoots: [],
      protectedPaths: [state.configPath],
      entries: [{ kind: "missing", sourcePath: state.configPath, sqlite: false, directory: false }],
    };
    const raw = JSON.stringify(manifest);
    parseUpdateRecoveryBackupManifest(raw);
    await fs.writeFile(path.join(directory, "manifest.json"), raw);
    await fs.writeFile(path.join(directory, "payload", "original.txt"), "synthetic original");
    if (status !== "unknown") {
      createUpdateRun({ runId, trigger: "cli", origin: { driver } }, { env: state.env });
      if (status !== "running") {
        finishUpdateRun(runId, { status }, { env: state.env });
      }
    }
    return {
      directory,
      runId,
      digest: createHash("sha256").update(raw).digest("hex"),
    };
  };
  return { capture, databasePath };
}

it("previews successful originals without deleting and applies retirement idempotently", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { capture } = await fixture(state);
    const original = await capture();
    const liveConfig = await fs.readFile(state.configPath);

    expect(
      await retireCompletedUpdateRecoveryCaptures({
        env: state.env,
        apply: false,
        minimumAgeMs: 0,
      }),
    ).toEqual({
      eligible: [original.directory],
      retired: [],
      protected: [],
      warnings: [],
    });
    expect(
      await fs.readFile(path.join(original.directory, "payload", "original.txt"), "utf8"),
    ).toBe("synthetic original");
    expect(
      await retireCompletedUpdateRecoveryCaptures({
        env: state.env,
        apply: true,
        minimumAgeMs: 0,
      }),
    ).toEqual({
      eligible: [original.directory],
      retired: [original.directory],
      protected: [],
      warnings: [],
    });
    await expect(fs.lstat(original.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(state.configPath)).toEqual(liveConfig);
    expect(
      await retireCompletedUpdateRecoveryCaptures({
        env: state.env,
        apply: true,
        minimumAgeMs: 0,
      }),
    ).toEqual({
      eligible: [],
      retired: [],
      protected: [],
      warnings: [],
    });
  });
});

it("retires a real completed capture's drained database staging but preserves unfinished staging", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    openOpenClawStateDatabase({ env: state.env });
    installPrivateUpdateHandoffStore(state.root);
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("Missing fixture process identity.");
    }
    const runId = randomUUID();
    createUpdateRun({ runId, trigger: "cli", origin: { driver } }, { env: state.env });
    const owner = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(state.env),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
        stateDir: state.stateDir,
        role: "sqlite-maintenance",
      },
    });
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => owner.assertCurrent(),
      assertDatabaseAccess: owner.assertDatabaseAccess,
    });
    let captured: Awaited<ReturnType<typeof captureUpdateRecoveryBaseline>>;
    try {
      captured = await scope.run(() =>
        captureUpdateRecoveryBaseline({
          runId,
          installRoot: state.root,
          env: state.env,
          drivers: [driver],
          assertCurrent: () => owner.assertCurrent(),
          acquisition: { mode: "maintenance-owner" },
        }),
      );
    } finally {
      try {
        await scope.close();
      } finally {
        owner.release();
      }
    }
    finishUpdateRun(runId, { status: "succeeded" }, { env: state.env });
    const directory = captured.ref.directory;
    const staging = path.join(directory, "database.databases");
    expect((await fs.lstat(staging)).isDirectory()).toBe(true);
    const manifest = parseUpdateRecoveryBackupManifest(
      await fs.readFile(captured.ref.manifestPath, "utf8"),
    );
    expect(manifest.entries.some((entry) => entry.kind === "file" && entry.sqlite)).toBe(true);
    const liveConfig = await fs.readFile(state.configPath);
    vi.spyOn(processInspection, "inspectUpdateRunDriver").mockReturnValue("dead");

    for (const parent of [staging, path.join(staging, "openclaw")]) {
      for (const kind of ["file", "directory"] as const) {
        const unfinished = path.join(parent, "unrecognized");
        if (kind === "file") {
          await fs.writeFile(unfinished, "unfinished database snapshot");
        } else {
          await fs.mkdir(unfinished);
        }
        const result = await retireCompletedUpdateRecoveryCaptures({
          env: state.env,
          apply: true,
          minimumAgeMs: 0,
        });
        expect(result.eligible).toEqual([]);
        expect(result.retired).toEqual([]);
        expect(result.protected).toEqual([
          { path: directory, reason: expect.stringContaining("database staging") },
        ]);
        expect(await fs.lstat(unfinished)).toBeDefined();
        await fs.rm(unfinished, { recursive: true });
      }
    }

    for (const apply of [false, true]) {
      expect(
        await retireCompletedUpdateRecoveryCaptures({
          env: state.env,
          apply,
          minimumAgeMs: 0,
        }),
      ).toEqual({
        eligible: [directory],
        retired: apply ? [directory] : [],
        protected: [],
        warnings: [],
      });
    }
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(state.configPath)).toEqual(liveConfig);
  });
});

it("retains the full recovery window after completion and the latest nested capture write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { capture } = await fixture(state);
    const day = 24 * 60 * 60 * 1000;
    const startedAtMs = Date.now() - 3 * day;
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAtMs);
    const longUpdate = await capture("running");
    const recentWrite = await capture();
    const expired = await capture();
    for (const { directory } of [longUpdate, recentWrite, expired]) {
      for (const relativePath of [
        ".",
        UPDATE_CAPTURE_PRIVACY_MARKER,
        "manifest.json",
        "payload",
        path.join("payload", "original.txt"),
      ]) {
        const timestamp = new Date(startedAtMs);
        await fs.utimes(path.join(directory, relativePath), timestamp, timestamp);
      }
    }
    const completedAtMs = startedAtMs + 2 * day;
    clock.mockReturnValue(completedAtMs);
    finishUpdateRun(longUpdate.runId, { status: "succeeded" }, { env: state.env });
    await fs.utimes(
      path.join(recentWrite.directory, "payload", "original.txt"),
      new Date(completedAtMs),
      new Date(completedAtMs),
    );
    clock.mockReturnValue(completedAtMs + day / 2);

    for (const apply of [false, true]) {
      const result = await retireCompletedUpdateRecoveryCaptures({
        env: state.env,
        apply,
        minimumAgeMs: day,
      });
      expect(result.eligible).toEqual([expired.directory]);
      expect(result.retired).toEqual(apply ? [expired.directory] : []);
      expect(result.protected.map((entry) => entry.path).toSorted()).toEqual(
        [longUpdate.directory, recentWrite.directory].toSorted(),
      );
      expect(
        result.protected.every((entry) => entry.reason.includes("requested recovery window")),
      ).toBe(true);
      for (const { directory } of [longUpdate, recentWrite]) {
        expect(await fs.readFile(path.join(directory, "payload", "original.txt"), "utf8")).toBe(
          "synthetic original",
        );
      }
    }

    clock.mockReturnValue(completedAtMs + day);
    const result = await retireCompletedUpdateRecoveryCaptures({
      env: state.env,
      apply: true,
      minimumAgeMs: day,
    });
    expect(result.retired.toSorted()).toEqual(
      [longUpdate.directory, recentWrite.directory].toSorted(),
    );
    expect(result.protected).toEqual([]);
  });
});

it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "rejects invalid minimumAgeMs %s before inspecting state",
  async (minimumAgeMs) => {
    await expect(
      retireCompletedUpdateRecoveryCaptures({ env: {}, apply: false, minimumAgeMs }),
    ).rejects.toThrow("minimumAgeMs must be finite and nonnegative");
  },
);

it("preserves failed, unknown, unsealed, live, and unrecognized recovery evidence", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { capture } = await fixture(state);
    const driver = readUpdateRunDriver();
    expect(driver).toBeDefined();
    const retained = [
      await capture("failed"),
      await capture("unknown"),
      await capture("unknown", undefined, `doctor-${randomUUID()}`),
      await capture("succeeded", driver),
      await capture("succeeded", { host: "another-host", pid: 1, startIdentity: "0" }),
    ];
    const partial = await capture();
    await fs.writeFile(path.join(partial.directory, "manifest.json.partial"), "unsealed");
    retained.push(partial);
    const laterGeneration = await capture();
    await fs.mkdir(path.join(laterGeneration.directory, "candidate"));
    retained.push(laterGeneration);
    const contradictory = await capture();
    await fs.writeFile(
      path.join(contradictory.directory, "outcome.json"),
      JSON.stringify({ status: "restored", manifestSha256: contradictory.digest }),
    );
    retained.push(contradictory);
    const linked = await capture();
    await fs.rename(linked.directory, state.path("external-capture"));
    await fs.symlink(state.path("external-capture"), linked.directory, "dir");
    retained.push(linked);

    for (const apply of [false, true]) {
      const result = await retireCompletedUpdateRecoveryCaptures({
        env: state.env,
        apply,
        minimumAgeMs: 0,
      });
      expect(result.eligible).toEqual([]);
      expect(result.retired).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.protected.map((entry) => entry.path).toSorted()).toEqual(
        retained.map((entry) => entry.directory).toSorted(),
      );
      expect(result.protected.every((entry) => entry.reason.length > 0)).toBe(true);
    }
    for (const { directory } of retained) {
      expect(await fs.lstat(directory)).toBeDefined();
    }
    expect(
      await fs.readFile(state.path("external-capture", "payload", "original.txt"), "utf8"),
    ).toBe("synthetic original");
  });
});

it("retires a future standalone Doctor copy only after its producer records success and exits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { capture } = await fixture(state);
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("Missing fixture process identity.");
    }
    const completed = await capture("unknown", driver, `doctor-${randomUUID()}`);
    const unfinished = await capture("unknown", driver, `doctor-${randomUUID()}`);
    await completeStandaloneDoctorCapture({
      env: state.env,
      ref: {
        directory: completed.directory,
        manifestPath: path.join(completed.directory, "manifest.json"),
        manifestSha256: completed.digest,
      },
    });
    expect(
      (
        await retireCompletedUpdateRecoveryCaptures({
          env: state.env,
          apply: true,
          minimumAgeMs: 0,
        })
      ).retired,
    ).toEqual([]);

    // Only the external liveness observation changes; completion and custody use real owners.
    vi.spyOn(processInspection, "inspectUpdateRunDriver").mockReturnValue("dead");
    const result = await retireCompletedUpdateRecoveryCaptures({
      env: state.env,
      apply: true,
      minimumAgeMs: 0,
    });
    expect(result.retired, JSON.stringify(result)).toEqual([completed.directory]);
    expect(result.protected).toEqual([
      { path: unfinished.directory, reason: expect.stringContaining("completion is unverified") },
    ]);
    await expect(fs.lstat(completed.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(unfinished.directory)).isDirectory()).toBe(true);
  });
});

it.each(["running-history", "native-owner", "pending-recovery", "maintenance-owner"] as const)(
  "retains successful originals while %s owns unfinished work",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { capture, databasePath } = await fixture(state);
      const original = await capture();
      const store = createManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: state.env,
      });
      const lease =
        kind === "native-owner"
          ? store.acquire(state.root, "active-update", { kind: "update" })
          : undefined;
      const maintenance =
        kind === "maintenance-owner"
          ? acquireGatewayStateOwner({
              databasePath: resolveOpenClawStateSqlitePath(state.env),
              payload: {
                pid: process.pid,
                createdAt: new Date().toISOString(),
                configPath: state.configPath,
                stateDir: state.stateDir,
                role: "sqlite-maintenance",
              },
            })
          : undefined;
      if (kind === "running-history") {
        await capture("running");
      } else if (kind === "pending-recovery") {
        const from = { root: state.root, nodePath: process.execPath, version: "1", buildId: "old" };
        createRetainedUpdateRecovery(
          { runId: randomUUID(), from, to: { ...from, version: "2", buildId: "new" } },
          { env: state.env },
        );
      }
      try {
        for (const apply of [false, true]) {
          const result = await retireCompletedUpdateRecoveryCaptures({
            env: state.env,
            apply,
            minimumAgeMs: 0,
          });
          expect(result.eligible).toEqual([]);
          expect(result.retired).toEqual([]);
          expect(result.protected).toContainEqual({
            path: original.directory,
            reason: expect.any(String),
          });
        }
        expect(
          await fs.readFile(path.join(original.directory, "payload", "original.txt"), "utf8"),
        ).toBe("synthetic original");
      } finally {
        maintenance?.release();
        if (lease?.kind === "acquired") {
          expect(store.release(lease.lease)).toBe(true);
        }
      }
    });
  },
);
