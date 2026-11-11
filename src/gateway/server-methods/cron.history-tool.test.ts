import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { expect, it, onTestFinished, vi } from "vitest";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import type { GatewayToolCaller } from "../../agents/tools/cron-tool.types.js";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { persistHistory, withCronTranscript } from "./cron.history.test-support.js";
import { cronHandlers } from "./cron.js";
import { createCronCallerClient } from "./cron.validation.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

type Fixture = Parameters<Parameters<typeof withCronTranscript>[0]>[0];

function createReader(fixture: Fixture, client: GatewayClient, isCurrent = () => true) {
  const callGateway: GatewayToolCaller = async <T>(...args: Parameters<GatewayToolCaller>) => {
    const [method, , params, callOptions] = args;
    const requestParams = expectDefined(asOptionalRecord(params), "Gateway params");
    expect(callOptions?.requireAgentRuntimeIdentity).toBe(true);
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      cronHandlers[method],
      method,
    )({
      req: { type: "req", id: "tool-history", method, params: requestParams },
      params: requestParams,
      client,
      context: fixture.context,
      respond,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: isCurrent,
    });
    expect(respond.mock.calls).toHaveLength(1);
    const [ok, payload, error] = expectDefined(respond.mock.calls[0], "Gateway response");
    if (!ok) {
      throw new Error(error?.message);
    }
    if (requestParams.messageId !== undefined) {
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(80 * 1024);
      expect(payload).not.toHaveProperty("message");
    }
    return payload as T;
  };
  const tool = createCronTool(
    { agentSessionKey: "agent:main:reader", selfRemoveOnlyJobId: fixture.job.id },
    { callGatewayTool: callGateway },
  );
  return async (input: Record<string, unknown> = {}) => {
    const result = await tool.execute("history", {
      action: "history",
      jobId: fixture.job.id,
      runId: "public-old-run",
      ...input,
    });
    expect(
      Value.Check(expectDefined(tool.outputSchema, "history output schema"), result.details),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(80 * 1024);
    return expectDefined(asOptionalRecord(result.details), "tool details");
  };
}

function currentJobReader(fixture: Fixture) {
  return {
    ...sharingPolicyClient({ scopes: ["operator.read"], user: fixture.profile.id }),
    internal: createCronCallerClient(
      "main",
      "personal",
      "agent:main:unrelated-reader",
      fixture.job.id,
    ).internal,
  };
}

it("reads retained runs through automations with paging, private-tool filtering and bound text continuation", async () => {
  await withCronTranscript(async (fixture) => {
    const { oldScope, job, cron, record } = fixture;
    const fullText = `Visible parent ${"x".repeat(9000)} last`;
    await appendTranscriptMessage(oldScope, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: fullText },
          { type: "toolResult", content: "Nested private tool output" },
          {
            type: "toolCall",
            id: "call",
            name: "fixture",
            arguments: { token: "PRIVATE_ARGUMENT" },
            partialJson: '{"token":"PRIVATE_SERIALIZED_ARGUMENT"}',
          },
        ],
      },
    });
    await appendTranscriptMessage(oldScope, {
      message: {
        role: "toolResult",
        toolCallId: "call",
        content: "Requested tool output internal-ticket-AbC12345",
      },
    });
    applyLoggingConfig({ redactPatterns: [String.raw`\binternal-ticket-[A-Za-z0-9]+\b`] });
    onTestFinished(resetLogger);
    const client = currentJobReader(fixture);
    const read = createReader(fixture, client);
    const first = await read({ limit: 2 });
    expect(JSON.stringify(first)).not.toContain("Nested private tool output");
    expect(JSON.stringify(first)).not.toContain("Requested tool output");
    expect(JSON.stringify(first)).not.toContain("PRIVATE_ARGUMENT");
    expect(JSON.stringify(first)).not.toContain("PRIVATE_SERIALIZED_ARGUMENT");
    expect(first.contentTruncated).toBe(true);
    const message = expectDefined(asOptionalRecord((first.messages as unknown[])[0]), "parent");
    const messageId = expectDefined(asOptionalRecord(message["__openclaw"])?.id, "message ID");
    expect(typeof messageId).toBe("string");
    const outside = createReader(fixture, {
      ...client,
      internal: createCronCallerClient("main", "personal", "agent:main:outside").internal,
    });
    await expect(outside()).rejects.toThrow(/unavailable/);
    await expect(outside({ messageId, textCursor: "start" })).rejects.toThrow(/unavailable/);
    const next = await read({ runId: undefined, runAtMs: 10, limit: 2, cursor: first.nextCursor });
    expect(next.messages).toMatchObject([{ content: "Old second" }, { content: "Old last" }]);
    const last = await read({ limit: 2, cursor: next.nextCursor });
    expect(last.messages).toMatchObject([{ content: "Old first" }]);
    expect(last.nextCursor).toBeUndefined();
    await expect(read({ cursor: first.nextCursor, includeTools: true })).rejects.toThrow(
      /includeTools/,
    );
    const text = await read({ messageId, textCursor: "start" });
    let page = expectDefined(asOptionalRecord(text.textPage), "text page");
    let joined = String(page.text);
    const textCursor = page.nextCursor;
    while (page.nextCursor) {
      const continued = await read({ messageId, textCursor: page.nextCursor });
      page = expectDefined(asOptionalRecord(continued.textPage), "continued text page");
      expect(page.field).toBe("content[0].text");
      joined += String(page.text);
    }
    expect(joined).toBe(fullText);
    expect(joined).not.toContain("Nested private tool output");
    expect(joined).not.toContain("PRIVATE_ARGUMENT");
    await expect(read({ messageId, textCursor, includeTools: true })).rejects.toThrow(
      /another recorded run|includeTools/,
    );
    const tools = await read({ includeTools: true, limit: 1 });
    expect(tools.messages).toMatchObject([
      { role: "toolResult", content: expect.stringContaining("Requested tool output") },
    ]);
    expect(JSON.stringify(tools)).not.toContain("internal-ticket-AbC12345");
    expect(tools.contentRedacted).toBe(true);
    const toolId = asOptionalRecord(
      asOptionalRecord((tools.messages as unknown[])[0])?.["__openclaw"],
    )?.id;
    await expect(read({ messageId: toolId, textCursor: "start" })).rejects.toThrow(/includeTools/);
    const toolText = await read({ messageId: toolId, textCursor: "start", includeTools: true });
    expect(toolText.textPage).toMatchObject({
      text: expect.stringContaining("Requested tool output"),
    });
    expect(JSON.stringify(toolText)).not.toContain("internal-ticket-AbC12345");
    expect(toolText.contentRedacted).toBe(true);
    await expect(read({ messageId: "pending:fixture", textCursor: "start" })).rejects.toThrow(
      /not_found/,
    );

    const detail = expectDefined(asOptionalRecord(record.detail), "run detail");
    persistHistory([
      { ...record, runId: "another-internal", detail: { ...detail, runId: "another-public" } },
    ]);
    await expect(read({ runId: "another-public", cursor: first.nextCursor })).rejects.toThrow(
      /unavailable/,
    );
    await expect(read({ runId: "another-public", messageId, textCursor })).rejects.toThrow(
      /another recorded run/,
    );
    await expect(read({ runId: undefined, runAtMs: 10 })).rejects.toThrow(/unavailable/);
    const claim = expectDefined(
      client.internal?.agentRuntimeIdentity?.cronSelfManagementContext,
      "current job claim",
    );
    claim.expiresAtMs = Date.now() - 1;
    await expect(read()).rejects.toThrow(/unavailable/);
    await expect(read({ messageId, textCursor: "start" })).rejects.toThrow(/unavailable/);
    claim.expiresAtMs = Date.now() + 60_000;
    await cron.remove(job.id);
    await expect(read()).rejects.toThrow(/unavailable/);
    await expect(read({ messageId, textCursor: "start" })).rejects.toThrow(/unavailable/);
  });
});

