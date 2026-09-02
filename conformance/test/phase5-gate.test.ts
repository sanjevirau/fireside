import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerUrl = new URL("../src/suite/run-phase5-gate.ts", import.meta.url);
const outputDrainFixtureUrl = new URL(
  "../fixtures/phase5/node-child-output-drain-contract.json",
  import.meta.url,
);

test("Phase 5 child-process output drain boundary is frozen", async () => {
  const fixture = JSON.parse(await readFile(outputDrainFixtureUrl, "utf8")) as {
    readonly contract: { readonly completionEvent: string; readonly reason: string };
    readonly observation: {
      readonly candidateRevision: string;
      readonly diagnostic: string;
      readonly independentFreshHead: string;
      readonly reportedRevisions: Readonly<Record<string, string>>;
      readonly stackWorkloadStarted: boolean;
    };
    readonly schemaVersion: number;
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.contract.completionEvent, "close");
  assert.match(fixture.contract.reason, /fully drained/u);
  assert.equal(
    fixture.observation.candidateRevision,
    "5b51e4de4e97a74c963d6cbd4a176723342c2cad",
  );
  assert.equal(
    fixture.observation.independentFreshHead,
    "f424c373b0947ed57db90f7d7f51455fadca547c",
  );
  assert.deepEqual(fixture.observation.reportedRevisions, {
    official: "f424c373b0947ed57db90f7d7f51455fadca547c",
    fireside: "f424c373b0947ed57db90f7d7f51455fadca547c",
    fresh: "",
  });
  assert.equal(fixture.observation.stackWorkloadStarted, false);
});

test("Phase 5 gate runs the frozen lifecycle in order", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.ok(
    source.lastIndexOf("await main();") > source.indexOf("const stackNames"),
    "top-level execution must begin after runtime constants are initialized",
  );
  const ordered = [
    'startPair(args, manifest, "initial"',
    "const initialSnapshots = await exercisePair(",
    "stageLifecycleExports(args)",
    "const restarted = await startPair(",
    "const restartSnapshots = await exercisePair(",
    '"two-hour-differential-soak"',
    "runFreshColleague(args, manifest, active)",
    "runRegressions(args)",
  ];
  let previous = -1;
  for (const boundary of ordered) {
    const position = source.indexOf(boundary);
    assert.ok(position > previous, `${boundary} is missing or out of order`);
    previous = position;
  }
});

test("Phase 5 gate compares every frozen persistent count without content", async () => {
  const source = await readFile(runnerUrl, "utf8");
  for (const field of [
    "firestoreDocuments",
    "authUsers",
    "storageObjects",
    "storageObjectBytes",
  ]) {
    assert.match(source, new RegExp(field, "u"));
  }
  assert.match(source, /collectionGroup\(collectionId\)\.count\(\)\.get\(\)/u);
  assert.match(source, /accounts:query/u);
  assert.match(source, /storage\/v1\/b\/\$\{bucket\}\/o/u);
});

test("Phase 5 gate preserves the no-private-evidence boundary", async () => {
  const source = await readFile(runnerUrl, "utf8");
  for (const boundary of [
    "candidateIdentityStored: false",
    "datasetIdentityStored: false",
    "privateContentStored: false",
  ]) {
    assert.ok(source.includes(boundary), `${boundary} is missing`);
  }
  assert.doesNotMatch(source, /userInfo\?\.[^[\n]*\[[^\n]*\]\.(?:email|localId|displayName)/u);
});

test("Phase 5 gate includes smoke, fresh colleague, regression, and checksum paths", async () => {
  const source = await readFile(runnerUrl, "utf8");
  for (const boundary of [
    '"--smoke"',
    'backendOverride: backend',
    '"TWODART_FIREBASE_BACKEND=official"',
    '"rust-clippy"',
    '"twodart-functions-build"',
    '"twodart-application-build"',
    '"checksums.sha256"',
  ]) {
    assert.ok(source.includes(boundary), `${boundary} is missing`);
  }
  assert.match(
    source,
    /!smoke &&\s+oomOrResourceEvidence !== manifest\.host\.preflight\.currentBootOomOrResourceKills/u,
  );
  assert.match(source, /violations\.push\(`swapInPagesPerSecond=/u);
  assert.match(source, /JSON\.stringify\(\{ \.\.\.snapshot, violations \}\)/u);
  assert.match(source, /expected: args\.twodartRevision, revisions/u);
  assert.match(source, /import root must be a real directory for firebase-tools lstat parity/u);
  assert.match(source, /stageHardlinkedDirectoryTree\(\s*args\.fullData,/u);
  assert.match(source, /assertDistinctPhase5ApplicationUrls/u);
  assert.match(source, /verifyFinalDatasetIdentity\(args, manifest\)/u);
  assert.match(source, /dataset-final\.json/u);
});
