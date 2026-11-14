import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  revision: 0,
  value: undefined as unknown,
}));

vi.mock("../plugin-state/plugin-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-state/plugin-state-store.js")>()),
  createCorePluginStateKeyedStore: () => ({
    lookup: async () => state.value,
    withCurrent: ({ assertCurrent }: { assertCurrent: () => void }) => ({
      observe: async () => {
        assertCurrent();
        return { value: state.value, comparison: String(state.revision) };
      },
      compareAndApply: async (
        _key: string,
        comparison: string,
        intent: { operation: string; action: string; value?: unknown },
      ) => {
        assertCurrent();
        if (comparison !== String(state.revision)) {
          return {
            status: "conflict",
            current: { value: state.value, comparison: String(state.revision) },
          };
        }
        if (intent.operation === "update" && intent.action === "set") {
          state.value = intent.value;
          state.revision += 1;
        }
        return { status: "applied" };
      },
    }),
  }),
}));

import { deleteCronGroup, listCronGroups, upsertCronGroup } from "./groups.js";

describe("cron group registry", () => {
  beforeEach(() => {
    state.revision = 0;
    state.value = undefined;
  });

  it("retries concurrent updates without losing groups and returns stable ordering", async () => {
    await Promise.all([
      upsertCronGroup({ id: "weekly", label: "Weekly", order: 2 }),
      upsertCronGroup({ id: "daily", label: "Daily", order: 1 }),
    ]);

    expect(await listCronGroups()).toEqual([
      { id: "daily", label: "Daily", order: 1 },
      { id: "weekly", label: "Weekly", order: 2 },
    ]);
  });

  it("replaces a group by id and deletes only the selected group", async () => {
    await upsertCronGroup({ id: "daily", label: "Daily" });
    await upsertCronGroup({ id: "weekly", label: "Weekly" });
    await upsertCronGroup({ id: "daily", label: "Daily checks", description: "Checks each day" });

    expect(await deleteCronGroup("weekly")).toEqual([
      { id: "daily", label: "Daily checks", description: "Checks each day" },
    ]);
  });

  it("does not commit when caller authority closes after observation", async () => {
    let checks = 0;
    await expect(
      upsertCronGroup({ id: "daily", label: "Daily" }, () => {
        if (++checks > 1) {
          throw new Error("authority closed");
        }
      }),
    ).rejects.toThrow("authority closed");
    expect(await listCronGroups()).toEqual([]);
  });
});
