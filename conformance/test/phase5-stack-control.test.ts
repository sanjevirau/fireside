import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import "./phase5-fresh-backend.test.ts";

import {
  cacheOutputDigest,
  PHASE5_DIAGNOSTIC_DEFINITIVE_ERROR_SAMPLES,
  PHASE5_DIRECTORY_EMPTY_SCANS,
  PHASE5_DIRECTORY_REAP_SECONDS,
  PHASE5_EXPORT_SHUTDOWN_SECONDS,
  PHASE5_LOGIN_ROUTE,
  PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS,
  PHASE5_PORTLESS_STATE_DIRECTORY,
  PHASE5_TWODARTNET_HEALTH_ROUTE,
  parseCacheOutputCounts,
  phase5CommandLaunchPathMatches,
  phase5EmulatorProcessMatches,
  phase5ProcessIdentityFromStat,
  phase5ProcKilobytes,
  phase5ReadinessConditions,
  phase5StorageAliasRegistered,
  renderPhase5MprocsControlCommand,
  renderPhase5StackCommand,
  type StackLaunchInput,
} from "../src/suite/phase5-stack-control.ts";
import {
  Phase5ReadinessTracker,
  PHASE5_FRONTEND_PROBE_SECONDS,
  phase5CurlArguments,
  phase5CurlProbe,
  phase5CacheJsonProbe,
  phase5FetchProbe,
  waitForPhase5Readiness,
  type ReadinessCondition,
} from "../src/suite/phase5-readiness.ts";

const controlUrl = new URL("../src/suite/phase5-stack-control.ts", import.meta.url);

