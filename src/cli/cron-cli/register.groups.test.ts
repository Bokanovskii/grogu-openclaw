import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();
vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronGroupCommands } = await import("./register.groups.js");

async function run(args: readonly string[]) {
  const program = new Command().exitOverride();
  registerCronGroupCommands(program);
  await program.parseAsync([...args], { from: "user" });
}

describe("cron group CLI", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset().mockResolvedValue({ groups: [] });
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["2", "0", "-2"])("writes group order %s through the Gateway", async (order) => {
    await run([
      "groups",
      "upsert",
      "--id",
      "daily",
      "--label",
      "Daily",
      "--description",
      "Daily checks",
      "--order",
      order,
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.groups.upsert", expect.anything(), {
      group: { id: "daily", label: "Daily", description: "Daily checks", order: Number(order) },
    });
  });

  it("lists and deletes groups through their dedicated RPCs", async () => {
    await run(["groups", "list"]);
    await run(["groups", "delete", "daily"]);

    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "cron.groups.list",
      "cron.groups.delete",
    ]);
  });
});
