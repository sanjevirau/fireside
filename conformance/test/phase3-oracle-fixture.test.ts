import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

interface FixtureResult {
  readonly state: "SUCCESS" | "FAILURE";
  readonly expressionReports?: readonly unknown[];
  readonly visitedExpressions?: readonly unknown[];
}

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly generatorSeed: string;
  readonly credentialsStored: boolean;
  readonly authorizationHeadersStored: boolean;
  readonly persistentCloudReads: number;
  readonly persistentCloudWrites: number;
  readonly caseCount: number;
  readonly batchCount: number;
  readonly batches: ReadonlyArray<{
    readonly source: string;
    readonly sourceSha256: string;
    readonly cases: readonly unknown[];
    readonly response: {
      readonly issues?: ReadonlyArray<{ readonly severity?: string }>;
      readonly testResults: readonly FixtureResult[];
    };
  }>;
}

const fixturePath = new URL(
  "../fixtures/rules-v2/production-expression-corpus.json",
  import.meta.url,
);

test("captured Phase 3 production expression corpus is complete and credential-free", async () => {
  const bytes = await readFile(fixturePath);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "cfe64606464b46a56fb2ff32ca088e742570fc168ad1ba1c64bc21d2619d42d1",
  );
  const fixture = JSON.parse(bytes.toString("utf8")) as Fixture;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.target, "production-firebase-rules-projects-test");
  assert.equal(fixture.generatorSeed, "fireside-phase-3-rules-v1");
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.authorizationHeadersStored, false);
  assert.equal(fixture.persistentCloudReads, 0);
  assert.equal(fixture.persistentCloudWrites, 0);
  assert.equal(fixture.caseCount, 1_024);
  assert.equal(fixture.batchCount, 32);

  const results = fixture.batches.flatMap(({ response }) => response.testResults);
  assert.equal(results.length, 1_024);
  assert.equal(results.filter(({ state }) => state === "SUCCESS").length, 939);
  assert.equal(results.filter(({ state }) => state === "FAILURE").length, 85);
  assert.ok(results.every(({ expressionReports }) => expressionReports?.length === 30));
  assert.ok(results.every(({ visitedExpressions }) => visitedExpressions?.length === 1));

  const issues = fixture.batches.flatMap(({ response }) => response.issues ?? []);
  assert.equal(issues.filter(({ severity }) => severity === "WARNING").length, 32);
  assert.equal(issues.filter(({ severity }) => severity === "ERROR").length, 0);
  assert.ok(
    fixture.batches.every(
      ({ source, sourceSha256, cases, response }) =>
        createHash("sha256").update(source).digest("hex") === sourceSha256 &&
        cases.length === 32 &&
        response.testResults.length === 32,
    ),
  );

  const serialized = bytes.toString("utf8").toLowerCase();
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
