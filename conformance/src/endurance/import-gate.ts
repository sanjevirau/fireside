import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { DurableLog } from "./durable-log.ts";
import type { EnduranceManifest } from "./manifest.ts";
import { sampleProcess } from "./process-metrics.ts";
import { startServer, type ServerHandle } from "./server.ts";

export interface ImportResult {
  readonly passed: boolean;
  readonly summary: Record<string, unknown>;
  readonly summaryPath: string;
}

export async function runImportGate(
  manifest: EnduranceManifest,
  kind: "fireside-disk" | "java",
  artifactDirectory: string,
  outputDirectory: string,
  dataDirectory?: string,
  javaToolOptions?: string,
): Promise<ImportResult> {
  await mkdir(outputDirectory, { recursive: true });
  const metadata = resolve(
    artifactDirectory,
    `${basename(artifactDirectory)}.overall_export_metadata`,
  );
  const shard = resolve(artifactDirectory, "all_namespaces/all_kinds/output-0");
  const artifactBytes = (await stat(shard)).size;
  const rss = new DurableLog(
    resolve(outputDirectory, "rss.csv"),
    "timestamp,elapsed_seconds,rss_bytes,peak_rss_bytes,process_swap_bytes,system_available_bytes,system_swap_used_bytes,load_1",
  );
  const events = new DurableLog(resolve(outputDirectory, "events.ndjson"));
  const errors = new DurableLog(resolve(outputDirectory, "errors.ndjson"));
  const startedAt = Date.now();
  let server: ServerHandle | undefined;
  let serverPid: number | undefined;
  let peakRssBytes = 0;
  let readErrors = 0;
  let samples = 0;
  let sampler: NodeJS.Timeout | undefined;
  let rssRecording = Promise.resolve();
  let startupError: string | undefined;

  try {
    events.json(event("import-start", { artifactBytes, kind, metadata }));
    const serverPromise = startServer({
      kind,
      projectId: "demo-fireside-endurance-import",
      outputDirectory,
      ...(dataDirectory === undefined ? {} : { dataDirectory }),
      ...(javaToolOptions === undefined ? {} : { javaToolOptions }),
      importMetadata: metadata,
      onSpawn(pid) {
        serverPid = pid;
        sampler = setInterval(
          queueRss,
          manifest.import.rssSampleIntervalMilliseconds,
        );
        queueRss();
      },
    });
    try {
      server = await serverPromise;
    } catch (error) {
      startupError = errorMessage(error);
      errors.json(event("import-startup-error", { message: startupError }));
    }

    if (server !== undefined) {
      events.json(event("import-ready", {
        startupMilliseconds: server.startupMilliseconds,
      }));
      readErrors = await verifyRandomReads(manifest, server, errors);
    }
  } finally {
    if (sampler !== undefined) {
      clearInterval(sampler);
    }
    await rssRecording.catch(() => undefined);
    await recordRss().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    rss.close();
    events.close();
    errors.close();
  }

  const artifactWithinBounds =
    artifactBytes >= manifest.import.minimumArtifactBytes
    && artifactBytes <= manifest.import.maximumArtifactBytes;
  const criteria = {
    artifactWithinBounds,
    serverReady: server !== undefined,
    randomReads: readErrors <= manifest.import.unexpectedErrorsAllowed,
    peakRss:
      kind === "java" || peakRssBytes <= manifest.import.maximumPeakRssBytes,
  };
  const passed = kind === "java"
    ? criteria.serverReady && criteria.randomReads
    : Object.values(criteria).every(Boolean);
  const summary = {
    kind,
    passed,
    artifactBytes,
    artifactDocumentCount: manifest.import.documentCount,
    elapsedMilliseconds: Date.now() - startedAt,
    startupMilliseconds: server?.startupMilliseconds ?? null,
    startupError: startupError ?? null,
    peakRssBytes,
    rssSamples: samples,
    verificationReads: manifest.import.verificationRandomReads,
    readErrors,
    criteria,
  } satisfies Record<string, unknown>;
  const summaryPath = resolve(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { passed, summary, summaryPath };

  async function recordRss(): Promise<void> {
    if (serverPid === undefined) {
      return;
    }
    const sample = await sampleProcess(serverPid);
    const elapsedSeconds = (Date.now() - startedAt) / 1_000;
    peakRssBytes = Math.max(peakRssBytes, sample.rssBytes, sample.peakRssBytes);
    samples += 1;
    rss.write([
      new Date().toISOString(),
      elapsedSeconds,
      sample.rssBytes,
      sample.peakRssBytes,
      sample.processSwapBytes,
      sample.systemAvailableBytes,
      sample.systemSwapUsedBytes,
      sample.loadOne,
    ].join(","));
  }

  function queueRss(): void {
    rssRecording = rssRecording.then(recordRss);
  }
}

async function verifyRandomReads(
  manifest: EnduranceManifest,
  server: ServerHandle,
  errors: DurableLog,
): Promise<number> {
  let failures = 0;
  let nextRead = 0;
  let state = 0x6d2b79f5;
  const workers = Array.from(
    { length: manifest.import.verificationConcurrency },
    async () => {
      while (true) {
        const read = nextRead;
        nextRead += 1;
        if (read >= manifest.import.verificationRandomReads) {
          return;
        }
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        const ordinal = state % manifest.import.documentCount;
        const id = `document-${String(ordinal).padStart(8, "0")}`;
        const url = `http://${server.host}:${String(server.port)}/v1/projects/demo-fireside-endurance-import/databases/(default)/documents/phase1_import/${id}`;
        try {
          const response = await fetch(url, {
            headers: { authorization: "Bearer owner" },
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            throw new Error(`read ${id} returned HTTP ${String(response.status)}`);
          }
          const body: unknown = await response.json();
          const observed = firestoreInteger(body, "ordinal");
          if (observed !== ordinal) {
            throw new Error(`read ${id} returned ordinal ${String(observed)}`);
          }
        } catch (error) {
          failures += 1;
          errors.json(event("verification-read-error", {
            ordinal,
            message: errorMessage(error),
          }));
        }
      }
    },
  );
  await Promise.all(workers);
  return failures;
}

function firestoreInteger(body: unknown, field: string): number | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const fields = Reflect.get(body, "fields");
  if (typeof fields !== "object" || fields === null) {
    return undefined;
  }
  const value = Reflect.get(fields, field);
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const integer = Reflect.get(value, "integerValue");
  return typeof integer === "string" || typeof integer === "number"
    ? Number(integer)
    : undefined;
}

function event(type: string, details: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: new Date().toISOString(), type, ...details };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
