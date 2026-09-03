import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPhase5Ports,
  assertDistinctPhase5ApplicationUrls,
  PHASE5_APPLICATION_URL_KEYS,
  phase5PortEnvironment,
  phase5DatasetPaths,
  PHASE5_STACK_PORTS,
  renderSafeTwodartEnvironment,
  stageHardlinkedDirectoryTree,
} from "../src/suite/phase5-host-prepare.ts";

const hostPrepareUrl = new URL("../src/suite/phase5-host-prepare.ts", import.meta.url);

test("the r13 rejection freezes the exact synthetic asset contamination", async () => {
  const fixture = JSON.parse(await readFile(new URL(
    "../fixtures/phase5/runtime-asset-isolation-contract.json", import.meta.url,
  ), "utf8"));
  assert.equal(fixture.observedFileCount, fixture.originalFileCount + 1);
  assert.equal(fixture.generatedPath, "core/phase5-smoke-core-slide.pptx");
  assert.equal(fixture.treeSha256ExcludingGeneratedFile, fixture.frozenTreeSha256);
  assert.equal(fixture.rejectedAttemptStartedStack, false);
  assert.equal(fixture.runnerChangesRequired, false);
  assert.equal(fixture.manifestChangesRequired, false);
});

test("Phase 5 host preparation drains captured child output", async () => {
  const source = await readFile(hostPrepareUrl, "utf8");
  assert.match(source, /child\.once\("close", \(code, signal\) =>/u);
});

function applicationUrls(prefix: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    PHASE5_APPLICATION_URL_KEYS.map((key) => [
      key,
      `https://${prefix}-${key.toLowerCase().replaceAll("_", "-")}.twodart.localhost`,
    ]),
  );
}

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
      FIREBASE_CACHE_WEBSOCKET_PORT: String(ports.cacheWebsocket),
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

test("Phase 5 application URL namespaces must be distinct", () => {
  const official = applicationUrls("phase5-official");
  const fireside = applicationUrls("phase5-fireside");
  assert.doesNotThrow(() => assertDistinctPhase5ApplicationUrls(official, fireside));
  assert.throws(
    () => assertDistinctPhase5ApplicationUrls(official, official),
    /application URL namespace collides/u,
  );
  assert.throws(
    () =>
      assertDistinctPhase5ApplicationUrls(official, {
        ...fireside,
        FE_URL: undefined as unknown as string,
      }),
    /application URL is missing: FE_URL/u,
  );
});

test("Phase 5 directory staging keeps a real tree with hardlinked files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phase5-dependencies-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await mkdir(path.join(source, "package"), { recursive: true });
    await writeFile(path.join(source, "package/index.js"), "export const ok = true;\n");
    await symlink("package/index.js", path.join(source, "entry.js"));

    await stageHardlinkedDirectoryTree(source, destination);

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
