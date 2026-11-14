// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { CronJob } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { addCronJob, createInitialCronState, startCronEdit } from "./index.ts";

const friendlyFields = {
  displayName: "Explore your open questions",
  groupId: "research",
  description: "Find and check useful information.",
  notificationDescription: "A finding answers an open question.",
};
const job: CronJob = {
  id: "research",
  name: "research-worker",
  ...friendlyFields,
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  configRevision: "friendly-revision",
  schedule: { kind: "every", everyMs: 1_800_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Research the open questions." },
  state: {},
};

function harness() {
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "cron.add" || method === "cron.update" || method === "cron.get") {
      return job;
    }
    if (method === "cron.list") {
      return {
        jobs: [job],
        groups: [],
        snapshotRevision: "friendly-list",
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      };
    }
    return { enabled: true, jobs: 1 };
  });
  const state = createInitialCronState({
    client: createTestGatewayClient(request),
    connected: true,
  });
  return { request, state };
}

it("saves friendly automation fields and a group through the Gateway contract", async () => {
  const { request, state } = harness();
  Object.assign(state.cronForm, friendlyFields, {
    name: job.name,
    payloadText: "Research the open questions.",
  });
  await addCronJob(state);
  const params = request.mock.calls.find(([method]) => method === "cron.add")?.[1];
  expect(params).toMatchObject(friendlyFields);
  expect(validateCronAddParams(params)).toBe(true);
});

it("hydrates friendly fields and clears them explicitly when the owner removes them", async () => {
  const { request, state } = harness();
  state.cronJobs = [job];
  startCronEdit(state, job);
  expect(state.cronForm).toMatchObject(friendlyFields);
  state.cronForm.displayName = "";
  state.cronForm.groupId = "";
  state.cronForm.description = "";
  state.cronForm.notificationDescription = "";
  await addCronJob(state);
  const params = request.mock.calls.find(([method]) => method === "cron.update")?.[1];
  expect(params).toMatchObject({
    patch: { displayName: null, groupId: null, description: "", notificationDescription: null },
  });
  expect(validateCronUpdateParams(params)).toBe(true);
});
