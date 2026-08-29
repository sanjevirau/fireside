import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Firestore } from "@google-cloud/firestore";

import { DurableLog } from "./durable-log.ts";
import type { EnduranceManifest } from "./manifest.ts";
import { sampleProcess } from "./process-metrics.ts";
import type { ServerHandle, ServerKind } from "./server.ts";
import {
  median,
  percentile,
  sustainedWindowTheilSenBytesPerHour,
  theilSenBytesPerHour,
} from "./statistics.ts";

export interface SoakResult {
  readonly passed: boolean;
  readonly summaryPath: string;
  readonly summary: Record<string, unknown>;
}

export interface SoakRunOptions {
  /// Measured diagnostic window. The frozen manifest remains the source for
  /// workload shape, warm-up, thresholds, and full-gate duration.
  readonly observationDurationSeconds?: number;
}

interface ListenerState {
  unsubscribe: () => void;
  ready: Promise<void>;
}

interface RssPoint {
  readonly elapsedSeconds: number;
  readonly rssBytes: number;
}

interface FailFastSlopeFailure {
  readonly elapsedSeconds: number;
  readonly observedBytesPerHour: number;
  readonly maximumBytesPerHour: number;
  readonly sustainedWindowSeconds: number;
}

const MAXIMUM_SEED_BATCH_PAYLOAD_BYTES = 3 * 1024 * 1024;

