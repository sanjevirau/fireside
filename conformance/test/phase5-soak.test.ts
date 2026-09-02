import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerUrl = new URL("../src/suite/run-phase5-soak.ts", import.meta.url);

test("the Phase 5 soak runner freezes the two-session app-shaped arithmetic", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.match(source, /child\.once\("close", \(exitCode\) =>/u);
  assert.match(source, /const sessionCount = 2;/u);
  assert.match(source, /const tokenSlots = 20;/u);
  for (const operation of [
    "tokenBatch",
    "gatewayJob",
    "runAndCaseStatus",
    "catalogRead",
    "storageCycle",
    "twodartFunctionTrigger",
  ]) {
    assert.match(source, new RegExp(`workload\\.${operation}`, "u"));
  }
  assert.match(source, /tokenWrites: tokenBatches \* workload\.tokenBatch\.writesPerBatch/u);
  assert.match(source, /Math\.floor\(durationSeconds \/ intervalSeconds\) \* sessionCount/u);
  assert.match(source, /--stack must be official or fireside/u);
  assert.match(source, /args\.stack === "official"/u);
});

test("the Phase 5 soak keeps one live listener per session and checks delivery exactly", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.match(source, /collection\(eventsPath\)\.onSnapshot/u);
  assert.match(source, /tracker\.expected\.add\(key\)/u);
  assert.match(source, /tracker\.seen\.add\(key\)/u);
  assert.match(source, /listenerExpected - listenerSeen/u);
  assert.match(source, /acknowledgedStateMismatches/u);
  assert.match(source, /duplicateObservableEffects/u);
});

test("the Phase 5 soak measures full stack memory and host health", async () => {
  const source = await readFile(runnerUrl, "utf8");
  for (const boundary of [
    "/proc/meminfo",
    "/proc/vmstat",
    "smaps_rollup",
    "VmRSS",
    "pswpin",
    "pswpout",
    "swapInPagesDelta",
    "swapOutPagesDelta",
    "journalctl",
    "systemctl",
    "rssSlopeBytesPerHour",
    "pssSlopeBytesPerHour",
  ]) {
    assert.ok(source.includes(boundary), `${boundary} is missing`);
  }
  assert.match(source, /!smoke && health\.failedUnits !== manifest\.soak\.thresholds\.failedUnits/u);
  assert.match(source, /smoke && health\.failedUnits !== healthBefore\.failedUnits/u);
  assert.match(source, /!smoke &&\s+health\.oomOrResourceEvidence !== manifest\.soak\.thresholds\.oomOrResourceKills/u);
  assert.match(source, /smoke && health\.oomOrResourceEvidence !== healthBefore\.oomOrResourceEvidence/u);
  assert.match(source, /swapActivity\.swapInPagesDelta !== 0/u);
  assert.match(source, /swapActivity\.swapOutPagesDelta !== 0/u);
});

test("the Phase 5 soak verifies Storage bytes, safe functions, cleanup, and evidence privacy", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.match(source, /downloaded\.equals\(bytes\)/u);
  assert.match(source, /onWriteInitiateCheckoutSession/u);
  assert.match(source, /Twodart function dispatch/u);
  assert.match(source, /Firestore cleanup left synthetic documents/u);
  assert.match(source, /Storage cleanup left synthetic objects/u);
  for (const privacy of [
    "candidateIdentityStored: false",
    "datasetIdentityStored: false",
    "privateContentStored: false",
    "syntheticIdentifiersStored: false",
    "userIdentityStored: false",
  ]) {
    assert.ok(source.includes(privacy), `${privacy} is missing`);
  }
});
