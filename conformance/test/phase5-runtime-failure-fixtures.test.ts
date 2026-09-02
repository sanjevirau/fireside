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
const tinyBrowserRuntimeUrl = new URL(
  "../fixtures/phase5/tiny-browser-runtime-contract.json",
  import.meta.url,
);
const tinyBrowserR5CleanupUrl = new URL(
  "../fixtures/phase5/tiny-browser-r5-cleanup-contract.json",
  import.meta.url,
);
const tinyBrowserR6ReadinessCleanupUrl = new URL(
  "../fixtures/phase5/tiny-browser-r6-readiness-cleanup-contract.json",
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

test("the r6 smoke freezes stable readiness errors and identity-scoped cleanup", async () => {
  const fixture = JSON.parse(
    await readFile(tinyBrowserR6ReadinessCleanupUrl, "utf8"),
  ) as {
    readonly schemaVersion: number;
    readonly oracle: {
      readonly candidateRevision: string;
      readonly diagnostic: string;
      readonly manifestSha256: string;
      readonly twodartRevision: string;
    };
    readonly sourceBeforeFix: { readonly sha256: string };
    readonly observation: {
      readonly allRequiredListenersReady: boolean;
      readonly allRequiredLogGatesReady: boolean;
      readonly browserJourneysCompleted: number;
      readonly cleanupRefusedMixedProcessGroup: number;
      readonly directoryOwnedMembersInMixedGroup: number;
      readonly directoryOwnedProcessesAfterManualCleanup: number;
      readonly directoryOwnedProcessesBeforeManualCleanup: number;
      readonly failedSystemdUnits: number;
      readonly frontendLoginFirstObservedStatus: number;
      readonly identicalErrorSamplesBeforeFailFast: number;
      readonly isolatedListenersAfterManualCleanup: number;
      readonly kernelOomEvidence: number;
      readonly outsideDirectoryMembersInMixedGroup: number;
      readonly outsideDirectoryProcessClass: string;
      readonly sharedCompilerPreserved: boolean;
      readonly steadySwapInOutSamples: readonly (readonly [number, number])[];
      readonly syntheticOnly: boolean;
    };
    readonly contract: {
      readonly cleanupProcessIdentityFields: readonly string[];
      readonly cleanupSignalTarget: string;
      readonly diagnosticDefinitiveErrorRequiresConsecutiveIdenticalSamples: number;
      readonly directoryOwnershipMustBeRevalidatedBeforeEverySignal: boolean;
      readonly mixedProcessGroupMayBeSignaledAsAGroup: boolean;
      readonly phase5ThresholdsMayChange: boolean;
      readonly readinessLimitSeconds: number;
      readonly sharedOutOfDirectoryProcessesMustRemainUntouched: boolean;
      readonly successfulProbeClearsErrorStreak: boolean;
      readonly twoConsecutiveEmptyDirectoryScansRequired: boolean;
      readonly unavailableProbeClearsErrorStreak: boolean;
      readonly zeroDirectoryOwnedProcessesRequired: boolean;
      readonly zeroIsolatedListenersRequired: boolean;
    };
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.oracle, {
    candidateRevision: "775ceda0b8c0992f95b5b3203502bb75b8d6b102",
    diagnostic: "two-tier-smoke-20260902T222845+0800-775ceda-r6",
    kind: "exact synthetic Phase 5 diagnostic smoke failure plus post-failure process audit",
    manifestSha256: "27f643a6e6b5b060bb548359584a133e1bec937b06eb3b3f91982910a985faaa",
    twodartRevision: "b13c6bd0b4b6fdb5c211395ebfb35e5eebb50c08",
  });
  assert.equal(
    fixture.sourceBeforeFix.sha256,
    "ff3065b046ef4517e6bbba006e61a5b8d1e718c90a85c433f80f4ca59e9363d3",
  );
  assert.deepEqual(fixture.observation, {
    allRequiredListenersReady: true,
    allRequiredLogGatesReady: true,
    browserJourneysCompleted: 0,
    cleanupRefusedMixedProcessGroup: 129879,
    directoryOwnedMembersInMixedGroup: 5,
    directoryOwnedProcessesAfterManualCleanup: 0,
    directoryOwnedProcessesBeforeManualCleanup: 22,
    failedSystemdUnits: 0,
    frontendLoginFirstObservedStatus: 404,
    gateFailureHash: "713ded432f9843c51bfbdffad4027109cde9eefaf8c9e57afd364ebd6c7ead31",
    identicalErrorSamplesBeforeFailFast: 1,
    isolatedListenersAfterManualCleanup: 0,
    kernelOomEvidence: 0,
    outsideDirectoryMembersInMixedGroup: 1,
    outsideDirectoryProcessClass: "dotnet-vbcscompiler",
    sharedCompilerPreserved: true,
    stack: "official",
    steadySwapInOutSamples: [[0, 0], [0, 0], [0, 0]],
    syntheticOnly: true,
  });
  assert.deepEqual(fixture.contract, {
    cleanupProcessIdentityFields: ["pid", "procStatStartTimeTicks"],
    cleanupSignalTarget: "exact directory-owned process identity",
    diagnosticDefinitiveErrorRequiresConsecutiveIdenticalSamples: 3,
    directoryOwnershipMustBeRevalidatedBeforeEverySignal: true,
    mixedProcessGroupMayBeSignaledAsAGroup: false,
    phase5ThresholdsMayChange: false,
    readinessLimitSeconds: 60,
    sharedOutOfDirectoryProcessesMustRemainUntouched: true,
    successfulProbeClearsErrorStreak: true,
    twoConsecutiveEmptyDirectoryScansRequired: true,
    unavailableProbeClearsErrorStreak: true,
    zeroDirectoryOwnedProcessesRequired: true,
    zeroIsolatedListenersRequired: true,
  });
});

test("the failed browser journey freezes the exact readiness routes and evidence gaps", async () => {
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
      readonly twodartNetHealthProbeRoute: string;
    };
    readonly observations: {
      readonly correctedReadinessFailure: {
        readonly bareLoginStatus: number;
        readonly dotnetRootStatus: number;
        readonly firesideStarted: boolean;
        readonly isolatedListenersAfterScopedCleanup: number;
        readonly isolatedProcessesAfterScopedCleanup: number;
        readonly officialExportCompleted: boolean;
        readonly orphanedDirectoryProcessGroups: readonly number[];
        readonly orphanedListenerPorts: readonly number[];
      };
      readonly priorBrowserFailure: {
        readonly exactNavigationStatusStored: boolean;
        readonly firstPartyResponses: number;
        readonly journeysCompleted: number;
        readonly navigationStatusClass: string;
        readonly requiredFailures: number;
        readonly requiredRequests: number;
      };
    };
    readonly sourceContract: {
      readonly dotnetHealthControllerPath: string;
      readonly dotnetHealthRoute: string;
      readonly emailInputId: string;
      readonly loginPageTypeMain: string;
      readonly loginPageTypePath: string;
      readonly loginRoute: string;
      readonly loginRoutePath: string;
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 2);
  assert.deepEqual(fixture.sourceContract, {
    dotnetHealthControllerPath:
      "engines/twodartnet/TwodartNet/Controllers/HealthCheckController.cs",
    dotnetHealthRoute: "/api/HealthCheck",
    emailInputId: "workEmail",
    loginPageTypeMain: "overview",
    loginPageTypePath:
      "apps/templates/components/Login/components/LoginPage/LoginPage.tsx",
    loginRoute: "/login/overview",
    loginRoutePath: "apps/templates/pages/login/[loginType].tsx",
  });
  assert.deepEqual(fixture.observations.priorBrowserFailure, {
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
  assert.deepEqual(fixture.observations.correctedReadinessFailure, {
    bareLoginStatus: 404,
    dotnetRootStatus: 404,
    failedSystemdUnits: 0,
    firesideStarted: false,
    isolatedListenersAfterScopedCleanup: 0,
    isolatedProcessesAfterScopedCleanup: 0,
    kernelOomEvidence: 0,
    manualScopedCleanupSignal: "SIGINT",
    officialCacheReady: true,
    officialExportCompleted: true,
    officialFullDatasetStarted: true,
    officialStorageExportObjects: 33353,
    officialStorageExportSize: "6.23 GB",
    orphanedDirectoryProcessGroups: [78521, 78525, 78538, 78540, 79096, 79097],
    orphanedListenerPorts: [23012],
    readinessTimeoutSeconds: 1200,
    stack: "official",
  });
  assert.deepEqual(fixture.contract, {
    browserNavigationMustFailBeforeSelectorWaitOnStatusError: true,
    browserNavigationStatusMustBeRecorded: true,
    maximumAcceptedReadinessStatus: 399,
    phase5ThresholdsMayChange: false,
    privateResponseBodiesMayBeStored: false,
    readinessProbeRoute: "/login/overview",
    renderedSelectorTimeoutMilliseconds: 180_000,
    revalidateImmediatelyBeforeBrowserJourney: true,
    twodartNetHealthProbeRoute: "/api/HealthCheck",
  });
});

test("the tiny browser smoke freezes runtime-path and client-route failures before fixes", async () => {
  const fixture = JSON.parse(await readFile(tinyBrowserRuntimeUrl, "utf8")) as {
    readonly contract: {
      readonly browserAndWatcherCachePortsMustMatch: boolean;
      readonly browserCachePortEnvironmentVariable: string;
      readonly diagnosticEvidenceMustRemainContentFree: boolean;
      readonly maximumLinuxUnixSocketPathBytes: number;
      readonly phase5ThresholdsMayChange: boolean;
      readonly runtimeDirectoryMustLeaveSocketSuffixHeadroom: boolean;
      readonly signedOutAuthCallbackMayMutateDynamicRouteQuery: boolean;
      readonly signedOutLoginPathMustRemain: string;
    };
    readonly observation: {
      readonly browserCacheWebsocketAttemptPort: number;
      readonly browserCacheWebsocketConnected: boolean;
      readonly browserFinalPath: string;
      readonly browserJourneysCompleted: number;
      readonly cacheWatcherListenPort: number;
      readonly emailSelectorVisible: boolean;
      readonly expectedLoginPath: string;
      readonly exportFirstShutdownCompleted: boolean;
      readonly functionsRuntimeSocketError: string;
      readonly functionsRuntimeSocketPathBytes: number;
      readonly isolatedListenersAfterCleanup: number;
      readonly isolatedProcessesAfterCleanup: number;
      readonly syntheticOnly: boolean;
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.observation.syntheticOnly, true);
  assert.equal(fixture.observation.cacheWatcherListenPort, 23_012);
  assert.equal(fixture.observation.browserCacheWebsocketAttemptPort, 8_081);
  assert.equal(fixture.observation.browserCacheWebsocketConnected, false);
  assert.equal(fixture.observation.expectedLoginPath, "/login/overview");
  assert.equal(fixture.observation.browserFinalPath, "/login/undefined");
  assert.equal(fixture.observation.emailSelectorVisible, false);
  assert.equal(fixture.observation.browserJourneysCompleted, 0);
  assert.equal(fixture.observation.functionsRuntimeSocketError, "EINVAL");
  assert.ok(
    fixture.observation.functionsRuntimeSocketPathBytes >
      fixture.contract.maximumLinuxUnixSocketPathBytes,
  );
  assert.equal(fixture.observation.exportFirstShutdownCompleted, true);
  assert.equal(fixture.observation.isolatedProcessesAfterCleanup, 0);
  assert.equal(fixture.observation.isolatedListenersAfterCleanup, 0);
  assert.deepEqual(fixture.contract, {
    browserAndWatcherCachePortsMustMatch: true,
    browserCachePortEnvironmentVariable: "NEXT_PUBLIC_FIREBASE_CACHE_WEBSOCKET_PORT",
    diagnosticEvidenceMustRemainContentFree: true,
    maximumLinuxUnixSocketPathBytes: 107,
    phase5ThresholdsMayChange: false,
    runtimeDirectoryMustLeaveSocketSuffixHeadroom: true,
    signedOutAuthCallbackMayMutateDynamicRouteQuery: false,
    signedOutLoginPathMustRemain: "/login/overview",
  });
});

test("the corrected tiny smoke freezes reparented cleanup failures before fixes", async () => {
  const fixture = JSON.parse(await readFile(tinyBrowserR5CleanupUrl, "utf8")) as {
    readonly contract: {
      readonly commandArgumentReferenceMayConferOwnership: boolean;
      readonly directoryOwnershipMustBeRevalidatedBeforeEverySignal: boolean;
      readonly directoryProcessDiscoveryMustConvergeAfterReparenting: boolean;
      readonly exportMetadataRequiredBeforeControllerShutdown: boolean;
      readonly launchPathUnderDirectoryMayConferOwnership: boolean;
      readonly phase5ThresholdsMayChange: boolean;
      readonly twoConsecutiveEmptyDirectoryScansRequired: boolean;
      readonly zeroDirectoryOwnedProcessesRequired: boolean;
      readonly zeroIsolatedListenersRequired: boolean;
    };
    readonly observation: {
      readonly cacheWebsocketConnected: boolean;
      readonly exportFirstShutdownCompleted: boolean;
      readonly failedSystemdUnits: number;
      readonly functionsRuntimeSocketPathAccepted: boolean;
      readonly isolatedListenersAfterManualCleanup: number;
      readonly isolatedProcessesAfterManualCleanup: number;
      readonly kernelOomEvidence: number;
      readonly manualScopedCleanupRequired: boolean;
      readonly orphanedListenerPorts: readonly number[];
      readonly reparentedProcessClasses: readonly string[];
      readonly syntheticOnly: boolean;
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.observation.syntheticOnly, true);
  assert.equal(fixture.observation.cacheWebsocketConnected, true);
  assert.equal(fixture.observation.functionsRuntimeSocketPathAccepted, true);
  assert.equal(fixture.observation.exportFirstShutdownCompleted, true);
  assert.deepEqual(fixture.observation.reparentedProcessClasses, [
    "cache-watcher",
    "next",
    "images",
    "twodartnet",
  ]);
  assert.deepEqual(fixture.observation.orphanedListenerPorts, [23_012]);
  assert.equal(fixture.observation.manualScopedCleanupRequired, true);
  assert.equal(fixture.observation.isolatedProcessesAfterManualCleanup, 0);
  assert.equal(fixture.observation.isolatedListenersAfterManualCleanup, 0);
  assert.equal(fixture.observation.failedSystemdUnits, 0);
  assert.equal(fixture.observation.kernelOomEvidence, 0);
  assert.deepEqual(fixture.contract, {
    commandArgumentReferenceMayConferOwnership: false,
    directoryOwnershipMustBeRevalidatedBeforeEverySignal: true,
    directoryProcessDiscoveryMustConvergeAfterReparenting: true,
    exportMetadataRequiredBeforeControllerShutdown: true,
    launchPathUnderDirectoryMayConferOwnership: true,
    phase5ThresholdsMayChange: false,
    twoConsecutiveEmptyDirectoryScansRequired: true,
    zeroDirectoryOwnedProcessesRequired: true,
    zeroIsolatedListenersRequired: true,
  });
});