export async function runSoak(
  manifest: EnduranceManifest,
  server: ServerHandle,
  kind: ServerKind,
  outputDirectory: string,
  options: SoakRunOptions = {},
): Promise<SoakResult> {
  const observationDurationSeconds = options.observationDurationSeconds
    ?? manifest.soak.durationSeconds;
  if (
    !Number.isInteger(observationDurationSeconds)
    || observationDurationSeconds <= manifest.soak.warmupSeconds
    || observationDurationSeconds > manifest.soak.durationSeconds
  ) {
    throw new Error("soak observation duration must be an integer after warm-up and no longer than the frozen run");
  }
  await mkdir(outputDirectory, { recursive: true });
  const files = manifest.telemetry.files;
  const events = new DurableLog(resolve(outputDirectory, requiredFile(files, "events")));
  const errors = new DurableLog(resolve(outputDirectory, requiredFile(files, "errors")));
  const stalls = new DurableLog(resolve(outputDirectory, requiredFile(files, "stalls")));
  const rss = new DurableLog(
    resolve(outputDirectory, requiredFile(files, "rss")),
    "timestamp,elapsed_seconds,rss_bytes,peak_rss_bytes,process_swap_bytes,pss_bytes,anonymous_bytes,private_clean_bytes,private_dirty_bytes,shared_clean_bytes,shared_dirty_bytes,lazy_free_bytes,anonymous_huge_pages_bytes,system_available_bytes,system_swap_used_bytes,load_1",
  );
  const logicalMemory = new DurableLog(
    resolve(outputDirectory, requiredFile(files, "logicalMemory")),
  );
  const throughput = new DurableLog(
    resolve(outputDirectory, requiredFile(files, "throughput")),
    "timestamp,elapsed_seconds,scheduled,completed,failed,interval_completed,interval_failed,transaction_attempts,interval_transaction_attempts",
  );
  const latency = new DurableLog(
    resolve(outputDirectory, requiredFile(files, "latency")),
    "timestamp,elapsed_seconds,write_count,write_p50_ms,write_p95_ms,write_p99_ms,write_max_ms,listener_count,listener_p50_ms,listener_p95_ms,listener_p99_ms,listener_max_ms",
  );
  const firestore = new Firestore({
    projectId: "demo-fireside-endurance",
    host: `${server.host}:${String(server.port)}`,
    ssl: false,
  });
  const collection = firestore.collection(manifest.soak.workingSet.collection);
  const payloads = payloadBuffers(manifest);
  let scheduled = 0;
  let completed = 0;
  let failed = 0;
  let transactionAttempts = 0;
  let intervalCompleted = 0;
  let intervalFailed = 0;
  let intervalTransactionAttempts = 0;
  let listenerMismatches = 0;
  let stallEvents = 0;
  let lastCompletionAt = Date.now();
  let stallOpen = false;
  const writeLatencies: number[] = [];
  const listenerLatencies: number[] = [];
  let intervalWriteLatencies: number[] = [];
  let intervalListenerLatencies: number[] = [];
  const rssSamples: RssPoint[] = [];
  const listenerExpected = Array<number>(manifest.soak.listeners.activeCount).fill(0);
  const listenerObserved = Array<number>(manifest.soak.listeners.activeCount).fill(0);
  const listenerPending = new Map<string, number>();
  const listenerStates: ListenerState[] = [];
  const listenerChains: Promise<void>[] = Array.from(
    { length: manifest.soak.listeners.activeCount },
    () => Promise.resolve(),
  );
  let measurementStart = 0;
  let churnCount = 0;
  let churnRunning = false;
  let stopped = false;
  let rssTimer: NodeJS.Timeout | undefined;
  let rollupTimer: NodeJS.Timeout | undefined;
  let stallTimer: NodeJS.Timeout | undefined;
  let churnTimer: NodeJS.Timeout | undefined;
  let rssRecording = Promise.resolve();
  let failFastSlopeFailure: FailFastSlopeFailure | undefined;

  try {
    events.json(event("seed-start", { kind }));
    const seedStarted = performance.now();
    try {
      await seedWorkingSet(firestore, manifest, payloads);
    } catch (error) {
      errors.json(event("seed-error", { kind, message: errorMessage(error) }));
      throw error;
    }
    events.json(event("seed-complete", {
      durationMilliseconds: performance.now() - seedStarted,
      documents: manifest.soak.workingSet.documentCount,
    }));

    for (let slot = 0; slot < manifest.soak.listeners.activeCount; slot += 1) {
      listenerStates.push(startListener(slot));
    }
    await Promise.all(listenerStates.map((state) => state.ready));
    events.json(event("listeners-ready", { count: listenerStates.length }));

    measurementStart = Date.now();
    lastCompletionAt = measurementStart;
    events.json(event("soak-start", {
      durationSeconds: observationDurationSeconds,
      manifestDurationSeconds: manifest.soak.durationSeconds,
      targetWritesPerSecond: manifest.soak.targetWritesPerSecond,
    }));

    rssTimer = setInterval(queueRss, manifest.soak.rssSampleIntervalSeconds * 1_000);
    rollupTimer = setInterval(
      recordRollup,
      manifest.soak.metricRollupIntervalSeconds * 1_000,
    );
    stallTimer = setInterval(recordStall, 1_000);
    churnTimer = setInterval(
      () => void churnListener(),
      manifest.soak.listeners.churnIntervalSeconds * 1_000,
    );
    await recordRss();

    const totalOperations = observationDurationSeconds
      * manifest.soak.targetWritesPerSecond;
    const intervalMilliseconds = 1_000 / manifest.soak.targetWritesPerSecond;
    const deadline = measurementStart + observationDurationSeconds * 1_000;
    const inFlight = new Set<Promise<void>>();

    for (let index = 0; index < totalOperations; index += 1) {
      if (failFastSlopeFailure !== undefined) {
        break;
      }
      if (server.child.exitCode !== null || server.child.signalCode !== null) {
        errors.json(event("server-exit", {
          code: server.child.exitCode,
          signal: server.child.signalCode,
          index,
        }));
        break;
      }
      const plannedAt = measurementStart + index * intervalMilliseconds;
      if (plannedAt >= deadline || Date.now() >= deadline) {
        break;
      }
      await delayUntil(plannedAt);
      if (failFastSlopeFailure !== undefined) {
        break;
      }
      while (inFlight.size >= manifest.soak.maxConcurrentOperations) {
        await Promise.race(inFlight);
        if (Date.now() >= deadline) {
          break;
        }
      }
      if (Date.now() >= deadline) {
        break;
      }
      scheduled += 1;
      const operation = scheduleOperation(index).finally(() => inFlight.delete(operation));
      inFlight.add(operation);
    }

    const remaining = Promise.allSettled(inFlight);
    await Promise.race([
      remaining,
      delay(manifest.soak.listeners.finalDrainSeconds * 1_000),
    ]);
    clearInterval(churnTimer);
    while (churnRunning) {
      await delay(25);
    }
    await waitForListenerConvergence();
    clearInterval(rssTimer);
    clearInterval(rollupTimer);
    clearInterval(stallTimer);
    stopped = true;
    await rssRecording;
    recordRollup();
    await recordRss();
    for (const state of listenerStates) {
      state.unsubscribe();
    }

    const elapsedSeconds = (Date.now() - measurementStart) / 1_000;
    const steadySamples = rssSamples.filter(
      (sample) => sample.elapsedSeconds >= manifest.soak.warmupSeconds,
    );
    const initialSamples = rssSamples.filter(
      (sample) =>
        sample.elapsedSeconds >= manifest.soak.memory.initialMedianWindowStartSeconds
        && sample.elapsedSeconds < manifest.soak.memory.initialMedianWindowEndSeconds,
    );
    const finalWindowStart = observationDurationSeconds
      - manifest.soak.memory.finalMedianWindowSeconds;
    const finalSamples = rssSamples.filter(
      (sample) => sample.elapsedSeconds >= finalWindowStart,
    );
    const rssSlope = theilSenBytesPerHour(steadySamples);
    const initialMedian = median(initialSamples.map((sample) => sample.rssBytes));
    const finalMedian = median(finalSamples.map((sample) => sample.rssBytes));
    const medianAllowance = initialMedian === null
      ? null
      : Math.max(
        initialMedian * manifest.soak.memory.maximumFinalMedianIncreaseFraction,
        manifest.soak.memory.maximumFinalMedianIncreaseBytesFloor,
      );
    const peakRss = Math.max(...rssSamples.map((sample) => sample.rssBytes), 0);
    const completionRatio = completed / totalOperations;
    const serverAlive = server.child.exitCode === null && server.child.signalCode === null;
    const criteria = {
      completionRatio:
        completionRatio >= manifest.soak.minimumCompletionRatio,
      errors: failed <= manifest.soak.progress.unexpectedErrorsAllowed,
      listenerMismatches:
        listenerMismatches <= manifest.soak.progress.listenerMismatchesAllowed,
      listenerFinalState: listenerExpected.every(
        (expected, slot) => listenerObserved[slot] === expected,
      ),
      noProgressStalls: stallEvents === 0,
      failFastSlope: failFastSlopeFailure === undefined,
      rssSlope:
        rssSlope !== null
        && rssSlope <= manifest.soak.memory.maximumRssSlopeBytesPerHour,
      rssMedian:
        initialMedian !== null
        && finalMedian !== null
        && medianAllowance !== null
        && finalMedian <= initialMedian + medianAllowance,
      workingSetRss:
        kind === "java"
        || peakRss <= manifest.soak.workingSet.maximumObservedFiresideRssBytes,
      serverAlive,
    };
    const passed = kind === "java"
      ? criteria.completionRatio
        && criteria.errors
        && criteria.listenerMismatches
        && criteria.listenerFinalState
        && criteria.noProgressStalls
        && criteria.serverAlive
      : Object.values(criteria).every(Boolean);
    const summary = {
      kind,
      passed,
      startedAt: new Date(measurementStart).toISOString(),
      elapsedSeconds,
      startupMilliseconds: server.startupMilliseconds,
      manifestDurationSeconds: manifest.soak.durationSeconds,
      observationDurationSeconds,
      targetOperations: totalOperations,
      scheduled,
      completed,
      failed,
      completionRatio,
      transactionAttempts,
      listenerChurns: churnCount,
      listenerMismatches,
      stallEvents,
      listenerExpected,
      listenerObserved,
      rss: {
        samples: rssSamples.length,
        peakBytes: peakRss,
        slopeBytesPerHour: rssSlope,
        initialMedianBytes: initialMedian,
        finalMedianBytes: finalMedian,
        medianAllowanceBytes: medianAllowance,
      },
      failFastSlopeFailure: failFastSlopeFailure ?? null,
      writeLatencyMilliseconds: latencySummary(writeLatencies),
      listenerLatencyMilliseconds: latencySummary(listenerLatencies),
      criteria,
    } satisfies Record<string, unknown>;
    const summaryPath = resolve(outputDirectory, requiredFile(files, "summary"));
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    events.json(event("soak-complete", { passed, completed, failed }));
    return { passed, summaryPath, summary };
  } finally {
    stopped = true;
    clearOptionalInterval(rssTimer);
    clearOptionalInterval(rollupTimer);
    clearOptionalInterval(stallTimer);
    clearOptionalInterval(churnTimer);
    await rssRecording.catch(() => undefined);
    while (churnRunning) {
      await delay(25);
    }
    for (const state of listenerStates) {
      state.unsubscribe();
    }
    await firestore.terminate().catch(() => undefined);
    events.close();
    errors.close();
    stalls.close();
    rss.close();
    logicalMemory.close();
    throughput.close();
    latency.close();
  }

  function startListener(slot: number): ListenerState {
    let markReady: (() => void) | undefined;
    let markFailed: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolvePromise, reject) => {
      markReady = resolvePromise;
      markFailed = reject;
    });
    let initial = true;
    const unsubscribe = listenerDocument(slot).onSnapshot(
      (snapshot) => {
        const sequence = Number(snapshot.get("sequence") ?? 0);
        const token = String(snapshot.get("operationToken") ?? "");
        const previous = listenerObserved[slot] ?? 0;
        if (!initial && sequence < previous) {
          listenerMismatches += 1;
          errors.json(event("listener-regression", { slot, previous, sequence }));
        }
        listenerObserved[slot] = Math.max(previous, sequence);
        const sentAt = listenerPending.get(token);
        if (sentAt !== undefined) {
          const observedLatency = performance.now() - sentAt;
          listenerLatencies.push(observedLatency);
          intervalListenerLatencies.push(observedLatency);
          listenerPending.delete(token);
        }
        initial = false;
        markReady?.();
        markReady = undefined;
      },
      (error) => {
        failed += 1;
        intervalFailed += 1;
        errors.json(event("listener-error", { slot, message: error.message }));
        markFailed?.(error);
        markFailed = undefined;
      },
    );
    return { unsubscribe, ready };
  }

  async function churnListener(): Promise<void> {
    if (churnRunning || stopped) {
      return;
    }
    churnRunning = true;
    const slot = churnCount % manifest.soak.listeners.activeCount;
    try {
      listenerStates[slot]?.unsubscribe();
      const replacement = startListener(slot);
      listenerStates[slot] = replacement;
      await replacement.ready;
      churnCount += 1;
      events.json(event("listener-churn", { slot, churnCount }));
    } catch (error) {
      failed += 1;
      intervalFailed += 1;
      errors.json(event("listener-churn-error", { slot, message: errorMessage(error) }));
    } finally {
      churnRunning = false;
    }
  }

  async function scheduleOperation(index: number): Promise<void> {
    const startedAt = performance.now();
    const listenerSchedule = manifest.soak.targetSchedule.listenerDocument;
    const largeSchedule = manifest.soak.targetSchedule.largeDocument;
    const transactionSchedule = manifest.soak.transactionSchedule;
    const isListener = index % listenerSchedule.modulus === listenerSchedule.remainder;
    const isLarge = index % largeSchedule.modulus === largeSchedule.remainder;
    const isTransaction =
      index % transactionSchedule.modulus === transactionSchedule.remainder;
    const sequence = index + 1;
    const token = `${kind}-${String(sequence)}`;
    let listenerSlot: number | undefined;
    try {
      if (isListener) {
        listenerSlot = Math.floor(index / listenerSchedule.modulus)
          % manifest.soak.listeners.activeCount;
        listenerPending.set(token, startedAt);
        const prior = listenerChains[listenerSlot] ?? Promise.resolve();
        const chained = prior.then(async () => {
          await listenerDocument(listenerSlot!).set(
            documentFields(sequence, token, "listener", payloads.small),
          );
        });
        listenerChains[listenerSlot] = chained.catch(() => undefined);
        await chained;
        listenerExpected[listenerSlot] = sequence;
      } else if (isLarge) {
        const ordinal = Math.floor(index / largeSchedule.modulus)
          % manifest.soak.workingSet.largeDocumentCount;
        const size = manifest.soak.workingSet.largeDocumentSizesBytes[
          ordinal % manifest.soak.workingSet.largeDocumentSizesBytes.length
        ];
        if (size === undefined) {
          throw new Error("large payload schedule is empty");
        }
        await collection.doc(documentId(manifest.soak.workingSet.smallDocumentCount + ordinal))
          .set(documentFields(sequence, token, "large", requiredPayload(payloads.large, size)));
      } else if (isTransaction) {
        const ordinal = manifest.soak.listeners.activeCount
          + (Math.floor(index / transactionSchedule.modulus)
            % transactionSchedule.hotDocumentCount);
        const document = collection.doc(documentId(ordinal));
        await firestore.runTransaction(
          async (transaction) => {
            transactionAttempts += 1;
            intervalTransactionAttempts += 1;
            await transaction.get(document);
            transaction.set(
              document,
              documentFields(sequence, token, "transaction", payloads.small),
            );
          },
          { maxAttempts: transactionSchedule.maxAttempts },
        );
      } else {
        const ordinaryStart = manifest.soak.listeners.activeCount
          + transactionSchedule.hotDocumentCount;
        const ordinaryCount = manifest.soak.workingSet.smallDocumentCount - ordinaryStart;
        const ordinal = ordinaryStart + ((index * 48_271) % ordinaryCount);
        await collection.doc(documentId(ordinal)).set(
          documentFields(sequence, token, "small", payloads.small),
        );
      }
      const observedLatency = performance.now() - startedAt;
      writeLatencies.push(observedLatency);
      intervalWriteLatencies.push(observedLatency);
      completed += 1;
      intervalCompleted += 1;
      lastCompletionAt = Date.now();
      stallOpen = false;
    } catch (error) {
      if (listenerSlot !== undefined) {
        listenerPending.delete(token);
      }
      failed += 1;
      intervalFailed += 1;
      errors.json(event("write-error", { index, message: errorMessage(error) }));
    }
  }

  async function recordRss(): Promise<void> {
    if (measurementStart === 0) {
      return;
    }
    try {
      const [sample, accounting] = await Promise.all([
        sampleProcess(server.pid),
        kind === "java" ? Promise.resolve(undefined) : sampleLogicalMemory(server),
      ]);
      const elapsedSeconds = (Date.now() - measurementStart) / 1_000;
      rssSamples.push({ elapsedSeconds, rssBytes: sample.rssBytes });
      const timestamp = new Date().toISOString();
      rss.write([
        timestamp,
        elapsedSeconds,
        sample.rssBytes,
        sample.peakRssBytes,
        sample.processSwapBytes,
        sample.pssBytes,
        sample.anonymousBytes,
        sample.privateCleanBytes,
        sample.privateDirtyBytes,
        sample.sharedCleanBytes,
        sample.sharedDirtyBytes,
        sample.lazyFreeBytes,
        sample.anonymousHugePagesBytes,
        sample.systemAvailableBytes,
        sample.systemSwapUsedBytes,
        sample.loadOne,
      ].join(","));
      if (accounting !== undefined) {
        logicalMemory.json({ timestamp, elapsedSeconds, ...accounting });
      }
      if (kind !== "java" && failFastSlopeFailure === undefined) {
        const rule = manifest.soak.memory.failFast;
        const observedBytesPerHour = sustainedWindowTheilSenBytesPerHour(
          rssSamples,
          manifest.soak.warmupSeconds,
          rule.sustainedWindowSeconds,
        );
        const maximumBytesPerHour = manifest.soak.memory.maximumRssSlopeBytesPerHour
          * rule.maximumSlopeMultiple;
        if (
          observedBytesPerHour !== null
          && observedBytesPerHour > maximumBytesPerHour
        ) {
          failFastSlopeFailure = {
            elapsedSeconds,
            observedBytesPerHour,
            maximumBytesPerHour,
            sustainedWindowSeconds: rule.sustainedWindowSeconds,
          };
          stopped = true;
          events.json(event("rss-slope-fail-fast", { ...failFastSlopeFailure }));
        }
      }
    } catch (error) {
      failed += 1;
      intervalFailed += 1;
      errors.json(event("rss-sample-error", { message: errorMessage(error) }));
    }
  }

  function queueRss(): void {
    rssRecording = rssRecording.then(recordRss);
  }

  function recordRollup(): void {
    if (measurementStart === 0) {
      return;
    }
    const elapsedSeconds = (Date.now() - measurementStart) / 1_000;
    throughput.write([
      new Date().toISOString(),
      elapsedSeconds,
      scheduled,
      completed,
      failed,
      intervalCompleted,
      intervalFailed,
      transactionAttempts,
      intervalTransactionAttempts,
    ].join(","));
    latency.write([
      new Date().toISOString(),
      elapsedSeconds,
      ...latencyCsv(intervalWriteLatencies),
      ...latencyCsv(intervalListenerLatencies),
    ].join(","));
    intervalCompleted = 0;
    intervalFailed = 0;
    intervalTransactionAttempts = 0;
    intervalWriteLatencies = [];
    intervalListenerLatencies = [];
  }

  function recordStall(): void {
    if (scheduled <= completed + failed || stopped) {
      return;
    }
    const noProgressMilliseconds = Date.now() - lastCompletionAt;
    if (
      noProgressMilliseconds >= manifest.soak.progress.maximumNoCompletionSeconds * 1_000
      && !stallOpen
    ) {
      stallOpen = true;
      stallEvents += 1;
      stalls.json(event("no-progress", {
        noProgressMilliseconds,
        scheduled,
        completed,
        failed,
      }));
    }
  }

  async function waitForListenerConvergence(): Promise<void> {
    const deadline = Date.now() + manifest.soak.listeners.finalDrainSeconds * 1_000;
    while (Date.now() < deadline) {
      if (listenerExpected.every((expected, slot) => listenerObserved[slot] === expected)) {
        return;
      }
      await delay(100);
    }
  }

  function listenerDocument(slot: number) {
    const ordinal = manifest.soak.workingSet.listenerDocumentIndexes[slot];
    if (ordinal === undefined) {
      throw new Error(`listener slot ${String(slot)} has no frozen document index`);
    }
    return collection.doc(documentId(ordinal));
  }
}

