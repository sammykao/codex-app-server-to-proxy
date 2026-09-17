import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createDirectBenchmarkServer } from "../dist/benchmark/direct-http.js";

/** Runs only against the explicitly selected, short-lived benchmark login. */
async function main() {
  if (process.env.STRESS_CONFIRM !== "I_UNDERSTAND_THIS_BURNS_SUBSCRIPTION_USAGE")
    throw new Error("Set STRESS_CONFIRM before making live calls.");
  if (!process.env.CODEX_HOME || !process.env.BENCH_ACCOUNT_HASH)
    throw new Error("Select an account home and expected account hash.");
  const auth = JSON.parse(await readFile(join(process.env.CODEX_HOME, "auth.json"), "utf8"));
  const account = auth.tokens?.account_id;
  const access = auth.tokens?.access_token;
  if (typeof account !== "string" || typeof access !== "string")
    throw new Error("Selected home has no subscription login.");
  const hash = createHash("sha256").update(account).digest("hex").slice(0, 16);
  if (hash !== process.env.BENCH_ACCOUNT_HASH) throw new Error("Account mismatch.");
  const expiration = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString()).exp;
  if (!Number.isFinite(expiration) || expiration * 1000 < Date.now() + 660_000)
    throw new Error("Login expires too soon; reauthenticate the selected home.");
  const server = createDirectBenchmarkServer({ account, access });
  server.once("error", () => { process.stderr.write("Cannot start benchmark listener.\n"); process.exitCode = 1; });
  server.listen(8793, "127.0.0.1");
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

await main().catch(() => { process.stderr.write("Cannot start direct benchmark; check account selection and login expiry.\n"); process.exitCode = 1; });
