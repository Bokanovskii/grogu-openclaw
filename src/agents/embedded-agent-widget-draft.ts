import {
  WIDGET_DRAFT_MAX_CHARS,
  WIDGET_DRAFT_TITLE_MAX_CHARS,
  type WidgetDraftProgress,
} from "../shared/widget-draft.js";
import { readToolCallBlock, readToolCallId } from "./embedded-agent-tool-call-progress.js";

const BATCH_MS = 100;
const MAX_CALLS = 16;
const ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/** Reads only root string fields, once per input character, including split JSON escapes. */
class WidgetArgumentReader {
  private depth = 0;
  private inString = false;
  private escape = false;
  private unicode: string | null = null;
  private key = "";
  private token = "";
  private keyExpected = false;
  private readingKey = false;
  private seen = new Set<string>();
  invalid = false;
  title?: string;
  kind?: string;
  receivedChars = 0;

  feed(input: string): string {
    const html: string[] = [];
    const text = (value: string) => {
      if (this.readingKey || (this.depth === 1 && (this.key === "title" || this.key === "kind"))) {
        if (this.token.length < WIDGET_DRAFT_TITLE_MAX_CHARS) {
          this.token += value;
        }
      } else if (this.depth === 1 && this.key === "widget_code") {
        this.receivedChars += value.length;
        if (this.receivedChars <= WIDGET_DRAFT_MAX_CHARS) {
          html.push(value);
        }
      }
    };
    for (const char of input) {
      if (this.invalid) {
        break;
      }
      if (this.inString) {
        if (this.unicode !== null) {
          if (!/^[\da-f]$/iu.test(char)) {
            this.invalid = true;
            break;
          }
          this.unicode += char;
          if (this.unicode.length === 4) {
            text(String.fromCharCode(Number.parseInt(this.unicode, 16)));
            this.unicode = null;
          }
        } else if (this.escape) {
          this.escape = false;
          const escaped = ESCAPES.get(char);
          if (char === "u") {
            this.unicode = "";
          } else if (escaped !== undefined) {
            text(escaped);
          } else {
            this.invalid = true;
          }
        } else if (char === "\\") {
          this.escape = true;
        } else if (char === '"') {
          this.inString = false;
          if (this.readingKey) {
            this.key = this.token;
            if (this.seen.has(this.key) || this.seen.size >= 64) {
              this.invalid = true;
            }
            this.seen.add(this.key);
            this.keyExpected = false;
          } else if (this.depth === 1) {
            if (this.key === "title") {
              this.title = this.token;
            }
            if (this.key === "kind") {
              this.kind = this.token;
            }
            this.key = "";
          }
          this.token = "";
        } else if (char < " ") {
          this.invalid = true;
        } else {
          text(char);
        }
      } else if (char === '"') {
        this.inString = true;
        this.readingKey = this.depth === 1 && this.keyExpected;
        this.token = "";
      } else if (char === "{" || char === "[") {
        this.depth += 1;
        if (this.depth === 1) {
          if (char !== "{") {
            this.invalid = true;
          }
          this.keyExpected = true;
        }
      } else if (char === "}" || char === "]") {
        this.depth -= 1;
        if (this.depth < 0) {
          this.invalid = true;
        }
      } else if (char === "," && this.depth === 1) {
        this.keyExpected = true;
        this.key = "";
      }
    }
    return html.join("");
  }
}

type DraftCall = {
  reader: WidgetArgumentReader;
  sourceLength: number;
  pending: string;
  offset: number;
  timer?: ReturnType<typeof setTimeout>;
  unavailable?: WidgetDraftProgress["unavailable"];
};

export class WidgetDraftProjector {
  private calls = new Map<string, DraftCall>();

  constructor(private emit: (toolCallId: string, draft: WidgetDraftProgress) => void) {}

  update(event: Record<string, unknown> | undefined): void {
    if (
      !event ||
      !["toolcall_start", "toolcall_delta", "toolcall_end"].includes(String(event.type))
    ) {
      return;
    }
    const block = readToolCallBlock(event);
    const id = readToolCallId(event);
    if (!id) {
      return;
    }
    if (event.type === "toolcall_end") {
      this.finish(id);
      return;
    }
    if (block?.name !== "show_widget") {
      return;
    }
    let call = this.calls.get(id);
    if (!call) {
      if (this.calls.size >= MAX_CALLS) {
        return;
      }
      call = { reader: new WidgetArgumentReader(), sourceLength: 0, pending: "", offset: 0 };
      this.calls.set(id, call);
      this.flush(id, call);
    }
    // Completions uses partialArgs; Anthropic/Responses use partialJson. Parsed
    // arguments refresh geometrically and cannot supply near-live HTML.
    const raw = typeof block.partialArgs === "string" ? block.partialArgs : block.partialJson;
    if (typeof raw !== "string") {
      return;
    }
    if (raw.length < call.sourceLength) {
      call.unavailable = "invalid";
    }
    const incoming = raw.slice(call.sourceLength);
    call.sourceLength = raw.length;
    if (raw.length > WIDGET_DRAFT_MAX_CHARS * 4) {
      call.unavailable = "limit";
    } else {
      call.pending += call.reader.feed(incoming);
    }
    if (call.reader.invalid) {
      call.unavailable = "invalid";
    } else if (call.reader.receivedChars > WIDGET_DRAFT_MAX_CHARS) {
      call.unavailable = "limit";
    } else if (call.reader.kind && call.reader.kind !== "html") {
      call.unavailable = "unsupported";
    }
    if (call.unavailable) {
      call.pending = "";
    }
    if (call.timer === undefined) {
      call.timer = setTimeout(() => {
        call.timer = undefined;
        this.flush(id, call);
      }, BATCH_MS);
      call.timer.unref?.();
    }
  }

  finish(id: string): void {
    const call = this.calls.get(id);
    if (!call) {
      return;
    }
    clearTimeout(call.timer);
    this.flush(id, call);
    this.calls.delete(id);
  }

  clear(): void {
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
    }
    this.calls.clear();
  }

  private flush(id: string, call: DraftCall): void {
    this.emit(id, {
      receivedChars: call.sourceLength,
      ...(call.reader.title ? { title: call.reader.title } : {}),
      ...(call.unavailable
        ? { unavailable: call.unavailable }
        : { offset: call.offset, html: call.pending }),
    });
    call.offset += call.pending.length;
    call.pending = "";
  }
}
