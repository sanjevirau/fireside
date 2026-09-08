import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly credentialsStored: boolean;
  readonly authorizationHeadersStored: boolean;
  readonly persistentCloudReads: number;
  readonly persistentCloudWrites: number;
  readonly javaJarSha256: string;
  readonly rulesSourceSha256: string;
  readonly nonBlankLines: number;
  readonly allowCases: number;
  readonly denyCases: number;
  readonly productionCompile: {
    readonly httpStatus: number;
    readonly response: { readonly issues?: readonly unknown[] };
  };
  readonly observations: ReadonlyArray<{
    readonly id: string;
    readonly feature: string;
    readonly expected: "ALLOW" | "DENY";
    readonly status: number;
    readonly body: unknown;
  }>;
}

test("the complex 1,193-line rules fixture passes its authoritative cases", async () => {
  const rulesBytes = await readFile(
    new URL("../fixtures/rules-v2/complex-firestore.rules", import.meta.url),
  );
  const casesBytes = await readFile(
    new URL("../fixtures/rules-v2/complex-rules-cases.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(rulesBytes).digest("hex"),
    "60218bddbb680859f3379659e969379ff63dcf926b34bef0b99b85716ce3017c",
  );
  assert.equal(
    createHash("sha256").update(casesBytes).digest("hex"),
    "f490c214849ec4921b3e07c4fcd14347486e64e0e86dcb168fd5ab820e949f81",
  );
  const fixture = JSON.parse(casesBytes.toString("utf8")) as Fixture;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(
    fixture.target,
    "official-java-emulator-and-production-compile",
  );
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.authorizationHeadersStored, false);
  assert.equal(fixture.persistentCloudReads, 0);
  assert.equal(fixture.persistentCloudWrites, 0);
  assert.equal(fixture.rulesSourceSha256, "60218bddbb680859f3379659e969379ff63dcf926b34bef0b99b85716ce3017c");
  assert.equal(fixture.nonBlankLines, 1_193);
  assert.equal(fixture.productionCompile.httpStatus, 200);
  assert.deepEqual(fixture.productionCompile.response.issues ?? [], []);
  assert.equal(fixture.allowCases, 27);
  assert.equal(fixture.denyCases, 18);
  assert.equal(fixture.observations.length, 45);
  assert.ok(
    fixture.observations.every(({ expected, status }) =>
      expected === "ALLOW" ? status >= 200 && status < 300 : status === 403,
    ),
  );
  assert.deepEqual(
    [...new Set(fixture.observations.map(({ feature }) => feature))].sort(),
    [
      "auth-and-custom-claims",
      "complex-generated-policy",
      "create-update-delete-resource-differences",
      "cross-document-access",
      "field-change-validation",
      "getAfter-batch-invariant",
      "nested-and-recursive-matches",
      "public-read",
      "query-limit-validation",
      "timestamps-durations-and-helper-functions",
    ],
  );
  const serialized = casesBytes.toString("utf8").toLowerCase();
  for (const forbidden of [
    "bearer ",
    "access_token",
    "refresh_token",
    "private_key",
    "client_secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
