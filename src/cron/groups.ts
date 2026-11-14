import { Value } from "typebox/value";
import { CronGroupSchema } from "../../packages/gateway-protocol/src/schema/cron.js";
import type { CronGroup } from "../../packages/gateway-protocol/src/schema/cron.types.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";

type CronGroupRegistry = { version: 1; groups: CronGroup[] };

const REGISTRY_KEY = "registry";
const registryStore = createCorePluginStateKeyedStore<CronGroupRegistry>({
  ownerId: "core:cron",
  namespace: "automation-groups",
  maxEntries: 1,
  overflowPolicy: "reject-new",
});

function validateGroup(group: unknown): asserts group is CronGroup {
  if (!Value.Check(CronGroupSchema, group)) {
    throw new Error("Invalid cron group registry data");
  }
}

function readRegistry(value: CronGroupRegistry | undefined): CronGroup[] {
  if (value === undefined) {
    return [];
  }
  if (
    typeof value !== "object" ||
    value === null ||
    value.version !== 1 ||
    !Array.isArray(value.groups)
  ) {
    throw new Error("Invalid cron group registry data");
  }
  for (const group of value.groups) {
    validateGroup(group);
  }
  return value.groups;
}

function sortGroups(groups: readonly CronGroup[]): CronGroup[] {
  return groups
    .map((group) => ({ ...group }))
    .toSorted(
      (left, right) =>
        (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    );
}

export async function listCronGroups(): Promise<CronGroup[]> {
  return sortGroups(readRegistry(await registryStore.lookup(REGISTRY_KEY)));
}

async function updateCronGroups(
  update: (groups: CronGroup[]) => CronGroup[],
  assertCurrent: () => void,
): Promise<CronGroup[]> {
  const store = registryStore.withCurrent({ assertCurrent });
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const observed = await store.observe(REGISTRY_KEY);
    const groups = readRegistry(observed.value);
    const next = update(groups);
    const result = await store.compareAndApply(REGISTRY_KEY, observed.comparison, {
      operation: "update",
      action: "set",
      value: { version: 1, groups: next },
    });
    if (result.status !== "conflict") {
      return sortGroups(next);
    }
  }
  throw new Error("Cron group registry changed too often; retry the update");
}

export async function upsertCronGroup(
  group: CronGroup,
  assertCurrent: () => void = () => {},
): Promise<CronGroup[]> {
  validateGroup(group);
  const clean = {
    id: group.id.trim(),
    label: group.label.trim(),
    ...(group.description === undefined ? {} : { description: group.description.trim() }),
    ...(group.order === undefined ? {} : { order: group.order }),
  };
  if (!clean.id || !clean.label) {
    throw new Error("Cron group id and label must not be blank");
  }
  return await updateCronGroups(
    (groups) => [...groups.filter((item) => item.id !== clean.id), clean],
    assertCurrent,
  );
}

export async function deleteCronGroup(
  id: string,
  assertCurrent: () => void = () => {},
): Promise<CronGroup[]> {
  return await updateCronGroups(
    (groups) => groups.filter((group) => group.id !== id),
    assertCurrent,
  );
}
