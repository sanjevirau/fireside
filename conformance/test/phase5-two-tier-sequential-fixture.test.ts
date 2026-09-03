import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/two-tier-sequential-gate-contract.json",
  import.meta.url,
);

test("Phase 5 two-tier sequential gate records the authorized v3 swap relaxation", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly schemaVersion: number;
    readonly contract: {
      readonly criteriaWeakened: boolean;
      readonly thresholdsChanged: boolean;
      readonly workloadChanged: boolean;
      readonly diagnosticSmoke: {
        readonly allNineBrowserJourneys: boolean;
        readonly cleanupAndZeroOrphans: boolean;
        readonly datasetTreeSha256: string;
        readonly executionOrder: readonly string[];
        readonly exportFirstShutdown: boolean;
        readonly failedAttemptStagingIsPreserved: boolean;
        readonly maximumReadySeconds: number;
        readonly mustPassBeforeFullData: boolean;
        readonly perAttemptDatasetNamespace: boolean;
        readonly shortSoakSecondsPerStack: number;
      };
      readonly fullGate: {
        readonly executionOrder: readonly string[];
        readonly freshQuiescentPreflightBeforeEachStack: boolean;
        readonly immutableGateInterventionAllowed: boolean;
        readonly soakDurationSecondsPerStack: number;
        readonly zeroSwapActivityDuringPreflight: boolean;
        readonly swapDrainBeforeEachStack: readonly string[];
        readonly soakSwapActivityIsMeasurementOnly: boolean;
      };
      readonly ci: {
        readonly fullSixJobMatrixRequiredFor: readonly string[];
        readonly harnessOnlyPreSmokeJobs: readonly string[];
      };
    };
    readonly observation: {
      readonly candidateRevision: string;
      readonly diagnostic: string;
      readonly errorHash: string;
      readonly manifestSha256: string;
      readonly observedSwapInPagesPerSecond: readonly number[];
      readonly stackWorkloadStarted: boolean;
      readonly staticStagingDirectoriesPreserved: number;
    };
  };

  assert.equal(fixture.schemaVersion, 2);
  assert.equal(fixture.contract.criteriaWeakened, true);
  assert.equal(fixture.contract.thresholdsChanged, true);
  assert.equal(fixture.contract.workloadChanged, false);
  assert.deepEqual(fixture.contract.diagnosticSmoke.executionOrder, ["official", "fireside"]);
  assert.equal(fixture.contract.diagnosticSmoke.mustPassBeforeFullData, true);
  assert.equal(fixture.contract.diagnosticSmoke.maximumReadySeconds, 60);
  assert.equal(fixture.contract.diagnosticSmoke.shortSoakSecondsPerStack, 60);
  assert.equal(fixture.contract.diagnosticSmoke.allNineBrowserJourneys, true);
  assert.equal(fixture.contract.diagnosticSmoke.exportFirstShutdown, true);
  assert.equal(fixture.contract.diagnosticSmoke.cleanupAndZeroOrphans, true);
  assert.equal(fixture.contract.diagnosticSmoke.failedAttemptStagingIsPreserved, true);
  assert.equal(fixture.contract.diagnosticSmoke.perAttemptDatasetNamespace, true);
  assert.equal(fixture.contract.diagnosticSmoke.datasetTreeSha256.length, 64);
  assert.deepEqual(fixture.contract.fullGate.executionOrder, ["official", "fireside"]);
  assert.equal(fixture.contract.fullGate.soakDurationSecondsPerStack, 7_200);
  assert.equal(fixture.contract.fullGate.freshQuiescentPreflightBeforeEachStack, true);
  assert.equal(fixture.contract.fullGate.zeroSwapActivityDuringPreflight, true);
  assert.deepEqual(fixture.contract.fullGate.swapDrainBeforeEachStack, ["swapoff -a", "swapon -a"]);
  assert.equal(fixture.contract.fullGate.soakSwapActivityIsMeasurementOnly, true);
  assert.equal(fixture.contract.fullGate.immutableGateInterventionAllowed, false);
  assert.deepEqual(fixture.contract.ci.harnessOnlyPreSmokeJobs, [
    "Phase 5 harness",
    "Rust quality gate",
  ]);
  assert.equal(fixture.contract.ci.fullSixJobMatrixRequiredFor.length, 4);
  assert.equal(
    fixture.observation.candidateRevision,
    "ccdea5415f83977fc70842bd256621bc661a2333",
  );
  assert.equal(
    fixture.observation.manifestSha256,
    "27f643a6e6b5b060bb548359584a133e1bec937b06eb3b3f91982910a985faaa",
  );
  assert.deepEqual(fixture.observation.observedSwapInPagesPerSecond, [0, 256, 0]);
  assert.equal(fixture.observation.stackWorkloadStarted, false);
  assert.equal(fixture.observation.staticStagingDirectoriesPreserved, 2);
  assert.equal(fixture.observation.errorHash.length, 64);
  assert.match(fixture.observation.diagnostic, /two-tier-smoke/u);
});
