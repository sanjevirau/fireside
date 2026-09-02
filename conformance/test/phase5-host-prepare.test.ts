import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPhase5Ports,
  phase5PortEnvironment,
  phase5DatasetPaths,
  PHASE5_STACK_PORTS,
  renderSafeTwodartEnvironment,
  stageHardlinkedDependencyTree,
} from "../src/suite/phase5-host-prepare.ts";

test("Phase 5 host preparation uses only synthetic local provider values", () => {
  const environment = renderSafeTwodartEnvironment();
  assert.match(environment, /^ENV="local"$/mu);
  assert.match(environment, /^TWODART_DISABLE_EXTERNALS="1"$/mu);
  assert.match(environment, /^NEXT_PUBLIC_ENABLE_POSTHOG="false"$/mu);
  assert.match(environment, /^FIREBASE_FE_PROJECT_ID="demo-twodart-local"$/mu);
  assert.doesNotMatch(environment, /(?:AIza|ya29\.|sk_(?:live|test)|@gmail\.)/u);
  assert.doesNotMatch(environment, /fireside-conformance/u);
});

test("Phase 5 host preparation freezes every official and Fireside port", () => {
  for (const name of ["official", "fireside"] as const) {
    const ports = PHASE5_STACK_PORTS[name];
    const rendered = JSON.parse(
      applyPhase5Ports('{"emulators":{}}', ports),
    ) as {
      readonly emulators: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    };
    assert.deepEqual(rendered.emulators.firestore, {
      host: "127.0.0.1",
      port: ports.firestore,
      websocketPort: ports.firestoreWebsocket,
    });
    assert.equal(rendered.emulators.auth?.port, ports.auth);
    assert.equal(rendered.emulators.storage?.port, ports.storage);
    assert.equal(rendered.emulators.functions?.port, ports.functions);
    assert.equal(rendered.emulators.pubsub?.port, ports.pubsub);
    assert.equal(rendered.emulators.hub?.port, ports.hub);
    assert.equal(rendered.emulators.ui?.port, ports.ui);
    assert.equal(rendered.emulators.logging?.port, ports.logging);
    assert.equal(rendered.emulators.eventarc?.port, ports.eventarc);
    assert.equal(rendered.emulators.tasks?.port, ports.tasks);
    assert.deepEqual(phase5PortEnvironment(ports), {
      FIREBASE_EMULATOR_AUTH_PORT: String(ports.auth),
      FIREBASE_EMULATOR_FIRESTORE_PORT: String(ports.firestore),
      FIREBASE_EMULATOR_FUNCTIONS_PORT: String(ports.functions),
      FIREBASE_EMULATOR_HUB_PORT: String(ports.hub),
      FIREBASE_EMULATOR_PUBSUB_PORT: String(ports.pubsub),
      FIREBASE_EMULATOR_STORAGE_PORT: String(ports.storage),
      FIREBASE_EMULATOR_UI_PORT: String(ports.ui),
      MPROCS_CONTROL_PORT: String(ports.mprocsControl),
      TWODART_FIREBASE_EVENTARC_PORT: String(ports.eventarc),
      TWODART_FIREBASE_LOGGING_PORT: String(ports.logging),
      TWODART_FIREBASE_TASKS_PORT: String(ports.tasks),
      TWODART_FIREBASE_WEBSOCKET_PORT: String(ports.firestoreWebsocket),
    });
  }
  const allPorts = Object.values(PHASE5_STACK_PORTS).flatMap((ports) =>
    Object.values(ports)
  );
  assert.equal(new Set(allPorts).size, allPorts.length);
});

test("Phase 5 input staging is immutable and uses distinct lifecycle exports", () => {
  const official = phase5DatasetPaths("/gate", "official");
  const fireside = phase5DatasetPaths("/gate", "fireside");
  assert.equal(official.importPath, fireside.importPath);
  assert.notEqual(official.exportPath, fireside.exportPath);
  assert.notEqual(official.importPath, official.exportPath);
  assert.notEqual(fireside.importPath, fireside.exportPath);
});

test("Phase 5 dependency reuse keeps a real tree with hardlinked files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phase5-dependencies-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await mkdir(path.join(source, "package"), { recursive: true });
    await writeFile(path.join(source, "package/index.js"), "export const ok = true;\n");
    await symlink("package/index.js", path.join(source, "entry.js"));

    await stageHardlinkedDependencyTree(source, destination);

    assert.equal((await stat(destination)).isDirectory(), true);
    const sourceFile = await stat(path.join(source, "package/index.js"));
    const destinationFile = await stat(path.join(destination, "package/index.js"));
    assert.equal(destinationFile.dev, sourceFile.dev);
    assert.equal(destinationFile.ino, sourceFile.ino);
    assert.equal(await readlink(path.join(destination, "entry.js")), "package/index.js");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
