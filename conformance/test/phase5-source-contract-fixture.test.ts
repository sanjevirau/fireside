import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Fixture {
  readonly schemaVersion: number;
  readonly oracle: string;
  readonly revision: string;
  readonly credentialsStored: boolean;
  readonly accessTokensStored: boolean;
  readonly realUserDataStored: boolean;
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly browserContract: Readonly<Record<string, unknown>>;
  readonly adminNavigationPageIds: readonly string[];
  readonly journeyIds: readonly string[];
  readonly invariants: Readonly<Record<string, unknown>>;
}

const root = new URL(
  "../fixtures/phase5/twodart-source-contract/",
  import.meta.url,
);

test("the cheap soak freezes its initialization failure and complete-window requirement", async () => {
  const fixture = JSON.parse(await readFile(new URL(
    "../fixtures/phase5/soak-runtime-boundaries.json", import.meta.url,
  ), "utf8"));
  assert.equal(fixture.observed.browserJourneysPassed, 9);
  assert.equal(fixture.observed.soakPassed, false);
  assert.equal(fixture.observed.primaryError, "ReferenceError: Cannot access 'frozenDispatchBody' before initialization");
  assert.equal(fixture.sourceAudit.includeFinalWindowEndpoint, true);
  assert.equal(fixture.sourceAudit.zeroSwapThresholdUnchanged, true);
  assert.equal(fixture.sourceAudit.fullSecondsUnchanged, 7200);
});

test("the first strict nine-journey pass exposes the smoke soak catalog precondition", async () => {
  const fixture = JSON.parse(await readFile(new URL(
    "../fixtures/phase5/smoke-soak-catalog-precondition.json", import.meta.url,
  ), "utf8"));
  assert.equal(fixture.browser.passed, true);
  assert.equal(fixture.browser.journeys, 9);
  assert.equal(fixture.browser.skippedJourneys, 0);
  assert.equal(fixture.soak.passed, false);
  assert.equal(fixture.soak.collection, "premade-templates");
  const file = "/srv/dev-fast/runtime-data/fireside-phase5-20260902T1417+0800-5b51e4d/harness-20165b0/conformance/src/suite/run-phase5-soak.ts";
  const stack = `Error: ${fixture.soak.errorMessage}\n` +
    `    at catalogRead (${file}:529:29)\n` +
    "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n" +
    `    at async scheduledWorker (${file}:458:7)\n` +
    "    at async Promise.allSettled (index 3)\n" +
    `    at async main (${file}:193:21)\n` +
    `    at async <anonymous> (${file}:148:1)`;
  assert.equal(createHash("sha256").update(stack).digest("hex"), fixture.soak.errorStackSha256);
  assert.equal(fixture.correctionContract.fullDataCatalogMustNotBeSynthesized, true);
  assert.equal(fixture.correctionContract.zeroSwapRuleUnchanged, true);
});

test("the final Mac runner patch freezes strict export and trace contracts", async () => {
  const fixture = JSON.parse(await readFile(new URL(
    "../fixtures/phase5/mac-final-runner-contract.json", import.meta.url,
  ), "utf8"));
  assert.equal(fixture.reportedMacJourneysPassed, 9);
  assert.equal(fixture.contracts.exportPaletteLength, 11);
  assert.equal(fixture.contracts.exportTimeoutIsFailureNotSkip, true);
  assert.equal(fixture.contracts.exportStatusHttp200MayContainTerminalFailure, true);
  assert.equal(fixture.contracts.referenceErrorsAreNeverAllowlisted, true);
  assert.equal(fixture.contracts.navigationTraceIsLiteralBrowserJavaScript, true);
  assert.equal(fixture.fullDataRequiresCompleteBothStackSmoke, true);
  assert.equal(fixture.thresholdsChanged, false);
});

test("the Twodart source oracle freezes the exact Phase 5 browser contract", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("fixture.json", root), "utf8"),
  ) as Fixture;

  assert.equal(fixture.schemaVersion, 3);
  assert.equal(fixture.oracle, "readable-twodart-source");
  assert.equal(fixture.revision, "6bda5bf29b2399017d2a872e8f3fc1a15d073a54");
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.realUserDataStored, false);
  assert.equal(fixture.sourceFiles.length, 20);
  for (const source of fixture.sourceFiles) {
    assert.match(
      source.path,
      /^(?:apps\/templates|engines\/twodartnet|scripts\/setup|libs\/common)\//u,
    );
    assert.match(source.sha256, /^[0-9a-f]{64}$/u);
  }

  assert.deepEqual(fixture.browserContract, {
    loginRoute: "/login/overview",
    loginPageTypeMain: "overview",
    emailInputId: "workEmail",
    emailSubmitText: "Continue",
    verificationInputId: "verificationCode",
    verificationSubmitText: "Start using Choladeck",
    verificationEndpoint: "/api/login/verificationCode",
    verificationMethod: "POST",
    verificationDigits: 6,
    authenticatedLandingRoute: "/home/recent",
    deckRoutePrefix: "/presentation/",
    premadeTemplatesRoute: "/premade-templates",
    slideLibraryRoute: "/slide-library",
    adminRoute: "/admin",
    twodartNetHealthRoute: "/api/HealthCheck",
  });

  assert.deepEqual(fixture.journeyIds, [
    "otp-auth-login",
    "dashboard-and-deck-list",
    "existing-deck-and-listener-edit",
    "catalog-slide-add",
    "deck-image-upload",
    "duplicate-and-delete-deck",
    "dotnet-deck-export",
    "dev-admin-pages",
    "sign-out-and-sign-in",
  ]);
  assert.equal(fixture.adminNavigationPageIds.length, 18);
  assert.equal(fixture.invariants.otpMayAppearInEvidence, false);
  assert.equal(fixture.invariants.datasetIdentityMayAppearInEvidence, false);
  assert.equal(fixture.invariants.authCallbacksMayMutateRouterQuery, false);
  assert.equal(fixture.invariants.signedOutLoginPathIsModuleLocal, true);
  assert.equal(fixture.invariants.externalProviderMutationsAllowed, false);
  assert.equal(fixture.invariants.liveMacMprocsMayBeTouched, false);
});

test("the source-oracle fixture and documentation have a complete checksum inventory", async () => {
  const sums = await readFile(new URL("SHA256SUMS", root), "utf8");
  assert.equal(sums.trimEnd().split("\n").length, 2);
  for (const line of sums.trimEnd().split("\n")) {
    const match = /^(?<sha>[0-9a-f]{64})  (?<name>.+)$/u.exec(line);
    assert.ok(match?.groups !== undefined, line);
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL(match.groups.name!, root)))
        .digest("hex"),
      match.groups.sha,
    );
  }

  const fixtureText = await readFile(new URL("fixture.json", root), "utf8");
  assert.doesNotMatch(fixtureText, /(?:AIza|ya29\.|sk_(?:live|test)|@(?:gmail|yahoo)\.)/u);
  assert.doesNotMatch(fixtureText, /\/Users\/|\/home\/sanjevi\//u);
});
