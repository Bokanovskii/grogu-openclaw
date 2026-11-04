import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import {
  loadGroguPrivateProfile,
  type ResearchCheckpointBinding,
} from "./grogu-private-profile.js";

export class ResearchCheckpointValidationError extends Error {
  constructor(
    detail: string,
    readonly code = "RESEARCH_CHECKPOINT_INVALID_SCHEMA",
  ) {
    super(
      `Critical research checkpoint rejected: ${detail}. Nothing was written. Re-read continuous-state.json and submit a complete valid checkpoint; save its referenced report first.`,
    );
    this.name = "ResearchCheckpointValidationError";
  }
}

function invalid(detail: string, code?: string): never {
  throw new ResearchCheckpointValidationError(detail, code);
}

export function researchCheckpointArtifactPath(
  value: unknown,
  binding: ResearchCheckpointBinding,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 4_096 ||
    value.startsWith("~") ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^[a-zA-Z][\w+.-]*:/.test(value) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    invalid(
      "artifact reference must be a relative research-workspace path",
      "RESEARCH_CHECKPOINT_UNSAFE_ARTIFACT",
    );
  }
  const prefix = binding.artifactPrefix?.replace(/\/?$/, "/");
  const relative = path.posix.normalize(
    prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value,
  );
  if (
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative === "continuous-state.json"
  ) {
    invalid(
      "artifact reference must remain inside the research workspace and cannot name the checkpoint",
      "RESEARCH_CHECKPOINT_UNSAFE_ARTIFACT",
    );
  }
  return relative;
}

export function assertResearchCheckpointValue(
  value: unknown,
  binding: ResearchCheckpointBinding,
): asserts value is Record<string, unknown> {
  const tracks = new Set(binding.tracks);
  if (!isRecord(value)) {
    invalid("JSON root must be an object");
  }
  if (value.version !== 1) {
    invalid("version must be 1");
  }
  if (
    typeof value.completedSlices !== "number" ||
    !Number.isSafeInteger(value.completedSlices) ||
    value.completedSlices < 0
  ) {
    invalid("completedSlices must be a non-negative safe integer");
  }
  if (
    typeof value.nextTrack !== "string" ||
    !tracks.has(value.nextTrack) ||
    (value.lastCompletedTrack != null &&
      (typeof value.lastCompletedTrack !== "string" || !tracks.has(value.lastCompletedTrack)))
  ) {
    invalid("progress tracks must name configured research tracks");
  }
  if (
    typeof value.updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    invalid("updatedAt must be an ISO timestamp");
  }
  if (
    value.tracks !== undefined &&
    (!Array.isArray(value.tracks) ||
      value.tracks.some((track: unknown) => typeof track !== "string" || !tracks.has(track)) ||
      new Set(value.tracks).size !== value.tracks.length)
  ) {
    invalid("tracks must contain distinct configured research tracks");
  }
  if (value.currentSlice != null) {
    if (
      !isRecord(value.currentSlice) ||
      (value.currentSlice.track !== undefined &&
        (typeof value.currentSlice.track !== "string" || !tracks.has(value.currentSlice.track))) ||
      (value.currentSlice.status !== undefined && typeof value.currentSlice.status !== "string")
    ) {
      invalid("currentSlice must be an object with a configured track and string status, or null");
    }
  }
  if (value.completedSlices > 0 && !value.lastArtifact) {
    invalid(
      "completed progress requires an artifact reference",
      "RESEARCH_CHECKPOINT_UNSAFE_ARTIFACT",
    );
  }
  if (value.lastArtifact != null) {
    researchCheckpointArtifactPath(value.lastArtifact, binding);
  }
}

/** Reuse native mutation identity, including sandbox mappings; do not match names or prefixes alone. */
export async function assertResearchCheckpointCandidate(params: {
  filePath: string;
  mutationKey: string;
  content: string;
  signal?: AbortSignal;
}): Promise<void> {
  const binding = loadGroguPrivateProfile()?.bindings.researchCheckpoint;
  if (!binding) {
    return;
  }
  const identity = params.mutationKey.slice(params.mutationKey.lastIndexOf("\0") + 1);
  if (
    path.basename(params.filePath) !== "continuous-state.json" &&
    path.basename(identity) !== "continuous-state.json"
  ) {
    return;
  }
  const checkpoint = path.join(binding.workspace, "continuous-state.json");
  const exactPath = path.resolve(params.filePath) === checkpoint;
  let checkpointIdentity: string;
  try {
    checkpointIdentity = resolveIdentityPathViaExistingAncestorSync(checkpoint);
  } catch (error) {
    if (exactPath) {
      throw error;
    }
    return;
  }
  if (!exactPath && identity !== checkpointIdentity) {
    return;
  }
  const assertCurrent = captureAgentToolSourceExecutionGuard(params.signal);
  assertCurrent();
  if (Buffer.byteLength(params.content, "utf8") > 1_048_576) {
    invalid("JSON checkpoint must be UTF-8 text no larger than 1 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(params.content);
  } catch {
    invalid("invalid JSON syntax", "RESEARCH_CHECKPOINT_INVALID_JSON");
  }
  assertResearchCheckpointValue(value, binding);
  if (value.lastArtifact != null) {
    const relative = researchCheckpointArtifactPath(value.lastArtifact, binding);
    let opened: Awaited<ReturnType<Awaited<ReturnType<typeof root>>["open"]>> | undefined;
    try {
      opened = await (
        await root(binding.workspace)
      ).open(relative, { symlinks: "reject", hardlinks: "reject" });
      assertCurrent();
      if (!opened.stat.isFile()) {
        invalid(
          "artifact reference must name a saved regular file",
          "RESEARCH_CHECKPOINT_UNSAFE_ARTIFACT",
        );
      }
    } catch (error) {
      assertCurrent();
      if (error instanceof ResearchCheckpointValidationError) {
        throw error;
      }
      invalid(
        "artifact reference is missing, unreadable, or outside its safe workspace boundary",
        "RESEARCH_CHECKPOINT_UNSAFE_ARTIFACT",
      );
    } finally {
      await opened?.handle.close();
    }
  }
  assertCurrent();
}
