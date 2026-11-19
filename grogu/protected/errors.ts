export class ProtectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function unavailable(message: string): never {
  throw new ProtectedError(503, "unavailable", message);
}

export function publicError(error: unknown): ProtectedError {
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause);) {
    seen.add(cause);
    if (
      ("code" in cause &&
        (cause.code === "ENOSPC" || cause.code === "EDQUOT" || cause.code === "SQLITE_FULL")) ||
      ("errcode" in cause && typeof cause.errcode === "number" && (cause.errcode & 255) === 13)
    ) {
      return new ProtectedError(
        507,
        "storage_full",
        "Family could not save because storage is full.",
      );
    }
    if ("code" in cause && cause.code === "too-large") {
      return new ProtectedError(413, "file_too_large", "A file exceeds the Family file limit.");
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return error instanceof ProtectedError
    ? error
    : new ProtectedError(500, "operation_failed", "The operation failed. Retry deliberately.");
}
