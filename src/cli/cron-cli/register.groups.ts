import { parseStrictInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION } from "../machine-output-argv.js";
import { handleCronCliError, parseCronStringOption, printCronJson } from "./shared.js";

export function registerCronGroupCommands(cron: Command) {
  const groups = cron.command("groups").description("Manage automation groups");
  addGatewayClientOptions(
    groups
      .command("list")
      .option("--json", MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION)
      .description("List automation groups")
      .action(async (opts: GatewayRpcOpts) => {
        try {
          printCronJson(await callGatewayFromCli("cron.groups.list", opts, {}));
        } catch (error) {
          handleCronCliError(error);
        }
      }),
  );
  addGatewayClientOptions(
    groups
      .command("upsert")
      .option("--json", MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION)
      .description("Create or replace an automation group")
      .requiredOption("--id <id>", "Stable group id")
      .requiredOption("--label <label>", "Human-readable group label")
      .option("--description <text>", "What automations in this group do")
      .option("--order <n>", "Group sort order")
      .action(async (opts: GatewayRpcOpts & Record<string, unknown>) => {
        try {
          const id = parseCronStringOption(opts.id, "--id");
          const label = parseCronStringOption(opts.label, "--label");
          const description = parseCronStringOption(opts.description, "--description");
          const order = parseStrictInteger(opts.order);
          if (opts.order !== undefined && order === undefined) {
            throw new Error("--order must be a safe integer");
          }
          if (!id || !label) {
            throw new Error("--id and --label must not be blank");
          }
          printCronJson(
            await callGatewayFromCli("cron.groups.upsert", opts, {
              group: {
                id,
                label,
                ...(description ? { description } : {}),
                ...(order === undefined ? {} : { order }),
              },
            }),
          );
        } catch (error) {
          handleCronCliError(error);
        }
      }),
  );
  addGatewayClientOptions(
    groups
      .command("delete")
      .option("--json", MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION)
      .description("Delete an automation group")
      .argument("<id>", "Group id")
      .action(async (idArg: string, opts: GatewayRpcOpts) => {
        try {
          const id = parseCronStringOption(idArg, "group id");
          if (!id) {
            throw new Error("Group id must not be blank");
          }
          printCronJson(await callGatewayFromCli("cron.groups.delete", opts, { id }));
        } catch (error) {
          handleCronCliError(error);
        }
      }),
  );
}
