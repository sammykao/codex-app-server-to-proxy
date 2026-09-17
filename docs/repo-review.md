# Fork review

Applied the community Karpathy guidelines: identify concrete failures, reproduce
them in offline tests, make narrow changes and preserve existing contracts.

## Scope

Reviewed the 26 maintained runtime modules and eight scripts, covering CLI
lifecycle, authentication, JSON-RPC, policy, continuation state, HTTP validation,
event normalization, quota translation, lanes and benchmark transports. Reviewed
test boundaries, fixtures and support code alongside the affected implementations.
Also checked the three JavaScript configurations and four GitHub workflows.

Generated protocol artifacts are verified by regeneration, typed fixtures and
contract tests, not manually refactored. This is a code review, not a guarantee
that every defect or security issue has been found.

## Refactoring stack

1. Validate restored lanes and retry headers. Corrupt IDs or duplicated jobs can
   break assignment; permissive numeric parsing can turn invalid retry headers
   into dates or infinite delays. Regression tests reproduce both failures.
2. Consolidate benchmark storage and completion accounting. One scan replaces
   two walks. Empty or unfinished replies do not count as successes. Missing
   usage is not a zero-token sample, and missing cache data is excluded from the
   cache denominator. Operator interruption is distinct from finishing a window.
3. Share exact token-count validation. Last-request fallback previously emitted
   negative, fractional or non-finite optional details. The cumulative store,
   normalizer, direct adapter and benchmark now use the same safe-integer rule.

The first and third changes have tests that failed before the fixes. The second
adds independent tests for storage and accounting. Each PR is based on the
previous branch so its diff contains only its own change.

## Existing constraints left in place

- The default app-server and durable continuation mappings still use storage.
  Retention is time-based, not a constant-size request history. The direct
  benchmark does not exercise these components.
- The default transport remembers raw-response-capable threads and interrupted
  tool turns for its process generation. These sets can grow in a long-lived
  process. Changing their lifetime needs continuation/replay tests; arbitrary
  eviction would change behavior and is not included in this stack.
- HTTP probes are handled before model-slot allocation. Their duplicated route
  branches are unreachable but harmless; no broad router rewrite is warranted.
- JSON-RPC relies on the HTTP concurrency limit and trusted pinned child process.
  It is not a standalone untrusted-input transport.
- The direct benchmark has no OAuth refresh, managed execution policy, tool
  execution or continuation. It uses an undocumented subscription backend and
  is not a supported production API.
- New benchmark runs retain their own reports. Nothing deletes previous counts
  or implements cross-run report retention automatically.
- npm publishing is still configured for the upstream identity. It fails closed
  from this fork. No publishing workflow was dispatched or registry write made.

No provider abstraction, speculative plugin system, module-wide rewrite or
unrelated dependency upgrade was added. The production ingestion repository was
not changed. The harness stayed stopped and no live successes were added.

## Verification

Build, strict source/test typechecks, lint, formatting, protocol drift and the
full offline suite are required. The packed CLI smoke test is also run. A
production-dependency audit reported no known advisories at review time; that
does not certify dependency safety.
The final complete offline check passed with 428 tests, including the 500-slot
saturation case, which makes no provider calls. Coverage floors passed,
including 90.20% maintained-source line coverage. The packed CLI smoke test passed.
No GitHub checks were reported on the first PR;
its reviewed commit was merged only after the local gates passed.
