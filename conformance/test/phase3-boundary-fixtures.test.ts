import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

interface Issue {
  readonly severity?: string;
  readonly description?: string;
}

interface Observation {
  readonly id: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly httpStatus: number;
  readonly response: {
    readonly issues?: readonly Issue[];
    readonly testResults?: ReadonlyArray<{
      readonly state?: "SUCCESS" | "FAILURE";
      readonly debugMessages?: readonly string[];
    }>;
  };
}

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly credentialsStored: boolean;
  readonly authorizationHeadersStored: boolean;
  readonly observations: readonly Observation[];
}

const fixtureRoot = new URL("../fixtures/rules-v2/", import.meta.url);

async function readFixture(
  name: string,
  expectedSha256: string,
): Promise<Fixture> {
  const bytes = await readFile(new URL(name, fixtureRoot));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256);
  const fixture = JSON.parse(bytes.toString("utf8")) as Fixture;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.target, "production-firebase-rules-projects-test");
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.authorizationHeadersStored, false);
  assert.ok(
    fixture.observations.every(
      ({ source, sourceSha256, sourceBytes }) =>
        createHash("sha256").update(source).digest("hex") === sourceSha256 &&
        Buffer.byteLength(source) === sourceBytes,
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
  return fixture;
}

test("production parser and source-envelope boundaries remain frozen", async () => {
  const fixture = await readFixture(
    "production-parse-errors.json",
    "21aa166345b9794b5cd2142b000735fd0405bde5d624aa0d79947fd54887f2d2",
  );
  assert.equal(fixture.observations.length, 13);
  const byId = new Map(fixture.observations.map((value) => [value.id, value]));
  const issueSummary = (id: string): string[] =>
    (byId.get(id)?.response.issues ?? []).map(
      ({ severity, description }) => `${severity}:${description}`,
    );

  assert.deepEqual(issueSummary("unexpected-token"), [
    "ERROR:Missing conditional expression after 'if'.",
  ]);
  assert.deepEqual(issueSummary("duplicate-let"), [
    "WARNING:Unused variable: value.",
    "ERROR:The identifier [value] is already bound in the current scope.",
  ]);
  assert.deepEqual(issueSummary("undefined-name"), [
    "WARNING:Invalid variable name: missingName.",
  ]);
  assert.deepEqual(issueSummary("invalid-function-arity"), [
    "WARNING:Incorrect number of arguments supplied to function: math.abs.",
  ]);
  assert.deepEqual(issueSummary("recursive-function"), [
    "ERROR:Recursive call is not allowed.",
  ]);
  assert.deepEqual(issueSummary("invalid-recursive-wildcard"), [
    "ERROR:Invalid glob match expression. Only one glob match is permitted in a match declaration path.",
  ]);
  for (const bytes of [255_999, 256_000, 256_001]) {
    const observation = byId.get(`source-bytes-${bytes}`);
    assert.equal(observation?.httpStatus, 200);
    assert.deepEqual(observation?.response, {});
  }
  for (const bytes of [262_143, 262_144, 262_145]) {
    const observation = byId.get(`source-bytes-${bytes}`);
    assert.equal(observation?.httpStatus, 400);
    assert.match(JSON.stringify(observation?.response), /INVALID_ARGUMENT/);
  }
});

test("production call-depth and expression budgets remain frozen", async () => {
  const fixture = await readFixture(
    "production-limit-probes.json",
    "d721561fa998437fb99279d821c8504b1b3374f0c2025d1b71e974cd2abc823a",
  );
  assert.equal(fixture.observations.length, 26);
  const byId = new Map(fixture.observations.map((value) => [value.id, value]));
  const state = (id: string): string | undefined =>
    byId.get(id)?.response.testResults?.[0]?.state;

  for (let depth = 15; depth <= 21; depth += 1) {
    assert.equal(state(`function-depth-${depth}`), "SUCCESS");
  }
  for (const depth of [22, 23]) {
    assert.deepEqual(
      byId
        .get(`function-depth-${depth}`)
        ?.response.issues?.map(({ severity, description }) => ({
          severity,
          description,
        })),
      [
        {
          description:
            "Maximum allowed call depth of 20 is reached for [f0->f1->f2->f3->f4->f5->f6->f7->f8->f9->f10->f11->f12->f13->f14->f15->f16->f17->f18->f19->f20] call stack.",
          severity: "ERROR",
        },
      ],
    );
  }
  for (const terms of [20, 30, 40, 50]) {
    assert.equal(state(`linear-expression-terms-${terms}`), "SUCCESS");
  }
  for (const terms of [60, 70, 80, 90]) {
    assert.equal(byId.get(`linear-expression-terms-${terms}`)?.httpStatus, 500);
  }
  assert.equal(state("balanced-expression-terms-100"), "SUCCESS");
  for (const terms of [125, 150, 175, 200, 225, 250, 300]) {
    assert.equal(state(`balanced-expression-terms-${terms}`), "FAILURE");
    assert.match(
      byId.get(`balanced-expression-terms-${terms}`)?.response.testResults?.[0]
        ?.debugMessages?.[0] ?? "",
      /maximum of 1000 expressions to evaluate has been reached/,
    );
  }
});
