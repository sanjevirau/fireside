import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  CaptureFixture,
  DecodedCaptureContract,
} from "../src/webchannel/capture-contract.ts";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/rest-v1",
);

const oracleTargets = [
  { directory: "java-v1.22.0", projectId: "demo-fireside-phase2", targetVersion: "1.22.0" },
  {
    directory: "production-cloud-firestore",
    projectId: "fireside-conformance",
    targetVersion: "production-2026-08-31",
  },
] as const;

for (const target of oracleTargets) {
  test(`${target.directory} aggregation-count fixture is safe and exact`, async () => {
    const { contract } = await readOracleFixture(target, "aggregation-count");

    const preflight = contract.exchanges.find((exchange) =>
      exchange.request.method === "OPTIONS"
    );
    assert.equal(preflight?.response.status, 200);
    const exchange = contract.exchanges.find((exchange) =>
      exchange.request.method === "POST"
    );
    assert.equal(exchange?.request.method, "POST");
    assert.equal(
      exchange?.request.path,
      `/v1/projects/${target.projectId}/databases/(default)/documents:runAggregationQuery`,
    );
    assert.match(exchange?.request.bodyText ?? "", /structuredAggregationQuery/u);
    assert.equal(exchange?.response.status, 200);
    assert.match(exchange?.response.bodyText ?? "", /aggregate_0/u);
  });

  test(`${target.directory} aggregation-limit-error fixture pins the exact limit`, async () => {
    const { contract } = await readOracleFixture(target, "aggregation-limit-error");
    const exchange = contract.exchanges.find((candidate) =>
      candidate.request.method === "POST"
    );

    assert.equal(exchange?.response.status, 400);
    assert.match(exchange?.request.bodyText ?? "", /"alias":"aggregate_5"/u);
    assert.match(
      exchange?.response.bodyText ?? "",
      /The maximum number of aggregations allowed in an aggregation query is 5\. Received: 6/u,
    );
  });

  test(`${target.directory} aggregation-composite-filter fixture pins the request shape`, async () => {
    const { contract } = await readOracleFixture(
      target,
      "aggregation-composite-filter",
    );
    const exchange = contract.exchanges.find((candidate) =>
      candidate.request.method === "POST"
    );

    assert.match(exchange?.request.bodyText ?? "", /"compositeFilter"/u);
    assert.match(exchange?.request.bodyText ?? "", /"op":"AND"/u);
    assert.match(exchange?.request.bodyText ?? "", /"filters":\[/u);
    if (target.directory === "java-v1.22.0") {
      assert.equal(exchange?.response.status, 200);
      assert.match(exchange?.response.bodyText ?? "", /aggregate_0/u);
      assert.match(exchange?.response.bodyText ?? "", /aggregate_1/u);
    } else {
      assert.equal(exchange?.response.status, 400);
      assert.match(exchange?.response.bodyText ?? "", /requires an index/u);
      assert.match(exchange?.response.bodyText ?? "", /FAILED_PRECONDITION/u);
    }
  });

  test(`${target.directory} transaction fixture pins commit validation and masks`, async () => {
    const { contract } = await readOracleFixture(
      target,
      "transaction-commit",
      target.directory === "java-v1.22.0" ? 10 : 9,
    );
    const commits = contract.exchanges.filter((exchange) =>
      exchange.request.method === "POST" && exchange.request.path.endsWith(":commit")
    );
    assert.equal(commits.length, 3);

    const invalid = commits.find((exchange) => exchange.response.status === 400);
    assert.match(invalid?.request.bodyText ?? "", /"delete":/u);
    assert.match(invalid?.request.bodyText ?? "", /"update":/u);
    assert.match(
      invalid?.response.bodyText ?? "",
      /Cannot delete then update an entity in the same request\./u,
    );

    const verify = commits.find((exchange) =>
      (exchange.request.bodyText ?? "").includes('"verify":')
    );
    assert.equal(verify?.response.status, 200);
    assert.match(verify?.response.bodyText ?? "", /writeResults/u);

    const nested = commits.find((exchange) =>
      (exchange.request.bodyText ?? "").includes('"`is.admin`"')
    );
    assert.equal(nested?.response.status, 200);
    assert.match(nested?.request.bodyText ?? "", /"owner.name"/u);
  });

  test(`${target.directory} transaction no-op fixture preserves update time`, async () => {
    const { contract } = await readOracleFixture(
      target,
      "transaction-noop-write",
      7,
    );
    const reads = contract.exchanges.filter((exchange) =>
      exchange.request.method === "POST" && exchange.request.path.endsWith(":batchGet")
    );
    assert.equal(reads.length, 2);
    const readUpdateTimes = reads.map((exchange) => {
      const body = JSON.parse(exchange.response.bodyText ?? "") as Array<{
        found: { updateTime: string };
      }>;
      return body[0]?.found.updateTime;
    });
    assert.equal(readUpdateTimes[0], readUpdateTimes[1]);

    const replacement = contract.exchanges.find((exchange) =>
      exchange.request.method === "POST" &&
      exchange.request.path.endsWith(":commit") &&
      (exchange.request.bodyText ?? "").includes('"update":')
    );
    assert.equal(replacement?.response.status, 200);
    const response = JSON.parse(replacement?.response.bodyText ?? "") as {
      writeResults: Array<{ updateTime: string }>;
    };
    assert.equal(response.writeResults[0]?.updateTime, readUpdateTimes[0]);
  });
}

async function readOracleFixture(
  target: (typeof oracleTargets)[number],
  scenario: string,
  expectedExchanges = 2,
): Promise<{
  contract: DecodedCaptureContract;
  fixture: CaptureFixture;
}> {
  const directory = join(fixtureRoot, target.directory, scenario);
  const fixtureText = await readFile(join(directory, "fixture.json"), "utf8");
  const contractText = await readFile(
    join(directory, "decoded-contract.json"),
    "utf8",
  );
  const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  const fixture = JSON.parse(fixtureText) as CaptureFixture;
  const contract = JSON.parse(contractText) as DecodedCaptureContract;

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.metadata.target, target.directory);
  assert.equal(fixture.metadata.targetVersion, target.targetVersion);
  assert.equal(fixture.metadata.sdk, "firebase@12.18.0");
  assert.equal(fixture.metadata.transport, "http1");
  assert.equal(fixture.exchanges.length, expectedExchanges);
  assert.equal(contract.exchanges.length, expectedExchanges);
  assert.ok(!/Bearer\s+(?!\[REDACTED\])/iu.test(fixtureText));
  assert.equal(
    sums,
    `${sha256(fixtureText)}  fixture.json\n${sha256(contractText)}  decoded-contract.json\n`,
  );

  const preflight = contract.exchanges.find((exchange) =>
    exchange.request.method === "OPTIONS"
  );
  assert.equal(preflight?.response.status, 200);
  if (scenario.startsWith("aggregation-")) {
    const exchange = contract.exchanges.find((candidate) =>
      candidate.request.method === "POST"
    );
    assert.equal(
      exchange?.request.path,
      `/v1/projects/${target.projectId}/databases/(default)/documents:runAggregationQuery`,
    );
  }

  return { contract, fixture };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
