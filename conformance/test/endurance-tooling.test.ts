import assert from "node:assert/strict";
import test from "node:test";

import { GateFailure, requireGate } from "../src/endurance/gate.ts";
import {
  assertControlledHostHealth,
  evaluateControlledHostHealth,
} from "../src/endurance/host-health.ts";
import { loadManifest } from "../src/endurance/manifest.ts";
import {
  circularPhaseSlopes,
  findJointHarmonicPeriod,
  interpolatedQuantile,
} from "../src/endurance/oscillation.ts";
import { parseSmapsRollup } from "../src/endurance/process-metrics.ts";
import {
  median,
  percentile,
  sustainedWindowTheilSenBytesPerHour,
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

test("sustained slope observation waits for one full post-warm-up hour", () => {
  const samples = Array.from({ length: 10 }, (_, index) => ({
    elapsedSeconds: index * 600,
    rssBytes: index * 20 * 1_048_576,
  }));
  assert.equal(sustainedWindowTheilSenBytesPerHour(samples.slice(0, 9), 1_800, 3_600), null);
  assert.equal(
    sustainedWindowTheilSenBytesPerHour(samples, 1_800, 3_600),
    120 * 1_048_576,
  );
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

test("oscillation analysis recovers a shared period and exposes phase sensitivity", () => {
  const samples = Array.from({ length: 181 }, (_, index) => ({
    elapsedSeconds: index * 10,
    rssBytes: 200_000_000 + 4_000_000 * Math.sin(2 * Math.PI * index * 10 / 300),
  }));
  const fit = findJointHarmonicPeriod([samples, samples], 240, 360);
  assert.equal(fit.periodSeconds, 300);
  assert.ok(fit.fits.every((run) => run.rSquared > 0.999));
  const phaseSlopes = circularPhaseSlopes(samples);
  assert.equal(phaseSlopes.length, samples.length);
  assert.ok(Math.min(...phaseSlopes) < 0);
  assert.ok(Math.max(...phaseSlopes) > 0);
  assert.equal(interpolatedQuantile([0, 10], 0.25), 2.5);
});

test("Linux process telemetry separates resident-page categories", () => {
  const usage = parseSmapsRollup(`
Rss:                1024 kB
Pss:                 900 kB
Shared_Clean:         10 kB
Shared_Dirty:          2 kB
Private_Clean:         4 kB
Private_Dirty:       880 kB
Anonymous:           850 kB
LazyFree:              8 kB
AnonHugePages:         0 kB
Swap:                  1 kB
`);
  assert.deepEqual(usage, {
    pssBytes: 921_600,
    anonymousBytes: 870_400,
    privateCleanBytes: 4_096,
    privateDirtyBytes: 901_120,
    sharedCleanBytes: 10_240,
    sharedDirtyBytes: 2_048,
    lazyFreeBytes: 8_192,
    anonymousHugePagesBytes: 0,
  });
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

test("controlled host health accepts a quiet current boot", () => {
  const health = evaluateControlledHostHealth({
    bootId: "boot-id",
    uptimeSeconds: 600,
    sshServiceState: "active",
    kernelJournal: "kernel started\n",
    errorJournal: "",
    sshJournal: "Accepted publickey\nAccepted publickey\n",
    failedUnits: "",
  });
  assert.equal(health.recentSshWindowSeconds, 300);
  assert.equal(health.recentSshAcceptedSessions, 2);
  assert.doesNotThrow(() => assertControlledHostHealth(health));
});

test("controlled host health rejects OOMs and runaway SSH login churn", () => {
  const sshJournal = Array.from(
    { length: 31 },
    () => "sshd-session: Accepted publickey for test",
  ).join("\n");
  const health = evaluateControlledHostHealth({
    bootId: "boot-id",
    uptimeSeconds: 600,
    sshServiceState: "active",
    kernelJournal: "kernel: worker invoked oom-killer",
    errorJournal: "systemd: Failed to spawn executor: Input/output error",
    sshJournal,
    failedUnits: "broken.service loaded failed failed Broken",
  });
  assert.throws(
    () => assertControlledHostHealth(health),
    /failed systemd units.*OOM evidence.*host resource failures.*SSH login churn/iu,
  );
});
