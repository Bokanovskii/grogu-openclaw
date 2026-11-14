import { Parser } from "htmlparser2";
import { WIDGET_HTML_MAX_UTF8_BYTES } from "../../packages/gateway-protocol/src/schema/canvas.js";
import type { PluginBoardWidgetContentKind } from "../plugins/board-widget-content-kind.types.js";
import {
  capturePluginRegistryLifecycleEpoch,
  isPluginRegistryLifecycleEpochActive,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { escapeHtml } from "../shared/html-escape.js";

type PublicResourceReader = NonNullable<
  PluginBoardWidgetContentKind["resources"]["readPublicResource"]
>;
type PublicScripts = Readonly<Record<string, string | Error>>;
const readersByEpoch = new WeakMap<object, Map<string, PublicResourceReader>>();
const scriptsByEpoch = new WeakMap<object, Promise<PublicScripts>>();

export function getSandboxPublicResourceReaders(registry: PluginRegistry) {
  const epoch = capturePluginRegistryLifecycleEpoch(registry);
  if (!epoch) {
    throw new Error("Renderer resources are unavailable");
  }
  let readers = readersByEpoch.get(epoch);
  if (!readers) {
    readers = new Map();
    for (const { definition } of registry.boardWidgetContentKinds.values()) {
      if (definition.resources.readPublicResource) {
        const read = definition.resources.readPublicResource.bind(definition.resources);
        for (const resourcePath of definition.resources.paths) {
          readers.set(resourcePath, read);
        }
      }
    }
    readersByEpoch.set(epoch, readers);
  }
  return { epoch, readers };
}

/** Public static bytes belong to one plugin activation, never to a viewer's credentials. */
export async function prepareSandboxPublicScripts(
  registry: PluginRegistry | undefined,
): Promise<PublicScripts> {
  if (!registry) {
    return {};
  }
  const { epoch, readers } = getSandboxPublicResourceReaders(registry);
  let prepared = scriptsByEpoch.get(epoch);
  if (!prepared) {
    prepared = (async () => {
      const scripts: Record<string, string | Error> = {};
      for (const [resourcePath, read] of readers) {
        let resource: Awaited<ReturnType<PublicResourceReader>>;
        try {
          resource = await read(resourcePath);
        } catch (cause) {
          scripts[resourcePath] = new Error(
            `Public renderer resource is unavailable: ${resourcePath}`,
            { cause },
          );
        }
        if (!isPluginRegistryLifecycleEpochActive(registry, epoch)) {
          throw new Error("Renderer resources changed; reload the widget");
        }
        if (!resource) {
          scripts[resourcePath] ??= new Error(
            `Public renderer resource is unavailable: ${resourcePath}`,
          );
          continue;
        }
        if (!/^(?:text|application)\/javascript(?:;|$)/iu.test(resource.contentType)) {
          continue;
        }
        if (resource.body.byteLength > WIDGET_HTML_MAX_UTF8_BYTES) {
          scripts[resourcePath] = new Error("Public renderer script exceeds the widget size limit");
          continue;
        }
        scripts[resourcePath] =
          `data:application/javascript;base64,${Buffer.from(resource.body).toString("base64")}`;
      }
      return scripts;
    })();
    scriptsByEpoch.set(epoch, prepared);
    void prepared.catch(() => {
      if (scriptsByEpoch.get(epoch) === prepared) {
        scriptsByEpoch.delete(epoch);
      }
    });
  }
  const scripts = await prepared;
  if (
    Object.values(scripts).some((value) => value instanceof Error) &&
    scriptsByEpoch.get(epoch) === prepared
  ) {
    scriptsByEpoch.delete(epoch);
  }
  if (!isPluginRegistryLifecycleEpochActive(registry, epoch)) {
    throw new Error("Renderer resources changed; reload the widget");
  }
  return scripts;
}

// Serialized into the transient document, including saved widgets with dynamic script loaders.
function installPublicScriptUrls(
  scripts: Readonly<Record<string, string>>,
  resourceOrigins: readonly string[],
  browser: {
    document: { baseURI: string };
    Element: {
      prototype: { setAttribute(name: string, value: string): void };
    };
    HTMLScriptElement: {
      prototype: { src: string; setAttribute(name: string, value: string): void };
    };
  },
) {
  const { document, Element, HTMLScriptElement } = browser;
  const base = document.baseURI;
  const resolve = (value: string) => {
    const url = URL.parse(value, base);
    if (!url || (url.origin !== new URL(base).origin && !resourceOrigins.includes(url.origin))) {
      return value;
    }
    const path = url.pathname.replace(/^\/__openclaw__\/cap\/[^/]+/u, "");
    return scripts[path] ?? value;
  };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
  if (descriptor?.set) {
    Object.defineProperty(HTMLScriptElement.prototype, "src", {
      ...descriptor,
      // Widget code may assign URL objects or other non-string values.
      set(value: unknown) {
        descriptor.set?.call(this, resolve(String(value)));
      },
    });
  }
  HTMLScriptElement.prototype.setAttribute = function (name, value) {
    Element.prototype.setAttribute.call(
      this,
      name,
      name.toLowerCase() === "src" ? resolve(value) : value,
    );
  };
}

/** Change only the delivered copy. Stored widget HTML and its approved digest stay intact. */
export function embedSandboxPublicScripts(
  html: string,
  publicScripts: PublicScripts,
  resourceOrigins: readonly string[] = [],
): string {
  const scripts: Record<string, string> = {};
  for (const [resourcePath, resource] of Object.entries(publicScripts)) {
    if (html.includes(resourcePath)) {
      if (resource instanceof Error) {
        throw resource;
      }
      scripts[resourcePath] = resource;
    }
  }
  if (Object.keys(scripts).length === 0) {
    return html;
  }
  const edits: Array<{ start: number; end: number; html: string }> = [];
  let insertion = 0;
  let firstScript: number | undefined;
  const parser = new Parser({
    onprocessinginstruction(name) {
      if (name.toLowerCase() === "!doctype") {
        insertion = parser.endIndex + 1;
      }
    },
    onopentag(name, attributes) {
      if (name === "script") {
        firstScript ??= parser.startIndex;
      }
      if (name === "head") {
        insertion = parser.endIndex + 1;
      }
      if (name === "script" && attributes.src) {
        const base = "https://sandbox.invalid";
        const url = URL.parse(attributes.src, base);
        const script =
          url && (url.origin === base || resourceOrigins.includes(url.origin))
            ? scripts[url.pathname.replace(/^\/__openclaw__\/cap\/[^/]+/u, "")]
            : undefined;
        if (script) {
          attributes.src = script;
          edits.push({
            start: parser.startIndex,
            end: parser.endIndex + 1,
            html: `<script${Object.entries(attributes)
              .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
              .join("")}>`,
          });
        }
      }
      if (
        name === "meta" &&
        attributes["http-equiv"]?.toLowerCase() === "content-security-policy" &&
        attributes.content
      ) {
        // Retain stricter user policies. Canonical widgets already allow inline
        // scripts; data URLs only carry their explicitly public renderer bytes.
        attributes.content = attributes.content.replace(
          /(^|;)(\s*script-src(?:-elem)?\s+[^;]*)/giu,
          (directive, separator: string, value: string) =>
            value.includes("'unsafe-inline'") &&
            !/'(?:nonce-|sha256-|sha384-|sha512-|strict-dynamic')/u.test(value) &&
            !/(?:^|\s)data:(?:\s|$)/u.test(value)
              ? `${separator}${value} data:`
              : directive,
        );
        edits.push({
          start: parser.startIndex,
          end: parser.endIndex + 1,
          html: `<meta${Object.entries(attributes)
            .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
            .join("")}>`,
        });
      }
    },
  });
  parser.end(html);
  const data = JSON.stringify([scripts, resourceOrigins]).replaceAll("<", "\\u003c");
  const source = `(()=>{const __name = (target) => target; (${installPublicScriptUrls.toString()})(...${data},globalThis);})();`;
  // Leading document CSP metadata must also govern the dynamic loader.
  insertion = firstScript ?? insertion;
  edits.push({ start: insertion, end: insertion, html: `<script>${source}</script>` });
  let result = html;
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.html + result.slice(edit.end);
  }
  if (Buffer.byteLength(result, "utf8") > WIDGET_HTML_MAX_UTF8_BYTES) {
    throw new Error("Widget with public renderer scripts exceeds the widget size limit");
  }
  return result;
}
