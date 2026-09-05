import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Event {
  sequence: number;
  at: string;
  elapsedMilliseconds: number;
  phase: string;
  kind: string;
  value: Record<string, unknown>;
}
interface OracleCase {
  directory: string;
  raw: { resultSha256: string; eventsSha256: string };
  observed: Record<string, unknown>;
  unrelatedAcknowledgements: number;
  unrelatedWriteMilliseconds: number;
  quietMilliseconds: number;
  quietRawResponses: number;
  sdkResumedRequest: Event;
  relevant: { sequence: number; response: Record<string, unknown> }[];
}
const root = new URL("../../reports/phase-5-metrics/idle-listen-20260906-r2/", import.meta.url);
const fixture = JSON.parse(await readFile(new URL("../fixtures/phase5/idle-listen-reset-oracle.json", import.meta.url), "utf8")) as {
  schemaVersion: number;
  capturedBeforeProductChange: boolean;
  firesideBaseline: { commit: string; binarySha256: string };
  official: { jarVersion: string };
  planSha256: string;
  cases: OracleCase[];
  contract: Record<string, boolean>;
};
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const frameKind = (response: Record<string, unknown>): unknown => response.targetChange === undefined
  ? "documentChange" : object(response.targetChange).targetChangeType;

test("quiet Listen oracle is captured before the product correction with actual Phase 5 pins", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.capturedBeforeProductChange, true);
  assert.equal(fixture.firesideBaseline.commit, "3407c658d31fbedc35fced8670a6afffd2943e97");
  assert.equal(fixture.firesideBaseline.binarySha256, "e37ef066c45b53a85a13b16c8b1652df6400e9256fc1e4797d602c637dec8df9");
  assert.equal(fixture.official.jarVersion, "1.21.0");
  assert.equal(fixture.planSha256, "401e08f0a5e5d02ffc3bf4d92b0f42e8d91e8e2c78836c2dfbd7800dcce542b3");
  assert.deepEqual(fixture.cases.map(item => item.directory), [
    "01-official-idle-control", "02-official-churn-natural", "03-official-churn-forced",
    "04-fireside-idle-control", "05-fireside-churn-natural", "06-fireside-churn-forced",
  ]);
  assert.equal(fixture.contract.javaReopensThroughTargetResetAndCurrentReplay, true);
  for (const name of ["javaQuietHeartbeatsObserved", "productGatePassClaimed", "performanceWinnerClaimed", "fullCacheQueryTimeoutAttributed"]) {
    assert.equal(fixture.contract[name], false);
  }
});

