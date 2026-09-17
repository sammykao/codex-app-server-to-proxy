# SQLite-free benchmark review

Reviewed with the community `karpathy-guidelines` skill from
[multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills).
This is derived from Karpathy's observations, not an official Karpathy package.

## Scope and decisions

- Keep the default app-server transport, authentication and tool policy unchanged.
- Include the previously external synthetic adapter so the fork is reproducible.
- Require explicit live opt-in and verify the selected account before startup.
- Count success only after a completed terminal response with assistant output.
- Preserve actual HTTP failures and real Retry-After values. Do not count 502 as success.
- Bound the whole upstream response, not just an unfinished SSE frame.
- Test split UTF-8/CRLF frames and terminal responses that omit earlier output.
- Omit missing usage counters rather than inventing zeros.
- Keep credentials, transcripts and runtime reports out of the repository.
- Keep reports and checkpoints bounded during a run. Repeated runs still create
  reports; the default app-server still creates SQLite.

## Verification

The default checks are offline. The direct adapter tests inject a fake upstream
and use ephemeral loopback listeners. No load test is required to merge this change.
`npm run check` passed: 402 tests, including 23 direct-adapter cases. Build,
typecheck, lint, formatting, protocol regeneration and coverage floors passed.

## Follow-up review

Review maintained source, scripts and tests for concrete correctness or lifecycle
issues before creating small refactoring PRs. Do not split modules or add provider
frameworks solely for style. Generated protocol code is checked by regeneration
and contract tests rather than hand edited.
