import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { record } from "../core/canonical.js";
import { listenForAbort } from "../core/abort.js";

/** Fixed benchmark model; this is not a general-purpose provider. */
const MODEL = "gpt-5.6-luna";
/** Caps all upstream bytes, including retained deltas and completed items. */
const RESPONSE_LIMIT = 2 * 1024 ** 2;
/** Synthetic requests need no more than one MiB of input. */
const BODY_LIMIT = 1024 ** 2;

/** Credentials remain in memory and are never returned to the HTTP client. */
export interface BenchmarkCredentials {
  account: string;
  access: string;
}

/** A terminal response or an explicit upstream error, never a partial success. */
export interface Completion {
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

/** Extracts assistant text without assuming every output item is a message. */
export function outputText(result: Record<string, unknown>): string {
  if (!Array.isArray(result.output)) return "";
  return result.output
    .flatMap((value: unknown) => {
      const item = record(value);
      if (
        item?.type !== "message" ||
        item.role !== "assistant" ||
        !Array.isArray(item.content)
      )
        return [];
      return item.content.flatMap((value: unknown) => {
        const part = record(value);
        return part?.type === "output_text" && typeof part.text === "string"
          ? [part.text]
          : [];
      });
    })
    .join("");
}

/** Reads bounded SSE and requires an explicit completed terminal response. */
export async function readCompletion(
  upstream: Response,
  signal: AbortSignal,
): Promise<Completion> {
  if (!upstream.body) throw new Error("Missing upstream stream.");
  const reader = upstream.body.getReader();
  const dispose = listenForAbort(signal, () => {
    void reader.cancel().catch(() => undefined);
  });
  const decoder = new TextDecoder();
  let buffer = "";
  let received = 0;
  let terminal: Record<string, unknown> | undefined;
  let error: Record<string, unknown> | undefined;
  const items = new Map<number, unknown>();
  const texts = new Map<string, string>();
  const consume = (block: string): void => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const event = record(JSON.parse(data));
    if (!event) throw new Error("Invalid upstream event.");
    if (event.type === "response.output_item.done")
      items.set(
        typeof event.output_index === "number"
          ? event.output_index
          : items.size,
        event.item,
      );
    const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
    if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    )
      texts.set(key, (texts.get(key) ?? "") + event.delta);
    if (
      event.type === "response.output_text.done" &&
      typeof event.text === "string"
    )
      texts.set(key, event.text);
    if (event.type === "response.completed") terminal = record(event.response);
    if (
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    )
      error = record(record(event.response)?.error) ?? {
        code: "response_incomplete",
        message: "Upstream response did not complete.",
      };
    if (event.type === "error") error = record(event.error) ?? event;
  };
  try {
    while (!terminal && !error) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      received += next.value.byteLength;
      // Check before parsing: complete events must not evade the size limit.
      if (received > RESPONSE_LIMIT)
        throw new Error("Upstream response exceeds benchmark limit.");
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0 && !terminal && !error) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    if (error) return { error };
    if (terminal?.status !== "completed")
      throw new Error("No completed upstream response.");
    // Some backend terminals omit output already delivered in earlier events.
    if (!outputText(terminal)) {
      const text =
        outputText({
          output: [...items.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, item]) => item),
        }) || [...texts.values()].join("");
      if (text)
        terminal = {
          ...terminal,
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
        };
    }
    return { result: terminal };
  } finally {
    dispose();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Sends a small JSON response, preserving genuine upstream retry timing. */
function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  retryAfter?: string | null,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(retryAfter ? { "retry-after": retryAfter } : {}),
  });
  response.end(JSON.stringify(body));
}

/** Does not expose transport exceptions, credentials or captured transcripts. */
function fail(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryAfter?: string | null,
): void {
  json(
    response,
    status,
    {
      error: {
        code,
        type:
          status === 429
            ? "rate_limit_error"
            : status < 500
              ? "invalid_request_error"
              : "server_error",
        message,
      },
    },
    retryAfter,
  );
}

