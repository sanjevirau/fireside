# Query rules: potential results, not current rows

Oracle-first response to the r25 Fireside rules failure. The original fixture
commit `34c8aeda8bcecb4ace06bf35aca408e782bd5baf` contains no product correction.
All input documents and identities are
synthetic. Existing Phase 3 production fixtures remain unchanged.

Two separate, checksum-verified official oracles were captured on macOS with
Java 26.0.2.1, Node 24.20.0, `@google-cloud/firestore` 9.0.0, firebase-js-sdk
12.18.0, and Chrome 152.0.7977.75:

| Corpus | Why this version | SHA-256 of its `SHA256SUMS` |
| --- | --- | --- |
| `java-1.21.0/` | Phase 5 firebase-tools 15.22.0's actual Firestore JAR | `5aea8ced2403cbe3ed1e6dd34fb05501c7a9ad2e9c116785587321e7c67ec3cc` |
| `java-1.22.0/` | Previous conformance/Phase 3 JAR pin | `21765b616286a57c8020f850d9dd0d9edb37cde7f8089188aac78d9ddb8cddcd` |

Per version: 56 query shapes × RunQuery/count/Listen, four ListDocuments probes,
one native changing Listen, and 109 observations in **each** browser variant
(54 shapes × Listen/count plus changing Listen). The two explicit-offset
shapes are native-only: the public browser SDK has no offset API. Native and
browser authorization verdicts agree for every comparable request. Aggregation
uses the SDK's REST API; only Listen uses WebChannel. Raw HTTP captures are kept
separately and labeled accordingly.

Coverage includes owner equality, absent/wrong owner, verified claims,
IN/array membership, unsafe disjunctions, compound AND/OR, range and not-equal
constraints, limits/offsets/order direction, empty collections/results, fixed
and constrained dynamic get/exists, group scope, short-circuiting a missing get,
and listener initial/update/leave. The source rules and exact case definitions
are retained, alongside raw responses, browser errors, request failures,
redacted proxy exchanges, and the official process log. Changing Listen is
paced by observed snapshots, not sleeps. Java uses RESET/CURRENT here; the SDK
observes added → modified → removed. That wire detail is not itself a demand
that Fireside abandon its existing incremental protocol.

Run `npm run test:rules:query-fixtures --prefix conformance` to verify checksums,
coverage, verdicts, document/count equality, both CI flags, redaction, and all
three changing snapshots. A timeout, page exception, HTTP 5xx, or non-cancelled
request failure is a failed capture, not a permission verdict.

Reproduce into a **new empty output directory**, never over these files:

```sh
JAVA=/path/to/java26 PHASE4_BROWSER_EXECUTABLE=/path/to/chrome \
  npm run capture:rules:queries --prefix conformance -- \
  --java-version 1.21.0 --output /absolute/path/to/new-capture
```

The script verifies the pinned local JAR before starting its owned process.
It uses the existing debug Fireside capture-proxy binary, overridable through
`FIRESIDE_CAPTURE_BINARY`. `--origin http://127.0.0.1:PORT` instead exercises an
already configured local Fireside with these exact rules and seeds; it does
not install rules or bypass authorization for the measured queries. Seed writes
alone use the explicit owner credential. `--grpc-only` is available for focused
diagnosis, not a substitute for both browser variants.

`npm run test:rules:query-replay --prefix conformance` starts owned Fireside
instances in memory and disk/WAL and compares the complete native and browser
observations with the frozen corpus. Its captures are retained in the printed
temporary directories. Replay metadata uses `working-tree` (or an explicit
`--candidate-version`) for Fireside, never a Java version. Browser probes now
use the same current synthetic JWT window as the native probes; this avoids the
SDK mock-token default epoch expiry without changing Fireside's Auth policy.
A separate complete Java 1.21.0 recapture at
`/tmp/query-rules-java121-live-window` reproduced all 173 native and 218 browser
semantic observations with that window. Original fixture files and checksums
remain untouched. A 15-second query deadline and fail-first persistence of
non-permission errors bound diagnostic replay without retrying denied verdicts.

Capture development evidence is retained locally rather than confused with
these validated fixtures: old incomplete Listen probes are under
`/tmp/query-rules-incomplete.qt6Mzo`; full diagnostic captures include
`/tmp/query-rules-java121-probe3`, `/tmp/query-rules-java122-final`, and
`/tmp/query-rules-java121-transport-audit`. Initial Listen lacked Java's required
resource-prefix metadata; an early changes probe incorrectly awaited an explicit
remove instead of RESET/CURRENT. Shared proxy pools also intermittently caused
aggregation CORS/network failures with no completed exchange. Separate Listen
and REST proxy pools eliminated those failures without changing query/rules
input or retrying verdicts. These are capture-harness probes, not Phase 5 smoke
attempts, and no failed verdict was relabeled as a pass.
