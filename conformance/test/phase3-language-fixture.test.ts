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
  readonly source: string;
  readonly sourceSha256: string;
  readonly cases: ReadonlyArray<{ readonly id: string; readonly category: string }>;
  readonly response: {
    readonly issues?: readonly unknown[];
    readonly testResults: ReadonlyArray<{
      readonly state: "SUCCESS" | "FAILURE";
      readonly debugMessages?: readonly string[];
    }>;
  };
}

test("captured production language contract covers the Phase 3 value surface", async () => {
  const bytes = await readFile(
    new URL(
      "../fixtures/rules-v2/production-language-contract.json",
      import.meta.url,
    ),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "08041f4ceae7856f8abf9b463adb25433b378a90755ee5d5b286eb145c3d57fb",
  );
  const fixture = JSON.parse(bytes.toString("utf8")) as Fixture;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.target, "production-firebase-rules-projects-test");
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.authorizationHeadersStored, false);
  assert.equal(fixture.persistentCloudReads, 0);
  assert.equal(fixture.persistentCloudWrites, 0);
  assert.equal(fixture.cases.length, 44);
  assert.equal(fixture.response.testResults.length, 44);
  assert.deepEqual(fixture.response.issues ?? [], []);
  assert.equal(
    createHash("sha256").update(fixture.source).digest("hex"),
    fixture.sourceSha256,
  );

  const requiredCategories = [
    "bytes",
    "debug",
    "duration",
    "function",
    "hashing",
    "latlng",
    "list",
    "map",
    "map-diff",
    "match",
    "math",
    "path",
    "query",
    "request",
    "resource",
    "set",
    "string",
    "timestamp",
  ];
  assert.deepEqual(
    [...new Set(fixture.cases.map(({ category }) => category))].sort(),
    requiredCategories,
  );

  const paired = fixture.cases.map((testCase, index) => ({
    ...testCase,
    result: fixture.response.testResults[index]!,
  }));
  assert.equal(
    paired.filter(({ result }) => result.state === "SUCCESS").length,
    43,
  );
  assert.deepEqual(
    paired
      .filter(({ result }) => result.state === "FAILURE")
      .map(({ id, result }) => ({ id, debugMessages: result.debugMessages })),
    [
      {
        id: "debug-return",
        debugMessages: [
          "Error: firestore.rules line [107], column [21]. Function not found error: Name: [debug].",
        ],
      },
    ],
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
