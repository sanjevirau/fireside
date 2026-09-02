import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/official-java-default-heap-import.json",
  import.meta.url,
);

test("the exact Java 26 default-heap import failure requires a labeled comparison retry", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly contract: {
      readonly classification: string;
      readonly defaultAttemptMustRemainPreserved: boolean;
      readonly firesideThresholdsMayChange: boolean;
      readonly fullDatasetComparisonRetryRequired: boolean;
      readonly functionalCriteriaMayChange: boolean;
      readonly retryJavaToolOptions: string;
      readonly retryMustBeReportedSeparately: boolean;
    };
    readonly observation: {
      readonly datasetDocuments: number;
      readonly failedSystemdUnits: number;
      readonly failure: string;
      readonly firesideStackStarted: boolean;
      readonly gateExitCode: number;
      readonly gateListenersRemainingAfterCleanup: number;
      readonly javaToolOptions: null;
      readonly kernelOomEvidence: number;
      readonly reportedJavaBinary: string;
      readonly requestedJavaBinary: string;
      readonly surfaceBody: unknown;
      readonly surfaceStatus: number;
    };
    readonly oracle: {
      readonly emulatorVersion: string;
      readonly firebaseToolsVersion: string;
      readonly javaVersion: string;
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.oracle, {
    component: "official Firestore emulator",
    emulatorVersion: "1.21.0",
    firebaseToolsVersion: "15.22.0",
    javaVersion: "26.0.2.1",
  });
  assert.equal(fixture.observation.datasetDocuments, 211_202);
  assert.equal(fixture.observation.requestedJavaBinary, fixture.observation.reportedJavaBinary);
  assert.equal(fixture.observation.javaToolOptions, null);
  assert.equal(fixture.observation.failure, "java.lang.OutOfMemoryError: Java heap space");
  assert.equal(fixture.observation.surfaceStatus, 500);
  assert.deepEqual(fixture.observation.surfaceBody, {
    error: { code: 500, status: "UNKNOWN" },
  });
  assert.equal(fixture.observation.gateExitCode, 1);
  assert.equal(fixture.observation.firesideStackStarted, false);
  assert.equal(fixture.observation.gateListenersRemainingAfterCleanup, 0);
  assert.equal(fixture.observation.kernelOomEvidence, 0);
  assert.equal(fixture.observation.failedSystemdUnits, 0);
  assert.deepEqual(fixture.contract, {
    classification: "official Java comparison limitation",
    defaultAttemptMustRemainPreserved: true,
    firesideThresholdsMayChange: false,
    fullDatasetComparisonRetryRequired: true,
    functionalCriteriaMayChange: false,
    retryJavaToolOptions: "-Xmx8g",
    retryMustBeReportedSeparately: true,
  });
});
