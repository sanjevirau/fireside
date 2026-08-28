import assert from "node:assert/strict";
import test from "node:test";

import { GateFailure, requireGate } from "../src/endurance/gate.ts";
import { loadManifest } from "../src/endurance/manifest.ts";
import {
  median,
  percentile,
  theilSenBytesPerHour,
} from "../src/endurance/statistics.ts";

test("frozen endurance schedule preserves the approved operation mix", async () => {
  const manifest = await loadManifest();
  const transactions = Array.from({ length: 100 }, (_, index) => index)
    .filter((index) =>
      index % manifest.soak.transactionSchedule.modulus
        === manifest.soak.transactionSchedule.remainder
    );
  const large = Array.from({ length: 100 }, (_, index) => index)
    .filter((index) =>
      index % manifest.soak.targetSchedule.largeDocument.modulus
        === manifest.soak.targetSchedule.largeDocument.remainder
    );
  const listeners = Array.from({ length: 100 }, (_, index) => index)
    .filter((index) =>
      index % manifest.soak.targetSchedule.listenerDocument.modulus
        === manifest.soak.targetSchedule.listenerDocument.remainder
    );

  assert.equal(transactions.length, 20);
  assert.equal(large.length, 1);
  assert.equal(listeners.length, 10);
  assert.equal(large.some((index) => transactions.includes(index)), false);
  assert.equal(listeners.some((index) => transactions.includes(index)), false);
  assert.equal(manifest.soak.workingSet.documentCount, 100_000);
  assert.equal(manifest.soak.listeners.activeCount, 8);
  assert.equal(manifest.recovery.rounds, 100);
  assert.equal(manifest.recovery.minimumAcknowledgedCommits, 10_000);
});

test("frozen working-set payload sizing is internally exact", async () => {
  const manifest = await loadManifest();
  const workingSet = manifest.soak.workingSet;
  const largeBytes = workingSet.largeDocumentSizesBytes.reduce(
    (total, size) => total + size * 200,
    0,
  );
  const smallBytes = workingSet.smallDocumentCount * workingSet.smallPayloadBytes;
  assert.equal(smallBytes + largeBytes, 613_376_000);
});

test("endurance statistics use nearest-rank percentiles and Theil-Sen slope", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.99), 4);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(
    theilSenBytesPerHour([
      { elapsedSeconds: 0, rssBytes: 100 },
      { elapsedSeconds: 3_600, rssBytes: 1_048_676 },
      { elapsedSeconds: 7_200, rssBytes: 2_097_252 },
    ]),
    1_048_576,
  );
});

test("a failed endurance criterion raises a durable gate failure", () => {
  assert.doesNotThrow(() => requireGate(true, "memory-soak", { passed: true }));
  assert.throws(
    () => requireGate(false, "memory-soak", { rssSlope: false }),
    (error: unknown) => {
      assert.ok(error instanceof GateFailure);
      assert.equal(error.name, "GateFailure");
      assert.match(error.message, /memory-soak/u);
      assert.match(error.message, /"rssSlope":false/u);
      return true;
    },
  );
});
