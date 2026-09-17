import assert from "node:assert/strict";
import { test } from "vitest";
import {
  benchmarkOptions,
  storageStats,
  confirmedCompletion,
  benchmarkTokenUsage,
} from "../../scripts/benchmark-lanes.mjs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "../support/temp.js";

/** Opt-in environment used only to test parsing; it never sends a request. */
const env = {
  BENCH_AUTH_HOME: "/test-account",
  STRESS_CONFIRM: "I_UNDERSTAND_THIS_BURNS_SUBSCRIPTION_USAGE",
};

test("storage accounting combines nested files and SQLite sidecars without following symlinks", async () => {
  await withTempDir(async (directory) => {
    const child = join(directory, "child");
    await mkdir(child);
    await writeFile(join(directory, "auth.json"), "synthetic");
    await writeFile(join(child, "state.sqlite"), "1234");
    await writeFile(join(child, "state.sqlite-wal"), "12");
    await writeFile(join(child, "state.sqlite-shm"), "1");
    if (process.platform !== "win32")
      await symlink(directory, join(child, "loop"));
    assert.deepEqual(await storageStats(directory), {
      bytes: 16,
      sqliteFiles: 3,
    });
  });
});

test("the benchmark rejects empty, unfinished and error-shaped HTTP 200 bodies", () => {
  const reply = {
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: "{}" } },
    ],
  };
  assert.equal(confirmedCompletion(reply), true);
  for (const value of [
    null,
    {},
    { error: {}, ...reply },
    { choices: [{ message: {} }] },
    {
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: "{}" },
        },
      ],
    },
    {
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: " " } },
      ],
    },
  ])
    assert.equal(confirmedCompletion(value), false);
});

test("missing and malformed counters are not invented measurements", () => {
  assert.deepEqual(benchmarkTokenUsage({}), {});
  for (const value of [
    -1,
    NaN,
    Infinity,
    "75000",
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.deepEqual(
      benchmarkTokenUsage({ usage: { prompt_tokens: value } }),
      {},
    );
  assert.deepEqual(benchmarkTokenUsage({ usage: { prompt_tokens: 75000 } }), {
    prompt: 75000,
  });
  assert.deepEqual(
    benchmarkTokenUsage({
      usage: {
        prompt_tokens: 75000,
        prompt_tokens_details: { cached_tokens: 74000 },
      },
    }),
    { prompt: 75000, cached: 74000 },
  );
  for (const value of [-1, NaN, Infinity, 75001])
    assert.deepEqual(
      benchmarkTokenUsage({
        usage: {
          prompt_tokens: 75000,
          prompt_tokens_details: { cached_tokens: value },
        },
      }),
      { prompt: 75000 },
    );
});

test("benchmark defaults retain the agreed workload and require opt-in", () => {
  assert.deepEqual(benchmarkOptions(env), {
    duration: 300,
    laneCount: 500,
    httpOnly: "true",
  });
  assert.throws(() => benchmarkOptions({}));
  assert.throws(() => benchmarkOptions({ STRESS_CONFIRM: env.STRESS_CONFIRM }));
});

test("A/B options cannot silently exceed the finite benchmark bounds", () => {
  assert.deepEqual(
    benchmarkOptions({
      ...env,
      BENCH_HTTP_ONLY: "false",
      BENCH_LANES: "2",
      BENCH_SECONDS: "30",
    }),
    { duration: 30, laneCount: 2, httpOnly: "false" },
  );
  for (const value of ["0", "501", "2.5", "invalid"])
    assert.throws(() => benchmarkOptions({ ...env, BENCH_LANES: value }));
  for (const value of ["0", "301", "2.5", "invalid"])
    assert.throws(() => benchmarkOptions({ ...env, BENCH_SECONDS: value }));
  assert.throws(() => benchmarkOptions({ ...env, BENCH_HTTP_ONLY: "invalid" }));
});

test("only the separate direct HTTP test allows a ten-minute segment", () => {
  assert.equal(
    benchmarkOptions({
      ...env,
      BENCH_TRANSPORT: "direct-http",
      BENCH_SECONDS: "600",
    }).duration,
    600,
  );
  assert.throws(() =>
    benchmarkOptions({
      ...env,
      BENCH_TRANSPORT: "direct-http",
      BENCH_SECONDS: "601",
    }),
  );
  assert.throws(() => benchmarkOptions({ ...env, BENCH_TRANSPORT: "unknown" }));
});
