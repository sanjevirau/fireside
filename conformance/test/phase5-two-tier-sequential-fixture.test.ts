import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/two-tier-sequential-gate-contract.json",
  import.meta.url,
);

test("Phase 5 two-tier sequential gate correction is frozen without weaker criteria", async () => {
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
        readonly maximumReadySeconds: number;
        readonly mustPassBeforeFullData: boolean;
        readonly shortSoakSecondsPerStack: number;
      };
      readonly fullGate: {
        readonly executionOrder: readonly string[];
        readonly freshQuiescentPreflightBeforeEachStack: boolean;
        readonly immutableGateInterventionAllowed: boolean;
        readonly soakDurationSecondsPerStack: number;
        readonly zeroSwapActivity: boolean;
      };
      readonly ci: {
        readonly fullSixJobMatrixRequiredFor: readonly string[];
        readonly harnessOnlyPreSmokeJobs: readonly string[];
      };
    };
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.contract.criteriaWeakened, false);
  assert.equal(fixture.contract.thresholdsChanged, false);
  assert.equal(fixture.contract.workloadChanged, false);
  assert.deepEqual(fixture.contract.diagnosticSmoke.executionOrder, ["official", "fireside"]);
  assert.equal(fixture.contract.diagnosticSmoke.mustPassBeforeFullData, true);
  assert.equal(fixture.contract.diagnosticSmoke.maximumReadySeconds, 60);
  assert.equal(fixture.contract.diagnosticSmoke.shortSoakSecondsPerStack, 60);
  assert.equal(fixture.contract.diagnosticSmoke.allNineBrowserJourneys, true);
  assert.equal(fixture.contract.diagnosticSmoke.exportFirstShutdown, true);
  assert.equal(fixture.contract.diagnosticSmoke.cleanupAndZeroOrphans, true);
  assert.equal(fixture.contract.diagnosticSmoke.datasetTreeSha256.length, 64);
  assert.deepEqual(fixture.contract.fullGate.executionOrder, ["official", "fireside"]);
  assert.equal(fixture.contract.fullGate.soakDurationSecondsPerStack, 7_200);
  assert.equal(fixture.contract.fullGate.freshQuiescentPreflightBeforeEachStack, true);
  assert.equal(fixture.contract.fullGate.zeroSwapActivity, true);
  assert.equal(fixture.contract.fullGate.immutableGateInterventionAllowed, false);
  assert.deepEqual(fixture.contract.ci.harnessOnlyPreSmokeJobs, [
    "Phase 5 harness",
    "Rust quality gate",
  ]);
  assert.equal(fixture.contract.ci.fullSixJobMatrixRequiredFor.length, 4);
});
