# Phase 5 r36 query-scaling oracle

This is the pre-fix oracle and failing-baseline capture for the Fireside r36
scaling defect. It was completed before any product code changed.

Both stacks ran alone on the same Ubuntu 26.04 host with a Ryzen 5 2600,
12 logical CPUs, and 16,146,870,272 bytes of RAM. Swap was drained before each
stack and three steady `vmstat` samples showed zero swap-in and swap-out. The
dataset contained 211,202 documents. The capture mutated only one synthetic
presentation and slide, then removed both.

| Operation | Returned | Official Java wall | Official peak PSS | Fireside pre-fix wall | Fireside pre-fix peak PSS |
|---|---:|---:|---:|---:|---:|
| 11 cache collections in parallel | 11,379 | 20.649 s | 9.041 GB | 28.340 s | 5.126 GB |
| Dashboard presentations query | 1 | 0.450 s | 9.041 GB | 3.612 s | 0.483 GB |
| Presentation + slides listeners | 2 | 0.471 s | 9.042 GB | 3.701 s | 0.379 GB |
| Listen document leaves result set | 1 | 0.465 s | 9.042 GB | 6.885 s | 0.379 GB |

The official process had already materialized its imported dataset before these
operations, so absolute process PSS is not a like-for-like internal allocation
comparison. The meaningful Fireside observation is its 0.205 GB to 5.126 GB
transient rise during the eleven parallel scoped reads, plus multi-second
single-result queries. That is consistent with the audited full-dataset scan and
copy path. No winner is claimed.

The permanent fixture is
`conformance/fixtures/phase5/query-scaling-v1/fixture.json`. Raw JSON, logs,
quiescent preflights, and per-stack checksums are preserved beside this report.
The previously flaky SDK cell passed on CI run 33870050111 attempt 2; all seven
jobs are green for the evidence commit's parent.