async function sampleLogicalMemory(
  server: ServerHandle,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://${server.host}:${String(server.port)}/emulator/v1/debug/memory`,
  );
  if (!response.ok) {
    throw new Error(`logical-memory endpoint returned HTTP ${String(response.status)}`);
  }
  const accounting: unknown = await response.json();
  if (
    typeof accounting !== "object"
    || accounting === null
    || Reflect.get(accounting, "schemaVersion") !== 3
  ) {
    throw new Error("logical-memory endpoint returned an unsupported schema");
  }
  return accounting as Record<string, unknown>;
}

async function seedWorkingSet(
  firestore: Firestore,
  manifest: EnduranceManifest,
  payloads: PayloadBuffers,
): Promise<void> {
  const writer = firestore.bulkWriter({ throttling: false });
  let writerError: Error | undefined;
  writer.onWriteError((error) => {
    writerError = error;
    return false;
  });
  const collection = firestore.collection(manifest.soak.workingSet.collection);
  const pending: Promise<void>[] = [];
  let pendingPayloadBytes = 0;
  for (let ordinal = 0; ordinal < manifest.soak.workingSet.documentCount; ordinal += 1) {
    const isLarge = ordinal >= manifest.soak.workingSet.smallDocumentCount;
    const payload = isLarge
      ? largePayloadForOrdinal(manifest, payloads, ordinal)
      : payloads.small;
    if (
      pending.length > 0
      && pendingPayloadBytes + payload.length > MAXIMUM_SEED_BATCH_PAYLOAD_BYTES
    ) {
      await drainPendingWrites();
    }
    const write = writer.set(
      collection.doc(documentId(ordinal)),
      documentFields(0, "seed", isLarge ? "large" : "small", payload),
    ).then(
      () => undefined,
      (error: unknown) => {
        writerError = error instanceof Error ? error : new Error(String(error));
      },
    );
    pending.push(write);
    pendingPayloadBytes += payload.length;
    if (pending.length >= manifest.soak.workingSet.seedBatchSize) {
      await drainPendingWrites();
    }
    if (writerError !== undefined) {
      throw writerError;
    }
  }
  await drainPendingWrites();
  await writer.close();
  if (writerError !== undefined) {
    throw writerError;
  }

  async function drainPendingWrites(): Promise<void> {
    await writer.flush();
    await Promise.all(pending.splice(0));
    pendingPayloadBytes = 0;
    if (writerError !== undefined) {
      throw writerError;
    }
  }
}

