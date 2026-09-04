# Phase 5 r40 — Fireside continuation failure

## Verdict

The banked official r36 baseline remains valid. The Fireside-only continuation
on candidate `c955d30ee84e4ba43ba020975d135c8d7170fc15` failed its strict initial
browser stage and is not a Phase 5 pass.

This is a Fireside WebChannel product defect. The Firebase JS SDK 12.15.0
received a one-result Write response while its oldest pending mutation batch
contained six writes and raised:

```text
FIRESTORE (12.15.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: e5da) CONTEXT: {"Qr":6,"Gr":1}
```

The immutable controller exited `1` after normal export-first cleanup. The
preserved evidence contains no private document contents, candidate identity,
or dataset identity.

## What passed before the failure

- The exact schema-v3 continuation manifest remained
  `48f4fce8ce6d803824ecfa3193c12f3834a84c840cf7bd34a0e5b278c430732e`.
- Full-data Fireside readiness passed all 24 conditions after importing
  211,202 Firestore documents, one Auth user, and 33,353 Storage objects.
- The first five protected journeys completed their positive assertions:
  OTP/Auth login, dashboard and deck list, existing-deck listener edit,
  catalogue slide add, and deck image upload.
- The browser recorded 2,038 first-party responses, 1,671 required requests,
  zero gating request failures, and then ten non-allowlisted page errors caused
  by the same SDK assertion.

The 7,200-second Fireside soak, restart lifecycle, parity, fresh-colleague
acceptance, and regressions did not start, so none is claimed.

## Oracle and correction boundary

The official Java v1.22.0 browser oracle is frozen before the product change in
`conformance/fixtures/webchannel-v8/java-v1.22.0/write-batch-six`. In both
`CI=1` and `CI=0`, a request containing six mutations receives six
`writeResults`. The permanent fixture and checksum contract were committed as
`33279fa75bf83aa7fcab870958f3f30f47c3827e`.

The product correction must preserve absolute WebChannel map order across
overlapping forward POSTs, retain retry deduplication, and keep the protected
Phase 5 browser runner byte-identical. A fresh seven-job CI pass, Linux release
build, and two-stack cheap smoke are required before another Fireside-only
continuation.

## Evidence

- [Failure record](phase-5-metrics/failed-full-gate-v3-20260905-c955d30-r36-write-order/evidence/failure.json)
- [Browser summary](phase-5-metrics/failed-full-gate-v3-20260905-c955d30-r36-write-order/evidence/browser-fireside-initial.json)
- [Verbatim diagnostic stream](phase-5-metrics/failed-full-gate-v3-20260905-c955d30-r36-write-order/evidence/browser-fireside-initial.json.diagnostics.jsonl)
- [Readiness ledger](phase-5-metrics/failed-full-gate-v3-20260905-c955d30-r36-write-order/evidence/fireside-initial-readiness.jsonl)
- [Process-memory samples](phase-5-metrics/failed-full-gate-v3-20260905-c955d30-r36-write-order/evidence/fireside-initial-process-memory.jsonl)
- [Controller log](phase-5-metrics/failed-full-gate-v3-20260905-c955d30-r36-write-order/run.log)
- [Evidence checksum manifest](phase-5-metrics/failed-full-gate-v3-20260905-c955d30-r36-write-order/evidence/checksums.sha256)
