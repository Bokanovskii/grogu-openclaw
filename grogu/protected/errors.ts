import { type FailoverError, isFailoverError } from "../../src/agents/failover/error.js";

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

export const providerTimeout = () =>
  new ProtectedError(
    504,
    "provider_timeout",
    "The model took too long to answer. Send again, or ask for a shorter reply.",
  );

// Codes stay outside 401/409/412 so clients never read a provider failure as a session or chat
// conflict. Client copy treats rate_limit and plan_limit codes as personal plan limits.
function providerFailure({ reason, provider }: FailoverError): ProtectedError {
  const sparky = provider === "sparky";
  switch (reason) {
    case "rate_limit":
    case "overloaded":
      return sparky || reason === "overloaded"
        ? new ProtectedError(
            503,
            "provider_busy",
            sparky
              ? "Sparky is busy with other work. Wait a minute, then send again."
              : "The model service is busy. Wait a minute, then send again.",
          )
        : new ProtectedError(
            429,
            "rate_limit",
            "The model account reached its rate limit. Wait, then send again.",
          );
    case "timeout":
      return providerTimeout();
    case "auth":
    case "auth_permanent":
    case "session_expired":
      return new ProtectedError(
        502,
        "provider_rejected",
        sparky
          ? "Sparky Labs did not accept the Alcove service key. Choose another model, or ask the owner to check Sparky."
          : "The model account did not accept this request. Reconnect this provider.",
      );
    case "billing":
      return new ProtectedError(
        402,
        "plan_limit",
        "The model account has no usage left. Check the account plan, or choose another model.",
      );
    case "context_overflow":
      return new ProtectedError(
        413,
        "chat_too_long",
        "This chat is too long for the model. Start a new chat.",
      );
    case "model_not_found":
      return new ProtectedError(422, "model_unavailable", "This model is not available.");
    default:
      return new ProtectedError(
        502,
        "provider_failed",
        "The model could not answer. Send again, or choose another model.",
      );
  }
}

export function publicError(error: unknown): ProtectedError {
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause);) {
    seen.add(cause);
    if (isFailoverError(cause)) {
      return providerFailure(cause);
    }
    if (
      ("code" in cause &&
        (cause.code === "ENOSPC" || cause.code === "EDQUOT" || cause.code === "SQLITE_FULL")) ||
      ("errcode" in cause && typeof cause.errcode === "number" && (cause.errcode & 255) === 13)
    ) {
      return new ProtectedError(
        507,
        "storage_full",
        "Alcove could not save because storage is full.",
      );
    }
    if ("code" in cause && cause.code === "too-large") {
      return new ProtectedError(413, "file_too_large", "A file exceeds the Alcove file limit.");
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return error instanceof ProtectedError
    ? error
    : new ProtectedError(500, "operation_failed", "The operation failed. Retry deliberately.");
}
