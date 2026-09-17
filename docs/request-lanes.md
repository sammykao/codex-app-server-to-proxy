# Request lanes over HTTP

The proxy still runs the official local app server. This fork adds HTTP-only
transport and a client-side lane scheduler. It does not bypass account limits or
remove the app server's SQLite storage.

## Lane model

There are 500 lane objects and 2,000 synthetic contact jobs in the example runner.
Each lane has an ID, an assigned job, a failure count and a cooldown deadline.
A ready lane takes a ready job immediately. There are no batches, global launch
pauses or launches-per-minute ceiling.

A successful contact waits 5–15 seconds before its next turn. Its lane can serve
another contact during that wait. Each contact has at most one request in flight
and advances through ten turns.

A retryable failure cools only its lane. The failed job remains queued with the
same earliest retry time, so moving it to another lane cannot skip that delay.
Other ready lanes continue working. `Retry-After` accepts seconds or a date. If
the app-server protocol does not expose upstream timing, the scheduler uses
exponential backoff with jitter instead of inventing a header.

Five hundred lanes means capacity for up to 500 in-flight requests. Cooling lanes
are not active upstream streams. This does not guarantee 500 simultaneous model
executions or any particular successful RPM. The existing proxy supports HTTP
SSE when clients request streaming; the example runner uses JSON responses.

## Durable state

`RequestLanes.snapshot()` copies lane and job metadata. The runner replaces one
private checkpoint file every five seconds rather than appending unlimited logs.
To restore state, pass the saved snapshot to the constructor after stopping the
old executor. Interrupted jobs may be retried: recovery is at least once, not
exactly once. Production work needs application-level idempotency for writes.

Checkpoints do not contain prompts, contact data, credentials or model output.
They do not make the upstream process stateless. Production can place the lane
metadata in a durable queue while hosting the app server on a separate machine.

## Start the adapter

```sh
npm ci
npm run build
node dist/bin.js serve \
  --codex-home /path/to/isolated-account \
  --sync-auth never \
  --http-only true \
  --max-requests 500 \
  --request-timeout 10m
```

It stays loopback-only. Do not expose an unauthenticated listener publicly.
Keep credentials outside the repository and select the intended account before
running live calls. HTTP-only mode sets both internal retry budgets to zero and
disables WebSockets. Authentication and tool policies are unchanged.

## Optional finite benchmark

No live benchmark runs during installation or offline tests. This command spends
subscription usage, including usage on the account you use to chat if they match.
The old exhaustion harness remains stopped.

```sh
BENCH_AUTH_HOME=/path/to/isolated-account \
BENCH_ACCOUNT_HASH=expected-account-hash \
BENCH_OUT=/path/outside/repository/lane-results.json \
STRESS_CONFIRM=I_UNDERSTAND_THIS_BURNS_SUBSCRIPTION_USAGE \
node scripts/benchmark-lanes.mjs
```

The selected home must already contain `auth.json` and `models_cache.json`.
The account hash is the first 16 hexadecimal characters of SHA-256 of
`tokens.account_id`; the key itself is never printed. The runner refuses an
account mismatch or an occupied test port (8793).

Defaults: 300 seconds, 500 lanes, ten turns per contact, no launch-rate ceiling,
`gpt-5.6-luna`, reasoning `none`, and the previous roughly 75K-token synthetic
context. Reported usage includes the measured minimum prompt size. Identical
synthetic prefixes are cache-friendly and do not establish production cache rates.
This is a scheduling simulation, not the production enrichment workflow.

The report separates attempts, successful completions, retryable errors, final
errors and aborted requests. It includes completions per minute, HTTP status
counts, error codes, token usage and observed Retry-After headers. Attempts count
client requests to the adapter, not hidden upstream requests in default mode.
Unfinished requests are cancelled at the deadline and are not counted as successes.

The runner stops early on an account usage limit, a proxy exit, less than 2 GiB
free disk, or more than 1 GiB of test storage. It stops its child before deleting
only the temporary directory it created. It never deletes the selected account
home or truncates a live SQLite database. A stopped or shortened run is not a
five-minute sustained-RPM measurement. Reports and checkpoints remain outside
the repository. It does not update any existing running-total file automatically.

## Repeat the transport A/B test

Use the same workload for both arms, one after another. These commands are
optional live tests, not part of the offline suite.

```sh
export BENCH_AUTH_HOME=/path/to/isolated-account
export STRESS_CONFIRM=I_UNDERSTAND_THIS_BURNS_SUBSCRIPTION_USAGE
export BENCH_LANES=2
export BENCH_SECONDS=30
BENCH_HTTP_ONLY=false BENCH_OUT=/path/outside/repository/default.json \
  node scripts/benchmark-lanes.mjs
BENCH_HTTP_ONLY=true BENCH_OUT=/path/outside/repository/http.json \
  node scripts/benchmark-lanes.mjs
```

The earlier saved test had seven logical turns per arm. Default transport had
seven successes over 14 adapter requests, 150 WebSocket 403 log events and 58
internal retry events. HTTP-only had six successes over 39 adapter requests, zero
WebSocket 403 events and zero internal retry events. The seventh turn failed.
Those are diagnostic observations, not an RPM improvement claim. Log events are
not request counts. Account load, cache state and arm ordering were not controlled
well enough to infer higher throughput. Fresh turns were used; conversation-ID
continuation was not validated.
