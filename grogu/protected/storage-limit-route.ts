import type { ProtectedStorageLimit } from "../../src/state/protected-storage-limits.js";
import { minimumUserLimitBytes, type StorageLimits } from "./capacity.js";
import { ProtectedError } from "./errors.js";

export type ProtectedStorageLimitView = {
  usedBytes: number | null;
  limitBytes: number | null;
  defaultLimitBytes: number;
  customLimitBytes: number | null;
  exempt: boolean;
  minLimitBytes: number;
  maxLimitBytes: number;
  version: string;
};

// The version is the stored override itself, so If-Match is a compare-and-set on it.
function storageLimitVersion(customLimitBytes: number | null) {
  return customLimitBytes === null ? "default" : `custom:${customLimitBytes}`;
}

export function parseStorageLimitVersion(header: string | null): number | null {
  if (header === null || !header.trim()) {
    throw new ProtectedError(428, "version_required", "Send the current version in If-Match.");
  }
  const version = header.trim().replace(/^"(.*)"$/u, "$1");
  if (version === "default") {
    return null;
  }
  const custom = /^custom:([1-9]\d{0,15})$/u.exec(version);
  if (!custom) {
    throw new ProtectedError(409, "version_conflict", "The storage limit changed. Reload it.");
  }
  return Number(custom[1]);
}

export function parseStorageLimitBytes(data: Record<string, unknown>, limits: StorageLimits) {
  const value = data.limitBytes;
  if (
    Object.keys(data).length !== 1 ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimumUserLimitBytes ||
    value > limits.globalBytes
  ) {
    throw new ProtectedError(
      400,
      "invalid_limit",
      `The storage limit must be a whole number of bytes from ${minimumUserLimitBytes} to ${limits.globalBytes}.`,
    );
  }
  return value;
}

export function storageLimitView(
  limit: ProtectedStorageLimit,
  limits: StorageLimits,
  usedBytes: number | null,
): ProtectedStorageLimitView {
  return {
    usedBytes,
    limitBytes: limit.exempt ? null : (limit.customLimitBytes ?? limits.userBytes),
    defaultLimitBytes: limits.userBytes,
    customLimitBytes: limit.customLimitBytes,
    exempt: limit.exempt,
    minLimitBytes: minimumUserLimitBytes,
    maxLimitBytes: limits.globalBytes,
    version: storageLimitVersion(limit.customLimitBytes),
  };
}
