import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { runImportGate } from "./endurance/import-gate.ts";
import {
  loadManifest,
  repositoryRoot,
  type EnduranceManifest,
} from "./endurance/manifest.ts";
import { runRecoveryGate } from "./endurance/recovery-gate.ts";
import { startServer, type ServerHandle } from "./endurance/server.ts";
import { runSoak } from "./endurance/soak.ts";

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "fireside-endurance-smoke-"));
let server: ServerHandle | undefined;
let succeeded = false;

try {
  await execute("cargo", ["build", "--release", "--locked", "-p", "fireside"], {
    cwd: repositoryRoot,
  });
  const manifest = smokeManifest(await loadManifest());
  for (const kind of ["fireside-memory", "fireside-disk"] as const) {
    const output = resolve(directory, `${kind}-soak`);
    server = await startServer({
      kind,
      projectId: "demo-fireside-endurance",
      outputDirectory: output,
      ...(kind === "fireside-disk"
        ? { dataDirectory: resolve(directory, "disk-soak-state") }
        : {}),
    });
    const result = await runSoak(manifest, server, kind, output);
    assert.equal(result.summary.failed, 0);
    assert.equal(
      Reflect.get(result.summary.criteria as object, "serverAlive"),
      true,
    );
    const releasedMemory = await waitForReleasedRuntimeMemory(server);
    assert.equal(Reflect.get(releasedMemory, "schemaVersion"), 1);
    const currentDocuments = requiredObject(releasedMemory, "currentDocuments");
    assert.equal(Reflect.get(currentDocuments, "entries"), 105);
    const changeLog = requiredObject(releasedMemory, "changeLog");
    assert.ok(Number(Reflect.get(changeLog, "entries")) <= 4_096);
    assert.equal(
      Reflect.get(requiredObject(releasedMemory, "transactions"), "transactions"),
      0,
    );
    const allocator = requiredObject(releasedMemory, "allocator");
    assert.equal(Reflect.get(allocator, "name"), "mimalloc");
    assert.ok(Number(Reflect.get(allocator, "version")) > 0);
    assert.ok(Reflect.get(allocator, "error") === undefined);
    assert.ok(Reflect.get(requiredObject(allocator, "statistics"), "process") !== undefined);
    assert.ok(Reflect.get(releasedMemory, "processResident") !== undefined);
    const logicalSeries = await readFile(resolve(output, "logical-memory.ndjson"), "utf8");
    assert.match(logicalSeries, /"schemaVersion":1/u);
    await server.stop();
    server = undefined;
  }

  const failedSeedOutput = resolve(directory, "failed-seed");
  server = await startServer({
    kind: "fireside-memory",
    projectId: "demo-fireside-endurance",
    outputDirectory: failedSeedOutput,
  });
  await assert.rejects(
    runSoak(failedSeedManifest(manifest), server, "fireside-memory", failedSeedOutput),
  );
  await server.stop();
  server = undefined;
  assert.match(
    await readFile(resolve(failedSeedOutput, "errors.ndjson"), "utf8"),
    /"type":"seed-error"/u,
  );

  const artifact = resolve(directory, "phase1-smoke-export");
  await execute(
    "cargo",
    [
      "run",
      "--release",
      "--locked",
      "-p",
      "fireside-export-format",
      "--example",
      "generate_endurance_export",
      "--",
      artifact,
      String(manifest.import.documentCount),
      String(manifest.import.payloadBytesPerDocument),
    ],
    { cwd: repositoryRoot },
  );
  const imported = await runImportGate(
    manifest,
    "fireside-disk",
    artifact,
    resolve(directory, "import"),
    resolve(directory, "import-state"),
  );
  assert.equal(imported.passed, true);

  const recovered = await runRecoveryGate(
    manifest,
    resolve(directory, "recovery"),
    resolve(directory, "recovery-state"),
  );
  assert.equal(recovered.passed, true);
  succeeded = true;
  console.log("phase 1 endurance tooling smoke test passed");
} finally {
  await server?.stop().catch(() => undefined);
  if (succeeded) {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.error(`failed endurance smoke evidence preserved at ${directory}`);
  }
}

async function waitForReleasedRuntimeMemory(
  handle: ServerHandle,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(
      `http://${handle.host}:${String(handle.port)}/emulator/v1/debug/memory`,
    );
    assert.equal(response.status, 200);
    const memory = await response.json() as Record<string, unknown>;
    const listeners = requiredObject(memory, "listeners");
    if (
      Reflect.get(listeners, "streams") === 0
      && Reflect.get(listeners, "targets") === 0
    ) {
      return memory;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("listener accounting remained after the soak client terminated");
}

function requiredObject(source: object, field: string): Record<string, unknown> {
  const value = Reflect.get(source, field) as unknown;
  assert.ok(typeof value === "object" && value !== null, `${field} must be an object`);
  return value as Record<string, unknown>;
}

function failedSeedManifest(source: EnduranceManifest): EnduranceManifest {
  return {
    ...source,
    soak: {
      ...source.soak,
      workingSet: {
        ...source.soak.workingSet,
        documentCount: 1,
        smallDocumentCount: 1,
        smallPayloadBytes: 11 * 1024 * 1024,
        largeDocumentCount: 0,
        listenerDocumentCount: 1,
        listenerDocumentIndexes: [0],
        seedBatchSize: 1,
      },
      listeners: {
        ...source.soak.listeners,
        activeCount: 1,
      },
    },
  };
}

function smokeManifest(source: EnduranceManifest): EnduranceManifest {
  return {
    ...source,
    soak: {
      ...source.soak,
      durationSeconds: 12,
      warmupSeconds: 2,
      rssSampleIntervalSeconds: 1,
      metricRollupIntervalSeconds: 1,
      targetWritesPerSecond: 10,
      minimumCompletionRatio: 0.9,
      maxConcurrentOperations: 4,
      transactionSchedule: {
        ...source.soak.transactionSchedule,
        hotDocumentCount: 4,
      },
      workingSet: {
        ...source.soak.workingSet,
        documentCount: 105,
        smallDocumentCount: 95,
        largeDocumentCount: 10,
        largeDocumentSizesBytes: [102_400, 204_800, 307_200, 409_600, 512_000],
        maximumObservedFiresideRssBytes: 2_147_483_648,
        listenerDocumentCount: 2,
        listenerDocumentIndexes: [0, 1],
        seedBatchSize: 25,
      },
      listeners: {
        ...source.soak.listeners,
        activeCount: 2,
        churnIntervalSeconds: 3,
        finalDrainSeconds: 3,
      },
      memory: {
        ...source.soak.memory,
        maximumRssSlopeBytesPerHour: Number.MAX_SAFE_INTEGER,
        initialMedianWindowStartSeconds: 2,
        initialMedianWindowEndSeconds: 6,
        finalMedianWindowSeconds: 4,
        maximumFinalMedianIncreaseFraction: 10,
      },
    },
    import: {
      ...source.import,
      documentCount: 64,
      payloadBytesPerDocument: 32_768,
      minimumArtifactBytes: 1,
      maximumArtifactBytes: 10_485_760,
      maximumPeakRssBytes: 1_073_741_824,
      rssSampleIntervalMilliseconds: 25,
      verificationRandomReads: 64,
      verificationConcurrency: 8,
    },
    recovery: {
      ...source.recovery,
      rounds: 2,
      minimumAcknowledgedCommits: 6,
      acknowledgedCommitsBeforeEachKill: 3,
    },
  };
}
