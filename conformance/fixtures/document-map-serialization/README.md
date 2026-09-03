# Repeated document-map serialization oracle

Captured before the r28 product repair from pinned official Java emulator
1.21.0 (Phase 5) and 1.22.0 (prior conformance pin), using Java 26 locally.
Each version records four synthetic documents, eight consecutive reads per
operation, seven operations: **224 reads / 28 groups**. No writes occur within
a read group. Both versions' `observations.json` are byte-identical.

Operations cover Node SDK `get()` (BatchGetDocuments), native GetDocument,
ListDocuments and RunQuery, REST GetDocument, and real Firebase browser SDK
server reads with long-polling and streaming. Inputs include nested maps, arrays
of maps, empty containers, numeric-looking keys, CJK, emoji and a synthetic
deck-shaped document. Exact decoded field JSON is retained, without volatile
response envelopes or read times. Checksum manifests preserve original output.

Observed: every group returns stable field JSON. The compatibility requirement
is repeated-read stability and unchanged values, **not** a particular Java key
permutation or a universal protobuf map-order guarantee. The regression compares
canonical values across servers and exact strings within each server. This
separates a serialization-order mismatch from actual data mutation.

Reproduce (fresh output directories only):

```sh
JAVA=/path/to/java26 node --import tsx src/serialization/capture.ts \
  --java-version 1.21.0 --output /new/capture/java-1.21.0
JAVA=/path/to/java26 node --import tsx src/serialization/capture.ts \
  --java-version 1.22.0 --output /new/capture/java-1.22.0
```

`FIRESTORE_EMULATOR_JAR` can supply the exact checksum-pinned JAR. `CHROME_BIN`
can select installed Chrome. For replay, `--origin http://127.0.0.1:PORT` uses
an isolated local Fireside instance with open rules; cloud endpoints are refused.
The command runs from `conformance/`. No Twodart or protected-runner changes.
