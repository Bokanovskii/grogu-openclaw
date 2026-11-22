import { Value } from "typebox/value";
import {
  ProtectedShareKindSchema,
  ProtectedShareCreateRequestSchema,
  type ProtectedShareCreateRequest,
} from "../../packages/gateway-protocol/src/protected-shares.js";
import type {
  ProtectedShareAuthority,
  ProtectedShareStorageAuthority,
} from "../../src/state/protected-share-operations.js";
import {
  isProtectedShareRouteId,
  type ProtectedShareKind,
  type ProtectedShareSnapshot,
} from "../../src/state/protected-shares.js";
import { ProtectedError } from "./errors.js";
import {
  createProtectedShare,
  listProtectedShares,
  readProtectedShare,
  revokeProtectedShare,
} from "./shares-store.js";

const commonHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: commonHeaders });
}

function notFound(): never {
  throw new ProtectedError(404, "not_found", "Not found.");
}

function invalid(): never {
  throw new ProtectedError(400, "invalid_request", "The request is invalid.");
}

export async function handleProtectedSharesHttp(options: {
  pathname: string;
  method: string;
  request: Request;
  profileId: string;
  identityKind: "human" | "development";
  stateDir: string;
  authority: ProtectedShareAuthority;
  storageAuthority: ProtectedShareStorageAuthority;
  revalidate: () => Promise<void>;
  isVerifiedHumanDirectoryRecipient: (profileId: string) => Promise<boolean>;
  parseBody: (request: Request) => Promise<Record<string, unknown>>;
  readSnapshot: (kind: ProtectedShareKind, routeId: string) => Promise<ProtectedShareSnapshot>;
}): Promise<Response | undefined> {
  const { pathname, method } = options;
  const isList =
    (pathname === "/shares" && method === "GET") ||
    (pathname === "/shared-with-you" && method === "GET");
  const isCreate = pathname === "/shares" && method === "POST";
  const isRead = pathname === "/shares/content" && method === "GET";
  const revokeMatch = /^\/shares\/([0-9a-f-]{36})$/u.exec(pathname);
  const isRevoke = revokeMatch !== null && method === "DELETE";
  if (!isList && !isCreate && !isRead && !isRevoke) {
    return undefined;
  }
  if (options.identityKind !== "human") {
    return notFound();
  }
  if (options.profileId !== options.authority.profileId) {
    throw new Error("Protected share handler does not match the current member.");
  }

  if (isList) {
    await options.revalidate();
    const relation = pathname === "/shares" ? "owner" : "recipient";
    const shares = await listProtectedShares(
      options.stateDir,
      { profileId: options.profileId, relation },
      options.authority,
    );
    await options.revalidate();
    return json({ shares });
  }

  if (isCreate) {
    const body = await options.parseBody(options.request);
    let input: ProtectedShareCreateRequest;
    try {
      input = Value.Parse(ProtectedShareCreateRequestSchema, body);
    } catch {
      return invalid();
    }
    const recipientProfileIds = input.recipientProfileIds;
    if (
      !isProtectedShareRouteId(input.routeId) ||
      recipientProfileIds.some((profileId) => profileId === options.profileId)
    ) {
      return invalid();
    }
    await options.revalidate();
    const verifiedHumanRecipients = await Promise.all(
      recipientProfileIds.map((profileId) => options.isVerifiedHumanDirectoryRecipient(profileId)),
    );
    await options.revalidate();
    if (verifiedHumanRecipients.some((verified) => !verified)) {
      return notFound();
    }
    const snapshot = await options.readSnapshot(input.kind, input.routeId);
    await options.revalidate();
    const result = await createProtectedShare(
      options.stateDir,
      {
        kind: input.kind,
        routeId: input.routeId,
        recipientProfileIds,
        snapshot,
        now: Date.now(),
      },
      options.storageAuthority,
    );
    if (result.status !== "created") {
      if (result.status === "route_conflict") {
        throw new ProtectedError(409, "share_conflict", "This item cannot be shared.");
      }
      if (result.status === "member_inactive" || result.status === "recipient_inactive") {
        return notFound();
      }
      throw new ProtectedError(409, "share_unchanged", "No new share was created.");
    }
    await options.revalidate();
    return json(
      { resourceId: result.resourceId, routeId: input.routeId, grants: result.grants },
      201,
    );
  }

  if (isRead) {
    const url = new URL(options.request.url);
    const kind = url.searchParams.get("kind");
    const routeId = url.searchParams.get("routeId");
    if (
      !Value.Check(ProtectedShareKindSchema, kind) ||
      routeId === null ||
      !isProtectedShareRouteId(routeId)
    ) {
      return invalid();
    }
    await options.revalidate();
    const result = await readProtectedShare(
      options.stateDir,
      { profileId: options.profileId, kind, routeId },
      options.authority,
    );
    if (!result) {
      return notFound();
    }
    await options.revalidate();
    return json(result);
  }

  await options.revalidate();
  const grantId = revokeMatch?.[1];
  if (!grantId) {
    return undefined;
  }
  const retired = await revokeProtectedShare(
    options.stateDir,
    { ownerProfileId: options.profileId, grantId },
    options.storageAuthority,
  );
  if (retired === undefined || retired === "member_inactive") {
    return notFound();
  }
  await options.revalidate();
  return new Response(null, { status: 204, headers: commonHeaders });
}
