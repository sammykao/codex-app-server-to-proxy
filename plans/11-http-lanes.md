# HTTP lanes

HTTP-only mode is opt-in. It disables WebSockets and internal request and stream
retries so an external scheduler owns backoff. It does not change account limits,
authentication, loopback binding, or tool policies.

Only intermediate errors marked `willRetry: true` are ignored. Terminal upstream
429 errors retain their status; genuine 502 and 503 failures remain failures.
Health and readiness checks remain available when model slots are full.

The next layer uses an event-driven delay queue and explicit lane states. Lanes
are separate from contacts: a lane retains its cooldown when assigned another
contact. A delayed job cannot jump to a healthy lane to skip its retry delay.

Implemented as `RequestLanes`, independent of the HTTP response transport.
The finite runner uses atomic metadata checkpoints, a bounded diagnostic tail,
and an isolated child home. SQLite storage is still owned by the app server;
disk guards stop the test rather than modifying a live database. The scheduling
tests run offline. Live benchmarks require explicit opt-in and never update an
existing running count automatically.

Local segmented runs can restore `BENCH_RESUME` metadata after a stopped child's
temporary storage has been removed. Absolute lane deadlines survive rotations.
`BENCH_MAX_ATTEMPTS` bounds the total adapter requests in a segment. A supervisor
may chain finite segments within one wall-clock deadline; throughput must include
restart overhead and cancellations rather than claiming continuous transport.

The local synthetic-only direct HTTP benchmark can run for 600 seconds without
an app-server. It uses `store: false`, no tools, no conversation continuation and
no SQLite library. It is a different transport, not a production policy bypass.
The default app-server mode remains unchanged. Storage scans record actual
SQLite file counts; direct mode stops if any appear. Both modes retain disk guards.

The direct adapter is now included in the checkout rather than loaded from an
external script. Its internal factory has no startup side effects. Offline tests
cover terminal completion, split SSE frames, malformed requests, bounded response
memory, exact upstream statuses and Retry-After. It omits unavailable usage and
redacts transport exceptions. Per-request limits are 1 MiB input and 2 MiB upstream
response; reports and checkpoints are overwritten, not appended. Reports from
different runs remain until the operator removes or archives them.
