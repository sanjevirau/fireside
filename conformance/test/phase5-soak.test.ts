import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { preparePhase5SmokeCatalog, type SmokeCatalogClient } from "../src/suite/phase5-smoke-catalog.ts";
import { phase5SoakSampleOffsets } from "../src/suite/phase5-soak-schedule.ts";
import { validPhase5SwapMeasurement, topPhase5ProcessesByPss, phase5ResourceComparison, renderPhase5ResourceComparison, type Phase5ResourceEvidence } from "../src/suite/phase5-resource-evidence.ts";

const runnerUrl = new URL("../src/suite/run-phase5-soak.ts", import.meta.url);

const measuredSwap = {
  sampleCount: 3, swapInPagesDelta: 16_562, swapOutPagesDelta: 42,
  residualSwapBytesAtStart: 1_193_906_176, residualSwapBytesAtEnd: 1_125_023_744,
};

test("v3 swap measurements accept activity in either direction but never missing or invalid counters", () => {
  assert.equal(validPhase5SwapMeasurement(measuredSwap), true);
  assert.equal(validPhase5SwapMeasurement({ ...measuredSwap, swapInPagesDelta: 0, swapOutPagesDelta: 0 }), true);
  assert.equal(validPhase5SwapMeasurement(undefined), false);
  for (const field of Object.keys(measuredSwap)) {
    for (const invalid of [undefined, null, -1, NaN, Infinity, 0.5]) {
      assert.equal(validPhase5SwapMeasurement({ ...measuredSwap, [field]: invalid }), false, `${field}: ${invalid}`);
    }
  }
  assert.equal(validPhase5SwapMeasurement({ ...measuredSwap, sampleCount: 1 }), false);
});

test("the actual soak validator ignores swap volume and retains every correctness and health gate", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const validator = stripTypeScriptTypes(source.slice(source.indexOf("function validateGate("), source.indexOf("function summarizeSwapActivity(")));
  const manifest = JSON.parse(await readFile(new URL("../../benchmarks/phase-5-twodart-acceptance.json", import.meta.url), "utf8"));
  const validate = vm.runInNewContext(`${validator}\nvalidateGate`, {
    validPhase5SwapMeasurement, summarizeSwapActivity: () => measuredSwap,
    memorySamples: Array.from({ length: 241 }), digest: (value: string) => value,
    summarizeRuntime: (runtime: { gaps: number }) => ({ listenerDelivery: { gaps: runtime.gaps } }),
  });
  const runtime = () => ({
    definition: { name: "official" }, gaps: 0, sessions: [{ tracker: { duplicates: 0 } }],
    metrics: { counts: {}, errorHashes: new Set<string>(), stalls: 0, acknowledgedStateMismatches: 0 },
  });
  const healthy = { failedUnits: 0, oomOrResourceEvidence: 0 };
  for (const smoke of [true, false]) {
    assert.equal(validate([runtime()], {}, healthy, [], manifest, smoke).length, 0);
    for (const key of ["failedUnits", "oomOrResourceEvidence"]) {
      assert.equal(validate([runtime()], {}, { ...healthy, [key]: 1 }, [], manifest, smoke).length, 1);
    }
    assert.equal(validate([runtime()], {}, healthy, ["synthetic-artifacts-remain"], manifest, smoke).length, 1);
    for (const defect of ["counts", "errors", "stalls", "acknowledged", "gaps", "duplicates"]) {
      const broken = runtime();
      if (defect === "counts") broken.metrics.counts = { unexpected: 1 };
      if (defect === "errors") broken.metrics.errorHashes.add("error-text");
      if (defect === "stalls") broken.metrics.stalls = 1;
      if (defect === "acknowledged") broken.metrics.acknowledgedStateMismatches = 1;
      if (defect === "gaps") broken.gaps = 1;
      if (defect === "duplicates") broken.sessions[0]!.tracker.duplicates = 1;
      assert.equal(validate([broken], {}, healthy, [], manifest, smoke).length, 1, defect);
    }
  }
});

