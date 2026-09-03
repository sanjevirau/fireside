import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installPhase5DocumentSnapshotDiagnostics, phase5DocumentSnapshotObservation } from "../src/suite/phase5-document-diagnostics.ts";

test("synthetic deck snapshot diagnostics retain exact order and semantic hash", () => {
  const value = { zulu: "last", alpha: { second: 2, first: 1 } };
  const observation = phase5DocumentSnapshotObservation({
    ref: { path: "presentations/phase5-smoke-deck" },
    readTime: { toDate: () => new Date("2026-09-04T00:00:00.000Z") },
    updateTime: { toDate: () => new Date("2026-09-04T00:00:01.000Z") },
  }, value);
  assert.ok(observation);
  assert.equal(observation.exactJson, JSON.stringify(value));
  assert.equal(observation.value, value);
  assert.equal(observation.readTime, "2026-09-04T00:00:00.000Z");
  assert.equal(observation.updateTime, "2026-09-04T00:00:01.000Z");
  assert.equal(observation.canonicalSha256.length, 64);
  assert.equal(phase5DocumentSnapshotObservation({ ref: { path: "users/private" } }, value), null);
});

test("snapshot observer calls the original once, returns its object and cannot affect reads", () => {
  let calls = 0;
  const returned = { zulu: "last", alpha: "first" };
  class Snapshot {
    readonly ref = { path: "presentations/phase5-smoke-deck" };
    data(): unknown { calls += 1; return returned; }
  }
  const observed: unknown[] = [];
  const restore = installPhase5DocumentSnapshotDiagnostics(true, [Snapshot], observation => observed.push(observation));
  const snapshot = new Snapshot();
  assert.equal(snapshot.data(), returned);
  assert.equal(calls, 1);
  assert.equal(observed.length, 1);
  restore();
  assert.equal(snapshot.data(), returned);
  assert.equal(calls, 2);

  const restoreThrowing = installPhase5DocumentSnapshotDiagnostics(true, [Snapshot], () => { throw new Error("observer failure"); });
  assert.equal(snapshot.data(), returned);
  assert.equal(calls, 3);
  restoreThrowing();
});

test("r28 document diagnostic amendment preserves every protected boundary", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/phase5/r28-document-snapshot-diagnostics-contract.json", import.meta.url), "utf8")) as { amendment: Record<string, unknown> };
  assert.equal(fixture.amendment.amendedBeforeNextMeasurement, true);
  assert.equal(fixture.amendment.syntheticSmokeDocumentValuesStored, true);
  assert.equal(fixture.amendment.fullDataDocumentValuesStored, false);
  assert.equal(fixture.amendment.additionalFirestoreRequests, 0);
  assert.equal(fixture.amendment.originalDataCallsExactlyOnce, true);
  assert.equal(fixture.amendment.dataReturnIdentityPreserved, true);
  for (const field of ["runnerEventsSuppressed", "workloadChanged", "durationsChanged", "thresholdsChanged", "twodartChanged", "protectedRunnerChanged", "manifestChanged"]) {
    assert.equal(fixture.amendment[field], false);
  }
});
