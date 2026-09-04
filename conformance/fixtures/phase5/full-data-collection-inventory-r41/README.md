# Phase 5 r41 full-data collection inventory oracle

The r41 Fireside continuation passed its exact-candidate two-stack smoke, all
nine initial browser journeys, the full 7,200-second soak, export-first
shutdown, restart readiness, and all nine restart journeys. It then stopped
before parity because the Phase 5 harness compared a partial collection-group
inventory with the frozen 211,202-document logical count.

Before changing the harness, the same full dataset was imported separately
into firebase-tools 15.22.0's Firestore emulator 1.21.0 on Java 26.0.2.1 and
the exact Fireside candidate. Both implementations returned 15,383 documents
for the harness's existing 47 collection groups and 195,819 documents for the
same 11 omitted groups. The complete total is exactly 211,202 on both.

This fixture records collection names and aggregate counts only. It contains
no document contents, document IDs, user identifiers, credentials, or tokens.
The correction restores complete frozen-count validation; it does not alter
the dataset, manifest, acceptance criteria, workload, duration, protected
browser runner, or banked official full-data stage.

Checksum-verified raw observations and the failed r41 stage are preserved under
`reports/phase-5-metrics/failed-full-gate-v3-20260905-aab4a56-r36-frozen-count/`.
