import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

interface Phase4Manifest {
  readonly frozen: boolean;
  readonly phase3Baseline: {
    readonly tag: string;
    readonly candidateRevision: string;
    readonly manifestSha256: string;
  };
  readonly oraclePolicy: {
    readonly requiredBeforeProductImplementation: boolean;
    readonly requiredFixtureSets: readonly string[];
    readonly captureCompletionBlocksImplementation: boolean;
  };
  readonly twodartContract: {
    readonly projectId: string;
    readonly readyPattern: string;
    readonly storageBuckets: readonly string[];
    readonly customFunctions: {
      readonly firestoreBackground: number;
      readonly scheduled: number;
      readonly callable: number;
      readonly http: number;
      readonly total: number;
    };
  };
  readonly gates: {
    readonly twodartFullData: {
      readonly required: boolean;
      readonly minimumStorageObjects: number;
      readonly minimumStorageBytes: number;
    };
    readonly cutover: {
      readonly officialJavaFirestoreProcessAllowed: boolean;
      readonly officialJavaPubsubProcessAllowed: boolean;
      readonly officialFirebaseAuthServiceAllowed: boolean;
      readonly officialFirebaseStorageServiceAllowed: boolean;
      readonly firebaseToolsNodeWorkloadHostAllowed: boolean;
      readonly firesideBecomesDefaultOnlyAfterFullPass: boolean;
    };
  };
}

test("the immutable Phase 4 manifest preserves the complete Twodart replacement boundary", async () => {
  const manifestBytes = await readFile(
    new URL("../../benchmarks/phase-4-twodart-suite.json", import.meta.url),
  );
  assert.equal(
    sha256(manifestBytes),
    "38697418c65d667dfcc64480e8b05ff4d16ed0f330beb19c64e9da04508dd3d2",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Phase4Manifest;

  assert.equal(manifest.frozen, true);
  assert.equal(manifest.phase3Baseline.tag, "phase-3");
  assert.equal(
    manifest.phase3Baseline.candidateRevision,
    "91e3c62e2fbec4c615f1b3018a578bfb55982b49",
  );
  assert.equal(
    manifest.phase3Baseline.manifestSha256,
    "5b8547cb0cf7697df6fb98c29b05ccaf412b93c259c22127bd9050d8c495fcc2",
  );

  assert.equal(manifest.oraclePolicy.requiredBeforeProductImplementation, true);
  assert.equal(manifest.oraclePolicy.captureCompletionBlocksImplementation, true);
  assert.equal(manifest.oraclePolicy.requiredFixtureSets.length, 13);
  assert.equal(new Set(manifest.oraclePolicy.requiredFixtureSets).size, 13);

  assert.equal(manifest.twodartContract.projectId, "demo-twodart-local");
  assert.equal(manifest.twodartContract.readyPattern, "All emulators ready");
  assert.deepEqual(manifest.twodartContract.storageBuckets, [
    "demo-twodart-local.appspot.com",
    "assets-local.twodart.com",
  ]);
  assert.deepEqual(manifest.twodartContract.customFunctions, {
    runtime: "nodejs24",
    codebase: "templates-firebase-function",
    firestoreBackground: 6,
    scheduled: 2,
    callable: 2,
    http: 1,
    total: 11,
  });

  assert.equal(manifest.gates.twodartFullData.required, true);
  assert.equal(manifest.gates.twodartFullData.minimumStorageObjects, 33_353);
  assert.equal(manifest.gates.twodartFullData.minimumStorageBytes, 6_230_000_000);

  assert.equal(manifest.gates.cutover.officialJavaFirestoreProcessAllowed, false);
  assert.equal(manifest.gates.cutover.officialJavaPubsubProcessAllowed, false);
  assert.equal(manifest.gates.cutover.officialFirebaseAuthServiceAllowed, false);
  assert.equal(manifest.gates.cutover.officialFirebaseStorageServiceAllowed, false);
  assert.equal(manifest.gates.cutover.firebaseToolsNodeWorkloadHostAllowed, true);
  assert.equal(manifest.gates.cutover.firesideBecomesDefaultOnlyAfterFullPass, true);
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
