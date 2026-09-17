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
