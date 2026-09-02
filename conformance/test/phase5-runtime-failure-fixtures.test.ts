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
