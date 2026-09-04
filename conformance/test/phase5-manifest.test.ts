import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPhase5Manifest,
  PHASE5_DATASET_TREE_SHA256,
  PHASE5_MANIFEST_SHA256,
  PHASE5_TWODART_REVISION,
  type Phase5Manifest,
} from "../src/suite/phase5-acceptance-plan.ts";

const manifestUrl = new URL(
  "../../benchmarks/phase-5-twodart-acceptance.json",
  import.meta.url,
);

test("the immutable Phase 5 manifest freezes the full Twodart differential gate", async () => {
  const bytes = await readFile(manifestUrl);
  const manifest = JSON.parse(bytes.toString("utf8")) as Phase5Manifest;

  assert.doesNotThrow(() => assertPhase5Manifest(manifest, bytes));
  assert.equal(manifest.phase4Baseline.tag, "phase-4");
  assert.equal(manifest.twodartSource.baselineRevision, PHASE5_TWODART_REVISION);
  assert.equal(manifest.dataset.treeSha256, PHASE5_DATASET_TREE_SHA256);
  assert.equal(manifest.dataset.fileCount, 66_758);
  assert.equal(manifest.dataset.fileBytes, 8_180_616_677);
  assert.deepEqual(manifest.dataset.logicalCounts, {
    firestoreDocuments: 211_202,
    authUsers: 1,
    storageObjects: 33_353,
    storageObjectBytes: 6_689_692_200,
  });
  assert.equal(manifest.host.sshAlias, "sanjevi-linux");
  assert.equal(manifest.host.minimumAvailableDiskBytes, 80_000_000_000);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.amendment.criteriaWeakened, true);
  assert.equal(manifest.amendment.thresholdsChanged, true);
  assert.equal(manifest.amendment.workloadChanged, false);
  assert.equal(manifest.diagnosticSmoke.requiredBeforeEveryFullDataAttempt, true);
  assert.equal(manifest.diagnosticSmoke.maximumReadySeconds, 60);
  assert.equal(manifest.diagnosticSmoke.shortSoakSecondsPerStack, 60);
  assert.deepEqual(manifest.stacks.executionOrder, ["official", "fireside"]);
  assert.equal(manifest.stacks.simultaneous, false);
  assert.deepEqual(manifest.soak.executionOrder, ["official", "fireside"]);
  assert.equal(manifest.soak.simultaneousBackends, false);
  assert.equal(manifest.soak.durationSeconds, 7_200);
  assert.equal(manifest.lifecycle.allowedCountMismatch, 0);
  assert.equal(manifest.lifecycle.acknowledgedWriteLossAllowed, 0);
  assert.equal(manifest.twodartRuntimeAssets.trees.length, 3);
  assert.equal(
    manifest.twodartRuntimeAssets.trees.reduce(
      (total, tree) => total + tree.fileCount,
      0,
    ),
    10_967,
  );
});

test("schema v3 records the authorized relaxation without reclassifying r20", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as Phase5Manifest;
  const fixture = JSON.parse(await readFile(new URL(
    "../fixtures/phase5/schema-v3-swap-measurement-contract.json", import.meta.url,
  ), "utf8"));
  assert.equal(manifest.amendment.previousManifestSha256, fixture.previousManifestSha256);
  assert.equal(manifest.amendment.reason, fixture.reason);
  assert.equal(manifest.amendment.amendedBeforeMeasurement, true);
  assert.equal(manifest.soak.swapActivityPolicy.gating, false);
  assert.equal(manifest.soak.swapActivityPolicy.winnerRequired, false);
  assert.equal(manifest.host.preflight.steadyVmstatSamples, 3);
  assert.equal(manifest.host.preflight.maximumSwapInPagesPerSecond, 0);
  assert.equal(manifest.host.preflight.maximumSwapOutPagesPerSecond, 0);
  assert.deepEqual(manifest.host.preflight.swapDrain.commands, ["swapoff -a", "swapon -a"]);
  assert.equal(manifest.host.preflight.swapDrain.changeVmSwappinessAllowed, false);
  assert.ok(Object.values(manifest.soak.thresholds).every((threshold) => threshold === 0));
  assert.equal(fixture.observation.soakPassedUnderSchema2, false);
  assert.equal(fixture.observation.historicalResultMustNotBeReclassified, true);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(await readFile(new URL(
    "../src/suite/run-phase5-browser-journeys.ts", import.meta.url,
  ))).digest("hex"), fixture.contract.browserRunnerSha256);
});