for (const item of fixture.cases) test(`quiet Listen evidence reconciles exact frames, tokens, counts and cleanup: ${item.directory}`, async () => {
  const capture = new URL(`${item.directory}/capture/`, root);
  const bytes = await readFile(new URL("events.jsonl", capture));
  const resultBytes = await readFile(new URL("result.json", capture));
  assert.equal(hash(bytes), item.raw.eventsSha256);
  assert.equal(hash(resultBytes), item.raw.resultSha256);
  const events = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Event);
  events.forEach((event, index) => assert.equal(event.sequence, index + 1));
  const phase = (name: string): Event => {
    const event = events.find(event => event.kind === "phase" && event.value.name === name);
    assert.ok(event, name); return event;
  };
  const quiet = phase("quiet-window-after-writes");
  const end = phase(item.directory.endsWith("churn-forced") ? "forced-client-stream-loss" : "target-mutation");
  assert.equal(end.elapsedMilliseconds - quiet.elapsedMilliseconds, item.quietMilliseconds);
  assert.ok(item.quietMilliseconds > 120_000); // Frozen timer is 150s; record measured duration, not a new gate.
  assert.equal(quiet.elapsedMilliseconds - phase("unrelated-writes").elapsedMilliseconds, item.unrelatedWriteMilliseconds);
  const requests = events.filter(event => event.kind === "commit-request" && /^unrelated-\d+$/u.test(String(event.value.label)));
  const acknowledgements = events.filter(event => event.kind === "commit-response" && /^unrelated-\d+$/u.test(String(event.value.label)));
  const churn = item.directory.includes("churn-");
  assert.equal(requests.length, churn ? 4100 : 0);
  assert.equal(acknowledgements.length, item.unrelatedAcknowledgements);
  assert.deepEqual(acknowledgements.map(event => event.value.label), requests.map(event => event.value.label));
  requests.forEach(event => assert.equal((event.value.writes as unknown[]).length, 1));
  assert.ok(item.unrelatedWriteMilliseconds < 180_000);
  const quietRaw = events.filter(event => event.kind === "raw-response" && event.value.label === "initial"
    && event.sequence > quiet.sequence && event.sequence < end.sequence);
  assert.equal(quietRaw.length, 0);
  assert.equal(quietRaw.length, item.quietRawResponses);

  const resumed = events.find(event => event.kind === "sdk-listen-request" && event.value.streamId === 2
    && object(event.value.request).addTarget !== undefined);
  assert.deepEqual(resumed, item.sdkResumedRequest);
  assert.ok(resumed);
  const prior = events.filter(event => event.kind === "sdk-listen-response" && event.value.streamId === 1
    && event.sequence < resumed.sequence);
  const lastToken = prior.map(event => object(event.value.response).targetChange)
    .filter(value => value !== undefined).map(value => object(value).resumeToken).filter(Boolean).at(-1);
  assert.equal(object(object(resumed.value.request).addTarget).resumeToken, lastToken);
  for (const frame of item.relevant) assert.deepEqual(events[frame.sequence - 1]?.value.response, frame.response);
  const sdkFrames = events.filter(event => event.kind === "sdk-listen-response" && event.value.streamId === 2
    && event.phase === "quiet-window-after-writes").map(event => object(event.value.response));
  if (item.directory.includes("official")) {
    assert.deepEqual(sdkFrames.map(frameKind), ["ADD", "RESET", "documentChange", "CURRENT", "NO_CHANGE"]);
    assert.deepEqual(object(sdkFrames[1]?.targetChange).targetIds, [1]);
  } else if (churn) {
    assert.deepEqual(sdkFrames.map(frameKind), ["REMOVE"]);
    assert.deepEqual(object(sdkFrames[0]?.targetChange).cause, { code: 9, message: "listen resume token has expired" });
  }
  const expectedRaw = !item.directory.startsWith("06-");
  const expectedHigh = !item.directory.startsWith("05-") && !item.directory.startsWith("06-");
  assert.equal(item.observed.rawMutationDelivered, expectedRaw);
  assert.equal(item.observed.highMutationDelivered, expectedHigh);
  assert.equal(item.observed.highErrors, expectedHigh ? 0 : 1);
  const forced = item.directory.endsWith("churn-forced");
  const rawResume = events.find(event => event.kind === "raw-request" && event.value.label === "resumed");
  assert.equal(rawResume !== undefined, forced);
  if (rawResume) {
    const priorRawTokens = events.filter(event => event.kind === "raw-response" && event.value.label === "initial"
      && event.sequence < rawResume.sequence).map(event => object(event.value.response).targetChange)
      .filter(value => value !== undefined).map(value => object(value).resumeToken).filter(Boolean);
    assert.equal(object(object(rawResume.value.request).addTarget).resumeToken, priorRawTokens.at(-1));
    const cancel = events.find(event => event.kind === "raw-cancel" && event.phase === "forced-client-stream-loss");
    assert.equal(cancel?.value.latestObservedTokenBase64, priorRawTokens.at(-1));
    const responses = events.filter(event => event.kind === "raw-response" && event.value.label === "resumed"
      && event.phase === "resume-observation").map(event => object(event.value.response));
    if (expectedRaw) {
      assert.deepEqual(responses.map(frameKind), ["ADD", "RESET", "documentChange", "CURRENT", "NO_CHANGE"]);
      assert.deepEqual(object(responses[1]?.targetChange).targetIds, [23]);
      assert.deepEqual(object(object(object(responses[2]?.documentChange).document).fields).version, { integerValue: "0" });
    } else {
      assert.deepEqual(responses.map(frameKind), ["REMOVE"]);
      assert.deepEqual(object(responses[0]?.targetChange).targetIds, [23]);
      assert.deepEqual(object(responses[0]?.targetChange).cause, { code: 9, message: "listen resume token has expired" });
    }
    assert.equal(item.observed.rawReattachedCurrent, expectedRaw);
    assert.equal(item.observed.rawReattachRejectedOrClosed, !expectedRaw);
  }
  const outcome = events.find(event => event.kind === "mutation-outcome");
  assert.deepEqual(outcome?.value, item.observed);
  assert.ok(outcome && outcome.sequence < phase("client-close-and-owned-cleanup").sequence);
  const mutation = phase("target-mutation");
  const mutationEvents = events.filter(event => event.sequence > mutation.sequence && event.sequence < outcome.sequence);
  const rawDelivery = mutationEvents.filter(event => event.kind === "raw-response"
    && event.value.label === (forced ? "resumed" : "initial"))
    .map(event => object(event.value.response).documentChange).filter(value => value !== undefined)
    .some(value => object(object(object(value).document).fields).version !== undefined
      && object(object(object(object(value).document).fields).version).integerValue === "1");
  const highDelivery = mutationEvents.filter(event => event.kind === "high-snapshot")
    .some(event => (event.value.documents as unknown[]).some(value => object(object(value).data).version === 1));
  assert.equal(rawDelivery, expectedRaw);
  assert.equal(highDelivery, expectedHigh);
  const highErrors = events.filter(event => event.kind === "high-error" && event.sequence < outcome.sequence);
  assert.equal(highErrors.length, expectedHigh ? 0 : 1);
  highErrors.forEach(event => assert.equal(event.value.message, "Error 9: listen resume token has expired"));
  if (!expectedHigh) assert.ok(outcome.elapsedMilliseconds - mutation.elapsedMilliseconds >= 30_000);
  const result = object(JSON.parse(resultBytes.toString("utf8")));
  assert.deepEqual(result.observed, item.observed);
  assert.equal(result.scenarioCompleted, true);
  assert.equal(result.cleanupCompleted, true);
  assert.equal(result.acceptancePassClaimed, false);
});

