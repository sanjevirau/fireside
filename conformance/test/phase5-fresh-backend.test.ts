import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  validatePhase5FreshBackend,
  recordPhase5FreshBackend,
  type Phase5FreshBackendObservation,
} from "../src/suite/phase5-fresh-backend.ts";

const evidence = new URL("../../reports/phase-5-metrics/hetzner-r46-20260905/completed-attempt/", import.meta.url);
const firesideLog = await readFile(new URL("full/service-logs/fresh-colleague/firebase-emulator.log", evidence), "utf8");
const officialLog = await readFile(new URL("smoke-service-logs/official/firebase-emulator.log", evidence), "utf8");
const tmuxLog = await readFile(new URL("full/evidence/fireside-fresh-default-tmux.log", evidence), "utf8");
const binary = "/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905/attempts/r46/target/release/fireside";
const directory = "/gate/fresh";
const selected = {
  pid: 42, procStatStartTimeTicks: "100", command: `${binary}\0suite\0`,
  cwd: `${directory}/apps/templates-firebase`, backendOverride: null,
};
const observation: Phase5FreshBackendObservation = {
  stack: "fireside", expectedOverride: null, directory, firesideBinary: binary,
  launchStartedAtMilliseconds: 1000, serviceLogModifiedAtMilliseconds: 1001,
  serviceLog: firesideLog, processes: [selected],
};

test("fresh backend acquisition failure is recorded verbatim before rethrowing", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "phase5-backend-"));
  try {
    await assert.rejects(recordPhase5FreshBackend({
      directory: path.join(output, "missing-checkout"), stack: "fireside", label: "fresh-default",
      firesideBinary: binary, launchStartedAtMilliseconds: Date.now(),
    }, null, output), /ENOENT/u);
    const failure = JSON.parse(await readFile(path.join(output, "fireside-fresh-default-backend.json"), "utf8"));
    assert.equal(failure.passed, false);
    assert.match(failure.error, /ENOENT.*firebase-emulator\.log/u);
    assert.equal(failure.expectedOverride, null);
  } finally { await rm(output, { recursive: true }); }
});

test("fresh default accepts the captured service output without a tmux marker", () => {
  assert.doesNotMatch(tmuxLog, /Fireside suite:/u);
  assert.doesNotThrow(() => validatePhase5FreshBackend(observation));
  assert.throws(() => validatePhase5FreshBackend({ ...observation, serviceLog: tmuxLog }), /service log/u);
});

test("official fallback accepts real launcher output, not the invented literal", () => {
  assert.doesNotMatch(officialLog, /official Firebase Emulator Suite/u);
  const official: Phase5FreshBackendObservation = {
    ...observation, stack: "official", expectedOverride: "official", serviceLog: officialLog,
    processes: [{ ...selected, command: `/usr/bin/node\0${directory}/node_modules/.bin/firebase\0emulators:start\0`, backendOverride: "official" }],
  };
  assert.doesNotThrow(() => validatePhase5FreshBackend(official));
  assert.throws(() => validatePhase5FreshBackend({ ...official, serviceLog: firesideLog }), /service log/u);
  assert.throws(() => validatePhase5FreshBackend({ ...official, processes: [{ ...official.processes[0]!, backendOverride: null }] }), /override/u);
});

test("fresh backend rejects stale, missing, duplicate, wrong-scope and wrong-binary evidence", () => {
  assert.throws(() => validatePhase5FreshBackend({ ...observation, serviceLogModifiedAtMilliseconds: 999 }), /stale/u);
  assert.throws(() => validatePhase5FreshBackend({ ...observation, processes: [] }), /exactly one/u);
  assert.throws(() => validatePhase5FreshBackend({ ...observation, processes: [selected, { ...selected, pid: 43 }] }), /exactly one/u);
  assert.throws(() => validatePhase5FreshBackend({ ...observation, processes: [{ ...selected, cwd: "/gate/fresh-other" }] }), /scope/u);
  assert.throws(() => validatePhase5FreshBackend({ ...observation, processes: [{ ...selected, command: "/wrong/fireside\0suite\0" }] }), /command/u);
  assert.throws(() => validatePhase5FreshBackend({ ...observation, processes: [{ ...selected, backendOverride: "fireside" }] }), /override/u);
  assert.throws(() => validatePhase5FreshBackend({ ...observation, serviceLog: `Fireside suite: /wrong/fireside\nAll emulators ready` }), /service log/u);
});

test("fresh acceptance persists service snapshots and clears inherited default override", async () => {
  const control = await readFile(new URL("../src/suite/phase5-stack-control.ts", import.meta.url), "utf8");
  const gate = await readFile(new URL("../src/suite/run-phase5-gate.ts", import.meta.url), "utf8");
  const fresh = gate.slice(gate.indexOf("async function runFreshColleague("), gate.indexOf("async function runRegressions("));
  assert.match(control, /env -u TWODART_FIREBASE_BACKEND/u);
  assert.match(fresh, /recordPhase5FreshBackend/u);
  assert.doesNotMatch(fresh, /readFile\(running\.launchLog/u);
  assert.doesNotMatch(fresh, /official Firebase Emulator Suite/u);
  assert.ok(fresh.indexOf("recordPhase5FreshBackend") < fresh.indexOf("await stopPhase5Stack"));
});
