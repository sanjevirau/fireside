# Phase B: developer tools implementation

Status: in progress. This is not a completed phase or release qualification.

The committed [Phase A oracle](phase-a-developer-tools.md) and
[predeclared resource/overhead checks](../benchmarks/phase-a-developer-tools.json)
remain the contract. No private consumer inputs are required.

## First increment: real allow-decision instrumentation

- Preserve the immutable rules source and exact allow declaration locations.
- Add opt-in single-operation and atomic tracing without a second evaluation.
- Retain actual allow/deny/error outcomes, including errors masked by a later allow.
- Bound each internal operation trace to 1,000 fixed-size outcomes, explicitly
  counting omissions. Do not copy documents or tokens into this trace.
- Leave existing serving paths unchanged until the bounded transport is ready.

Tests compare the captured ten evaluation contexts with their actual outcomes and
source lines. They distinguish the jar's accumulated history from a single
evaluation; they do not claim identical counts of live WebSocket messages.
Constructed regressions cover short-circuiting, method filtering, empty matches,
non-ASCII/CRLF source offsets, trace-cap overflow, atomic ordering and actual store
access counts. Existing oracle regressions compare complete traced/untraced
verdicts, including all 1,024 expression cases, query proofs and access limits.

Local validation for this increment: rules-engine/rules-runtime tests (31 test
functions, including parameterized oracle corpora), seven Phase A integrity
checks, strict rules-engine Clippy, formatting and whitespace checks. Full
seven-job exact-candidate CI is still required before merge. The endpoint/UI
and paired-overhead checks have not yet run against an integrated candidate.

## Remaining before Phase B completion

1. Feed the real traces into bounded Requests history and subscriber queues;
   qualify reconnect, TTL, slow readers, disabled diagnostics and cleanup.
2. Add source-positioned expression coverage, JSON and rendered HTML reports.
3. Verify the supported UI controls, request details, discovery/status and logs
   in a real browser against Fireside, fixing demonstrated gaps oracle-first.
4. Measure paired diagnostics overhead against every predeclared limit, then
   require exact-candidate CI and review. Prior baseline CI is not product CI.

No two-hour acceptance, npm release, tag, consumer switch or application-stack
restart is part of this increment. Public compatibility limitations stay in place.
