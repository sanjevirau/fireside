import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./auth-refresh-reuse.test.ts";

interface Observation {
  readonly id: string;
  readonly status: number;
  readonly response: unknown;
}

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly targetVersion: string;
  readonly targetProject: string;
  readonly credentialsStored: boolean;
  readonly accessTokensStored: boolean;
  readonly realUserDataStored: boolean;
  readonly observations: readonly Observation[];
  readonly decodedTokenContracts?: readonly {
    readonly id: string;
    readonly claims: Readonly<Record<string, unknown>>;
  }[];
  readonly dispatches?: readonly {
    readonly method: string;
    readonly path: string;
    readonly body: Readonly<Record<string, unknown>>;
  }[];
  readonly invariants?: Readonly<Record<string, unknown>>;
}

const fixtureNames = [
  "auth-identity-toolkit-and-admin",
  "auth-browser-oauth-and-token-refresh",
  "auth-import-export-and-trigger-dispatch",
] as const;

test("the Auth oracle freezes client, Admin, custom-token, refresh, and error contracts", async () => {
  const fixture = await loadFixture("auth-identity-toolkit-and-admin");
  assertFixtureMetadata(fixture);
  assert.deepEqual(
    fixture.observations.map(({ id, status }) => ({ id, status })),
    [
      { id: "readiness", status: 200 },
      { id: "password-sign-up", status: 200 },
      { id: "client-account-lookup", status: 200 },
      { id: "client-profile-update", status: 200 },
      { id: "admin-custom-claims-update", status: 200 },
      { id: "admin-lookup-by-email", status: 200 },
      { id: "admin-query-users", status: 200 },
      { id: "password-sign-in", status: 200 },
      { id: "strict-json-custom-token-sign-in", status: 200 },
      { id: "secure-token-refresh", status: 200 },
      { id: "wrong-password-error", status: 400 },
    ],
  );

  const wrongPassword = observation(fixture, "wrong-password-error");
  assert.equal(
    nestedString(wrongPassword.response, ["error", "message"]),
    "INVALID_PASSWORD",
  );
  const passwordClaims = tokenClaims(fixture, "password-sign-in");
  assert.equal(passwordClaims.role, "owner");
  assert.equal(passwordClaims.unicode, "火🔥");
  assert.equal(
    nestedString(passwordClaims, ["firebase", "sign_in_provider"]),
    "password",
  );
  const customClaims = tokenClaims(fixture, "custom-token-sign-in");
  assert.equal(customClaims.tier, "oracle");
  assert.equal(customClaims.emoji, "🔥");
  assert.equal(customClaims.iss, `https://securetoken.google.com/${fixture.targetProject}`);
  assert.equal(customClaims.aud, fixture.targetProject);
});

test("the Auth browser fixture freezes fake OAuth helper pages and refreshed JWT identity", async () => {
  const fixture = await loadFixture("auth-browser-oauth-and-token-refresh");
  assertFixtureMetadata(fixture);
  assert.deepEqual(
    fixture.observations.map(({ id, status }) => ({ id, status })),
    [
      { id: "create-auth-uri-existing-password-user", status: 200 },
      { id: "recaptcha-parameters", status: 200 },
      { id: "fake-google-idp-sign-in", status: 200 },
      { id: "idp-secure-token-refresh", status: 200 },
      { id: "oauth-popup-handler", status: 200 },
      { id: "oauth-helper-iframe", status: 200 },
    ],
  );

  const createAuthUri = observation(
    fixture,
    "create-auth-uri-existing-password-user",
  );
  assert.equal(nestedBoolean(createAuthUri.response, ["registered"]), true);
  assert.deepEqual(nestedArray(createAuthUri.response, ["signinMethods"]), ["password"]);

  const googleClaims = tokenClaims(fixture, "fake-google-idp");
  assert.equal(googleClaims.email, "phase4-google@example.com");
  assert.equal(
    nestedString(googleClaims, ["firebase", "sign_in_provider"]),
    "google.com",
  );
  assert.deepEqual(tokenClaims(fixture, "idp-refresh").firebase, googleClaims.firebase);

  const popup = observation(fixture, "oauth-popup-handler");
  assert.ok(nestedNumber(popup.response, ["byteLength"]) > 10_000);
  assert.match(nestedString(popup.response, ["sha256"]) ?? "", /^[0-9a-f]{64}$/u);
  const iframe = observation(fixture, "oauth-helper-iframe");
  assert.ok(nestedArray(iframe.response, ["contains"]).includes("gapi.iframes"));
});

