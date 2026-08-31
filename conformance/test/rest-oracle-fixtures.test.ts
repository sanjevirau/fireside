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

for (const target of [
  { directory: "java-v1.22.0", projectId: "demo-fireside-phase2", targetVersion: "1.22.0" },
  {
    directory: "production-cloud-firestore",
    projectId: "fireside-conformance",
    targetVersion: "production-2026-08-31",
  },
] as const) {
  test(`${target.directory} aggregation-count fixture is safe and exact`, async () => {
    const directory = join(fixtureRoot, target.directory, "aggregation-count");
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
    assert.equal(fixture.exchanges.length, 2);
    assert.equal(contract.exchanges.length, 2);
    assert.ok(!/Bearer\s+(?!\[REDACTED\])/iu.test(fixtureText));
    assert.equal(
      sums,
      `${sha256(fixtureText)}  fixture.json\n${sha256(contractText)}  decoded-contract.json\n`,
    );

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
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
