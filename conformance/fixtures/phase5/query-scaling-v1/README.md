# Phase 5 full-data query-scaling oracle

This fixture freezes a synthetic, pre-product-change comparison on the Phase 5
full dataset. It was captured on commit `3b210d5` after the r36 Fireside stage
showed that scoped queries decoded all 211,202 documents and could materialize
multiple full-dataset copies under application concurrency.

The official side used firebase-tools 15.22.0 and its downloaded Firestore
emulator 1.21.0. The Fireside side used the exact r36 binary. Each stack ran
alone after swap was drained and three steady `vmstat` samples showed no swap
activity. The capture added and removed only a synthetic presentation and slide.
It retained operation counts, wall time, and emulator RSS/PSS; it did not retain
document contents, real identifiers, credentials, or access tokens.

The four operations match the relevant Twodart shapes: eleven cache collections
read in parallel, the dashboard presentation query, a presentation plus slides
listener set, and a Listen update that removes a document from the result set.
Both implementations returned the same synthetic result counts and delivered
the leave-result event. Timings are measurements for this hardware and dataset,
not portable thresholds and not a performance-winner claim.

Raw, checksum-verified capture evidence is under
`reports/phase-5-metrics/query-scaling-oracle-20260904-3b210d5/`.
