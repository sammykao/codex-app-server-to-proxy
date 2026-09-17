import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  statfs,
  readdir,
  stat,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import {
  RequestLanes,
  retryAfterMilliseconds,
  fallbackDelay,
} from "../dist/core/request-lanes.js";

/** Writes private metadata atomically; checkpoints do not grow with attempts. */
async function save(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
}

/** Measures this run's storage without inspecting unrelated user files. */
async function treeBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(path);
    else if (entry.isFile())
      bytes += (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return bytes;
}

/** Validates live opt-in and workload bounds without making network calls. */
export function benchmarkOptions(env) {
  if (env.STRESS_CONFIRM !== "I_UNDERSTAND_THIS_BURNS_SUBSCRIPTION_USAGE")
    throw new Error("Set STRESS_CONFIRM before making live calls.");
  if (!env.BENCH_AUTH_HOME)
    throw new Error("Set BENCH_AUTH_HOME to the intended logged-in account.");
  const duration = Number(env.BENCH_SECONDS ?? 300);
  const laneCount = Number(env.BENCH_LANES ?? 500);
  const httpOnly = env.BENCH_HTTP_ONLY ?? "true";
  if (!["true", "false"].includes(httpOnly))
    throw new Error("BENCH_HTTP_ONLY must be true or false.");
  if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 500)
    throw new Error("Lane count must be 1–500.");
  if (!Number.isInteger(duration) || duration < 1 || duration > 300)
    throw new Error("Benchmark duration must be 1–300 seconds.");
  return { duration, laneCount, httpOnly };
}

