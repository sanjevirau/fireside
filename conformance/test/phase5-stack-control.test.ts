import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  cacheOutputDigest,
  parseCacheOutputCounts,
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
  assert.match(command, /official-initial\.exit/u);
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
});
