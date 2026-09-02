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
      readonly controlEvent: string;
      readonly directEmulatorProcessGroupSigintRequired: boolean;
      readonly emulatorGrandchildExitGuaranteed: boolean;
      readonly headlessTransport: string;
      readonly quitRequestsConfiguredChildStop: boolean;
      readonly quitStopsServerAfterChildrenExit: boolean;
      readonly terminalKeyDependsOnFocus: boolean;
    };
    readonly oracle: {
      readonly packageRevision: string;
      readonly sourceRevision: string;
      readonly version: string;
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
  assert.equal(fixture.contract.controlEvent, "c: quit");
  assert.equal(fixture.contract.directEmulatorProcessGroupSigintRequired, true);
  assert.equal(fixture.contract.emulatorGrandchildExitGuaranteed, false);
  assert.equal(fixture.contract.headlessTransport, "configured TCP control server");
  assert.equal(fixture.contract.quitRequestsConfiguredChildStop, true);
  assert.equal(fixture.contract.terminalKeyDependsOnFocus, true);
  assert.equal(fixture.contract.quitStopsServerAfterChildrenExit, true);
});