/** Creates an isolated, finite HTTP benchmark; never starts the old harness. */
async function main() {
  const { duration, laneCount, httpOnly } = benchmarkOptions(process.env);
  // Refuse to attach to an unrelated process already using the test port.
  const probe = createServer();
  await new Promise((resolveProbe, rejectProbe) => {
    probe.once("error", rejectProbe);
    probe.listen(8793, "127.0.0.1", resolveProbe);
  });
  await new Promise((resolveClose, rejectClose) =>
    probe.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  const runId = randomUUID();
  const out = resolve(process.env.BENCH_OUT ?? `lane-benchmark-${runId}.json`);
  const temporary = await mkdtemp(join(tmpdir(), "proxy-lanes-"));
  try {
    await chmod(temporary, 0o700);
    const home = join(temporary, "home");
    const root = join(temporary, "root");
    const state = join(temporary, "state");
    await Promise.all(
      [home, root, state].map((path) => mkdir(path, { mode: 0o700 })),
    );
    const auth = JSON.parse(
      await readFile(join(process.env.BENCH_AUTH_HOME, "auth.json"), "utf8"),
    );
    if (!auth.tokens?.account_id)
      throw new Error("No logged-in subscription account in selected home.");
    const accountHash = createHash("sha256")
      .update(auth.tokens.account_id)
      .digest("hex")
      .slice(0, 16);
    if (
      process.env.BENCH_ACCOUNT_HASH &&
      process.env.BENCH_ACCOUNT_HASH !== accountHash
    )
      throw new Error("Account hash mismatch.");
    await copyFile(
      join(process.env.BENCH_AUTH_HOME, "auth.json"),
      join(home, "auth.json"),
    );
    await chmod(join(home, "auth.json"), 0o600);
    // The pinned runtime does not parse newer catalog effort variants. Only
    // advertised effort metadata is filtered; model entitlement is unchanged.
    const catalog = JSON.parse(
      await readFile(
        join(process.env.BENCH_AUTH_HOME, "models_cache.json"),
        "utf8",
      ),
    );
    for (const model of catalog.models) {
      model.supported_reasoning_levels =
        model.supported_reasoning_levels?.filter((level) =>
          ["none", "minimal", "low", "medium", "high", "xhigh"].includes(
            level.effort,
          ),
        );
    }
    await save(join(home, "models_cache.json"), catalog);
    await writeFile(
      join(home, "config.toml"),
      'cli_auth_credentials_store = "file"\n[history]\npersistence = "none"\n',
      { mode: 0o600 },
    );
    const stop = new globalThis.AbortController();
    const signalStop = () => stop.abort();
    process.once("SIGINT", signalStop);
    process.once("SIGTERM", signalStop);
    let proxy;
    let exit;
    let peakStorageBytes = 0;
    const report = {
      runId,
      accountHash,
      model: "gpt-5.6-luna",
      reasoning: "none",
      transport: httpOnly === "true" ? "HTTP" : "default",
      laneCount,
      contacts: 2000,
      turnsPerContact: 10,
      targetContextTokens: 75000,
      launchCeiling: null,
      retryScope: "lane",
      searchDelayMs: [5000, 15000],
      attempts: 0,
      successes: 0,
      retryableErrors: 0,
      finalErrors: 0,
      aborted: 0,
      statuses: {},
      errorCodes: {},
      perMinuteSuccesses: Array.from(
        { length: Math.ceil(duration / 60) },
        () => 0,
      ),
      promptTokens: 0,
      cachedTokens: 0,
      minimumPromptTokens: null,
      maximumInFlight: 0,
      stopReason: "duration",
      retryAfterSeen: 0,
    };
    const queue = new RequestLanes(
      laneCount,
      Array.from({ length: report.contacts }, (_, i) => ({
        id: `synthetic-${i}`,
        turn: 0,
        readyAt: 0,
      })),
    );
    const pending = new Set();
    const context = "x ".repeat(67429);
    let started;
    let lastCheckpoint = 0;
    try {
      proxy = spawn(
        process.execPath,
        [
          "dist/bin.js",
          "serve",
          "--root",
          root,
          "--codex-home",
          home,
          "--state-dir",
          state,
          "--sync-auth",
          "never",
          "--port",
          "8793",
          "--http-only",
          httpOnly,
          "--request-timeout",
          "10m",
          "--max-requests",
          String(laneCount),
          "--log-level",
          "error",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, RUST_LOG: "error" },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      exit = new Promise((resolveExit) => proxy.once("exit", resolveExit));
      // Keep only a bounded diagnostic tail in memory, never raw logs on disk.
      let diagnostics = "";
      proxy.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-4000);
      });
      let ready = false;
      for (let i = 0; i < 90 && !stop.signal.aborted; i++) {
        if (proxy.exitCode !== null)
          throw new Error(`Proxy exited before readiness: ${diagnostics}`);
        try {
          ready = (
            await fetch("http://127.0.0.1:8793/ready", {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          /* Readiness is bounded above. */
        }
        if (ready) break;
        await wait(500);
      }
      if (!ready) throw new Error("Proxy did not become ready.");
      started = Date.now();
      report.startedAt = new Date(started).toISOString();
      process.stdout.write(
        JSON.stringify({
          event: "started",
          runId,
          accountHash,
          laneCount,
          duration,
        }) + "\n",
      );
      const send = async (assignment) => {
        report.attempts++;
        try {
          const response = await fetch(
            "http://127.0.0.1:8793/v1/chat/completions",
            {
              method: "POST",
              signal: stop.signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: report.model,
                reasoning_effort: "none",
                stream: false,
                messages: [
                  {
                    role: "user",
                    content: `${context}\nSynthetic enrichment ${assignment.job.id}, turn ${assignment.job.turn + 1}. Return only {"summary":"synthetic","confidence":1}. Do not use tools.`,
                  },
                ],
              }),
            },
          );
          const payload = await response.json();
          if (payload.error?.code)
            report.errorCodes[payload.error.code] =
              (report.errorCodes[payload.error.code] ?? 0) + 1;
          report.statuses[response.status] =
            (report.statuses[response.status] ?? 0) + 1;
          const now = Date.now();
          if (response.ok && payload.choices?.[0]?.message) {
            report.successes++;
            const minute = Math.min(
              report.perMinuteSuccesses.length - 1,
              Math.floor((now - started) / 60000),
            );
            report.perMinuteSuccesses[minute]++;
            const tokens = Number(payload.usage?.prompt_tokens ?? 0);
            report.promptTokens += tokens;
            report.cachedTokens += Number(
              payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            );
            report.minimumPromptTokens =
              report.minimumPromptTokens === null
                ? tokens
                : Math.min(report.minimumPromptTokens, tokens);
            queue.succeed(
              assignment,
              now,
              5000 + Math.floor(Math.random() * 10001),
              report.turnsPerContact,
            );
          } else if (
            [408, 425, 429, 500, 502, 503, 504].includes(response.status) &&
            payload.error?.code !== "usage_limit_exceeded"
          ) {
            report.retryableErrors++;
            const retryAfter = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              now,
            );
            if (retryAfter !== undefined) report.retryAfterSeen++;
            queue.retry(
              assignment,
              now,
              retryAfter ??
                fallbackDelay(response.status, assignment.lane.failures + 1),
            );
            if (
              payload.error?.x_codex?.reset_at ||
              payload.error?.code === "usage_limit_reached"
            ) {
              report.stopReason = "usage-limit";
              stop.abort();
            }
          } else {
            report.finalErrors++;
            queue.fail(assignment);
            if (
              /usage.limit|quota|insufficient/i.test(payload.error?.code ?? "")
            ) {
              report.stopReason = "usage-limit";
              stop.abort();
            }
          }
        } catch {
          if (stop.signal.aborted) {
            report.aborted++;
            queue.retry(assignment, Date.now(), 1000);
          } else {
            report.retryableErrors++;
            report.statuses.transport = (report.statuses.transport ?? 0) + 1;
            queue.retry(
              assignment,
              Date.now(),
              fallbackDelay(502, assignment.lane.failures + 1),
            );
          }
        }
      };
      while (!stop.signal.aborted && Date.now() - started < duration * 1000) {
        if (proxy.exitCode !== null) {
          report.stopReason = "proxy-exit";
          break;
        }
        let assignment;
        while ((assignment = queue.take(Date.now()))) {
          const operation = send(assignment);
          pending.add(operation);
          operation.finally(() => pending.delete(operation));
        }
        report.maximumInFlight = Math.max(report.maximumInFlight, pending.size);
        if (Date.now() - lastCheckpoint > 5000) {
          lastCheckpoint = Date.now();
          const disk = await statfs(temporary);
          const bytes = await treeBytes(temporary);
          peakStorageBytes = Math.max(peakStorageBytes, bytes);
          await save(`${out}.checkpoint.json`, queue.snapshot());
          await save(out, {
            ...report,
            elapsedSeconds: (Date.now() - started) / 1000,
            inFlight: pending.size,
            coolingLanes: queue.lanes.filter(
              (lane) => lane.readyAt > Date.now(),
            ).length,
            peakStorageBytes,
          });
          if (disk.bavail * disk.bsize < 2 * 1024 ** 3 || bytes > 1024 ** 3) {
            report.stopReason = "disk-safety";
            break;
          }
          process.stdout.write(
            JSON.stringify({
              event: "progress",
              seconds: Math.round((Date.now() - started) / 1000),
              attempts: report.attempts,
              successes: report.successes,
              retryableErrors: report.retryableErrors,
              inFlight: pending.size,
              storageMB: Math.round(bytes / 1024 ** 2),
            }) + "\n",
          );
        }
        await wait(100);
      }
    } finally {
      const measurementSeconds = started
        ? Math.min(duration, (Date.now() - started) / 1000)
        : 0;
      stop.abort();
      await Promise.allSettled(pending);
      if (proxy && proxy.exitCode === null) {
        proxy.kill("SIGINT");
        await Promise.race([exit, wait(10000)]);
        if (proxy.exitCode === null) {
          proxy.kill("SIGKILL");
          await exit;
        }
      }
      const elapsedSeconds = started ? (Date.now() - started) / 1000 : 0;
      report.elapsedSeconds = elapsedSeconds;
      report.measurementSeconds = measurementSeconds;
      report.rpm = measurementSeconds
        ? (report.successes * 60) / measurementSeconds
        : 0;
      report.sustainedFiveMinuteRpm =
        report.stopReason === "duration" && measurementSeconds === 300
          ? report.successes / 5
          : null;
      report.peakStorageBytes = peakStorageBytes;
      report.cacheFraction = report.promptTokens
        ? report.cachedTokens / report.promptTokens
        : null;
      report.finishedAt = new Date().toISOString();
      await save(out, report);
      await save(`${out}.checkpoint.json`, queue.snapshot());
      process.off("SIGINT", signalStop);
      process.off("SIGTERM", signalStop);
      process.stdout.write(
        JSON.stringify({ event: "finished", ...report }) + "\n",
      );
    }
  } finally {
    // Delete only the freshly created test directory, after its child stops.
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
