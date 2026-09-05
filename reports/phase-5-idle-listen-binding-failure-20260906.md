# Quiet Listen diagnostic r1: launcher-only rejection

No Firestore capture client or full gate started in diagnostic r1. After a clean
fresh host preflight, the external launcher started the pinned official Java
server, then rejected its listener before sending any test traffic. The exact
failure was `Diagnostic listener is not exclusively owned loopback server`.
Its identity-checked Java shutdown completed with exit 143; the subsequent
quiescence check passed. R48 and all historical gate evidence remain untouched.

The original launcher unfortunately did not persist the rejected `ss` sample.
The preserved [r1 summary](phase-5-metrics/idle-listen-20260906-r1/summary.json)
therefore cannot by itself establish the rejected address. All 39 entries in its
checksum manifest were pulled and verified locally; no diagnostic rerun was
silently substituted for this failure.

## Separate binding-only oracle, before correction

A fresh, bounded, separately identified Java binding observation performed no
Firestore RPCs, writes or imports. It used the unchanged host preflight and same
jar, runtime, explicit `--host 127.0.0.1` and port 23200, recorded 12 verbatim
listener samples, and then stopped only its identity-checked child. The
[sample](phase-5-metrics/idle-listen-binding-20260906-r1/listeners-08.json)
shows the actual address `[::ffff:127.0.0.1]:23200` owned by that Java PID.
The same PID's ephemeral listeners also use that mapped loopback address.
The [binding result](phase-5-metrics/idle-listen-binding-20260906-r1/result.json)
records clean shutdown and no diagnostic listeners afterwards.

This proves a launcher address-format defect: it accepted only the literal IPv4
spelling, rejecting the equivalent IPv4-mapped IPv6 loopback address. It is not
evidence of an emulator workload failure or a public listener. The
[pre-correction fixture](../conformance/fixtures/phase5/idle-listen-binding-oracle.json)
preserves the exact observation before changing the predicate.

The correction must accept only the explicit loopback spellings used by this
diagnostic while retaining sole-PID ownership checks. Wildcard and non-loopback
addresses, a second owner, and a wrong PID remain errors. Persist every readiness
sample before evaluating it so a future rejection includes its exact cause.
Use a new attempt path for any corrected capture; do not modify r1 evidence or
resume it. This does not change the protected runner, immutable gate, workload,
duration, or product behavior.

The [larger cache-query follow-up plan](phase-5-cache-query-capture-plan-20260906.md)
is a separately reviewed specification, not executed evidence. The tiny quiet
Listen capture and the larger contention attribution both remain unfinished.