interface PayloadBuffers {
  readonly small: Buffer;
  readonly large: ReadonlyMap<number, Buffer>;
}

function payloadBuffers(manifest: EnduranceManifest): PayloadBuffers {
  return {
    small: Buffer.alloc(manifest.soak.workingSet.smallPayloadBytes, 0x73),
    large: new Map(
      manifest.soak.workingSet.largeDocumentSizesBytes.map((size) => [
        size,
        Buffer.alloc(size, 0x4c),
      ]),
    ),
  };
}

function largePayloadForOrdinal(
  manifest: EnduranceManifest,
  payloads: PayloadBuffers,
  ordinal: number,
): Buffer {
  const largeOrdinal = ordinal - manifest.soak.workingSet.smallDocumentCount;
  const sizes = manifest.soak.workingSet.largeDocumentSizesBytes;
  const size = sizes[largeOrdinal % sizes.length];
  if (size === undefined) {
    throw new Error("large document size schedule is empty");
  }
  return requiredPayload(payloads.large, size);
}

function requiredPayload(payloads: ReadonlyMap<number, Buffer>, size: number): Buffer {
  const payload = payloads.get(size);
  if (payload === undefined) {
    throw new Error(`missing frozen ${String(size)}-byte payload`);
  }
  return payload;
}

