import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TransientSessionLifetime } from "./types.js";

/** Cleanup fact only: it selects non-archiving deletion and never grants execution authority. */
export function readSessionTransientLifetime(value: unknown): TransientSessionLifetime | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const lifetime = value.transientLifetime;
  if (
    !isRecord(lifetime) ||
    value.incognito === true ||
    lifetime.kind !== "request" ||
    typeof lifetime.parentSessionKey !== "string" ||
    typeof lifetime.parentSessionId !== "string" ||
    typeof lifetime.profileId !== "string" ||
    !lifetime.parentSessionKey ||
    !lifetime.parentSessionId ||
    !lifetime.profileId
  ) {
    return undefined;
  }
  return {
    kind: "request",
    parentSessionKey: lifetime.parentSessionKey,
    parentSessionId: lifetime.parentSessionId,
    profileId: lifetime.profileId,
  };
}