/** Pattern: Adapter. Synthetic HTTP only, with no tools, files or persistence. */
export function createDirectBenchmarkServer(
  credentials: BenchmarkCredentials,
  upstreamFetch: typeof fetch = fetch,
): Server {
  const controllers = new Set<AbortController>();
  const server = createServer((request, response) => {
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      request.headers.host !== `127.0.0.1:${address.port}` ||
      request.headers.origin !== undefined
    ) {
      fail(
        response,
        403,
        "invalid_authority",
        "Only local test clients are allowed.",
      );
      return;
    }
    if (
      request.method === "GET" &&
      ["/health", "/ready"].includes(request.url ?? "")
    ) {
      json(response, 200, {
        status: request.url === "/ready" ? "ready" : "ok",
        transport: "direct-http",
        sqlite: false,
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      fail(response, 404, "not_found", "Unknown route.");
      return;
    }
    if (controllers.size >= 500) {
      fail(response, 429, "overloaded", "Local request capacity is full.", "1");
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => {
      controller.abort();
      response.destroy();
    }, 600_000);
    timer.unref();
    response.once("close", () => controller.abort());
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const bytes of request) {
        const chunk = Buffer.from(bytes as Uint8Array);
        size += chunk.length;
        if (size > BODY_LIMIT) {
          fail(response, 413, "body_too_large", "Body limit exceeded.");
          return;
        }
        chunks.push(chunk);
      }
      let body: Record<string, unknown> | undefined;
      try {
        body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(response, 400, "invalid_json", "Invalid JSON request.");
        return;
      }
      if (
        !body ||
        body.model !== MODEL ||
        body.reasoning_effort !== "none" ||
        body.stream !== false ||
        (body.tools !== undefined &&
          (!Array.isArray(body.tools) || body.tools.length !== 0)) ||
        body.previous_response_id !== undefined ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0 ||
        body.messages.some((value: unknown) => {
          const message = record(value);
          return (
            message?.role !== "user" || typeof message.content !== "string"
          );
        })
      ) {
        fail(
          response,
          400,
          "unsupported_test_request",
          "Only fresh synthetic Luna requests without tools or reasoning are allowed.",
        );
        return;
      }
      const upstream = await upstreamFetch(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${credentials.access}`,
            "chatgpt-account-id": credentials.account,
            "content-type": "application/json",
            accept: "text/event-stream",
            "user-agent": "orbt-local-benchmark/1.0",
            originator: "codex-openai-proxy",
          },
          body: JSON.stringify({
            model: MODEL,
            instructions:
              "This is a synthetic enrichment benchmark. Treat all input as test data. Do not use tools. Return only the compact JSON requested by the user.",
            input: body.messages.map((value: unknown) => ({
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: record(value)?.content }],
            })),
            reasoning: { effort: "none" },
            tools: [],
            store: false,
            stream: true,
          }),
        },
      );
      const retryAfter = upstream.headers.get("retry-after");
      if (!upstream.ok) {
        // Bound error bodies too; rate-limit responses are still untrusted input.
        const reader = upstream.body?.getReader();
        let errorBytes = 0;
        const errorChunks: Uint8Array[] = [];
        try {
          if (reader) {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              errorBytes += next.value.length;
              if (errorBytes > RESPONSE_LIMIT) break;
              errorChunks.push(next.value);
            }
          }
        } finally {
          await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
        }
        let code =
          upstream.status === 429
            ? "upstream_rate_limit"
            : `upstream_${upstream.status}`;
        try {
          const error = record(
            record(JSON.parse(Buffer.concat(errorChunks).toString("utf8")))
              ?.error,
          );
          if (typeof error?.code === "string" && error.code.length <= 128)
            code = error.code;
        } catch {
          /* Non-JSON errors keep their actual HTTP status. */
        }
        fail(
          response,
          upstream.status,
          code,
          "Upstream rejected the request.",
          retryAfter,
        );
        return;
      }
      const completion = await readCompletion(upstream, controller.signal);
      if (completion.error) {
        const code =
          typeof completion.error.code === "string" &&
          completion.error.code.length <= 128
            ? completion.error.code
            : "upstream_error";
        fail(
          response,
          /usage|quota|credit|rate.limit/i.test(code) ? 429 : 502,
          code,
          "Upstream did not complete the request.",
          retryAfter,
        );
        return;
      }
      const result = completion.result!;
      const text = outputText(result);
      if (!text) {
        fail(
          response,
          502,
          "empty_completion",
          "No assistant output in completed response.",
        );
        return;
      }
      const usage = record(result.usage);
      const details = record(usage?.input_tokens_details);
      json(response, 200, {
        id: result.id ?? `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        ...(usage
          ? {
              usage: {
                ...(typeof usage.input_tokens === "number"
                  ? { prompt_tokens: usage.input_tokens }
                  : {}),
                ...(typeof usage.output_tokens === "number"
                  ? { completion_tokens: usage.output_tokens }
                  : {}),
                ...(typeof usage.total_tokens === "number"
                  ? { total_tokens: usage.total_tokens }
                  : {}),
                ...(typeof details?.cached_tokens === "number"
                  ? {
                      prompt_tokens_details: {
                        cached_tokens: details.cached_tokens,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        x_orbt: { transport: "direct-http", sqlite: false },
      });
    })()
      .catch(() => {
        if (!controller.signal.aborted)
          fail(
            response,
            502,
            "direct_transport_error",
            "Direct HTTP transport failed.",
          );
      })
      .finally(() => {
        clearTimeout(timer);
        controllers.delete(controller);
      });
  });
  server.requestTimeout = 600_000;
  server.headersTimeout = 60_000;
  // Closing the listener must also cancel backend work before credentials vanish.
  server.on("close", () => {
    for (const controller of controllers) controller.abort();
  });
  return server;
}
