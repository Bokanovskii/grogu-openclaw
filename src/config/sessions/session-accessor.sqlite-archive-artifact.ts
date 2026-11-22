// Archive artifact bytes and publication; no session lifecycle or database orchestration.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as createFsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import type { DirEntry } from "@openclaw/fs-safe/types";
import { syncDirectoryBestEffortSync } from "../../infra/directory-durability.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";
import {
  formatSessionArchiveTimestamp,
  isSessionArchiveArtifactName,
  type SessionArchiveReason,
} from "./artifacts.js";

export const MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_RESIDUE_ROOTS = 128;
const MAX_ARCHIVE_RESIDUE_ENTRIES_PER_ROOT = 512;
const MAX_ARCHIVE_RESIDUE_ENTRIES = 8192;

type ArchiveResidueEntryKind = "file" | "directory" | "symlink" | "other";

export type SqliteTranscriptArchiveResidueReport = {
  writerQuiescence: "not-established";
  candidates: Array<{
    root: string;
    name: string;
    status: "unknown";
    metadata?: {
      kind: ArchiveResidueEntryKind;
      sizeBytes: number;
      modifiedAtMs: number;
    };
  }>;
  aliases: Array<{
    root: string;
    physicalRoot: string;
    reason: "resolved-path" | "duplicate-physical-root";
    aliasOf?: string;
  }>;
  races: Array<{
    root: string;
    name?: string;
    operation: "root-identity" | "directory-enumeration";
    code?: string;
  }>;
  errors: Array<{
    root: string;
    operation: "resolve" | "open" | "read" | "stat";
    code?: string;
  }>;
  truncations: Array<{
    root?: string;
    limit: "root-count" | "entries-per-root" | "total-entries";
  }>;
  scannedEntries: number;
};

function isArchiveResidueCandidateName(name: string): boolean {
  return (
    name.endsWith(".jsonl-stage") ||
    name.endsWith(".stage") ||
    name.endsWith(".tmp") ||
    name.endsWith(".tmp.zst")
  );
}

function archiveResidueEntryKind(entry: DirEntry): ArchiveResidueEntryKind {
  if (entry.isSymbolicLink) {
    return "symlink";
  }
  if (entry.isFile) {
    return "file";
  }
  if (entry.isDirectory) {
    return "directory";
  }
  return "other";
}

