import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerUrl = new URL("../src/suite/run-phase5-gate.ts", import.meta.url);

test("Phase 5 gate runs the frozen lifecycle in order", async () => {
  const source = await readFile(runnerUrl, "utf8");
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
});
