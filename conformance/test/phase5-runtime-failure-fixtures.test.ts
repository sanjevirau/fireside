import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const singleSigintUrl = new URL(
  "../fixtures/phase5/emulator-single-sigint-contract.json",
  import.meta.url,
);
const loginReadinessUrl = new URL(
  "../fixtures/phase5/frontend-login-readiness-contract.json",
  import.meta.url,
);

test("the exact lifecycle observation requires one SIGINT to one emulator process", async () => {
  const fixture = JSON.parse(await readFile(singleSigintUrl, "utf8")) as {
    readonly contract: {
      readonly directoryProcessGroupReapIsFallbackOnly: boolean;
      readonly exportMetadataRequiredBeforeMprocsForceQuit: boolean;
      readonly gracefulSignal: string;
      readonly gracefulSignalDeliveryCount: number;
      readonly gracefulSignalTarget: string;
      readonly phase5ThresholdsMayChange: boolean;
      readonly processGroupSignalAllowedForGracefulShutdown: boolean;
      readonly processIdentityFields: readonly string[];
      readonly waitForExactProcessIdentityExit: boolean;
      readonly zeroDirectoryOwnedProcessesRequiredAfterCleanup: boolean;
    };
    readonly observation: {
      readonly fireside: {
        readonly emulatorListenerOutlivedExport: boolean;
        readonly exportMetadataPresent: boolean;
        readonly lifecycleBoundaryExceeded: boolean;
      };
      readonly host: {
        readonly failedSystemdUnits: number;
        readonly isolatedListenersAfterScopedCleanup: number;
        readonly isolatedProcessesAfterScopedCleanup: number;
        readonly kernelOomEvidence: number;
      };
      readonly official: {
        readonly exportMetadataPresent: boolean;
        readonly firstSigintStartedCleanShutdown: boolean;
        readonly secondSigintForcedExit: boolean;
        readonly subprocessesStillRunningReported: number;
      };
    };
    readonly oracle: {
      readonly candidateCommit: string;
      readonly supersedes: { readonly field: string; readonly fixture: string };
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(
    fixture.oracle.candidateCommit,
    "a081386df5fbe67e199069d4ca98aba113d6d93b",
  );
  assert.deepEqual(fixture.oracle.supersedes, {
    field: "contract.directEmulatorProcessGroupSigintRequired",
    fixture: "mprocs-headless-shutdown-contract.json",
  });
  assert.equal(fixture.observation.official.firstSigintStartedCleanShutdown, true);
  assert.equal(fixture.observation.official.secondSigintForcedExit, true);
  assert.equal(fixture.observation.official.subprocessesStillRunningReported, 2);
  assert.equal(fixture.observation.official.exportMetadataPresent, false);
  assert.equal(fixture.observation.fireside.exportMetadataPresent, true);
  assert.equal(fixture.observation.fireside.emulatorListenerOutlivedExport, true);
  assert.equal(fixture.observation.fireside.lifecycleBoundaryExceeded, true);
  assert.deepEqual(fixture.observation.host, {
    failedSystemdUnits: 0,
    isolatedListenersAfterScopedCleanup: 0,
    isolatedProcessesAfterScopedCleanup: 0,
    kernelOomEvidence: 0,
  });
  assert.deepEqual(fixture.contract, {
    directoryProcessGroupReapIsFallbackOnly: true,
    exportMetadataRequiredBeforeMprocsForceQuit: true,
    gracefulSignal: "SIGINT",
    gracefulSignalDeliveryCount: 1,
    gracefulSignalTarget: "exact emulator launch process",
    phase5ThresholdsMayChange: false,
    processGroupSignalAllowedForGracefulShutdown: false,
    processIdentityFields: ["pid", "procStatStartTimeTicks"],
    waitForExactProcessIdentityExit: true,
    zeroDirectoryOwnedProcessesRequiredAfterCleanup: true,
  });
});

test("the failed browser journey freezes the login readiness and evidence gap", async () => {
  const fixture = JSON.parse(await readFile(loginReadinessUrl, "utf8")) as {
    readonly contract: {
      readonly browserNavigationMustFailBeforeSelectorWaitOnStatusError: boolean;
      readonly browserNavigationStatusMustBeRecorded: boolean;
      readonly maximumAcceptedReadinessStatus: number;
      readonly phase5ThresholdsMayChange: boolean;
      readonly privateResponseBodiesMayBeStored: boolean;
      readonly readinessProbeRoute: string;
      readonly renderedSelectorTimeoutMilliseconds: number;
      readonly revalidateImmediatelyBeforeBrowserJourney: boolean;
    };
    readonly observation: {
      readonly exactNavigationStatusStored: boolean;
      readonly firstPartyResponses: number;
      readonly journeysCompleted: number;
      readonly navigationStatusClass: string;
      readonly requiredFailures: number;
      readonly requiredRequests: number;
    };
    readonly sourceContract: { readonly emailInputId: string; readonly loginRoute: string };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.sourceContract, {
    emailInputId: "workEmail",
    loginRoute: "/login",
  });
  assert.deepEqual(fixture.observation, {
    browserErrorHash: "c11cd719e31ad32230b53c5f8e78d59764b8cac13ebe610bca4133567d8b2812",
    browserEvidenceSha256: "a85c07e75e91fdc1a1f993b7d232893133c626ccf749d22c074a1f51ecbeb5e5",
    cacheBuildReady: true,
    exactNavigationStatusStored: false,
    failedSystemdUnits: 0,
    firstPartyResponses: 1,
    fullDatasetReady: true,
    journeysCompleted: 0,
    kernelOomEvidence: 0,
    navigationStatusClass: ">=400",
    observedRouteClass: "https://phase5-official.templates.twodart.localhost:443/login",
    requiredFailures: 1,
    requiredRequests: 1,
    selectorFailure: "workEmail was not found before the 30000 ms locator timeout",
    stack: "official",
  });
  assert.deepEqual(fixture.contract, {
    browserNavigationMustFailBeforeSelectorWaitOnStatusError: true,
    browserNavigationStatusMustBeRecorded: true,
    maximumAcceptedReadinessStatus: 399,
    phase5ThresholdsMayChange: false,
    privateResponseBodiesMayBeStored: false,
    readinessProbeRoute: "/login",
    renderedSelectorTimeoutMilliseconds: 180_000,
    revalidateImmediatelyBeforeBrowserJourney: true,
  });
});
