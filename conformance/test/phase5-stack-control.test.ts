import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  cacheOutputDigest,
  PHASE5_EXPORT_SHUTDOWN_SECONDS,
  parseCacheOutputCounts,
  phase5EmulatorProcessMatches,
  renderPhase5MprocsControlCommand,
  renderPhase5StackCommand,
  type StackLaunchInput,
} from "../src/suite/phase5-stack-control.ts";

const controlUrl = new URL("../src/suite/phase5-stack-control.ts", import.meta.url);

const launch: StackLaunchInput = {
  datasetName: "full-data",
  directory: "/gate/stack-official",
  evidenceDirectory: "/gate/evidence",
  exportPath: "/gate/exports/official/full-data",
  firesideBinary: "/gate/bin/fireside-phase4",
  javaHome: "/home/sanjevi/.local/share/mise/installs/java/26.0.2.1",
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
    "TWODART_DISABLE_EXTERNALS='1'",
    "TWODART_EMULATOR_EXPORT_OVERRIDE='/gate/exports/official/full-data'",
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
    "dotnet/10.0.301",
    "python/3.14.6/bin",
    "rust/1.98.0/bin",
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
  assert.deepEqual(
    renderPhase5MprocsControlCommand("/gate/stack-official", 23011),
    {
      arguments: ["--server", "127.0.0.1:23011", "--ctl", "c: force-quit"],
      command: "/gate/stack-official/node_modules/.bin/mprocs",
    },
  );
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
    /name === "mprocsControl" \? listenerOpen\(port\) : portOpen\(port\)/u,
  );
  assert.match(
    source,
    /ports\.map\(async \(port\) => listenerOpen\(port\)\)/u,
  );
  assert.match(source, /cleanupFailedStart\(input, exitMarker\)/u);
  assert.match(source, /emulatorProcessObserved/u);
  assert.match(source, /emulator process exited before readiness/u);
  assert.match(source, /child\.once\("close", \(exitCode\) =>/u);
  assert.doesNotMatch(source, /send-keys[\s\S]{0,100}["']q["']/u);
});
