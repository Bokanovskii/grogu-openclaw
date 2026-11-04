import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ResearchCheckpointBinding = Readonly<{
  workspace: string;
  tracks: readonly string[];
  artifactPrefix?: string;
}>;

export type GroguPrivateProfile = Readonly<{
  schemaVersion: 1;
  bindings: Readonly<{ researchCheckpoint?: ResearchCheckpointBinding }>;
}>;

function invalid(): never {
  throw new Error(
    "Invalid Grogu private profile. Use a protected schemaVersion:1 JSON profile with valid runtime bindings.",
  );
}

export function isSafeResearchArtifactPrefix(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    value === value.trim() &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("~") &&
    !/^[a-zA-Z][\w+.-]*:/.test(value) &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    value
      .replace(/\/$/, "")
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** This is a configuration artifact contract, not an additional runtime state store. */
export function parseGroguPrivateProfile(value: unknown): GroguPrivateProfile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.bindings)) {
    invalid();
  }
  const binding = value.bindings.researchCheckpoint;
  if (binding === undefined) {
    return Object.freeze({ schemaVersion: 1, bindings: Object.freeze({}) });
  }
  if (
    !isRecord(binding) ||
    typeof binding.workspace !== "string" ||
    !path.isAbsolute(binding.workspace) ||
    binding.workspace.includes("\0") ||
    binding.workspace !== binding.workspace.trim() ||
    !Array.isArray(binding.tracks) ||
    binding.tracks.length === 0 ||
    binding.tracks.some(
      (track: unknown) => typeof track !== "string" || !track.trim() || track !== track.trim(),
    ) ||
    new Set(binding.tracks).size !== binding.tracks.length ||
    (binding.artifactPrefix !== undefined && !isSafeResearchArtifactPrefix(binding.artifactPrefix))
  ) {
    invalid();
  }
  const researchCheckpoint: ResearchCheckpointBinding = Object.freeze({
    workspace: path.resolve(binding.workspace),
    tracks: Object.freeze([...binding.tracks] as string[]),
    ...(binding.artifactPrefix === undefined
      ? {}
      : { artifactPrefix: binding.artifactPrefix as string }),
  });
  return Object.freeze({ schemaVersion: 1, bindings: Object.freeze({ researchCheckpoint }) });
}

const admittedProfiles = new Map<string, GroguPrivateProfile>();
const admittedDocuments = new Map<string, Record<string, unknown>>();

/** A selected path is one process/profile generation; no file freshness polling in hot paths. */
export function readGroguPrivateProfileDocument(
  profileFile = process.env.GROGU_PROFILE_FILE,
): Record<string, unknown> | undefined {
  if (profileFile === undefined) {
    return undefined;
  }
  if (
    !profileFile ||
    !path.isAbsolute(profileFile) ||
    profileFile !== profileFile.trim() ||
    profileFile.includes("\0")
  ) {
    invalid();
  }
  const file = path.resolve(profileFile);
  const cached = admittedDocuments.get(file);
  if (cached) {
    return cached;
  }
  let descriptor: number | undefined;
  try {
    if (fs.realpathSync(file) !== file) {
      invalid();
    }
    const parent = fs.lstatSync(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) {
      invalid();
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 1_048_576 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    ) {
      invalid();
    }
    const content = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(content) > 1_048_576) {
      invalid();
    }
    const document: unknown = JSON.parse(content);
    if (!isRecord(document) || document.schemaVersion !== 1) {
      invalid();
    }
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) {
          freeze(child);
        }
        Object.freeze(value);
      }
    };
    freeze(document);
    admittedDocuments.set(file, document);
    return document;
  } catch (error) {
    throw new Error(
      "Cannot admit GROGU_PROFILE_FILE. It must be an existing, owner-only regular JSON file without symlinks or hardlinks and no larger than 1 MiB.",
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function loadGroguPrivateProfile(
  profileFile = process.env.GROGU_PROFILE_FILE,
): GroguPrivateProfile | undefined {
  const document = readGroguPrivateProfileDocument(profileFile);
  if (!document || !profileFile) {
    return undefined;
  }
  const file = path.resolve(profileFile);
  const existing = admittedProfiles.get(file);
  if (existing) {
    return existing;
  }
  const profile = parseGroguPrivateProfile(document);
  admittedProfiles.set(file, profile);
  return profile;
}
