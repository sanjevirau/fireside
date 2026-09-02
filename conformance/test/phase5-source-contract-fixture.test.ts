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

test("the Twodart source oracle freezes the exact Phase 5 browser contract", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("fixture.json", root), "utf8"),
  ) as Fixture;

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.oracle, "readable-twodart-source");
  assert.equal(fixture.revision, "6703ee77bb678e6b6ef26237c447b5d13dc51c62");
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.realUserDataStored, false);
  assert.equal(fixture.sourceFiles.length, 7);
  for (const source of fixture.sourceFiles) {
    assert.match(source.path, /^(?:apps\/templates)\//u);
    assert.match(source.sha256, /^[0-9a-f]{64}$/u);
  }

  assert.deepEqual(fixture.browserContract, {
    loginRoute: "/login",
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