test("public quiet Listen records retain exact checksums and private originals stay hash-inventoried", async () => {
  const manifest = (await readFile(new URL("launcher-checksums.sha256", root), "utf8")).trimEnd().split("\n");
  const inventory = JSON.parse(await readFile(new URL("../../reports/phase-5-idle-listen-private-inventory-20260906.json", import.meta.url), "utf8")) as {
    files: { path: string; sha256: string; bytes: number }[];
  };
  assert.deepEqual(inventory.files.map(file => file.path), fixture.cases.flatMap(item => [
    `${item.directory}/preflight/07-kernel-journal.json`, `${item.directory}/preflight/08-boot-journal.json`,
  ]));
  let publicRecords = 0;
  let privateRecords = 0;
  assert.equal(manifest.length, 272);
  for (const line of manifest) {
    const match = /^([a-f0-9]{64})  (\.\/.+)$/u.exec(line);
    assert.ok(match);
    const target = new URL(match[2]!, root);
    assert.ok(target.href.startsWith(root.href));
    const privateRecord = inventory.files.find(file => `./${file.path}` === match[2]);
    if (privateRecord) {
      assert.equal(privateRecord.sha256, match[1]);
      privateRecords++;
    } else {
      assert.equal(hash(await readFile(target)), match[1]);
      publicRecords++;
    }
  }
  assert.equal(publicRecords, 260);
  assert.equal(privateRecords, 12);
});
