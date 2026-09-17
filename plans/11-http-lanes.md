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
