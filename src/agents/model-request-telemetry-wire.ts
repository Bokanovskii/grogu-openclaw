import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeReportedUsage,
  telemetryCode,
  telemetryErrorCodes,
  telemetryHash,
  telemetryIdentifier,
} from "./model-request-telemetry-metadata.js";
import { currentHttpRequestTelemetry, type RequestTracker } from "./model-request-telemetry.js";

export function createWireTelemetryObserver(tracker: RequestTracker, contentType: string) {
  const sse = /\btext\/event-stream\b/i.test(contentType);
  const json = /\bapplication\/json\b|\+json\b/i.test(contentType);
  const decoder = new TextDecoder();
  let buffer = "";
  let eventData = "";
  let skipLine = false;
  let skipEvent = false;
  let previousCR = false;
  let terminal: string | undefined;
  let sawDone = false;
  const inspect = (value: unknown) => {
    if (!isRecord(value)) {
      return;
    }
    const result = isRecord(value.response) ? value.response : value;
    tracker.update(
      {
        responseId: telemetryIdentifier(result.id) ?? tracker.record.responseId,
        responseModel: telemetryCode(result.model) ?? tracker.record.responseModel ?? null,
      },
      false,
    );
    const usage = normalizeReportedUsage(result.usage, { wire: true });
    if (usage) {
      tracker.update(usage, false);
    }
    if (value.error || value.type === "error" || value.type === "response.failed") {
      terminal = "provider_error";
      const error = isRecord(value.error)
        ? value.error
        : isRecord(result.error)
          ? result.error
          : {};
      tracker.update(
        {
          providerErrorCode:
            typeof error.code === "string" && telemetryErrorCodes.has(error.code)
              ? error.code
              : null,
          providerErrorCodeHash: telemetryHash(error.code),
          providerErrorType:
            typeof error.type === "string" && telemetryErrorCodes.has(error.type)
              ? error.type
              : null,
        },
        false,
      );
    }
    for (const choice of Array.isArray(value.choices) ? value.choices.slice(0, 4) : []) {
      if (!isRecord(choice)) {
        continue;
      }
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        tracker.output("reasoning");
      }
      if (typeof delta.content === "string" && delta.content) {
        tracker.output("wire_content");
      }
      if (
        Array.isArray(delta.tool_calls) &&
        delta.tool_calls.some(
          (t: unknown) => isRecord(t) && isRecord(t.function) && t.function.arguments,
        )
      ) {
        tracker.output("tool");
      }
      if (choice.finish_reason) {
        terminal ??= "protocol_complete";
        tracker.update({ stopReason: telemetryCode(choice.finish_reason) }, false);
      }
    }
    if (typeof value.delta === "string" && value.delta) {
      const type = typeof value.type === "string" ? value.type : "";
      if (/reasoning.*delta$/.test(type)) {
        tracker.output("reasoning");
      } else if (/output_text.*delta$/.test(type)) {
        tracker.output("text");
      } else if (/function_call_arguments.*delta$/.test(type)) {
        tracker.output("tool");
      }
    }
    if (value.type === "response.completed" || value.type === "message_stop") {
      terminal ??= "protocol_complete";
    }
    if (value.type === "response.incomplete") {
      terminal = "incomplete_stream";
    }
  };
  const parse = (data: string) => {
    if (!data) {
      return;
    }
    if (data.trim() === "[DONE]") {
      sawDone = true;
      return;
    }
    try {
      inspect(JSON.parse(data));
    } catch {
      tracker.update(
        { unparsedWireEvents: Number(tracker.record.unparsedWireEvents ?? 0) + 1 },
        false,
      );
    }
  };
  const line = (value: string) => {
    if (!value) {
      if (!skipEvent) {
        parse(eventData);
      }
      eventData = "";
      skipEvent = false;
    } else if (!skipEvent && value.startsWith("data:")) {
      eventData += (eventData ? "\n" : "") + value.slice(5).trimStart();
      if (eventData.length > 65_536) {
        eventData = "";
        skipEvent = true;
        tracker.update({ wireParserTruncated: true }, false);
      }
    }
  };
  return {
    chunk(bytes: Uint8Array) {
      tracker.bytes(bytes.byteLength);
      if (!sse && !json) {
        return;
      }
      const text = decoder.decode(bytes, { stream: true });
      if (json) {
        if (!tracker.record.wireParserTruncated && buffer.length + text.length <= 65_536) {
          buffer += text;
        } else {
          buffer = "";
          tracker.update({ wireParserTruncated: true }, false);
        }
        return;
      }
      for (const char of text) {
        if (previousCR && char === "\n") {
          previousCR = false;
          continue;
        }
        previousCR = char === "\r";
        if (char === "\n" || char === "\r") {
          if (!skipLine) {
            line(buffer);
          }
          buffer = "";
          skipLine = false;
        } else if (!skipLine) {
          buffer += char;
          if (buffer.length > 65_536) {
            buffer = "";
            skipLine = true;
            skipEvent = true;
            tracker.update({ wireParserTruncated: true }, false);
          }
        }
      }
    },
    finish(outcome: string, error?: unknown, signal?: AbortSignal) {
      if (sse) {
        if (buffer) {
          line(buffer);
        }
        if (eventData && !skipEvent) {
          parse(eventData);
        }
      } else if (json && !tracker.record.wireParserTruncated) {
        parse(buffer);
      }
      const httpError = tracker.record.httpStatus !== null && tracker.record.httpStatus >= 400;
      const finalOutcome = error
        ? outcome
        : httpError
          ? "http_error"
          : (terminal ?? (sse && (outcome === "eof" || sawDone) ? "incomplete_stream" : outcome));
      tracker.finish({ outcome: finalOutcome, error, signal });
      buffer = "";
      eventData = "";
    },
  };
}

export function observeModelHttpResponse(response: Response, dispatcherReused?: boolean): Response {
  const tracker = currentHttpRequestTelemetry();
  if (!tracker) {
    return response;
  }
  tracker.headers(response, dispatcherReused);
  if (!response.body) {
    tracker.finish({ outcome: response.ok ? "no_body" : "http_error" });
    return response;
  }
  const reader = response.body.getReader();
  const observer = createWireTelemetryObserver(tracker, response.headers.get("content-type") ?? "");
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            observer.finish("eof");
            controller.close();
          } else {
            observer.chunk(chunk.value);
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          observer.finish("stream_error", error, tracker.signal);
          controller.error(error);
        }
      },
      cancel(reason) {
        observer.finish(
          "consumer_cancel",
          reason instanceof Error ? reason : undefined,
          tracker.signal,
        );
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, response);
}
