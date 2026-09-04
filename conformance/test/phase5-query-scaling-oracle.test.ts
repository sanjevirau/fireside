import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/query-scaling-v1/fixture.json",
  import.meta.url,
);
const reportRoot = new URL(
  "../../reports/phase-5-metrics/query-scaling-oracle-20260904-3b210d5/",
  import.meta.url,
);

test("the Phase 5 query-scaling oracle freezes the pre-fix full-data measurements", async () => {
  const fixtureText = await readFile(fixtureUrl, "utf8");
  const fixture = JSON.parse(fixtureText) as {
    readonly schemaVersion: number;
    readonly capturedBeforeProductChange: boolean;
    readonly candidateCommit: string;
    readonly dataset: { readonly documents: number; readonly exportMetadataSha256: string };
    readonly environment: { readonly firesideRedbCacheBytes: number };
    readonly operations: readonly {
      readonly name: string;
      readonly returnedDocuments: number;
      readonly official: { readonly durationMilliseconds: number; readonly peakPssBytes: number };
      readonly firesideBeforeFix: {
        readonly durationMilliseconds: number;
        readonly peakPssBytes: number;
      };
    }[];
    readonly contract: Readonly<Record<string, boolean>>;
    readonly privacy: Readonly<Record<string, boolean>>;
    readonly rawEvidence: {
      readonly officialJsonSha256: string;
      readonly firesideBeforeFixJsonSha256: string;
    };
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.capturedBeforeProductChange, true);
  assert.equal(fixture.candidateCommit, "3b210d5e962b93cf8190438295133840a29adab2");
  assert.equal(fixture.dataset.documents, 211_202);
  assert.match(fixture.dataset.exportMetadataSha256, /^[0-9a-f]{64}$/u);
  assert.equal(fixture.environment.firesideRedbCacheBytes, 64 * 1024 * 1024);
  assert.deepEqual(fixture.operations.map(({ name }) => name), [
    "cache-watcher-parallel",
    "dashboard-presentations",
    "editor-listener-set",
    "listen-document-leaves-result-set",
  ]);
  assert.deepEqual(fixture.operations.map(({ returnedDocuments }) => returnedDocuments), [
    11_379, 1, 2, 1,
  ]);
  assert.deepEqual(
    fixture.operations.map(({ official }) => official.durationMilliseconds),
    [20_649, 450, 471, 465],
  );
  assert.deepEqual(
    fixture.operations.map(({ firesideBeforeFix }) => firesideBeforeFix.durationMilliseconds),
    [28_340, 3_612, 3_701, 6_885],
  );
  assert.equal(fixture.operations[0]?.official.peakPssBytes, 9_041_154_048);
  assert.equal(fixture.operations[0]?.firesideBeforeFix.peakPssBytes, 5_126_018_048);
  assert.deepEqual(fixture.contract, {
    collectionQueriesReadOnlyTheirKeyRange: true,
    collectionGroupQueriesUseASecondaryIndex: true,
    diskAndOverlayResultsAreMergedInKeyOrder: true,
    documentsAreDecodedOnlyAfterKeyScopeSelection: true,
    queryMemoryIsBoundedByScopedResultsAndOverlay: true,
    correctnessRequiresLeaveResultSetNotification: true,
    performanceWinnerRequired: false,
    phase5WorkloadOrThresholdsChanged: false,
  });
  assert.deepEqual(fixture.privacy, {
    credentialsStored: false,
    documentContentsStored: false,
    realDocumentIdsStored: false,
    realUserIdentifiersStored: false,
    syntheticOnlyMutations: true,
  });
  assert.doesNotMatch(fixtureText, /(?:AIza|ya29\.|sk_(?:live|test)|\/Users\/|\/home\/sanjevi\/)/u);
});

test("the Phase 5 query-scaling fixture points at immutable raw capture evidence", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly rawEvidence: {
      readonly officialJsonSha256: string;
      readonly firesideBeforeFixJsonSha256: string;
    };
  };
  const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    sha256(await readFile(new URL("official/official.json", reportRoot))),
    fixture.rawEvidence.officialJsonSha256,
  );
  assert.equal(
    sha256(await readFile(new URL("fireside/fireside.json", reportRoot))),
    fixture.rawEvidence.firesideBeforeFixJsonSha256,
  );
});

test("the Phase 5 query-scaling fixture has a complete checksum inventory", async () => {
  const root = new URL("../fixtures/phase5/query-scaling-v1/", import.meta.url);
  const sums = (await readFile(new URL("SHA256SUMS", root), "utf8")).trimEnd().split("\n");
  assert.equal(sums.length, 2);
  for (const line of sums) {
    const match = /^(?<sha>[0-9a-f]{64})  (?<name>.+)$/u.exec(line);
    assert.ok(match?.groups !== undefined, line);
    assert.equal(
      createHash("sha256").update(await readFile(new URL(match.groups.name!, root))).digest("hex"),
      match.groups.sha,
    );
  }
});
