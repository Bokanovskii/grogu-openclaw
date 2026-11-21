type SandboxHostTransportOptions = {
  frame: {
    readonly contentWindow: {
      postMessage(message: unknown, targetOrigin: string, transfer?: MessagePort[]): void;
    } | null;
  };
  sandboxUrl: string;
  sameOriginSandbox?: boolean;
  onMessage: (event: MessageEvent) => void;
};

/** Also serialized into the standalone App host; keep this function self-contained. */
export function createSandboxHostTransport(options: SandboxHostTransportOptions) {
  const origin = new URL(options.sandboxUrl).origin;
  let port: MessagePort | undefined;
  let disposed = false;
  const reset = () => {
    port?.close();
    port = undefined;
  };
  const acceptsMessage = (event: MessageEvent): boolean => {
    if (disposed || !options.frame.contentWindow) {
      return false;
    }
    if (!options.sameOriginSandbox) {
      return event.source === options.frame.contentWindow && event.origin === origin;
    }
    if (port && event.currentTarget === port) {
      return true;
    }
    if (
      !port &&
      event.source === options.frame.contentWindow &&
      event.origin === "null" &&
      event.data?.method === "ui/notifications/sandbox-proxy-ready" &&
      event.data?.params?.sandboxUrl === options.sandboxUrl
    ) {
      const channel = new MessageChannel();
      port = channel.port1;
      port.addEventListener("message", (message) => {
        if (acceptsMessage(message)) {
          options.onMessage(message);
        }
      });
      port.start();
      // Opaque origins cannot receive an origin-addressed message. Transfer only
      // this private channel; document bytes and grants never use the wildcard.
      options.frame.contentWindow.postMessage(
        {
          method: "ui/notifications/sandbox-connect",
          params: { sandboxUrl: options.sandboxUrl },
        },
        "*",
        [channel.port2],
      );
    }
    return false;
  };
  return {
    acceptsMessage,
    send(message: unknown): boolean {
      if (disposed || !options.frame.contentWindow) {
        return false;
      }
      if (options.sameOriginSandbox) {
        if (!port) {
          return false;
        }
        port.postMessage(message);
      } else {
        options.frame.contentWindow.postMessage(message, origin);
      }
      return true;
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}

export function sandboxHostFramePermissions(sameOriginSandbox?: boolean): string {
  return sameOriginSandbox
    ? "allow-scripts allow-forms"
    : "allow-scripts allow-same-origin allow-forms";
}
