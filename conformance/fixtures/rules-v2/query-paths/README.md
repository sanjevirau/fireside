# Query wildcard paths and boolean-error proof

Oracle-first follow-up to Phase 5 smoke r27. This corpus is separate from the
unchanged r25 field-constraint corpus. No product repair was present at capture.

Both exact official JARs were captured with Java 26.0.2.1, Node 24.20.0,
firebase-js-sdk 12.18.0, @google-cloud/firestore 9.0.0 and local Chrome on macOS.
Each corpus contains 37 query shapes × native RunQuery/count/Listen, seven
ListDocuments probes and one changing Listen: **119 native observations**.
Each browser variant contains 75 observations (37 Listen/count pairs and one
changing Listen). Raw Listen and REST count captures use separate proxy pools.
All comparable native/browser verdicts and document/count results agree between
the versions. Tests pin checksums, exact inputs, health, redaction and coverage.

| Official JAR | SHA-256 of `SHA256SUMS` |
| --- | --- |
| 1.21.0, Phase 5 pin | `53d5094de52b94d3278ecd02fb36292d018aae1fc454906d32879399383d005d` |
| 1.22.0, previous conformance pin | `afd05d0968064240fc7e06e4830dcd7bb2385c0f67cf28db2e5493a769cad215` |

Observed contract: in a collection query, the child document wildcard is not a
concrete path to read. `!exists(childWildcardPath) || parentOwner()` allows a
provably authorized parent owner, including an empty child collection. A
denied or missing parent is denied; the unknown expression by itself is denied.
The result is the same through a helper function, get(), and reversed OR order.
`unknown || true`, `!(unknown && false)`, and the corresponding missing-resource
error expressions allow. A conjunction of eleven distinct existing-document
exists() calls followed by `|| true` also allows: an independent true branch is
sufficient. This does not authorize an eleventh document read or increase the
access-call budget; the proof need not depend on that failing branch. The
existing access-limit fixtures remain unchanged.

The query captures include the unchanged owner-equality baseline and its
added/modified/removed listener observations. They do not establish new write,
getAfter, or production-specific semantics. No app-specific bypass is implied.

Reproduce into a new empty directory:

```sh
JAVA=/path/to/java26 PHASE4_BROWSER_EXECUTABLE=/path/to/chrome \
  npm run capture:rules:queries --prefix conformance -- \
  --java-version 1.21.0 --case-set paths --output /absolute/new-directory
```

The initial 31-shape captures were preserved privately before adding explicit
concrete-error AND and access-limit OR controls. Final corpora above were
captured anew, not edited or relabeled. Neither set is a Phase 5 smoke attempt.
