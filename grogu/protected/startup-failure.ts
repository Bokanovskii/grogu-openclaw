import { extractErrorCode, readErrorCause, readErrorName } from "../../src/infra/errors.js";
import { redactSensitiveText } from "../../src/logging/redact.js";

const maxCauses = 4;
const maxFrames = 2;
const maxScannedChars = 16 * 1024;
const maxLineChars = 4_000;
// V8 JSON.parse errors quote the start of their input, which can be decrypted state or config.
const jsonInputSnippet = /(?:Unexpected token '[^]{1,2}', )?"[^]*?"(?:\.\.\.)? is not valid JSON/gu;

function clip(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clean(text: string, limit: number) {
  const scanned = text.slice(0, maxScannedChars);
  const withheld = scanned.includes(" is not valid JSON")
    ? scanned.replace(jsonInputSnippet, "input is not valid JSON (input withheld)")
    : scanned;
  // Redact before clipping so a cut never leaves part of a credential the patterns cannot match.
  const redacted = redactSensitiveText(withheld, { mode: "tools" });
  return clip(redacted.replace(/[\s\p{Cc}]+/gu, " ").trim(), limit);
}

function describeError(value: unknown) {
  if (!(value instanceof Error)) {
    return `non-Error ${value === null ? "null" : typeof value}`;
  }
  const className = clean(
    (typeof value.constructor === "function" && value.constructor.name) || "Error",
    64,
  );
  const name = clean(readErrorName(value), 64);
  const code = extractErrorCode(value);
  const message = typeof value.message === "string" ? value.message : "";
  // The stack header repeats the message; only the frames after it are added.
  const stack = typeof value.stack === "string" ? value.stack : "";
  const header = String(value);
  const frames = (stack.startsWith(header) ? stack.slice(header.length) : stack)
    .split("\n")
    .filter((line) => /^\s+at /u.test(line))
    .slice(0, maxFrames)
    .map((line) => clean(line, 200));
  return [
    className,
    name && name !== className ? ` (${name})` : "",
    code && /^[\w.:-]{1,64}$/u.test(code) ? ` [${code}]` : "",
    `: ${clean(message, 300) || "(no message)"}`,
    frames.length ? ` (${frames.join("; ")})` : "",
  ].join("");
}

/** One bounded, credential-redacted line naming each error in the cause chain. */
export function describeStartupFailure(error: unknown): string {
  const chain = [error];
  let next = readErrorCause(error);
  while (next != null && !chain.includes(next) && chain.length <= maxCauses) {
    chain.push(next);
    next = readErrorCause(next);
  }
  const omitted = next != null && !chain.includes(next) ? " <- further causes omitted" : "";
  return clip(
    `Startup failure: ${chain.map(describeError).join(" <- caused by ")}${omitted}`,
    maxLineChars,
  );
}
