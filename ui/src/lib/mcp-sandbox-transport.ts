import type { Transport } from "@modelcontextprotocol/client";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { createSandboxHostTransport } from "../../../src/shared/sandbox-host-transport.ts";
import { t } from "../i18n/index.ts";

export async function prepareMcpSandboxTransport(options: {
  frame: HTMLIFrameElement;
  sandboxUrl: string;
  sameOriginSandbox?: boolean;
  signal: AbortSignal;
}): Promise<Transport> {
  let receivePortMessage: (event: MessageEvent) => void = () => undefined;
  const shell = createSandboxHostTransport({
    ...options,
    onMessage: (event) => receivePortMessage(event),
  });
  let cleanup: () => void = () => undefined;
  try {
    options.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        if (
          shell.acceptsMessage(event) &&
          event.data?.method === "ui/notifications/sandbox-proxy-ready" &&
          (!options.sameOriginSandbox || event.data?.params?.sandboxUrl === options.sandboxUrl)
        ) {
          resolve();
        }
      };
      receivePortMessage = onMessage;
      const abort = () =>
        reject(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("MCP App sandbox preparation aborted"),
        );
      const timeout = window.setTimeout(
        () => reject(new Error(t("mcpApp.errors.sandboxTimedOut"))),
        15_000,
      );
      cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        options.signal.removeEventListener("abort", abort);
      };
      window.addEventListener("message", onMessage);
      options.signal.addEventListener("abort", abort, { once: true });
      options.frame.src = options.sandboxUrl;
    });
    options.signal.throwIfAborted();
    if (!options.frame.contentWindow) {
      throw new Error(t("mcpApp.errors.sandboxUnavailable"));
    }
    if (!options.sameOriginSandbox) {
      shell.dispose();
      return new PostMessageTransport(options.frame.contentWindow, options.frame.contentWindow);
    }
    const transport: Transport = {
      async start() {
        receivePortMessage = (event) => {
          const message = JSONRPCMessageSchema.safeParse(event.data);
          if (message.success) {
            transport.onmessage?.(message.data);
          } else if (event.data?.jsonrpc === "2.0") {
            transport.onerror?.(
              new Error(`Invalid JSON-RPC message received: ${message.error.message}`),
            );
          }
        };
      },
      async send(message) {
        if (!shell.send(message)) {
          throw new Error(t("mcpApp.errors.sandboxUnavailable"));
        }
      },
      async close() {
        shell.dispose();
        transport.onclose?.();
      },
    };
    return transport;
  } catch (error) {
    shell.dispose();
    throw error;
  } finally {
    cleanup();
  }
}