function archiveResidueErrorCode(error: unknown): string | undefined {
  if (error instanceof FsSafeError) {
    return error.code;
  }
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isArchiveResidueEntryRace(error: unknown): boolean {
  const code = archiveResidueErrorCode(error);
  return (
    code === "path-mismatch" ||
    code === "not-found" ||
    code === "symlink" ||
    code === "ENOENT" ||
    code === "ENOTDIR"
  );
}

/**
 * Observe possible stage metadata without reading contents or assigning ownership.
 * Roots must come from configured session-store paths; cold roots are supplied separately.
 */
export async function inspectSqliteTranscriptArchiveResidue(
  configuredRoots: readonly string[],
): Promise<SqliteTranscriptArchiveResidueReport> {
  const report: SqliteTranscriptArchiveResidueReport = {
    writerQuiescence: "not-established",
    candidates: [],
    aliases: [],
    races: [],
    errors: [],
    truncations: [],
    scannedEntries: 0,
  };
  const physicalRoots = new Map<string, string>();
  const roots = configuredRoots.slice(0, MAX_ARCHIVE_RESIDUE_ROOTS);
  if (configuredRoots.length > roots.length) {
    report.truncations.push({ limit: "root-count" });
  }

  for (const configuredRoot of roots) {
    if (!path.isAbsolute(configuredRoot)) {
      report.errors.push({ root: configuredRoot, operation: "resolve", code: "EINVAL" });
      continue;
    }
    const root = path.resolve(configuredRoot);
    let safeRoot: Root;
    try {
      safeRoot = await createFsSafeRoot(root, {
        mkdir: false,
        symlinks: "reject",
      });
    } catch (error) {
      report.errors.push({ root, operation: "open", code: archiveResidueErrorCode(error) });
      continue;
    }
    const physicalRoot = safeRoot.rootReal;
    let rootStat: Awaited<ReturnType<Root["stat"]>>;
    try {
      rootStat = await safeRoot.stat(".");
    } catch (error) {
      if (isArchiveResidueEntryRace(error)) {
        report.races.push({
          root,
          operation: "root-identity",
          code: archiveResidueErrorCode(error),
        });
      } else {
        report.errors.push({ root, operation: "stat", code: archiveResidueErrorCode(error) });
      }
      continue;
    }

    if (!rootStat.isDirectory || rootStat.dev === 0 || rootStat.ino === 0) {
      report.errors.push({ root, operation: "stat", code: "IDENTITY_UNAVAILABLE" });
      continue;
    }
    const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
    const priorRoot = physicalRoots.get(rootIdentity);
    if (priorRoot) {
      report.aliases.push({
        root,
        physicalRoot,
        reason: "duplicate-physical-root",
        aliasOf: priorRoot,
      });
      continue;
    }
    if (root !== physicalRoot) {
      report.aliases.push({ root, physicalRoot, reason: "resolved-path" });
    }
    physicalRoots.set(rootIdentity, root);

    const remainingEntries = MAX_ARCHIVE_RESIDUE_ENTRIES - report.scannedEntries;
    const maxEntries = Math.min(MAX_ARCHIVE_RESIDUE_ENTRIES_PER_ROOT, remainingEntries);
    const truncationLimit =
      remainingEntries <= MAX_ARCHIVE_RESIDUE_ENTRIES_PER_ROOT
        ? "total-entries"
        : "entries-per-root";
    try {
      for await (const entry of safeRoot.entries(".", {
        maxEntries,
        order: "filesystem",
        symlinks: "reject",
      })) {
        report.scannedEntries += 1;
        if (isArchiveResidueCandidateName(entry.name)) {
          report.candidates.push({
            root,
            name: entry.name,
            status: "unknown",
            metadata: {
              kind: archiveResidueEntryKind(entry),
              sizeBytes: entry.size,
              modifiedAtMs: entry.mtimeMs,
            },
          });
        }
      }
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "too-large") {
        report.truncations.push({ root, limit: truncationLimit });
      } else if (isArchiveResidueEntryRace(error)) {
        report.races.push({
          root,
          operation: "directory-enumeration",
          code: archiveResidueErrorCode(error),
        });
      } else {
        report.errors.push({ root, operation: "read", code: archiveResidueErrorCode(error) });
      }
    }
  }

  report.candidates.sort(
    (left, right) => left.root.localeCompare(right.root) || left.name.localeCompare(right.name),
  );
  return report;
}

// Leave room under the 255-byte component limit for timestamps, generations,
// compression suffixes, and staging UUIDs. Raising this can break publication.
const MAX_REGISTERED_ARCHIVE_SESSION_ID_BYTES = 96;

function resolveRegisteredArchiveSessionIdComponent(sessionId: string): string {
  if (Buffer.byteLength(sessionId, "utf8") <= MAX_REGISTERED_ARCHIVE_SESSION_ID_BYTES) {
    return sessionId;
  }
  return `session-${createHash("sha256").update(sessionId).digest("hex")}`;
}