test("cache readiness requires browser-decoded JSON, not an HTTP 200 gzip body", async () => {
  const payload = gzipSync(Buffer.from('{"synthetic":"火🔥"}'));
  const server = createServer((request, response) => {
    assert.match(request.headers["accept-encoding"] ?? "", /gzip/u);
    if (request.url === "/good") response.setHeader("content-encoding", "gzip");
    response.setHeader("content-type", "application/json");
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const signal = new AbortController().signal;
    const good = await phase5CacheJsonProbe(`${origin}/good`, signal);
    assert.equal(good.ready, true);
    assert.equal(good.status, 200);
    assert.equal(good.jsonValid, true);
    assert.match(good.decodedSha256 ?? "", /^[0-9a-f]{64}$/u);
    const bad = await phase5CacheJsonProbe(`${origin}/r23`, signal);
    assert.equal(bad.ready, false);
    assert.equal(bad.status, 200);
    assert.equal(bad.definitive, true);
    assert.equal(bad.jsonValid, false);
    assert.match(bad.error ?? "", /SyntaxError/u);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Storage alias must be registered for this exact stack port", () => {
  const routes = [{ hostname: "phase5-fireside.storage.twodart.localhost", port: 23102, pid: 0 }];
  assert.equal(phase5StorageAliasRegistered(routes, "phase5-fireside.storage.twodart.localhost", 23102), true);
  assert.equal(phase5StorageAliasRegistered(routes, "phase5-fireside.storage.twodart.localhost", 23002), false);
  assert.equal(phase5StorageAliasRegistered([], "phase5-fireside.storage.twodart.localhost", 23102), false);
});

test("three identical malformed-JSON observations fail diagnostic readiness with verbatim attribution", () => {
  const conditions: ReadinessCondition[] = [{ id: "cache", group: "application", kind: "probe", target: "cache",
    check: async () => ({ ready: false, outcome: "error" }) }];
  const tracker = new Phase5ReadinessTracker(conditions, 0, { emulator: 60, application: 1200 });
  for (let index = 1; index <= 3; index++) {
    tracker.observe("cache", { ready: false, outcome: "error", status: 200, definitive: true, error: "SyntaxError: Unexpected gzip bytes" }, index * 1000);
    const result = tracker.sample(index * 1000, true);
    if (index < 3) assert.equal(result.failure, null);
    else assert.match(result.failure ?? "", /cache returned 200: SyntaxError: Unexpected gzip bytes/u);
  }
});

const launch: StackLaunchInput = {
  datasetName: "full-data",
  directory: "/gate/stack-official",
  evidenceDirectory: "/gate/evidence",
  exportPath: "/gate/exports/official/full-data",
  firesideBinary: "/gate/bin/fireside-phase4",
  javaHome: "/home/sanjevi/.local/share/mise/installs/java/26.0.2.1",
  javaToolOptions: PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS,
  label: "initial",
  nodeBinary: "/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node",
  ports: {
    auth: 23001,
    cacheWebsocket: 23012,
    eventarc: 23009,
    firestore: 23000,
    firestoreWebsocket: 23007,
    functions: 23003,
    hub: 23005,
    logging: 23008,
    mprocsControl: 23011,
    pubsub: 23004,
    storage: 23002,
    tasks: 23010,
    ui: 23006,
  },
  runtimeDirectory: "/gate/runtime/official-initial",
  stack: "official",
  tmuxSession: "phase5-official-initial",
};

test("Phase 5 stack launch uses the exact isolated runtime contract", () => {
  const command = renderPhase5StackCommand(launch);
  for (const boundary of [
    "FIREBASE_EMULATOR_TMPDIR='/gate/runtime/official-initial'",
    "FIREBASE_SKIP_PREBUILD='1'",
    "JAVA_HOME='/home/sanjevi/.local/share/mise/installs/java/26.0.2.1'",
    "JAVA_TOOL_OPTIONS=''",
    "PORTLESS_STATE_DIR='/home/sanjevi/.portless'",
    "TWODART_DISABLE_EXTERNALS='1'",
    "TWODART_EMULATOR_EXPORT_OVERRIDE='/gate/exports/official/full-data'",
    "TWODART_EMULATOR_JAVA_TOOL_OPTIONS='-Xmx8g'",
    "TWODART_FIREBASE_BACKEND='official'",
    "TWODART_FIREBASE_NODE_BIN='/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node'",
    "TWODART_FIRESIDE_BIN='/gate/bin/fireside-phase4'",
    "bun dev:mprocs --data 'full-data'",
  ]) {
    assert.ok(command.includes(boundary), `${boundary} is missing`);
  }
  assert.ok(command.indexOf("java/26.0.2.1/bin") < command.indexOf("mise/shims"));
  for (const exactToolDirectory of [
    "node/24.20.0/bin",
    "bun/1.3.14/bin",
    "mise/dotnet-root",
    "python/3.14.6/bin",
    ".rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin",
  ]) {
    assert.ok(
      command.indexOf(exactToolDirectory) < command.indexOf("mise/shims"),
      `${exactToolDirectory} must precede the mutable mise shim layer`,
    );
  }
  assert.match(command, /official-initial\.exit/u);
});

test("Phase 5 stack shutdown uses the pinned mprocs control event", () => {
  assert.equal(PHASE5_EXPORT_SHUTDOWN_SECONDS, 600);
  assert.equal(PHASE5_DIRECTORY_REAP_SECONDS, 60);
  assert.equal(PHASE5_DIRECTORY_EMPTY_SCANS, 2);
  assert.equal(PHASE5_DIAGNOSTIC_DEFINITIVE_ERROR_SAMPLES, 3);
  assert.equal(PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS, "-Xmx8g");
  assert.equal(PHASE5_LOGIN_ROUTE, "/login/overview");
  assert.equal(PHASE5_PORTLESS_STATE_DIRECTORY, "/home/sanjevi/.portless");
  assert.equal(PHASE5_TWODARTNET_HEALTH_ROUTE, "/api/HealthCheck");
  assert.deepEqual(
    renderPhase5MprocsControlCommand("/gate/stack-official", 23011),
    {
      arguments: ["--server", "127.0.0.1:23011", "--ctl", "c: force-quit"],
      command: "/gate/stack-official/node_modules/.bin/mprocs",
    },
  );
});

test("fresh default unsets inherited backend while fallback explicitly selects official", () => {
  const command = renderPhase5StackCommand({ ...launch, stack: "fireside", backendOverride: null });
  assert.match(command, /env -u TWODART_FIREBASE_BACKEND /u);
  assert.doesNotMatch(command, /TWODART_FIREBASE_BACKEND=/u);
  const fallback = renderPhase5StackCommand({ ...launch, backendOverride: "official" });
  assert.match(fallback, /TWODART_FIREBASE_BACKEND='official'/u);
  assert.doesNotMatch(fallback, /env -u/u);
});

test("Phase 5 stack shutdown waits for export before force-quit and always settles", async () => {
  const source = await readFile(controlUrl, "utf8");
  const stopStart = source.indexOf("export async function stopPhase5Stack");
  const stopEnd = source.indexOf("async function waitForPhase5ExportMetadata", stopStart);
  const stopSource = source.slice(stopStart, stopEnd);
  const exportWait = stopSource.indexOf("await waitForPhase5ExportMetadata");
  const forceQuit = stopSource.indexOf("await requestHeadlessMprocsShutdown");
  assert.ok(exportWait >= 0, "shutdown must wait for export metadata");
  assert.ok(forceQuit > exportWait, "mprocs force-quit must follow completed export");
  assert.match(stopSource, /await settlePhase5StackCleanup\(running\)/u);
  assert.match(stopSource, /lifecycle and isolated cleanup both failed/u);
  assert.match(stopSource, /remainingDirectoryProcessGroups/u);
  assert.match(stopSource, /remainingListenerPorts/u);
  assert.match(stopSource, /orphanCheckPassed: true/u);
  assert.match(stopSource, /shutdownOrder: "emulator-export-first-then-mprocs"/u);
});

test("Phase 5 stack shutdown identifies only exact emulator launch processes", () => {
  const binary = "/gate/bin/fireside-phase4";
  assert.equal(
    phase5EmulatorProcessMatches(
      "official",
      "/usr/bin/node\0/gate/stack-official/node_modules/.bin/firebase\0--project\0demo\0emulators:start\0",
      binary,
    ),
    true,
  );
  assert.equal(
    phase5EmulatorProcessMatches(
      "fireside",
      `${binary}\0suite\0--host\0${"127.0.0.1"}\0`,
      binary,
    ),
    true,
  );
  assert.equal(
    phase5EmulatorProcessMatches(
      "official",
      "/usr/bin/node\0/gate/stack-official/node_modules/.bin/firebase\0deploy\0",
      binary,
    ),
    false,
  );
  assert.equal(
    phase5EmulatorProcessMatches("fireside", `${binary}\0firestore\0`, binary),
    false,
  );
});

test("Phase 5 process identities include PID reuse protection", () => {
  assert.deepEqual(
    phase5ProcessIdentityFromStat(
      42,
      "42 (firebase process) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0",
    ),
    { pid: 42, procStatStartTimeTicks: "987654" },
  );
});

test("Phase 5 lifecycle sampling records every scoped process at ten-second intervals", async () => {
  assert.equal(phase5ProcKilobytes("Name:\tnode\nVmRSS:\t1234 kB\n", "VmRSS"), 1_263_616);
  assert.equal(phase5ProcKilobytes("Rss: 42 kB\nPss: 31 kB\n", "Pss"), 31_744);
  assert.equal(phase5ProcKilobytes("VmSize: 9 kB\n", "VmRSS"), null);

  const source = await readFile(controlUrl, "utf8");
  const launchSampler = source.indexOf("const processSampler = startPhase5ProcessSampler(input)");
  const readiness = source.indexOf("await waitForPhase5Readiness", launchSampler);
  assert.ok(launchSampler >= 0 && readiness > launchSampler);
  assert.match(source, /intervalSeconds: 10/u);
  assert.match(source, /await Promise\.race\(\[delay\(10_000\), stopSignal\]\)/u);
  assert.match(source, /smaps_rollup/u);
  assert.match(source, /processPeaks/u);
  assert.match(source, /peakAggregatePssBytes/u);
  assert.match(source, /peakAggregateRssBytes/u);
  assert.match(source, /await running\.processSampler\.stop\(\)/u);
});

test("directory ownership accepts launch paths but rejects mere argument references", () => {
  const directory = "/gate/stack-official";
  assert.equal(
    phase5CommandLaunchPathMatches(
      "/usr/bin/node\0/gate/stack-official/node_modules/.bin/next\0dev\0",
      directory,
    ),
    true,
  );
  assert.equal(
    phase5CommandLaunchPathMatches(
      "/gate/stack-official/engines/images/.venv/bin/python\0server.py\0",
      directory,
    ),
    true,
  );
  assert.equal(
    phase5CommandLaunchPathMatches(
      "/usr/bin/node\0/gate/harness/run-phase5-gate.ts\0--official-dir\0/gate/stack-official\0",
      directory,
    ),
    false,
  );
});

test("cache summary parsing is content-free and deterministic", () => {
  const log = `
📊 Data summary:
   - Colors: 11
   - Fonts: 22
   - Font Pairs: 3
   - Editor Styles: 4
   - Theme Metadata: Yes
   - Icon Libraries: 5
   - Background Images Metadata: Yes (JSON URL available)
   - Unsplash Topics: 6
   - Tags: 7
   - Core Free Slide IDs: 8
   - Legacy Templates Metadata: No
`;
  const counts = parseCacheOutputCounts(log);
  assert.deepEqual(counts, {
    backgroundImagesMetadata: true,
    colors: 11,
    coreFreeSlideIds: 8,
    editorStyles: 4,
    fontPairs: 3,
    fonts: 22,
    iconLibraries: 5,
    legacyTemplatesMetadata: false,
    tags: 7,
    themeMetadata: true,
    unsplashTopics: 6,
  });
  assert.equal(cacheOutputDigest(counts), cacheOutputDigest({ ...counts }));
});

test("mprocs control readiness never opens a protocol-less TCP connection", async () => {
  const source = await readFile(controlUrl, "utf8");
  assert.match(
    source,
    /name === "mprocsControl" \? await listenerOpen\(port\) : await portOpen\(port\)/u,
  );
  assert.match(
    source,
    /ports\.map\(async \(port\) => listenerOpen\(port\)\)/u,
  );
  assert.match(source, /cleanupFailedStart\(input\)/u);
  assert.match(source, /emulatorProcessObserved/u);
  assert.match(source, /emulator process exited before readiness/u);
  assert.match(source, /reapPhase5DirectoryProcesses/u);
  assert.match(source, /phase5DirectoryProcesses/u);
  assert.match(source, /phase5EmulatorProcesses/u);
  assert.match(source, /process\.kill\(identity\.pid, "SIGINT"\)/u);
  assert.match(source, /phase5ProcessIdentityAlive/u);
  assert.match(source, /signalPhase5DirectoryProcesses\([\s\S]*?"SIGINT"/u);
  assert.match(source, /signalPhase5DirectoryProcesses\([\s\S]*?"SIGTERM"/u);
  assert.doesNotMatch(source, /process\.kill\(-/u);
  assert.match(source, /cwd !== resolvedDirectory/u);
  assert.match(source, /child\.once\("close", \(exitCode\) =>/u);
  assert.doesNotMatch(source, /send-keys[\s\S]{0,100}["']q["']/u);
});

test("failed startup reaps its directory before asserting listener cleanup", async () => {
  const source = await readFile(controlUrl, "utf8");
  const cleanupStart = source.indexOf("async function cleanupFailedStart");
  const cleanupEnd = source.indexOf("async function stopPhase5EmulatorProcess", cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  const directoryReap = cleanupSource.indexOf("await reapPhase5DirectoryProcesses");
  const controllerSessionClose = cleanupSource.indexOf(
    '"close failed Phase 5 startup session"',
  );
  const listenerAssertion = cleanupSource.indexOf("const deadline");
  assert.ok(directoryReap >= 0, "failed startup must reap its scoped directory");
  assert.ok(
    controllerSessionClose >= 0 && controllerSessionClose < directoryReap,
    "failed startup must close its exact tmux session before directory reaping",
  );
  assert.ok(
    listenerAssertion > directoryReap,
    "listener cleanup must be asserted only after directory process reaping",
  );
  assert.match(cleanupSource, /close cleaned Phase 5 startup session/u);
});

test("directory cleanup converges across reparenting and revalidates every signal", async () => {
  const source = await readFile(controlUrl, "utf8");
  const reapStart = source.indexOf("async function reapPhase5DirectoryProcesses");
  const reapEnd = source.indexOf("async function phase5DirectoryProcesses", reapStart);
  const reapSource = source.slice(reapStart, reapEnd);
  assert.match(reapSource, /consecutiveEmptyScans/u);
  assert.match(
    reapSource,
    /consecutiveEmptyScans >= PHASE5_DIRECTORY_EMPTY_SCANS/u,
  );
  assert.match(reapSource, /newlyDiscoveredProcesses/u);
  assert.match(reapSource, /phase5ProcessIdentityKey\(identity\)/u);
  assert.match(reapSource, /signalPhase5DirectoryProcesses\([\s\S]*?"SIGINT"/u);
  assert.match(reapSource, /signalPhase5DirectoryProcesses\([\s\S]*?"SIGTERM"/u);

  const discoveryStart = source.indexOf("async function phase5DirectoryProcesses");
  const discoveryEnd = source.indexOf("async function signalPhase5DirectoryProcesses", discoveryStart);
  const discoverySource = source.slice(discoveryStart, discoveryEnd);
  assert.match(discoverySource, /readFile\(`\/proc\/\$\{entry\.name\}\/cmdline`\)/u);
  assert.match(
    discoverySource,
    /!phase5CommandLaunchPathMatches\(command, resolvedDirectory\)/u,
  );
  assert.match(discoverySource, /phase5ProcessIdentityFromStat/u);
  const signalStart = source.indexOf("async function signalPhase5DirectoryProcesses");
  const signalEnd = source.indexOf("async function assertPhase5DirectoryProcessScope", signalStart);
  const signalSource = source.slice(signalStart, signalEnd);
  assert.match(signalSource, /assertPhase5DirectoryProcessScope\(identity, directory\)/u);
  assert.match(signalSource, /process\.kill\(identity\.pid, signal\)/u);
  assert.doesNotMatch(signalSource, /process\.kill\(-/u);
});

test("diagnostic readiness fails fast only after healthy process and listener gates", async () => {
  const tracker = new Phase5ReadinessTracker(testConditions(), 0, { emulator: 60, application: 1200 });
  for (const at of [1, 2, 3]) {
    tracker.observe("login", { ready: false, outcome: "http", status: 404 }, at);
    assert.equal(tracker.sample(at, true).consecutiveDefinitiveErrors, 0);
  }
  tracker.observe("marker", { ready: true, outcome: "ready" }, 4);
  assert.equal(tracker.sample(4, true).consecutiveDefinitiveErrors, 1);
  assert.equal(tracker.sample(5, true).consecutiveDefinitiveErrors, 1, "cached response is not a new sample");
  tracker.observe("login", { ready: false, outcome: "timeout", status: null }, 6);
  assert.equal(tracker.sample(6, true).consecutiveDefinitiveErrors, 0);
  for (const at of [7, 8, 9]) {
    tracker.observe("login", { ready: false, outcome: "http", status: 404 }, at);
    const sample = tracker.sample(at, true);
    assert.equal(sample.consecutiveDefinitiveErrors, at - 6);
    if (at === 9) assert.match(sample.failure ?? "", /3 identical samples: login returned 404/u);
    else assert.equal(sample.failure, null);
  }
});

function testConditions(): ReadinessCondition[] {
  return [
    { id: "marker", group: "emulator", kind: "marker", target: "All emulators ready",
      check: async () => ({ ready: true, outcome: "ready" }) },
    { id: "login", group: "application", kind: "probe", target: "http://localhost/login/overview",
      check: async () => ({ ready: true, outcome: "http", status: 200 }) },
  ];
}

test("all readiness conditions are inventoried and classified identically for both stacks", () => {
  for (const stack of ["official", "fireside"] as const) {
    const conditions = phase5ReadinessConditions({ ...launch, stack }, "https://templates.localhost", "https://net.localhost");
    assert.equal(conditions.length, 24);
    assert.equal(conditions.filter(({ kind }) => kind === "marker").length, 4);
    assert.equal(conditions.filter(({ kind }) => kind === "port").length, 13);
    assert.equal(conditions.filter(({ kind }) => kind === "probe").length, 7);
    assert.equal(conditions.filter(({ group }) => group === "emulator").length, 14);
    assert.deepEqual(conditions.filter(({ group }) => group === "application").map(({ id }) => id), [
      "marker:firebase-cache-watch.log", "marker:templates.log", "marker:dotnet.log",
      "port:cacheWebsocket", "port:mprocsControl", "probe:frontend-login", "probe:twodartnet-health",
      "probe:cache-json-raw", "probe:cache-json-alias", "probe:storage-alias-registration",
    ]);
  }
});

test("r22 cold-render replay keeps 60 seconds for the emulator, 1200 for applications", () => {
  const conditions = phase5ReadinessConditions(launch, "https://templates.localhost", "https://net.localhost");
  const tracker = new Phase5ReadinessTracker(conditions, 0, { emulator: 60, application: 1200 });
  for (const condition of conditions.filter(({ id }) => id !== "probe:frontend-login")) {
    const time = condition.group === "emulator" ? 17_000 : 21_000;
    tracker.observe(condition.id, { ready: true, outcome: "ready" }, time);
  }
  tracker.observe("probe:frontend-login", { ready: false, outcome: "timeout", status: null }, 59_000);
  const waiting = tracker.sample(60_000, true);
  assert.equal(waiting.failure, null);
  assert.deepEqual(waiting.unmetConditions, ["probe:frontend-login"]);
  assert.equal(waiting.deadlines.emulator?.readyMilliseconds, 17_000);
  assert.equal(waiting.deadlines.application?.maximumSeconds, 1200);
  tracker.observe("probe:frontend-login", { ready: true, outcome: "http", status: 200 }, 79_000);
  const ready = tracker.sample(79_001, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.conditions.find(({ id }) => id === "probe:frontend-login")?.firstReadyMilliseconds, 79_000);
});

test("a late emulator success cannot rescue the 60-second deadline", () => {
  const tracker = new Phase5ReadinessTracker(testConditions(), 0, { emulator: 60, application: 1200 });
  tracker.observe("login", { ready: true, outcome: "http", status: 200 }, 5_000);
  assert.match(tracker.sample(60_000, true).failure ?? "", /emulator: 60 seconds.*marker/u);
  tracker.observe("marker", { ready: true, outcome: "ready" }, 60_001);
  assert.equal(tracker.sample(60_001, true).ready, false);
  assert.match(tracker.sample(60_001, true).failure ?? "", /late conditions: marker/u);
});

test("full-gate allowances stay 1200 seconds and a regressed condition cannot wait forever", () => {
  const tracker = new Phase5ReadinessTracker(testConditions(), 0, { emulator: 1200, application: 1200 });
  assert.equal(tracker.sample(60_000, false).failure, null);
  assert.match(tracker.sample(1_200_000, false).failure ?? "", /emulator: 1200 seconds/u);
  const regressed = new Phase5ReadinessTracker(testConditions(), 0, { emulator: 60, application: 1200 });
  regressed.observe("marker", { ready: true, outcome: "ready" }, 10_000);
  regressed.observe("marker", { ready: false, outcome: "not-ready" }, 70_000);
  regressed.observe("login", { ready: true, outcome: "http", status: 200 }, 80_000);
  assert.equal(regressed.sample(80_000, false).ready, false);
  assert.match(regressed.sample(1_200_000, false).failure ?? "", /marker/u);
});

test("frontend command keeps connect=3, increases total to 30, and .NET stays at 8", () => {
  assert.equal(PHASE5_FRONTEND_PROBE_SECONDS, 30);
  assert.deepEqual(phase5CurlArguments("https://templates.localhost/login/overview", 30).slice(0, 4),
    ["--connect-timeout", "3", "--max-time", "30"]);
  assert.equal(phase5CurlArguments("https://net.localhost/api/HealthCheck", 8)[3], "8");
});

test("a pending frontend probe cannot delay the emulator deadline or its persisted ledger", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase5-readiness-test-"));
  try {
    let aborted = false;
    let healthSamples = 0;
    const conditions = testConditions();
    conditions[0] = { ...conditions[0]!, check: async () => ({ ready: false, outcome: "not-ready" }) };
    conditions[1] = { ...conditions[1]!, check: async (signal) => await new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ ready: false, outcome: "error", error: "probe cancelled after deadline" });
      }, { once: true });
    }) };
    const ledgerPath = path.join(directory, "readiness.jsonl");
    const summaryPath = path.join(directory, "readiness.json");
    const startedAt = Date.now();
    await assert.rejects(waitForPhase5Readiness({ conditions, startedAt,
      allowances: { emulator: 0.08, application: 1200 }, ledgerPath, summaryPath,
      diagnosticFailFast: true, checkHealth: async () => { healthSamples += 1; }, sampleMilliseconds: 5,
    }), /emulator: 0.08 seconds.*marker/u);
    assert.ok(Date.now() - startedAt < 2000, "must not await the frontend's 30-second budget");
    assert.equal(aborted, true);
    assert.ok(healthSamples > 1);
    const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(ledger.length > 1);
    for (const sample of ledger) {
      assert.equal(sample.conditions.length, 2);
      assert.equal(sample.deadlines.application.maximumSeconds, 1200);
      assert.ok(sample.timestamp);
    }
    const final = JSON.parse(await readFile(summaryPath, "utf8"));
    assert.equal(final.passed, false);
    assert.match(final.failure, /marker/u);
    assert.equal(final.conditions[1].pending, true);
    assert.equal(final.conditions[1].firstReadyAt, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("passing readiness persists per-condition ready times and health failures persist the exact error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase5-readiness-test-"));
  try {
    const result = await waitForPhase5Readiness({ conditions: testConditions(), startedAt: Date.now(),
      allowances: { emulator: 60, application: 1200 }, ledgerPath: path.join(directory, "pass.jsonl"),
      summaryPath: path.join(directory, "pass.json"), diagnosticFailFast: true,
      checkHealth: async () => {}, sampleMilliseconds: 1,
    });
    assert.equal(result.ready, true);
    assert.ok(result.conditions.every(({ firstReadyAt }) => firstReadyAt !== null));
    assert.equal(JSON.parse(await readFile(path.join(directory, "pass.json"), "utf8")).passed, true);
    await assert.rejects(waitForPhase5Readiness({ conditions: testConditions(), startedAt: Date.now(),
      allowances: { emulator: 60, application: 1200 }, ledgerPath: path.join(directory, "fail.jsonl"),
      summaryPath: path.join(directory, "fail.json"), diagnosticFailFast: true,
      checkHealth: async () => { throw new Error("fireside exited before readiness with status 1"); },
    }), /exited before readiness/u);
    const final = JSON.parse(await readFile(path.join(directory, "fail.json"), "utf8"));
    assert.equal(final.failure, "fireside exited before readiness with status 1");
    assert.equal(final.passed, false);
    assert.equal(final.conditions.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real loopback probes preserve HTTP errors and curl timeout text", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/hang") return;
    response.writeHead(request.url === "/missing" ? 404 : 200).end("synthetic");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const base = `http://127.0.0.1:${String(address.port)}`;
    const signal = new AbortController().signal;
    assert.equal((await phase5CurlProbe(`${base}/ready`, 30, signal)).status, 200);
    assert.deepEqual(await phase5FetchProbe(`${base}/missing`, signal), { ready: false, outcome: "http", status: 404 });
    const timeout = await phase5CurlProbe(`${base}/hang`, 0.03, signal);
    assert.equal(timeout.outcome, "timeout");
    assert.equal(timeout.status, null);
    assert.match(timeout.error ?? "", /timed out/u);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
