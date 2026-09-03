import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { preparePhase5SmokeCatalog, type SmokeCatalogClient } from "../src/suite/phase5-smoke-catalog.ts";

const runnerUrl = new URL("../src/suite/run-phase5-soak.ts", import.meta.url);

function fakeCatalog(existing = false) {
  const operations: string[] = [];
  let data: Record<string, unknown> | undefined;
  const client: SmokeCatalogClient = {
    collection(name) {
      operations.push(`collection:${name}`);
      return { limit(count) {
        assert.equal(count, 1);
        return { async get() { return { empty: !existing }; } };
      } };
    },
    doc(name) {
      assert.equal(name, "premade-templates/phase5-smoke-soak-owned-run");
      return {
        async create(value) { operations.push("create"); data = value; },
        async delete() { operations.push("delete"); data = undefined; },
        async get() { return { exists: data !== undefined, data: () => data }; },
      };
    },
  };
  return { client, operations, replace(value: Record<string, unknown>) { data = value; } };
}

test("the smoke soak supplies and removes only its owned missing catalogue row", async () => {
  const fake = fakeCatalog();
  const cleanup = await preparePhase5SmokeCatalog(fake.client, true, "owned-run");
  assert.notEqual(cleanup, null);
  assert.deepEqual(fake.operations, ["collection:premade-templates", "create"]);
  await cleanup?.();
  assert.deepEqual(fake.operations, ["collection:premade-templates", "create", "delete"]);
});

test("the smoke seed never alters a full-data or existing catalogue", async () => {
  const full = fakeCatalog();
  assert.equal(await preparePhase5SmokeCatalog(full.client, false, "owned-run"), null);
  assert.deepEqual(full.operations, []);
  const existing = fakeCatalog(true);
  assert.equal(await preparePhase5SmokeCatalog(existing.client, true, "owned-run"), null);
  assert.deepEqual(existing.operations, ["collection:premade-templates"]);
});

test("smoke catalogue cleanup rejects non-owned state and unsafe markers", async () => {
  const fake = fakeCatalog();
  await assert.rejects(preparePhase5SmokeCatalog(fake.client, true, "../other"), /Invalid/u);
  assert.equal(fake.operations.length, 0);
  const cleanup = await preparePhase5SmokeCatalog(fake.client, true, "owned-run");
  fake.replace({ phase5SmokeSoakMarker: "another-run" });
  await assert.rejects(cleanup!, /non-owned/u);
  assert.ok(!fake.operations.includes("delete"));
});

test("soak input preparation precedes measurement and failures retain readable diagnostics", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.ok(source.indexOf("await preparePhase5SmokeCatalog") < source.indexOf("const scheduleStartedAt"));
  assert.match(source, /primaryErrorText: primaryError === undefined \? null : errorText\(primaryError\)/u);
  assert.match(source, /errorTexts: \[\.\.\.runtime\.metrics\.errorTexts\]/u);
  assert.match(source, /cleanupErrorTexts\.push\(errorText\(error\)\)/u);
  assert.match(source, /snapshot\.empty\) throw new Error\("Twodart catalog read returned no premade templates"\)/u);
});

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