test("r22 diagnostic amendment splits readiness without touching workload or soak", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as Phase5Manifest;
  const fixture = JSON.parse(await readFile(new URL(
    "../fixtures/phase5/r22-readiness-attribution-contract.json", import.meta.url,
  ), "utf8"));
  assert.equal(fixture.historicalResult, "failed readiness; not reclassified as a pass");
  assert.match(fixture.source, /user-supplied/u);
  assert.equal(manifest.diagnosticReadinessAmendment.previousManifestSha256,
    "e5d43e4f41f7d2276754468e04b4131f76076e37aeb5afd536b6ce9c8d5b77ca");
  assert.equal(manifest.diagnosticReadinessAmendment.amendedBeforeMeasurement, true);
  for (const key of ["browserRunnerChanged", "workloadChanged", "durationsChanged",
    "soakThresholdsChanged", "fullGateReadinessAllowanceChanged"] as const) {
    assert.equal(manifest.diagnosticReadinessAmendment[key], false);
  }
  assert.equal(manifest.diagnosticSmoke.maximumReadySecondsScope, "emulator-suite");
  assert.equal(manifest.diagnosticSmoke.applicationMaximumReadySecondsFrom,
    fixture.contract.applicationSecondsFrom);
  assert.equal(manifest.diagnosticSmoke.maximumReadySeconds, fixture.contract.emulatorSeconds);
  assert.equal(manifest.cacheWatcher.maximumReadySeconds, fixture.contract.fullGateSeconds);
  assert.equal(manifest.readinessEvidence.frontendCurlMaximumSeconds, 30);
  assert.equal(manifest.readinessEvidence.frontendCurlConnectTimeoutSeconds, 3);
  assert.equal(manifest.readinessEvidence.hubProbeMaximumSeconds, 5);
  assert.equal(manifest.readinessEvidence.functionsProbeMaximumSeconds, 5);
  assert.equal(manifest.readinessEvidence.definitiveErrorSamples, 3);
  assert.equal(manifest.readinessEvidence.ledgerRequired, true);
  assert.equal(manifest.readinessEvidence.checksumsRequiredOnPassAndFailure, true);
  assert.equal(manifest.readinessEvidence.perConditionReadyTimesRequired, true);
});

test("r36 amendment is official-only and leaves every Fireside criterion strict", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as Phase5Manifest;
  const amendment = manifest.officialRestartHostLimitAmendment;
  assert.equal(
    amendment.previousManifestSha256,
    "fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957",
  );
  assert.equal(amendment.amendedBeforeFiresideMeasurement, true);
  assert.equal(amendment.criteriaWeakened, true);
  assert.equal(amendment.scope, "official-baseline-only");
  assert.match(amendment.reason, /^Official full-data evidence stands:/u);
  assert.match(amendment.reason, /The restart-phase failure is host exhaustion/u);
  assert.match(amendment.normalizedEvidenceCorrection, /three completed journeys/u);
  assert.deepEqual(amendment.qualifyingConditions, {
    stack: "official",
    stage: "post-restart-browser-journeys",
    pageErrors: 0,
    gatingRequestFailures: 0,
    pendingRawEmulatorRequestsRequired: true,
    pendingProxiedAliasRequestsRequired: true,
    sourceEvidenceChecksumVerificationRequired: true,
  });
  assert.equal(amendment.officialInitialAndSoakRemainBaselineMeasurements, true);
  assert.deepEqual(amendment.sourceOfficialExport, {
    fileCount: 66_756,
    fileBytes: 8_180_612_785,
    treeSha256: "c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca",
  });
  assert.equal(amendment.officialStageRerun, false);
  assert.equal(amendment.continueWithFireside, true);
  assert.equal(amendment.freshQuiescentPreflightBeforeFireside, true);
  for (const key of [
    "firesideCriteriaChanged",
    "firesideWorkloadChanged",
    "firesideDurationsChanged",
    "firesideThresholdsChanged",
    "bothStacksMayRunConcurrently",
    "performanceWinnerRequired",
    "phase6MayStart",
  ] as const) {
    assert.equal(amendment[key], false);
  }
  assert.equal(amendment.finalReportMarksOfficialRestartHostLimited, true);
  assert.ok(Object.values(manifest.soak.thresholds).every((threshold) => threshold === 0));
  assert.equal(manifest.soak.durationSeconds, 7_200);
  assert.equal(manifest.differentialJourneys.journeys.length, 9);
});

test("the Phase 5 manifest rejects byte drift before any measurement", async () => {
  const bytes = await readFile(manifestUrl);
  const manifest = JSON.parse(bytes.toString("utf8")) as Phase5Manifest;
  const drifted = Buffer.from(bytes);
  drifted[0] = drifted[0] === 0x7b ? 0x20 : 0x7b;

  assert.equal(PHASE5_MANIFEST_SHA256.length, 64);
  assert.throws(() => assertPhase5Manifest(manifest, drifted), /SHA-256 mismatch/u);
});
