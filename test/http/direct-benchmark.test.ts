import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import {
  createDirectBenchmarkServer,
  outputText,
  readCompletion,
} from "../../src/benchmark/direct-http.js";

/** Only synthetic fixtures are passed to the injected offline transport. */
const credentials = { account: "test-account", access: "test-token" };
/** The benchmark accepts only this narrow request shape. */
const request = {
  model: "gpt-5.6-luna",
  reasoning_effort: "none",
  stream: false,
  messages: [{ role: "user", content: "synthetic input" }],
};
/** Tracks local listeners so failures never leak sockets into another test. */
const servers: Server[] = [];
/** Creates a synthetic completed message item. */
function message(text: string) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}
/** Serializes synthetic events; no provider calls or captured transcripts. */
function stream(...events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}
/** Starts an ephemeral loopback-only listener with an injected provider. */
async function start(provider: typeof fetch): Promise<string> {
  const server = createDirectBenchmarkServer(credentials, provider);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
/** Sends a local test request; the upstream transport is always mocked. */
async function post(url: string, body: unknown = request): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

test("confirmed completions preserve measured usage without persistence", async () => {
  const provider = vi.fn<typeof fetch>().mockResolvedValue(
    stream({
      type: "response.completed",
      response: {
        status: "completed",
        output: [message("{}")],
        usage: {
          input_tokens: 75000,
          output_tokens: 2,
          total_tokens: 75002,
          input_tokens_details: { cached_tokens: 74000 },
        },
      },
    }),
  );
  const result = await post(await start(provider));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.choices[0].message.content, "{}");
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 74000);
  assert.deepEqual(body.x_orbt, { transport: "direct-http", sqlite: false });
  const sent = JSON.parse(String(provider.mock.calls[0]?.[1]?.body));
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.tools, []);
});

test("unavailable usage is omitted, not replaced with estimated zero counts", async () => {
  const url = await start(async () =>
    stream({
      type: "response.completed",
      response: {
        status: "completed",
        output: [message("{}")],
        usage: { input_tokens: 75 },
      },
    }),
  );
  const body = await (await post(url)).json();
  assert.deepEqual(body.usage, { prompt_tokens: 75 });
});

test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "direct usage omits invalid counts without failing a completed reply: %s",
  async (count) => {
    const url = await start(async () =>
      stream({
        type: "response.completed",
        response: {
          status: "completed",
          output: [message("{}")],
          usage: {
            input_tokens: 75,
            output_tokens: count,
            total_tokens: count,
            input_tokens_details: { cached_tokens: count },
          },
        },
      }),
    );
    const body = await (await post(url)).json();
    assert.deepEqual(body.usage, { prompt_tokens: 75 });
  },
);

test.each([429, 502, 503])(
  "real upstream %i and Retry-After survive translation",
  async (status) => {
    const url = await start(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "usage_limit_reached" } }),
          { status, headers: { "retry-after": "900" } },
        ),
    );
    const response = await post(url);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "900");
    assert.equal((await response.json()).error.code, "usage_limit_reached");
  },
);

test("typed stream errors stay failures and preserve rate-limit classification", async () => {
  const url = await start(async () =>
    stream({
      type: "error",
      code: "rate_limit_exceeded",
      message: "synthetic error",
    }),
  );
  const response = await post(url);
  assert.equal(response.status, 429);
});

test.each([
  { type: "response.created" },
  { type: "response.incomplete", response: {} },
  { type: "response.failed", response: {} },
  { type: "response.completed", response: { status: "completed", output: [] } },
])(
  "partial, failed and empty responses are not successes: %j",
  async (event) => {
    const response = await post(await start(async () => stream(event)));
    assert.equal(response.status, 502);
  },
);

test("terminal output omitted by the backend is recovered only after completion", async () => {
  const result = await readCompletion(
    stream(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: message("{}"),
      },
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ),
    new AbortController().signal,
  );
  assert.equal(outputText(result.result!), "{}");
  await assert.rejects(
    readCompletion(
      stream({ type: "response.output_text.delta", delta: "{}" }),
      new AbortController().signal,
    ),
    /No completed/,
  );
});