test("the Auth lifecycle fixture proves imports are quiet and create/delete multicast exactly once", async () => {
  const fixture = await loadFixture("auth-import-export-and-trigger-dispatch");
  assertFixtureMetadata(fixture);
  assert.equal(fixture.invariants?.batchImportDispatchCount, 0);
  assert.equal(fixture.invariants?.lifecycleDispatchCount, 2);
  assert.equal(fixture.invariants?.capturedDispatchCount, 2);
  assert.equal(fixture.invariants?.batchImportTriggersCreateEvents, false);

  assert.equal(fixture.dispatches?.length, 2);
  assert.deepEqual(
    fixture.dispatches?.map((dispatch) => nestedString(dispatch.body, ["eventType"])),
    [
      "providers/firebase.auth/eventTypes/user.create",
      "providers/firebase.auth/eventTypes/user.delete",
    ],
  );
  for (const dispatch of fixture.dispatches ?? []) {
    assert.equal(dispatch.method, "POST");
    assert.equal(
      dispatch.path,
      `/functions/projects/${fixture.targetProject}/trigger_multicast`,
    );
    assert.equal(
      nestedString(dispatch.body, ["resource", "service"]),
      "firebaseauth.googleapis.com",
    );
    assert.equal(nestedString(dispatch.body, ["data", "uid"]), "phase4-lifecycle-user");
    assert.equal(nestedString(dispatch.body, ["data", "displayName"]), "Lifecycle 🔥");
  }

  const exported = observation(fixture, "accounts-json-batch-export");
  const users = nestedArray(exported.response, ["users"]);
  const imported = users.filter((user): user is Record<string, unknown> =>
    typeof user === "object" && user !== null &&
      ["phase4-import-user-a", "phase4-import-user-b"].includes(
        String((user as Record<string, unknown>).localId),
      ),
  );
  assert.equal(imported.length, 2);
  assert.equal(imported[0]?.createdAt, "1700000000000");
  assert.equal(imported[1]?.disabled, true);
});

test("every permanent Auth fixture has a complete and valid checksum inventory", async () => {
  for (const fixtureName of fixtureNames) {
    const root = fixtureRoot(fixtureName);
    const sums = await readFile(new URL("SHA256SUMS", root), "utf8");
    assert.equal(sums.trimEnd().split("\n").length, 2, fixtureName);
    for (const line of sums.trimEnd().split("\n")) {
      const match = /^(?<sha>[0-9a-f]{64})  (?<name>.+)$/u.exec(line);
      assert.ok(match?.groups !== undefined, line);
      assert.equal(
        sha256(await readFile(new URL(match.groups.name!, root))),
        match.groups.sha,
        `${fixtureName}/${match.groups.name!}`,
      );
    }
  }
});

async function loadFixture(name: typeof fixtureNames[number]): Promise<Fixture> {
  return JSON.parse(
    await readFile(new URL("fixture.json", fixtureRoot(name)), "utf8"),
  ) as Fixture;
}

function fixtureRoot(name: typeof fixtureNames[number]): URL {
  return new URL(`../fixtures/firebase-suite-v1/${name}/`, import.meta.url);
}

function assertFixtureMetadata(fixture: Fixture): void {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.target, "official-firebase-tools-auth-emulator");
  assert.equal(fixture.targetVersion, "15.22.0");
  assert.match(fixture.targetProject, /^demo-/u);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.realUserDataStored, false);
}

function observation(fixture: Fixture, id: string): Observation {
  const match = fixture.observations.find((candidate) => candidate.id === id);
  assert.ok(match, id);
  return match;
}

function tokenClaims(fixture: Fixture, id: string): Readonly<Record<string, unknown>> {
  const match = fixture.decodedTokenContracts?.find((candidate) => candidate.id === id);
  assert.ok(match, id);
  return match.claims;
}

function nestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  const nested = nestedValue(value, path);
  return typeof nested === "string" ? nested : undefined;
}

function nestedBoolean(value: unknown, path: readonly string[]): boolean | undefined {
  const nested = nestedValue(value, path);
  return typeof nested === "boolean" ? nested : undefined;
}

function nestedNumber(value: unknown, path: readonly string[]): number {
  const nested = nestedValue(value, path);
  return typeof nested === "number" ? nested : Number.NaN;
}

function nestedArray(value: unknown, path: readonly string[]): unknown[] {
  const nested = nestedValue(value, path);
  return Array.isArray(nested) ? nested : [];
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