export function resolveSqliteTranscriptArchivePath(params: {
  archiveDirectory: string;
  generation?: string;
  identityOwner: "filename" | "registry";
  reason: SessionArchiveReason;
  sessionId: string;
  nowMs?: number;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const generationSuffix = params.generation ? `.${params.generation}` : "";
  const sessionIdComponent =
    params.identityOwner === "registry"
      ? resolveRegisteredArchiveSessionIdComponent(params.sessionId)
      : params.sessionId;
  const archivePath = path.resolve(
    archiveDirectory,
    `${sessionIdComponent}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(params.nowMs)}${generationSuffix}`,
  );
  if (path.dirname(archivePath) !== archiveDirectory) {
    throw new Error(`Cannot archive SQLite transcript outside ${archiveDirectory}`);
  }
  return archivePath;
}

export function resolveRegisteredSqliteTranscriptArchiveName(params: {
  createdAt: number;
  encoding: "identity" | "zstd";
  generation: string;
  reason: SessionArchiveReason;
  sessionId: string;
}): string {
  return path.basename(
    `${resolveSqliteTranscriptArchivePath({
      archiveDirectory: ".",
      generation: params.generation,
      identityOwner: "registry",
      reason: params.reason,
      sessionId: params.sessionId,
      nowMs: params.createdAt,
    })}${params.encoding === "zstd" ? SESSION_ARCHIVE_ZSTD_SUFFIX : ""}`,
  );
}

function findMatchingSqliteTranscriptArchive(
  params: Parameters<typeof writeTranscriptArchive>[0],
): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(params.archiveDirectory);
  } catch {
    return null;
  }
  const prefix = `${params.sessionId}.jsonl.${params.reason}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !isSessionArchiveArtifactName(entry)) {
      continue;
    }
    const archivePath = path.join(params.archiveDirectory, entry);
    const compressed = entry.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
    try {
      const stat = fs.statSync(archivePath);
      if (!stat.isFile()) {
        continue;
      }
      if (!compressed && stat.size !== Buffer.byteLength(params.content, "utf8")) {
        continue;
      }
      if (readSessionArchiveContentSync(archivePath) === params.content) {
        return archivePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Writes or reuses a transcript archive and returns its durable path. */
export function writeTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: SessionArchiveReason;
  sessionId: string;
}): string {
  fs.mkdirSync(params.archiveDirectory, { recursive: true });
  const existing = findMatchingSqliteTranscriptArchive(params);
  if (existing) {
    return existing;
  }
  // Archives are the long-lived cold tier; compress when the runtime can so
  // keep-forever retention stays cheap. Plain JSONL is the Bun/older fallback.
  const encoded = encodeSessionArchiveContent(params.content);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const archivePath = `${resolveSqliteTranscriptArchivePath({
      archiveDirectory: params.archiveDirectory,
      identityOwner: "filename",
      reason: params.reason,
      sessionId: params.sessionId,
      nowMs: Date.now() + attempt,
    })}${encoded.suffix}`;
    if (fs.existsSync(archivePath)) {
      continue;
    }
    const tempPath = `${archivePath}.${randomUUID()}.tmp`;
    try {
      writeDurableFileExclusive(tempPath, encoded.bytes);
      fs.renameSync(tempPath, archivePath);
      syncDirectoryBestEffortSync(params.archiveDirectory);
      // Full readback is bounded by the same single-generation content held by
      // this Worker (Node string limits cap both); a partial
      // or corrupt archive must fail here, before any rows are reclaimed.
      if (readSessionArchiveContentSync(archivePath) !== params.content) {
        fs.rmSync(archivePath, { force: true });
        throw new Error(`SQLite transcript archive verification failed for ${params.sessionId}`);
      }
      return archivePath;
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if (hasErrnoCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not create SQLite transcript archive for ${params.sessionId}`);
}

// Windows rejects fsync on read-only handles, so keep the exclusive writable
// descriptor open through both the write and durability boundary.
function writeDurableFileExclusive(filePath: string, content: Buffer): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw error;
  }
}

export function hashSessionArchiveBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Publishes one exact canonical archive without directory scans or replacement. */
export function publishEncodedSessionTranscriptArchive(params: {
  archiveDirectory: string;
  archiveName: string;
  bytes: Uint8Array;
  sha256: string;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(archiveDirectory, params.archiveName);
  if (
    path.dirname(archivePath) !== archiveDirectory ||
    path.basename(archivePath) !== params.archiveName
  ) {
    throw new Error(`Cannot publish SQLite transcript archive outside ${archiveDirectory}`);
  }
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(archivePath)) {
    if (hashSessionArchiveBytes(fs.readFileSync(archivePath)) !== params.sha256) {
      throw new Error(`SQLite transcript archive collision for ${params.archiveName}`);
    }
    return archivePath;
  }

  const tempPath = `${archivePath}.${randomUUID()}.tmp`;
  writeDurableFileExclusive(tempPath, Buffer.from(params.bytes));
  try {
    fs.linkSync(tempPath, archivePath);
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  syncDirectoryBestEffortSync(archiveDirectory);
  if (hashSessionArchiveBytes(fs.readFileSync(archivePath)) !== params.sha256) {
    throw new Error(`SQLite transcript archive verification failed for ${params.archiveName}`);
  }
  return archivePath;
}
