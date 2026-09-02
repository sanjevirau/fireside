import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerUrl = new URL("../src/suite/run-phase5-gate.ts", import.meta.url);
const outputDrainFixtureUrl = new URL(
  "../fixtures/phase5/node-child-output-drain-contract.json",
  import.meta.url,
);
const childTsxResolutionFixtureUrl = new URL(
  "../fixtures/phase5/node-child-tsx-resolution-contract.json",
  import.meta.url,
);
const officialJavaFixtureUrl = new URL(
  "../fixtures/phase5/official-explicit-java-contract.json",
  import.meta.url,
);

test("Phase 5 official explicit-Java boundary is frozen", async () => {
  const fixture = JSON.parse(await readFile(officialJavaFixtureUrl, "utf8")) as {
    readonly contract: {
      readonly environmentVariable: string;
      readonly heapPolicy: string;
      readonly selection: string;
      readonly startupFailurePolicy: string;
    };
    readonly observation: {
      readonly failure: string;
      readonly firesideCandidateRevision: string;
      readonly firesideStackStarted: boolean;
      readonly reportedJavaBinary: string;
      readonly requestedJavaBinary: string;
      readonly twodartRevision: string;
    };
    readonly schemaVersion: number;
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.contract.environmentVariable, "TWODART_EMULATOR_JAVA_BIN");
  assert.match(fixture.contract.selection, /validate and execute/u);
  assert.match(fixture.contract.heapPolicy, /does not add JAVA_TOOL_OPTIONS/u);
  assert.match(fixture.contract.startupFailurePolicy, /must make the Phase 5 stack fail/u);
  assert.equal(
    fixture.observation.firesideCandidateRevision,
    "11dadd4442ef81b209191859db2ed9e1fdd1fafb",
  );
  assert.equal(
    fixture.observation.twodartRevision,
    "f424c373b0947ed57db90f7d7f51455fadca547c",
  );
  assert.equal(
    fixture.observation.requestedJavaBinary,
    "/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin/java",
  );
  assert.equal(
    fixture.observation.reportedJavaBinary,
    "/home/sanjevi/.local/share/mise/installs/java/21/bin/java",
  );
  assert.match(fixture.observation.failure, /OutOfMemoryError/u);
  assert.equal(fixture.observation.firesideStackStarted, false);
});

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

test("Phase 5 child TypeScript loader resolution boundary is frozen", async () => {
  const fixture = JSON.parse(await readFile(childTsxResolutionFixtureUrl, "utf8")) as {
    readonly contract: {
      readonly childImportSpecifier: string;
      readonly failurePolicy: string;
      readonly workingDirectory: string;
    };
    readonly observation: {
      readonly bothStacksReady: boolean;
      readonly browserWorkloadStarted: boolean;
      readonly candidateRevision: string;
      readonly diagnostic: string;
      readonly error: string;
      readonly errorCode: string;
      readonly manifestSha256: string;
      readonly privateContentStored: boolean;
    };
    readonly schemaVersion: number;
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.contract.childImportSpecifier, /parent must resolve tsx/u);
  assert.match(fixture.contract.workingDirectory, /Repository root is intentional/u);
  assert.match(fixture.contract.failurePolicy, /must not be retried silently/u);
  assert.equal(
    fixture.observation.candidateRevision,
    "67ce1c0a781bfbb8aeba7fe10106e8c14a00147b",
  );
  assert.equal(
    fixture.observation.manifestSha256,
    "a0e58c98e1b6962c6de04de0809b625948b126968903f4ca1c41de6ffcb433b0",
  );
  assert.equal(
    fixture.observation.diagnostic,
    "full-gate-smoke-20260902T162708+0800-67ce1c0-r2",
  );
  assert.equal(fixture.observation.bothStacksReady, true);
  assert.equal(fixture.observation.browserWorkloadStarted, false);
  assert.equal(fixture.observation.errorCode, "ERR_MODULE_NOT_FOUND");
  assert.match(fixture.observation.error, /Cannot find package 'tsx'/u);
  assert.equal(fixture.observation.privateContentStored, false);
});

test("Phase 5 gate runs the frozen lifecycle in order", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.equal([...source.matchAll(/child\.once\("close"/gu)].length, 2);
  assert.match(source, /const tsxImportSpecifier = import\.meta\.resolve\("tsx"\)/u);
  assert.equal([...source.matchAll(/"--import",\s+tsxImportSpecifier/gu)].length, 2);
  assert.doesNotMatch(source, /"--import",\s+"tsx"/u);
  assert.ok(
    source.lastIndexOf("await main();") > source.indexOf("const stackNames"),
    "top-level execution must begin after runtime constants are initialized",
  );
  const ordered = [
    "for (const stack of stackNames)",
    "await captureHostHealth(manifest, args.smoke)",
    "const running = await startStack(",
    "const initial = await exerciseStack(",
    "await runSoak(args, manifest, stack)",
    "await stopPhase5Stack(running",
    "stageLifecycleExport(args, stack)",
    "const restarted = await startStack(",
    "const restart = await exerciseStack(",
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
    'javaToolOptions: PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS',
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
  assert.match(source, /maximumConcurrentStacks: 1/u);
  assert.match(source, /exportFirstShutdown: true/u);
  assert.match(source, /orphanCheck: true/u);
  assert.match(source, /--smoke-evidence is required for a full-data Phase 5 attempt/u);
  assert.match(source, /validateSmokePrerequisite\(args, manifest\)/u);
  assert.match(source, /environment\.candidateRevision !== currentRevision/u);
  assert.match(source, /await verifyChecksumManifest\(smokeEvidence\)/u);
});
