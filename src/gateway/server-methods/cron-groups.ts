import {
  validateCronGroupsDeleteParams,
  validateCronGroupsListParams,
  validateCronGroupsUpsertParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { deleteCronGroup, listCronGroups, upsertCronGroup } from "../../cron/groups.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { assertCronReadCurrent, respondInvalidCronParams } from "./cron-job-access.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronGroupHandlers: GatewayRequestHandlers = {
  "cron.groups.list": async (opts) => {
    const { params, respond } = opts;
    if (!assertValidParams(params, validateCronGroupsListParams, "cron.groups.list", respond)) {
      return;
    }
    const groups = await listCronGroups();
    assertCronReadCurrent(opts);
    respond(true, { groups }, undefined);
  },
  "cron.groups.upsert": async (opts) => {
    const { params, respond } = opts;
    if (!assertValidParams(params, validateCronGroupsUpsertParams, "cron.groups.upsert", respond)) {
      return;
    }
    try {
      const groups = await upsertCronGroup(params.group, () => assertCronReadCurrent(opts));
      assertCronReadCurrent(opts);
      respond(true, { groups }, undefined);
    } catch (error) {
      respondInvalidCronParams(respond, "cron.groups.upsert", formatErrorMessage(error));
    }
  },
  "cron.groups.delete": async (opts) => {
    const { params, respond } = opts;
    if (!assertValidParams(params, validateCronGroupsDeleteParams, "cron.groups.delete", respond)) {
      return;
    }
    const groups = await deleteCronGroup(params.id, () => assertCronReadCurrent(opts));
    assertCronReadCurrent(opts);
    respond(true, { groups }, undefined);
  },
};
