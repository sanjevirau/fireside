import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { phase5ListenRequestSummary, phase5ListenResponseSummary, phase5SmokeDomEvidence } from "../src/suite/phase5-listen-diagnostics.ts";

test("Phase 5 Listen observations preserve target shape without credentials or user values", () => {
  const body = new URLSearchParams({
    headers: "Authorization: Bearer secret-jwt", count: "2", ofs: "7",
    req0___data__: JSON.stringify({ addTarget: { targetId: 4, resumeToken: "secret-resume", query: {
      parent: "projects/p/databases/(default)/documents/private-user/path",
      structuredQuery: { from: [{ collectionId: "presentations" }], where: { fieldFilter: { field: { fieldPath: "createdBy" }, op: "EQUAL", value: { stringValue: "private-user" } } }, orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "DESCENDING" }], limit: 12 },
    } } }),
    req1___data__: JSON.stringify({ removeTarget: 2 }),
  }).toString();
  const summary = JSON.stringify(phase5ListenRequestSummary(body));
  for (const secret of ["secret-jwt", "secret-resume", "private-user"]) assert.ok(!summary.includes(secret));
  for (const shape of ['"targetId":4', '"removeTarget":2', '"createdBy"', '"limit":12', '"ofs":"7"']) assert.ok(summary.includes(shape));
});

test("Phase 5 Listen observations count UTF-16 units and omit document contents", () => {
  const frame = JSON.stringify([[11, [{ documentChange: { document: { name: "projects/p/databases/(default)/documents/presentations/private-deck", fields: { title: { stringValue: "中文🙂private-content" } } }, targetIds: [4] } }]], [12, [{ targetChange: { targetChangeType: "CURRENT", targetIds: [4], resumeToken: "private-token" } }]]]);
  const summary = JSON.stringify(phase5ListenResponseSummary(`${frame.length}\n${frame}`));
  for (const secret of ["private-deck", "private-content", "中文", "private-token"]) assert.ok(!summary.includes(secret));
  assert.ok(summary.includes('"arrayId":11'));
  assert.ok(summary.includes('"type":"CURRENT"'));
  assert.deepEqual(phase5ListenResponseSummary("[1,12,0]"), { forwardAck: [1, 12, 0] });
  assert.deepEqual(phase5ListenResponseSummary("8\n[1,18,7]"), { arrays: [{ forwardAck: [1, 18, 7] }] });
  assert.throws(() => phase5ListenResponseSummary(`${Buffer.byteLength(frame)}\n${frame}`), /incomplete UTF-16/u);
});

test("Phase 5 Listen observer decodes the committed official wire without preserving fixture contents", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/rules-v2/query-authorization/java-1.21.0/long-poll-wire.json", import.meta.url), "utf8")) as { exchanges: { response: { status: number; bodyBase64: string | null } }[] };
  const summaries = fixture.exchanges.filter(exchange => exchange.response.status === 200 && (exchange.response.bodyBase64?.length ?? 0) > 0)
    .map(exchange => phase5ListenResponseSummary(Buffer.from(exchange.response.bodyBase64!, "base64").toString()));
  const text = JSON.stringify(summaries);
  assert.ok(text.includes('"documentChange"'));
  assert.ok(text.includes('"type":"CURRENT"'));
  assert.ok(!text.includes('"stringValue":"query-owner"'));
  assert.ok(!text.includes("/documents/presentations/owned"));
});

test("Phase 5 complete DOM evidence is synthetic-smoke only", () => {
  assert.equal(phase5SmokeDomEvidence(false, "private full-data deck"), null);
  assert.equal(phase5SmokeDomEvidence(true, "No presentations found"), "No presentations found");
});

test("r26 diagnostic amendment preserves the protected runner and all acceptance conditions", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/phase5/r26-observability-gap-contract.json", import.meta.url), "utf8")) as { amendment: Record<string, unknown> };
  assert.equal(fixture.amendment.amendedBeforeNextMeasurement, true);
  for (const field of ["runnerEventsSuppressed", "workloadChanged", "durationsChanged", "thresholdsChanged", "twodartChanged"]) assert.equal(fixture.amendment[field], false);
});