function documentFields(
  sequence: number,
  operationToken: string,
  kind: string,
  payload: Buffer,
): Record<string, unknown> {
  return { kind, operationToken, payload, sequence };
}

function documentId(ordinal: number): string {
  return `document-${String(ordinal).padStart(6, "0")}`;
}

function latencySummary(values: readonly number[]): Record<string, number | null> {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: maximum(values),
  };
}

function latencyCsv(values: readonly number[]): Array<number | string> {
  return [
    values.length,
    csvNumber(percentile(values, 0.5)),
    csvNumber(percentile(values, 0.95)),
    csvNumber(percentile(values, 0.99)),
    maximum(values) ?? "",
  ];
}

function csvNumber(value: number | null): number | string {
  return value ?? "";
}

function maximum(values: readonly number[]): number | null {
  let maximumValue: number | null = null;
  for (const value of values) {
    maximumValue = maximumValue === null ? value : Math.max(maximumValue, value);
  }
  return maximumValue;
}

function clearOptionalInterval(timer: NodeJS.Timeout | undefined): void {
  if (timer !== undefined) {
    clearInterval(timer);
  }
}

function requiredFile(files: Record<string, string>, name: string): string {
  const path = files[name];
  if (path === undefined) {
    throw new Error(`manifest does not define telemetry file ${name}`);
  }
  return path;
}

function event(type: string, details: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: new Date().toISOString(), type, ...details };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function delayUntil(timestamp: number): Promise<void> {
  const milliseconds = timestamp - Date.now();
  if (milliseconds > 0) {
    await delay(milliseconds);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