test("PSS evidence ranks independent PIDs by measured peaks and preserves missing values", () => {
  const top = topPhase5ProcessesByPss([
    { stacks: { official: { processes: [
      { command: "next-server", pid: 10, pssBytes: 800, rssBytes: 900 },
      { command: "java", pid: 20, pssBytes: null, rssBytes: 600 },
      { command: "java", pid: 30, pssBytes: null, rssBytes: 700 },
    ] } } },
    { stacks: { official: { processes: [
      { command: "next-server", pid: 10, pssBytes: 700, rssBytes: 950 },
      { command: "java", pid: 20, pssBytes: 850, rssBytes: 1000 },
    ] } } },
  ], "official");
  assert.deepEqual(top.map(({ pid }) => pid), [20, 10, 30]);
  assert.equal(top[1]?.peakPssBytes, 800);
  assert.equal(top[1]?.peakRssBytes, 950);
  assert.equal(top[1]?.samples, 2);
  assert.equal(top[2]?.peakPssBytes, null);
  const official: Phase5ResourceEvidence = { durationSeconds: 60, passed: true, swapActivity: measuredSwap, topProcessesByPss: { official: top } };
  const partial = phase5ResourceComparison({ official });
  assert.equal(partial.stacks.fireside, null);
  assert.equal(partial.winnerRequired, false);
  assert.match(renderPhase5ResourceComparison({ official }), /Swap-in pages \| 16562 \| not measured/u);
  const fireside: Phase5ResourceEvidence = { ...official, swapActivity: { ...measuredSwap, swapInPagesDelta: 5 }, topProcessesByPss: { fireside: top.slice(0, 1) } };
  const table = renderPhase5ResourceComparison({ official, fireside });
  assert.match(table, /Swap-in pages \| 16562 \| 5/u);
  assert.match(table, /java \(PID 20\) \| 850 \| java \(PID 20\) \| 850/u);
  assert.match(table, /next-server \(PID 10\) \| 800 \| not measured \| not measured/u);
});

test("all Phase 5 entry-point bindings initialize before top-level execution", async () => {
  for (const file of ["run-phase5-soak.ts", "run-phase5-gate.ts", "run-phase5-browser-journeys.ts"]) {
    const source = await readFile(new URL(`../src/suite/${file}`, import.meta.url), "utf8");
    const boundary = source.indexOf(file === "run-phase5-browser-journeys.ts" ? "\ntry {" : "\nawait main();");
    assert.ok(boundary > 0, `${file} execution boundary is missing`);
    const late = [...source.matchAll(/^(?:export )?(?:let|const|class)\s+([\w]+)/gmu)]
      .filter((match) => match.index > boundary).map((match) => match[1]);
    assert.deepEqual(late, [], `${file} has uninitialized module bindings`);
  }
});

test("the actual soak dispatch loader reads and caches the frozen v2 body", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const declaration = source.match(/^let frozenDispatchBody[^\n]+/mu)?.[0];
  assert.ok(declaration);
  const loader = source.slice(source.indexOf("async function frozenV2DispatchBody"), source.indexOf("async function sampleMemory"));
  const fixtureText = await readFile(new URL("../fixtures/firebase-suite-v1/firestore-trigger-registration-and-v1-v2-dispatch/fixture.json", import.meta.url), "utf8");
  const fixture = JSON.parse(fixtureText);
  const expected = fixture.dispatches.find((entry: { headers: Record<string, string> }) => entry.headers["ce-type"]?.startsWith("google.cloud.firestore")).body;
  let reads = 0;
  const program = stripTypeScriptTypes(`${declaration}\n${loader}\n(async () => [await frozenV2DispatchBody(), await frozenV2DispatchBody()])()`);
  const result = await vm.runInNewContext(program, {
    conformanceDirectory: "/synthetic/conformance", path,
    async readFile(file: string) {
      assert.ok(file.endsWith("firestore-trigger-registration-and-v1-v2-dispatch/fixture.json"));
      reads += 1;
      return fixtureText;
    },
  });
  assert.equal(JSON.stringify(result), JSON.stringify([expected, expected]));
  assert.equal(reads, 1);
});

test("soak samples include the entire final interval without changing duration", () => {
  assert.deepEqual(phase5SoakSampleOffsets(60, 30), [0, 30_000, 60_000]);
  const full = phase5SoakSampleOffsets(7200, 30);
  assert.equal(full.length, 241);
  assert.equal(full[0], 0);
  assert.equal(full.at(-1), 7_200_000);
  assert.deepEqual(phase5SoakSampleOffsets(65, 30), [0, 30_000, 60_000, 65_000]);
  assert.throws(() => phase5SoakSampleOffsets(0, 30), /positive finite/u);
  assert.throws(() => phase5SoakSampleOffsets(60, -1), /positive finite/u);
});

test("swap counters bracket all workers and final sampling before cleanup", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.ok(source.indexOf("swapWindowStart = await hostMemory()") < source.indexOf("const scheduleStartedAt"));
  assert.ok(source.indexOf("swapWindowEnd = await hostMemory()") > source.indexOf("await Promise.allSettled(workers)"));
  assert.ok(source.indexOf("swapWindowEnd = await hostMemory()") < source.indexOf("for (const cleanup of smokeCatalogCleanups)"));
  assert.match(source, /const first = swapWindowStart;/u);
  assert.match(source, /const last = swapWindowEnd;/u);
});

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
  assert.match(source, /health\.failedUnits !== manifest\.soak\.thresholds\.failedUnits/u);
  assert.match(source, /health\.oomOrResourceEvidence !== manifest\.soak\.thresholds\.oomOrResourceKills/u);
  assert.match(source, /!validPhase5SwapMeasurement\(swapActivity\)/u);
  assert.doesNotMatch(source, /swapActivity\.swap(?:In|Out)PagesDelta !== 0/u);
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