test("split CRLF and multibyte UTF-8 boundaries retain completed text", async () => {
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "é" })}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\r\n\r\n`,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const result = await readCompletion(
    new Response(body),
    new AbortController().signal,
  );
  assert.equal(outputText(result.result!), "é");
});

test("both complete oversized events and accumulated small events are bounded", async () => {
  const event = {
    type: "response.output_text.delta",
    delta: "x".repeat(1024 ** 2),
  };
  await assert.rejects(
    readCompletion(stream(event, event), new AbortController().signal),
    /exceeds benchmark limit/,
  );
  await assert.rejects(
    readCompletion(
      stream({
        type: "response.completed",
        response: {
          status: "completed",
          output: [message("x".repeat(2 * 1024 ** 2))],
        },
      }),
      new AbortController().signal,
    ),
    /exceeds benchmark limit/,
  );
});

test("aborting a blocked stream cancels its reader", async () => {
  const cancel = vi.fn();
  const controller = new AbortController();
  const result = readCompletion(
    new Response(new ReadableStream({ cancel })),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(result);
  assert.equal(cancel.mock.calls.length, 1);
});

test.each([
  null,
  { ...request, messages: [] },
  { ...request, messages: [null] },
  { ...request, tools: {} },
  { ...request, tools: [{ type: "function" }] },
  { ...request, previous_response_id: "prior" },
])(
  "unsafe and malformed requests never reach the provider: %j",
  async (body) => {
    const provider = vi.fn<typeof fetch>();
    const result = await post(await start(provider), body);
    assert.equal(result.status, 400);
    assert.equal(provider.mock.calls.length, 0);
  },
);

test("invalid JSON and oversized input are client errors, not transport failures", async () => {
  const provider = vi.fn<typeof fetch>();
  const url = await start(provider);
  assert.equal(
    (await fetch(`${url}/v1/chat/completions`, { method: "POST", body: "{" }))
      .status,
    400,
  );
  assert.equal(
    (
      await post(url, {
        ...request,
        messages: [{ role: "user", content: "x".repeat(1024 ** 2) }],
      })
    ).status,
    413,
  );
  assert.equal(provider.mock.calls.length, 0);
});

test("probe routing rejects browser origins and hostile authorities", async () => {
  const url = await start(vi.fn<typeof fetch>());
  assert.equal((await fetch(`${url}/ready`)).status, 200);
  assert.equal(
    (await fetch(`${url}/health`, { headers: { origin: "" } })).status,
    403,
  );
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${url}/ready`,
        { headers: { host: "example.com" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once("error", reject);
      request.end();
    }),
    403,
  );
  assert.equal((await fetch(`${url}/unknown`)).status, 404);
});

test("transport exceptions are redacted and the released slot is reusable", async () => {
  const provider = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("secret transcript"))
    .mockResolvedValueOnce(
      stream({
        type: "response.completed",
        response: { status: "completed", output: [message("{}")] },
      }),
    );
  const url = await start(provider);
  const first = await post(url);
  assert.equal(first.status, 502);
  assert(!JSON.stringify(await first.json()).includes("secret transcript"));
  assert.equal((await post(url)).status, 200);
});

test("500 occupied slots reject extra work while probes remain usable", async () => {
  const release: Array<() => void> = [];
  const provider: typeof fetch = async (_url, options) =>
    new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new Error("synthetic cancellation"));
      options?.signal?.addEventListener("abort", abort, { once: true });
      release.push(() => {
        options?.signal?.removeEventListener("abort", abort);
        resolve(
          stream({
            type: "response.completed",
            response: { status: "completed", output: [message("{}")] },
          }),
        );
      });
    });
  const url = await start(provider);
  const clients = Array.from({ length: 500 }, () => post(url));
  const deadline = Date.now() + 10000;
  try {
    while (release.length < 500 && Date.now() < deadline) await wait(10);
    assert.equal(release.length, 500);
    assert.equal((await fetch(`${url}/ready`)).status, 200);
    const overflow = await post(url);
    assert.equal(overflow.status, 429);
    assert.equal(overflow.headers.get("retry-after"), "1");
    assert.equal(release.length, 500);
  } finally {
    for (const finish of release) finish();
    const responses = await Promise.all(clients);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
  }
}, 15000);
