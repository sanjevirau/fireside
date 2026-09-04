import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PageObservation {
  readonly id: string;
  readonly status: number;
  readonly itemCount: number;
  readonly itemNames: readonly string[];
  readonly first: string | null;
  readonly last: string | null;
  readonly nextPageToken?: string;
}

const fixtureUrl = new URL(
  "../fixtures/firebase-suite-v1/storage-list-pagination/fixture.json",
  import.meta.url,
);

test("official Storage pagination crosses the default 1,000-object boundary", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly schemaVersion: number;
    readonly targetVersion: string;
    readonly syntheticOnly: boolean;
    readonly objectCorpus: Readonly<Record<string, number | string>>;
    readonly observations: readonly PageObservation[];
    readonly sdkAutopagination: Readonly<Record<string, number | string>>;
    readonly invariants: Readonly<Record<string, boolean | number | string>>;
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.targetVersion, "15.22.0");
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.objectCorpus.count, 1_002);
  assert.equal(fixture.objectCorpus.boundaryToken, "objects/1000.json");

  for (const prefix of ["gcs", "firebase"]) {
    const first = observation(fixture.observations, `${prefix}-default-first`);
    const second = observation(fixture.observations, `${prefix}-default-second`);
    assert.equal(first.status, 200);
    assert.equal(first.itemCount, 1_000);
    assert.equal(first.first, "objects/0000.json");
    assert.equal(first.last, "objects/0999.json");
    assert.equal(first.nextPageToken, "objects/1000.json");
    assert.equal(second.itemCount, 2);
    assert.deepEqual(second.itemNames, ["objects/1000.json", "objects/1001.json"]);
    assert.equal(second.nextPageToken, undefined);

    const smallFirst = observation(fixture.observations, `${prefix}-small-first`);
    const smallSecond = observation(fixture.observations, `${prefix}-small-second`);
    assert.deepEqual(smallFirst.itemNames, ["objects/0000.json", "objects/0001.json"]);
    assert.equal(smallFirst.nextPageToken, "objects/0002.json");
    assert.deepEqual(smallSecond.itemNames, ["objects/0002.json", "objects/0003.json"]);
    assert.equal(smallSecond.nextPageToken, "objects/0004.json");
  }

  const unknown = observation(fixture.observations, "gcs-unknown-token");
  assert.deepEqual(unknown.itemNames, ["objects/0000.json", "objects/0001.json"]);
  assert.equal(unknown.nextPageToken, "objects/0002.json");
  assert.equal(fixture.sdkAutopagination.count, 1_002);
  assert.equal(fixture.sdkAutopagination.boundaryAfter, "objects/1000.json");
  assert.equal(fixture.invariants.pageTokenIsInclusiveOnResume, true);
  assert.equal(fixture.invariants.gcsAndFirebaseRoutesSharePagination, true);
  assert.equal(fixture.invariants.sdkAutopaginationReturnsAllObjects, true);
});

function observation(
  observations: readonly PageObservation[],
  id: string,
): PageObservation {
  const result = observations.find((candidate) => candidate.id === id);
  assert.ok(result, `missing Storage pagination observation ${id}`);
  return result;
}
