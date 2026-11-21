import { createSandboxHostTransport } from "./transport.js";

export type ProtectedWidgetOptions = {
  html: string;
  theme: "light" | "dark";
  sandboxUrl?: string;
  draft?: boolean;
  onPrompt: (text: string) => void;
  onError: (error: Error) => void;
};

/** The matching server shell must use the protected sandbox policy. */
export function createWidgetHost(frame: HTMLIFrameElement, options: ProtectedWidgetOptions) {
  if (new TextEncoder().encode(options.html).byteLength > 10 * 1024 * 1024) {
    throw new Error("Widget exceeds the display limit.");
  }
  const sandboxUrl = new URL(
    options.sandboxUrl ?? "/api/protected/v1/widget-sandbox",
    window.location.href,
  );
  if (sandboxUrl.origin !== window.location.origin) {
    throw new Error("Widget sandbox must be served by this application.");
  }
  let disposed = false;
  let loaded = false;
  let promptPort: MessagePort | undefined;
  let theme = options.theme;
  const renderId = crypto.randomUUID();
  const transport = createSandboxHostTransport({
    frame,
    sandboxUrl: sandboxUrl.href,
    sameOriginSandbox: true,
    onMessage: (event) => {
      if (disposed || !event.data || typeof event.data !== "object") {
        return;
      }
      const data = event.data;
      const offeredPromptPort = event.ports[0];
      if (
        data.type === "openclaw:widget-prompt-offer" &&
        !options.draft &&
        !promptPort &&
        event.ports.length === 1 &&
        offeredPromptPort
      ) {
        promptPort = offeredPromptPort;
        promptPort.addEventListener("message", (message) => {
          const value = message.data;
          if (
            !disposed &&
            value?.type === "openclaw:widget-prompt" &&
            typeof value.prompt === "string" &&
            value.prompt.trim() &&
            value.prompt.length <= 8_000
          ) {
            options.onPrompt(value.prompt);
          }
        });
        promptPort.start();
        return;
      }
      // Protected widgets never receive transferred RPC, credential, or host
      // ports. Only this shell's private transport is retained.
      for (const port of event.ports) {
        port.close();
      }
      if (data.method === "ui/notifications/sandbox-proxy-ready" && !loaded) {
        loaded = true;
        transport.send({
          method: "ui/notifications/sandbox-resource-ready",
          params: { html: options.html, allowScripts: !options.draft, renderId },
        });
        transport.send({ type: "openclaw:widget-theme", mode: theme, tokens: {} });
      } else if (
        data.method === "ui/notifications/sandbox-resource-loaded" &&
        data.params?.renderId === renderId
      ) {
        clearTimeout(timeout);
      } else if (
        data.type === "openclaw:widget-size" &&
        Number.isFinite(data.height) &&
        !options.draft
      ) {
        frame.style.height = `${Math.max(120, Math.min(1200, Math.ceil(data.height)))}px`;
      } else if (data.type === "openclaw:widget-runtime-error") {
        options.onError(new Error("This widget could not run. Try reopening it."));
      }
    },
  });
  const receive = (event: MessageEvent) => {
    transport.acceptsMessage(event);
  };
  window.addEventListener("message", receive);
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
  frame.referrerPolicy = "same-origin";
  frame.src = sandboxUrl.href;
  const timeout = setTimeout(() => {
    if (!disposed) {
      options.onError(new Error("The widget did not load. Reopen it to try again."));
    }
  }, 30_000);
  return {
    setTheme(mode: "light" | "dark") {
      theme = mode;
      transport.send({ type: "openclaw:widget-theme", mode, tokens: {} });
    },
    dispose() {
      disposed = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      transport.dispose();
      promptPort?.close();
      frame.removeAttribute("src");
    },
  };
}