it("returns bounded Gateway text pages for a selected message larger than the agent response budget", async () => {
  await withCronTranscript(async (fixture) => {
    const fullText = `Large retained text ${"x".repeat(100_000)}`;
    await appendTranscriptMessage(fixture.oldScope, {
      message: { role: "assistant", content: fullText },
    });
    const read = createReader(fixture, currentJobReader(fixture));
    const history = await read({ limit: 1 });
    const messageId = asOptionalRecord(
      asOptionalRecord((history.messages as unknown[])[0])?.["__openclaw"],
    )?.id;
    const first = await read({ messageId, textCursor: "start" });
    expect(first.textPage).toMatchObject({
      offset: 0,
      text: fullText.slice(0, 4000),
      totalChars: fullText.length,
    });
    const page = expectDefined(asOptionalRecord(first.textPage), "large message page");
    const continued = await read({ messageId, textCursor: page.nextCursor });
    expect(continued.textPage).toMatchObject({
      offset: 4000,
      text: fullText.slice(4000, 8000),
      totalChars: fullText.length,
    });
  });
});

it.each(["client", "sharing", "job deletion", "run binding", "transcript owner"] as const)(
  "refuses selected-message publication after %s changes during the retained read",
  async (change) => {
    await withCronTranscript(async (fixture) => {
      const client = currentJobReader(fixture);
      let current = true;
      const read = createReader(fixture, client, () => current);
      const first = await read({ limit: 1 });
      const messageId = asOptionalRecord(
        asOptionalRecord((first.messages as unknown[])[0])?.["__openclaw"],
      )?.id;
      const original = fixture.cron.readJob.bind(fixture.cron);
      let reads = 0;
      const spy = vi.spyOn(fixture.cron, "readJob").mockImplementation(async (id) => {
        const job = await original(id);
        if (++reads === 2) {
          if (change === "client") {
            current = false;
          } else if (change === "sharing") {
            await patchSessionEntryCore({ agentId: "main", sessionKey: fixture.baseKey }, () => ({
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: "another-profile" },
            }));
          } else if (change === "job deletion") {
            await fixture.cron.remove(fixture.job.id);
          } else if (change === "run binding") {
            const detail = expectDefined(asOptionalRecord(fixture.record.detail), "run detail");
            persistHistory([
              { ...fixture.record, detail: { ...detail, sessionId: fixture.latest.sessionId } },
            ]);
          } else {
            runOpenClawAgentWriteTransaction(
              ({ db }) =>
                db
                  .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
                  .run("agent:main:another-owner", fixture.oldScope.sessionId),
              { agentId: "main" },
            );
          }
        }
        return job;
      });
      try {
        const error =
          change === "sharing"
            ? /session access changed/
            : change === "run binding"
              ? /retained transcript changed/
              : /unavailable/;
        await expect(read({ messageId, textCursor: "start" })).rejects.toThrow(error);
        expect(reads).toBeGreaterThanOrEqual(2);
      } finally {
        spy.mockRestore();
      }
    });
  },
);
