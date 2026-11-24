import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ProtectedError } from "../errors.js";
import { isBrowserHandoffInput, type BrowserHandoffControl } from "./handoff.js";

const headers = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
};
const invalid = () =>
  new ProtectedError(400, "invalid_request", "Invalid browser control request.");
const conflict = () =>
  new ProtectedError(409, "handoff_conflict", "The browser view changed. Take control again.");

/** The caller owns member, login-session, chat and run admission; this adapter never logs bodies. */
export async function browserHandoffResponse(input: {
  request: Request;
  action: string;
  control: BrowserHandoffControl;
  readBody: () => Promise<Record<string, unknown>>;
  revalidate: () => Promise<void>;
}): Promise<Response> {
  const { request, action, control, readBody, revalidate } = input;
  const controller = request.headers.get("x-alcove-browser-controller") ?? "";
  const empty = () => new Response(null, { status: 204, headers });
  if (action === "frame" && request.method === "GET") {
    await revalidate();
    const frame = await control.frame(controller);
    await revalidate();
    if (frame === "conflict") {
      throw conflict();
    }
    return new Response(new Uint8Array(frame.image), {
      headers: {
        ...headers,
        "content-type": "image/jpeg",
        "x-alcove-browser-origin": frame.origin,
        "x-alcove-browser-sequence": String(frame.sequence),
        "x-alcove-browser-field": frame.field,
      },
    });
  }
  if (request.method !== "POST") {
    throw new ProtectedError(404, "not_found", "Not found.");
  }
  const data = await readBody();
  if (!isRecord(data) || typeof data.origin !== "string" || data.origin.length > 300) {
    throw invalid();
  }
  const { origin, ...fields } = data;
  if (action !== "input" && Object.keys(fields).length !== 0) {
    throw invalid();
  }
  await revalidate();
  if (action === "claim") {
    const claim = await control.claim(origin);
    await revalidate();
    if (claim === "conflict") {
      throw conflict();
    }
    return Response.json(claim, { headers });
  }
  if (action === "return" || action === "cancel") {
    const result =
      action === "return"
        ? await control.finish(controller, origin)
        : await control.cancel(controller, origin);
    if (result === "conflict") {
      throw conflict();
    }
    return empty();
  }
  if (action !== "input" || !isBrowserHandoffInput(fields)) {
    throw invalid();
  }
  const outcome = await control.input(controller, origin, fields);
  if (outcome === "conflict") {
    throw conflict();
  }
  if (outcome === "declined") {
    throw new ProtectedError(422, "handoff_declined", "That part of the page cannot be used here.");
  }
  return empty();
}
