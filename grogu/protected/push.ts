import { createHash } from "node:crypto";
import type { WebPushMutationGuard } from "../../src/infra/push-web-store.records.js";
import {
  clearBoundWebPushSubscription,
  hasBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  registerWebPushSubscription,
  resolveVapidKeys,
  withBoundWebPushSubscriptions,
} from "../../src/infra/push-web.js";
import { listProtectedAdmissions } from "./admission-store.js";

function deviceId(endpoint: string): string {
  return `alcove-${createHash("sha256").update(endpoint).digest("hex")}`;
}

function ownerGuard(profileId: string, assertCurrent: () => void): WebPushMutationGuard {
  return {
    family: "worker",
    profiles: { original: profileId, current: profileId },
    assertCurrent,
    assertProfiles: (facts) => {
      if (!facts.bindingCurrent || facts.profileId !== profileId) {
        throw new Error("Owner push authority changed.");
      }
    },
  };
}

export async function protectedPushPublicKey(stateDir: string, assertCurrent: () => void) {
  assertCurrent();
  const keys = await resolveVapidKeys(stateDir);
  assertCurrent();
  return keys.publicKey;
}

export async function subscribeProtectedPush(params: {
  stateDir: string;
  profileId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  const subscription = await registerWebPushSubscription({
    baseDir: params.stateDir,
    endpoint: params.endpoint,
    keys: params.keys,
    binding: { deviceId: deviceId(params.endpoint), userProfileId: params.profileId },
    guard: ownerGuard(params.profileId, params.assertCurrent),
  });
  params.assertCurrent();
  return subscription.subscriptionId;
}

export async function unsubscribeProtectedPush(params: {
  stateDir: string;
  profileId: string;
  endpoint: string;
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  const removed = await clearBoundWebPushSubscription({
    baseDir: params.stateDir,
    endpoint: params.endpoint,
    expectedDeviceId: deviceId(params.endpoint),
    expectedUserProfileId: params.profileId,
    guard: ownerGuard(params.profileId, params.assertCurrent),
  });
  params.assertCurrent();
  return removed;
}

async function notifyProtectedOwner(params: {
  stateDir: string;
  issuer: string;
  ownerSubject?: string;
  payload: { title?: string; body?: string; tag: string; url?: string };
}) {
  if (!params.ownerSubject || !(await hasBoundWebPushSubscriptions(params.stateDir))) {
    return;
  }
  const owner = (await listProtectedAdmissions(params.stateDir)).find(
    (person) =>
      person.issuer === params.issuer &&
      person.subject === params.ownerSubject &&
      person.status === "approved",
  );
  if (!owner?.profileId) {
    return;
  }
  const send = await prepareWebPushNotificationSender(params.stateDir);
  const results = await withBoundWebPushSubscriptions(
    params.stateDir,
    (subscriptions, assertCurrent) => {
      const targets = subscriptions.filter(
        (subscription) =>
          subscription.userProfileId === owner.profileId && subscription.devicePreferences.enabled,
      );
      if (targets.length === 0) {
        return undefined;
      }
      return {
        start: () => {
          assertCurrent();
          return send({
            subscriptions: targets,
            payload: params.payload,
            deliveryOptions: { TTL: 300, timeout: 10_000 },
          });
        },
      };
    },
  );
  if (
    results?.some((result) => !result.ok && result.statusCode !== 404 && result.statusCode !== 410)
  ) {
    throw new Error("Owner push delivery failed.");
  }
}

export function notifyProtectedAccessRequest(params: {
  stateDir: string;
  issuer: string;
  ownerSubject?: string;
}) {
  return notifyProtectedOwner({
    ...params,
    payload: {
      title: "Alcove",
      body: "A request needs review.",
      tag: "access-request",
      url: "/settings/admin",
    },
  });
}

export function notifyProtectedIssueReport(params: {
  stateDir: string;
  issuer: string;
  ownerSubject?: string;
}) {
  return notifyProtectedOwner({
    ...params,
    payload: { tag: "issue-report" },
  });
}
