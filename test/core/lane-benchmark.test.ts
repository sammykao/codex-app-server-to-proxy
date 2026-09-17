import assert from "node:assert/strict";
import { test } from "vitest";
import { benchmarkOptions } from "../../scripts/benchmark-lanes.mjs";

/** Opt-in environment used only to test parsing; it never sends a request. */
const env = {
  BENCH_AUTH_HOME: "/test-account",
  STRESS_CONFIRM: "I_UNDERSTAND_THIS_BURNS_SUBSCRIPTION_USAGE",
};

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
