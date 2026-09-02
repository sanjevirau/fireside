import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/mprocs-headless-shutdown-contract.json",
  import.meta.url,
);

test("mprocs oracle defines deterministic headless lifecycle shutdown", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly contract: {
      readonly cliFlag: string;
      readonly controlEventAfterEmulatorExit: string;
      readonly directEmulatorProcessGroupSigintRequired: boolean;
      readonly emulatorGrandchildExitGuaranteed: boolean;
      readonly applicationGrandchildExitGuaranteed: boolean;
      readonly forceQuitSafeOnlyAfterEmulatorProcessGroupExited: boolean;
      readonly headlessTransport: string;
      readonly postQuitDirectoryProcessAuditRequired: boolean;
      readonly quitRequestsConfiguredChildStop: boolean;
      readonly quitStopsServerAfterChildrenExit: boolean;
      readonly terminalKeyDependsOnFocus: boolean;
    };
    readonly oracle: {
      readonly packageRevision: string;
      readonly sourceRevision: string;
      readonly version: string;
    };
    readonly observation: {
      readonly failedStartCleanup: {
        readonly gateExitCode: number;
        readonly gateListenersRemaining: number;
        readonly orphanedApplicationProcessGroups: readonly string[];
        readonly orphanedListeners: readonly number[];
        readonly orphanedProcessCount: number;
        readonly requiredCleanup: string;
      };
      readonly fullDatasetExport: {
        readonly completionObservedAt: string;
        readonly maximumObservedSeconds: number;
        readonly minimumShutdownAllowanceSeconds: number;
        readonly sigintSentAt: string;
      };
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.oracle, {
    component: "mprocs",
    packageRevision: "024743006f46effc5c72b91bca11eef3c6253460",
    sourceFiles: [
      "src/mprocs/ctl.rs",
      "src/mprocs/event.rs",
      "src/mprocs/modal/quit.rs",
    ],
    sourceRevision: "aeba627ff59c1dd1444f0d0dcbed7759d1dbcf9c",
    version: "0.9.6-twodart.2",
  });
  assert.equal(fixture.contract.cliFlag, "--ctl");
  assert.equal(fixture.contract.controlEventAfterEmulatorExit, "c: force-quit");
  assert.equal(fixture.contract.directEmulatorProcessGroupSigintRequired, true);
  assert.equal(fixture.contract.emulatorGrandchildExitGuaranteed, false);
  assert.equal(fixture.contract.applicationGrandchildExitGuaranteed, false);
  assert.equal(fixture.contract.forceQuitSafeOnlyAfterEmulatorProcessGroupExited, true);
  assert.equal(fixture.contract.headlessTransport, "configured TCP control server");
  assert.equal(fixture.contract.postQuitDirectoryProcessAuditRequired, true);
  assert.equal(fixture.contract.quitRequestsConfiguredChildStop, true);
  assert.equal(fixture.contract.terminalKeyDependsOnFocus, true);
  assert.equal(fixture.contract.quitStopsServerAfterChildrenExit, true);
  assert.deepEqual(fixture.observation.fullDatasetExport, {
    completionObservedAt: "2026-09-02T13:38:53+08:00",
    maximumObservedSeconds: 245,
    minimumShutdownAllowanceSeconds: 600,
    sigintSentAt: "2026-09-02T13:34:48+08:00",
  });
  assert.equal(fixture.observation.failedStartCleanup.gateExitCode, 1);
  assert.equal(fixture.observation.failedStartCleanup.gateListenersRemaining, 0);
  assert.equal(fixture.observation.failedStartCleanup.orphanedProcessCount, 22);
  assert.deepEqual(fixture.observation.failedStartCleanup.orphanedApplicationProcessGroups, [
    "templates-python",
    "dotnet",
    "images",
    "templates",
  ]);
  assert.deepEqual(fixture.observation.failedStartCleanup.orphanedListeners, [
    4599,
    4848,
    4659,
    40629,
    40745,
    4115,
  ]);
  assert.match(fixture.observation.failedStartCleanup.requiredCleanup, /every process-group member/u);
});
