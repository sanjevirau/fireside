import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Firestore } from "@google-cloud/firestore";

import {
  assertPhase5Manifest,
  PHASE5_MANIFEST_SHA256,
  type Phase5Manifest,
} from "./phase5-acceptance-plan.ts";

type StackName = "official" | "fireside";

interface Arguments {
  readonly firesideDirectory: string;
  readonly officialDirectory: string;
  readonly output: string;
  readonly projectId: string;
  readonly smoke: boolean;
  readonly stack: StackName;
}

interface StackPorts {
  readonly firestore: number;
  readonly functions: number;
  readonly storage: number;
}

interface StackDefinition {
  readonly directory: string;
  readonly name: StackName;
  readonly ports: StackPorts;
}

interface FunctionTrigger {
  readonly entryPoint?: string;
  readonly id?: string;
  readonly region?: string;
}

interface Backend {
  readonly functionTriggers?: readonly FunctionTrigger[];
}

interface Tracker {
  duplicates: number;
  readonly expected: Set<string>;
  readonly expectedLatest: Map<string, string>;
  readonly listenerLatencyMilliseconds: number[];
  readonly seen: Set<string>;
}

interface Session {
  readonly client: Firestore;
  readonly eventsPath: string;
  readonly index: number;
  readonly ready: Promise<void>;
  readonly tracker: Tracker;
  readonly unsubscribe: () => void;
}

interface WorkloadCounts {
  catalogReads: number;
  functionDispatches: number;
  gatewayWrites: number;
  runAndCaseWrites: number;
  storageCycles: number;
  tokenBatches: number;
  tokenWrites: number;
}

interface RuntimeMetrics {
  acknowledgedStateMismatches: number;
  readonly catalogLatencyMilliseconds: number[];
  readonly counts: WorkloadCounts;
  readonly errorHashes: Set<string>;
  readonly functionLatencyMilliseconds: number[];
  readonly storageLatencyMilliseconds: number[];
  stalls: number;
  readonly writeLatencyMilliseconds: number[];
}

interface StackRuntime {
  readonly abort: AbortController;
  readonly definition: StackDefinition;
  readonly functionTrigger: FunctionTrigger;
  readonly marker: string;
  readonly metrics: RuntimeMetrics;
  readonly sessions: readonly Session[];
}

interface ProcessMetric {
  readonly command: string;
  readonly pid: number;
  readonly pssBytes: number | null;
  readonly rssBytes: number;
}

interface MemorySample {
  readonly capturedAt: string;
  readonly elapsedMilliseconds: number;
  readonly host: {
    readonly swapFreeBytes: number;
    readonly swapInPages: number;
    readonly swapOutPages: number;
    readonly swapTotalBytes: number;
  };
  readonly stacks: Readonly<Partial<Record<StackName, {
    readonly processCount: number;
    readonly processes: readonly ProcessMetric[];
    readonly pssBytes: number | null;
    readonly rssBytes: number;
  }>>>;
}

interface HealthEvidence {
  readonly failedUnits: number;
  readonly oomOrResourceEvidence: number;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const conformanceDirectory = path.join(repositoryRoot, "conformance");
const manifestPath = path.join(
  repositoryRoot,
  "benchmarks",
  "phase-5-twodart-acceptance.json",
);
const sessionCount = 2;
const tokenSlots = 20;
const memorySamples: MemorySample[] = [];

await main();

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await requireAbsent(args.output);
  await mkdir(path.dirname(args.output), { recursive: true });

  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Phase5Manifest;
  assertPhase5Manifest(manifest, manifestBytes);
  const durationSeconds = args.smoke
    ? manifest.diagnosticSmoke.shortSoakSecondsPerStack
    : manifest.soak.durationSeconds;
  const definitions = stackDefinitions(args, manifest);
  const startedAt = new Date().toISOString();
  const healthBefore = await captureHealth();
  const runtimes: StackRuntime[] = [];
  const sharedAbort = new AbortController();
  let primaryError: unknown;

  try {
    for (const definition of definitions) {
      runtimes.push(await prepareStack(definition, args.projectId, sharedAbort));
    }
    await withTimeout(
      Promise.all(runtimes.flatMap((runtime) => runtime.sessions.map(({ ready }) => ready))),
      60_000,
      "Phase 5 listeners did not become ready",
    );

    const scheduleStartedAt = Date.now() + 2_000;
    const workers = runtimes.flatMap((runtime) =>
      runtime.sessions.flatMap((session) =>
        sessionWorkers(runtime, session, args.projectId, manifest, durationSeconds, scheduleStartedAt),
      ),
    );
    workers.push(
      sampleMemory(
        definitions,
        manifest,
        durationSeconds,
        scheduleStartedAt,
        runtimes.map(({ abort }) => abort.signal),
      ),
    );
    const settled = await Promise.allSettled(workers);
    const failed = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && !isAbortError(result.reason),
    );
    if (failed !== undefined) throw failed.reason;

    for (const runtime of runtimes) {
      await waitForListenerDelivery(runtime, 120_000);
      await verifyLatestState(runtime);
    }
  } catch (error: unknown) {
    primaryError = error;
    for (const runtime of runtimes) runtime.abort.abort();
  }

  const cleanupFailures: string[] = [];
  for (const runtime of runtimes) {
    for (const session of runtime.sessions) session.unsubscribe();
    try {
      await cleanupRuntime(runtime, args.projectId);
    } catch (error: unknown) {
      cleanupFailures.push(digest(errorText(error)));
    }
    await Promise.all(
      runtime.sessions.map(async ({ client }) => {
        await client.terminate();
      }),
    );
  }

  const healthAfter = await captureHealth();
  const summaries = Object.fromEntries(
    runtimes.map((runtime) => [runtime.definition.name, summarizeRuntime(runtime)]),
  );
  const expected = expectedCounts(manifest, durationSeconds);
  const gateFailures = validateGate(
    runtimes,
    expected,
    healthBefore,
    healthAfter,
    cleanupFailures,
    manifest,
    args.smoke,
  );
  if (primaryError !== undefined) gateFailures.unshift(digest(errorText(primaryError)));
  const passed = gateFailures.length === 0;
  const evidence = {
    candidateIdentityStored: false,
    completedAt: new Date().toISOString(),
    datasetIdentityStored: false,
    durationSeconds,
    expected,
    failureHashes: [...new Set(gateFailures)].sort(),
    health: { after: healthAfter, before: healthBefore },
    manifestSha256: PHASE5_MANIFEST_SHA256,
    memory: summarizeMemory(definitions),
    privateContentStored: false,
    projectId: args.projectId,
    raw: {
      memorySamples,
      stacks: Object.fromEntries(
        runtimes.map((runtime) => [runtime.definition.name, rawRuntime(runtime)]),
      ),
    },
    schemaVersion: 1,
    smoke: args.smoke,
    swapActivity: summarizeSwapActivity(),
    stack: args.stack,
    stacks: summaries,
    startedAt,
    syntheticIdentifiersStored: false,
    userIdentityStored: false,
    passed,
  };
  await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (!passed) {
    throw new Error(`Phase 5 soak failed; see ${args.output}`);
  }
}

async function prepareStack(
  definition: StackDefinition,
  projectId: string,
  abort: AbortController,
): Promise<StackRuntime> {
  const response = await fetch(
    `http://127.0.0.1:${String(definition.ports.functions)}/backends`,
  );
  if (!response.ok) {
    throw new Error(`${definition.name} function inventory returned ${String(response.status)}`);
  }
  const inventory = (await response.json()) as { readonly backends?: readonly Backend[] };
  const triggers = (inventory.backends ?? []).flatMap(
    ({ functionTriggers }) => functionTriggers ?? [],
  );
  const matches = triggers.filter(
    ({ entryPoint }) => entryPoint === "onWriteInitiateCheckoutSession",
  );
  if (matches.length !== 1 || matches[0]?.id === undefined) {
    throw new Error(`${definition.name} omitted the safe Twodart function trigger`);
  }

  const marker = randomUUID();
  const metrics: RuntimeMetrics = {
    acknowledgedStateMismatches: 0,
    catalogLatencyMilliseconds: [],
    counts: emptyCounts(),
    errorHashes: new Set<string>(),
    functionLatencyMilliseconds: [],
    stalls: 0,
    storageLatencyMilliseconds: [],
    writeLatencyMilliseconds: [],
  };
  const sessions = Array.from({ length: sessionCount }, (_, index) =>
    createSession(definition, projectId, marker, index, abort, metrics),
  );
  return {
    abort,
    definition,
    functionTrigger: matches[0],
    marker,
    metrics,
    sessions,
  };
}

function createSession(
  definition: StackDefinition,
  projectId: string,
  marker: string,
  index: number,
  abort: AbortController,
  metrics: RuntimeMetrics,
): Session {
  const client = new Firestore({
    host: `127.0.0.1:${String(definition.ports.firestore)}`,
    projectId,
    ssl: false,
  });
  const eventsPath = `__fireside_phase5_soak/${marker}/sessions/session-${String(index)}/events`;
  const tracker: Tracker = {
    duplicates: 0,
    expected: new Set<string>(),
    expectedLatest: new Map<string, string>(),
    listenerLatencyMilliseconds: [],
    seen: new Set<string>(),
  };
  let ready = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const unsubscribe = client.collection(eventsPath).onSnapshot(
    (snapshot) => {
      if (!ready) {
        ready = true;
        resolveReady();
      }
      for (const change of snapshot.docChanges()) {
        const data = change.doc.data();
        if (data.marker !== marker || typeof data.deliveryKey !== "string") continue;
        const key = data.deliveryKey;
        if (!tracker.expected.has(key)) continue;
        if (tracker.seen.has(key)) {
          tracker.duplicates += 1;
          continue;
        }
        tracker.seen.add(key);
        if (typeof data.sentAtMs === "number") {
          tracker.listenerLatencyMilliseconds.push(Math.max(0, Date.now() - data.sentAtMs));
        }
      }
    },
    (error) => {
      metrics.errorHashes.add(digest(errorText(error)));
      if (!ready) rejectReady(error);
      abort.abort();
    },
  );
  return {
    client,
    eventsPath,
    index,
    ready: readyPromise,
    tracker,
    unsubscribe,
  };
}

function sessionWorkers(
  runtime: StackRuntime,
  session: Session,
  projectId: string,
  manifest: Phase5Manifest,
  durationSeconds: number,
  startedAt: number,
): Promise<void>[] {
  const workload = manifest.soak.workload;
  return [
    scheduledWorker(
      runtime,
      durationSeconds,
      workload.tokenBatch.intervalSecondsPerSession,
      startedAt,
      async (cycle) => tokenBatch(runtime, session, cycle),
    ),
    scheduledWorker(
      runtime,
      durationSeconds,
      workload.gatewayJob.intervalSecondsPerSession,
      startedAt,
      async (cycle) => eventWrite(runtime, session, "gateway", "gateway", cycle),
    ),
    scheduledWorker(
      runtime,
      durationSeconds,
      workload.runAndCaseStatus.intervalSecondsPerSession,
      startedAt,
      async (cycle) => {
        const kind = cycle % 2 === 0 ? "run-status" : "case-status";
        await eventWrite(runtime, session, kind, "status", cycle);
      },
    ),
    scheduledWorker(
      runtime,
      durationSeconds,
      workload.catalogRead.intervalSecondsPerSession,
      startedAt,
      async () => catalogRead(runtime, session),
    ),
    scheduledWorker(
      runtime,
      durationSeconds,
      workload.storageCycle.intervalSecondsPerSession,
      startedAt,
      async (cycle) => storageCycle(runtime, session, projectId, cycle, workload.storageCycle.payloadBytes),
    ),
    scheduledWorker(
      runtime,
      durationSeconds,
      workload.twodartFunctionTrigger.intervalSecondsPerSession,
      startedAt,
      async (cycle) => functionDispatch(runtime, session, projectId, cycle),
    ),
  ];
}

async function scheduledWorker(
  runtime: StackRuntime,
  durationSeconds: number,
  intervalSeconds: number,
  startedAt: number,
  operation: (cycle: number) => Promise<void>,
): Promise<void> {
  const cycles = Math.floor(durationSeconds / intervalSeconds);
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const target = startedAt + cycle * intervalSeconds * 1_000;
    await sleepUntil(target, runtime.abort.signal);
    const lateBy = Date.now() - target;
    if (lateBy >= intervalSeconds * 1_000) runtime.metrics.stalls += 1;
    const operationStarted = performance.now();
    try {
      await operation(cycle);
    } catch (error: unknown) {
      runtime.metrics.errorHashes.add(digest(errorText(error)));
      runtime.abort.abort();
      throw error;
    }
    if (performance.now() - operationStarted >= intervalSeconds * 1_000) {
      runtime.metrics.stalls += 1;
    }
  }
}

async function tokenBatch(
  runtime: StackRuntime,
  session: Session,
  cycle: number,
): Promise<void> {
  const batch = session.client.batch();
  const sentAtMs = Date.now();
  for (let slot = 0; slot < tokenSlots; slot += 1) {
    const deliveryKey = `token:${String(cycle)}:${String(slot)}`;
    const documentId = `token-${String(slot).padStart(2, "0")}`;
    expectDelivery(session, documentId, deliveryKey);
    batch.set(session.client.doc(`${session.eventsPath}/${documentId}`), {
      deliveryKey,
      kind: "token",
      marker: runtime.marker,
      sequence: cycle,
      sentAtMs,
      slot,
      value: `synthetic-token-${String(cycle)}-${String(slot)}`,
    });
  }
  const started = performance.now();
  await batch.commit();
  runtime.metrics.writeLatencyMilliseconds.push(performance.now() - started);
  runtime.metrics.counts.tokenBatches += 1;
  runtime.metrics.counts.tokenWrites += tokenSlots;
}

async function eventWrite(
  runtime: StackRuntime,
  session: Session,
  kind: string,
  documentId: string,
  cycle: number,
): Promise<void> {
  const deliveryKey = `${kind}:${String(cycle)}`;
  expectDelivery(session, documentId, deliveryKey);
  const started = performance.now();
  await session.client.doc(`${session.eventsPath}/${documentId}`).set({
    deliveryKey,
    kind,
    marker: runtime.marker,
    sequence: cycle,
    sentAtMs: Date.now(),
    state: cycle % 2 === 0 ? "running" : "complete",
  });
  runtime.metrics.writeLatencyMilliseconds.push(performance.now() - started);
  if (kind === "gateway") runtime.metrics.counts.gatewayWrites += 1;
  else runtime.metrics.counts.runAndCaseWrites += 1;
}

function expectDelivery(session: Session, documentId: string, key: string): void {
  session.tracker.expected.add(key);
  session.tracker.expectedLatest.set(documentId, key);
}

async function catalogRead(runtime: StackRuntime, session: Session): Promise<void> {
  const started = performance.now();
  const snapshot = await session.client.collection("premade-templates").limit(1).get();
  if (snapshot.empty) throw new Error("Twodart catalog read returned no premade templates");
  runtime.metrics.catalogLatencyMilliseconds.push(performance.now() - started);
  runtime.metrics.counts.catalogReads += 1;
}

async function storageCycle(
  runtime: StackRuntime,
  session: Session,
  projectId: string,
  cycle: number,
  payloadBytes: number,
): Promise<void> {
  const bucket = `${projectId}.appspot.com`;
  const objectName = `phase5-soak/${runtime.marker}/session-${String(session.index)}/cycle-${String(cycle)}.bin`;
  const encodedBucket = encodeURIComponent(bucket);
  const encodedObject = encodeURIComponent(objectName);
  const origin = `http://127.0.0.1:${String(runtime.definition.ports.storage)}`;
  const bytes = deterministicPayload(payloadBytes, session.index, cycle);
  const headers = {
    Authorization: "Bearer owner",
    "content-type": "application/octet-stream",
  };
  const started = performance.now();
  const upload = await fetch(
    `${origin}/upload/storage/v1/b/${encodedBucket}/o?uploadType=media&name=${encodedObject}`,
    { body: new Uint8Array(bytes), headers, method: "POST" },
  );
  await requireResponse(upload, "storage upload", 200);
  const metadata = await fetch(
    `${origin}/storage/v1/b/${encodedBucket}/o/${encodedObject}`,
    { headers: { Authorization: "Bearer owner" } },
  );
  await requireResponse(metadata, "storage metadata", 200);
  const metadataBody = (await metadata.json()) as { readonly size?: string };
  if (Number(metadataBody.size) !== payloadBytes) {
    throw new Error(`storage metadata size mismatch: ${String(metadataBody.size)}`);
  }
  const download = await fetch(
    `${origin}/download/storage/v1/b/${encodedBucket}/o/${encodedObject}?alt=media`,
    { headers: { Authorization: "Bearer owner" } },
  );
  await requireResponse(download, "storage download", 200);
  const downloaded = Buffer.from(await download.arrayBuffer());
  if (!downloaded.equals(bytes)) throw new Error("storage download bytes diverged");
  const deletion = await fetch(
    `${origin}/storage/v1/b/${encodedBucket}/o/${encodedObject}`,
    { headers: { Authorization: "Bearer owner" }, method: "DELETE" },
  );
  await requireResponse(deletion, "storage delete", 200, 204);
  runtime.metrics.storageLatencyMilliseconds.push(performance.now() - started);
  runtime.metrics.counts.storageCycles += 1;
}

async function functionDispatch(
  runtime: StackRuntime,
  session: Session,
  projectId: string,
  cycle: number,
): Promise<void> {
  const trigger = runtime.functionTrigger;
  if (trigger.id === undefined) throw new Error("Twodart function trigger id is missing");
  const document = `licenses/phase5-soak/checkout_sessions/session-${String(session.index)}`;
  const body = await frozenV2DispatchBody();
  const started = performance.now();
  const response = await fetch(
    `http://127.0.0.1:${String(runtime.definition.ports.functions)}/functions/projects/${projectId}/triggers/${trigger.id}-0`,
    {
      body,
      headers: {
        "ce-database": "(default)",
        "ce-datacontenttype": "application/protobuf",
        "ce-dataschema": "https://github.com/googleapis/google-cloudevents/blob/main/proto/google/events/cloud/firestore/v1/data.proto",
        "ce-document": document,
        "ce-id": `phase5-${runtime.marker}-${String(session.index)}-${String(cycle)}`,
        "ce-location": trigger.region ?? "us-central1",
        "ce-namespace": "(default)",
        "ce-project": projectId,
        "ce-source": `//firestore.googleapis.com/projects/${projectId}/databases/(default)`,
        "ce-specversion": "1.0",
        "ce-subject": `documents/${document}`,
        "ce-time": new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString(),
        "ce-type": "google.cloud.firestore.document.v1.written",
        "content-type": "application/protobuf",
      },
      method: "POST",
    },
  );
  await requireResponse(response, "Twodart function dispatch", 200, 202, 204);
  runtime.metrics.functionLatencyMilliseconds.push(performance.now() - started);
  runtime.metrics.counts.functionDispatches += 1;
}

let frozenDispatchBody: string | undefined;

async function frozenV2DispatchBody(): Promise<string> {
  if (frozenDispatchBody !== undefined) return frozenDispatchBody;
  const fixture = JSON.parse(
    await readFile(
      path.join(
        conformanceDirectory,
        "fixtures",
        "firebase-suite-v1",
        "firestore-trigger-registration-and-v1-v2-dispatch",
        "fixture.json",
      ),
      "utf8",
    ),
  ) as {
    readonly dispatches?: readonly {
      readonly body?: string;
      readonly headers?: Readonly<Record<string, string>>;
    }[];
  };
  const dispatch = fixture.dispatches?.find(
    ({ headers }) => headers?.["ce-type"]?.startsWith("google.cloud.firestore") === true,
  );
  if (dispatch?.body === undefined || dispatch.body.length === 0) {
    throw new Error("frozen v2 dispatch fixture omitted its Base64 protobuf body");
  }
  frozenDispatchBody = dispatch.body;
  return dispatch.body;
}

async function sampleMemory(
  definitions: readonly StackDefinition[],
  manifest: Phase5Manifest,
  durationSeconds: number,
  startedAt: number,
  signals: readonly AbortSignal[],
): Promise<void> {
  const intervalMilliseconds = manifest.soak.memorySampleIntervalSeconds * 1_000;
  const sampleCount = Math.ceil(durationSeconds / manifest.soak.memorySampleIntervalSeconds);
  for (let index = 0; index < sampleCount; index += 1) {
    await sleepUntilAnyAbort(startedAt + index * intervalMilliseconds, signals);
    const stacks = Object.fromEntries(
      await Promise.all(
        definitions.map(async (definition) => {
          const processes = await stackProcessMetrics(definition.directory);
          if (processes.length === 0) {
            throw new Error(`no ${definition.name} stack processes were measurable`);
          }
          const pssAvailable = processes.every(({ pssBytes }) => pssBytes !== null);
          return [
            definition.name,
            {
              processCount: processes.length,
              processes,
              pssBytes: pssAvailable
                ? processes.reduce((total, metric) => total + (metric.pssBytes ?? 0), 0)
                : null,
              rssBytes: processes.reduce((total, { rssBytes }) => total + rssBytes, 0),
            },
          ] as const;
        }),
      ),
    ) as MemorySample["stacks"];
    memorySamples.push({
      capturedAt: new Date().toISOString(),
      elapsedMilliseconds: Date.now() - startedAt,
      host: await hostMemory(),
      stacks,
    });
  }
}

async function stackProcessMetrics(directory: string): Promise<ProcessMetric[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const processIds = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => Number(entry.name));
  const parents = new Map<number, number>();
  const roots = new Set<number>();
  const resolvedDirectory = path.resolve(directory);
  for (const pid of processIds) {
    try {
      const [cwd, statText] = await Promise.all([
        readlink(`/proc/${String(pid)}/cwd`),
        readFile(`/proc/${String(pid)}/stat`, "utf8"),
      ]);
      const closing = statText.lastIndexOf(")");
      const after = statText.slice(closing + 2).split(" ");
      const parent = Number(after[1]);
      if (Number.isInteger(parent)) parents.set(pid, parent);
      const resolvedCwd = path.resolve(cwd);
      if (
        resolvedCwd === resolvedDirectory ||
        resolvedCwd.startsWith(`${resolvedDirectory}${path.sep}`)
      ) {
        roots.add(pid);
      }
    } catch {
      // Processes may exit while /proc is scanned.
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) {
      if (roots.has(parent) && !roots.has(pid)) {
        roots.add(pid);
        changed = true;
      }
    }
  }
  const metrics = await Promise.all([...roots].map(async (pid) => processMetric(pid)));
  return metrics
    .filter((metric): metric is ProcessMetric => metric !== undefined)
    .sort((left, right) => left.pid - right.pid);
}

async function processMetric(pid: number): Promise<ProcessMetric | undefined> {
  try {
    const [command, status, smaps] = await Promise.all([
      readFile(`/proc/${String(pid)}/comm`, "utf8"),
      readFile(`/proc/${String(pid)}/status`, "utf8"),
      readFile(`/proc/${String(pid)}/smaps_rollup`, "utf8").catch(() => ""),
    ]);
    return {
      command: command.trim().slice(0, 64),
      pid,
      pssBytes: smaps.length === 0 ? null : statusKilobytes(smaps, "Pss") * 1_024,
      rssBytes: statusKilobytes(status, "VmRSS") * 1_024,
    };
  } catch {
    return undefined;
  }
}

function statusKilobytes(contents: string, label: string): number {
  const match = new RegExp(`^${label}:\\s+(\\d+)\\s+kB$`, "mu").exec(contents);
  if (match?.[1] === undefined) return 0;
  return Number(match[1]);
}

async function hostMemory(): Promise<MemorySample["host"]> {
  const [memory, virtualMemory] = await Promise.all([
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/vmstat", "utf8"),
  ]);
  return {
    swapFreeBytes: statusKilobytes(memory, "SwapFree") * 1_024,
    swapInPages: vmstatValue(virtualMemory, "pswpin"),
    swapOutPages: vmstatValue(virtualMemory, "pswpout"),
    swapTotalBytes: statusKilobytes(memory, "SwapTotal") * 1_024,
  };
}

function vmstatValue(contents: string, label: string): number {
  const match = new RegExp(`^${label}\\s+(\\d+)$`, "mu").exec(contents);
  return Number(match?.[1] ?? 0);
}

async function waitForListenerDelivery(
  runtime: StackRuntime,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (
    runtime.sessions.some(({ tracker }) => tracker.seen.size !== tracker.expected.size)
  ) {
    if (Date.now() >= deadline) return;
    await delay(100);
  }
}

async function verifyLatestState(runtime: StackRuntime): Promise<void> {
  for (const session of runtime.sessions) {
    const snapshot = await session.client.collection(session.eventsPath).get();
    const observed = new Map<string, string>();
    for (const document of snapshot.docs) {
      const data = document.data();
      if (typeof data.deliveryKey === "string") observed.set(document.id, data.deliveryKey);
    }
    for (const [documentId, expectedKey] of session.tracker.expectedLatest) {
      if (observed.get(documentId) !== expectedKey) {
        runtime.metrics.acknowledgedStateMismatches += 1;
      }
    }
  }
}

async function cleanupRuntime(runtime: StackRuntime, projectId: string): Promise<void> {
  for (const session of runtime.sessions) {
    const snapshot = await session.client.collection(session.eventsPath).get();
    for (let offset = 0; offset < snapshot.docs.length; offset += 500) {
      const batch = session.client.batch();
      for (const document of snapshot.docs.slice(offset, offset + 500)) batch.delete(document.ref);
      await batch.commit();
    }
    if (!(await session.client.collection(session.eventsPath).limit(1).get()).empty) {
      throw new Error(`${runtime.definition.name} Firestore cleanup left synthetic documents`);
    }
  }
  const origin = `http://127.0.0.1:${String(runtime.definition.ports.storage)}`;
  const bucket = encodeURIComponent(`${projectId}.appspot.com`);
  const prefix = encodeURIComponent(`phase5-soak/${runtime.marker}/`);
  const response = await fetch(
    `${origin}/storage/v1/b/${bucket}/o?prefix=${prefix}&maxResults=1000`,
    { headers: { Authorization: "Bearer owner" } },
  );
  await requireResponse(response, "storage cleanup verification", 200);
  const body = (await response.json()) as { readonly items?: readonly unknown[] };
  if ((body.items ?? []).length !== 0) {
    throw new Error(`${runtime.definition.name} Storage cleanup left synthetic objects`);
  }
}

function summarizeRuntime(runtime: StackRuntime): Record<string, unknown> {
  const listenerExpected = sum(runtime.sessions.map(({ tracker }) => tracker.expected.size));
  const listenerSeen = sum(runtime.sessions.map(({ tracker }) => tracker.seen.size));
  const duplicates = sum(runtime.sessions.map(({ tracker }) => tracker.duplicates));
  const listenerLatencies = runtime.sessions.flatMap(
    ({ tracker }) => tracker.listenerLatencyMilliseconds,
  );
  return {
    acknowledgedStateMismatches: runtime.metrics.acknowledgedStateMismatches,
    counts: runtime.metrics.counts,
    duplicateObservableEffects: duplicates,
    errors: runtime.metrics.errorHashes.size,
    listenerDelivery: {
      expected: listenerExpected,
      gaps: listenerExpected - listenerSeen,
      observed: listenerSeen,
    },
    latencyMilliseconds: {
      catalogRead: distribution(runtime.metrics.catalogLatencyMilliseconds),
      functionDelivery: distribution(runtime.metrics.functionLatencyMilliseconds),
      listenerDelivery: distribution(listenerLatencies),
      storageCycle: distribution(runtime.metrics.storageLatencyMilliseconds),
      writeCommit: distribution(runtime.metrics.writeLatencyMilliseconds),
    },
    sessions: runtime.sessions.length,
    stalls: runtime.metrics.stalls,
  };
}

function rawRuntime(runtime: StackRuntime): Record<string, unknown> {
  return {
    catalogLatencyMilliseconds: runtime.metrics.catalogLatencyMilliseconds,
    errorHashes: [...runtime.metrics.errorHashes].sort(),
    functionLatencyMilliseconds: runtime.metrics.functionLatencyMilliseconds,
    listenerLatencyMilliseconds: runtime.sessions.flatMap(
      ({ tracker }) => tracker.listenerLatencyMilliseconds,
    ),
    storageLatencyMilliseconds: runtime.metrics.storageLatencyMilliseconds,
    writeLatencyMilliseconds: runtime.metrics.writeLatencyMilliseconds,
  };
}

function expectedCounts(
  manifest: Phase5Manifest,
  durationSeconds: number,
): WorkloadCounts {
  const workload = manifest.soak.workload;
  const perBackend = (intervalSeconds: number): number =>
    Math.floor(durationSeconds / intervalSeconds) * sessionCount;
  const tokenBatches = perBackend(workload.tokenBatch.intervalSecondsPerSession);
  return {
    catalogReads: perBackend(workload.catalogRead.intervalSecondsPerSession),
    functionDispatches: perBackend(workload.twodartFunctionTrigger.intervalSecondsPerSession),
    gatewayWrites: perBackend(workload.gatewayJob.intervalSecondsPerSession),
    runAndCaseWrites: perBackend(workload.runAndCaseStatus.intervalSecondsPerSession),
    storageCycles: perBackend(workload.storageCycle.intervalSecondsPerSession),
    tokenBatches,
    tokenWrites: tokenBatches * workload.tokenBatch.writesPerBatch,
  };
}

function validateGate(
  runtimes: readonly StackRuntime[],
  expected: WorkloadCounts,
  healthBefore: HealthEvidence,
  health: HealthEvidence,
  cleanupFailures: readonly string[],
  manifest: Phase5Manifest,
  smoke: boolean,
): string[] {
  const failures: string[] = [...cleanupFailures];
  const swapActivity = summarizeSwapActivity();
  if (swapActivity.sampleCount < 2) {
    failures.push(digest(`swap-samples:${String(swapActivity.sampleCount)}`));
  }
  if (swapActivity.swapInPagesDelta !== 0) {
    failures.push(digest(`swap-in-pages:${String(swapActivity.swapInPagesDelta)}`));
  }
  if (swapActivity.swapOutPagesDelta !== 0) {
    failures.push(digest(`swap-out-pages:${String(swapActivity.swapOutPagesDelta)}`));
  }
  if (
    (!smoke && health.failedUnits !== manifest.soak.thresholds.failedUnits) ||
    (smoke && health.failedUnits !== healthBefore.failedUnits)
  ) {
    failures.push(digest(`failed-units:${String(health.failedUnits)}`));
  }
  if (
    (!smoke &&
      health.oomOrResourceEvidence !== manifest.soak.thresholds.oomOrResourceKills) ||
    (smoke && health.oomOrResourceEvidence !== healthBefore.oomOrResourceEvidence)
  ) {
    failures.push(digest(`oom-resource:${String(health.oomOrResourceEvidence)}`));
  }
  for (const runtime of runtimes) {
    const summary = summarizeRuntime(runtime);
    if (JSON.stringify(runtime.metrics.counts) !== JSON.stringify(expected)) {
      failures.push(digest(`${runtime.definition.name}:count-mismatch`));
    }
    if (runtime.metrics.errorHashes.size !== manifest.soak.thresholds.errors) {
      failures.push(...runtime.metrics.errorHashes);
    }
    if (runtime.metrics.stalls !== manifest.soak.thresholds.stalls) {
      failures.push(digest(`${runtime.definition.name}:stalls:${String(runtime.metrics.stalls)}`));
    }
    if (
      runtime.metrics.acknowledgedStateMismatches !==
      manifest.soak.thresholds.acknowledgedStateMismatches
    ) {
      failures.push(digest(`${runtime.definition.name}:acknowledged-state-mismatch`));
    }
    const listener = summary.listenerDelivery as {
      readonly gaps: number;
    };
    if (listener.gaps !== manifest.soak.thresholds.listenerGaps) {
      failures.push(digest(`${runtime.definition.name}:listener-gaps:${String(listener.gaps)}`));
    }
    const duplicates = runtime.sessions.reduce(
      (total, { tracker }) => total + tracker.duplicates,
      0,
    );
    if (duplicates !== manifest.soak.thresholds.duplicateObservableEffects) {
      failures.push(digest(`${runtime.definition.name}:duplicates:${String(duplicates)}`));
    }
  }
  if (
    !smoke &&
    memorySamples.length < manifest.soak.minimumSteadyMemorySamplesPerBackend
  ) {
    failures.push(digest(`memory-samples:${String(memorySamples.length)}`));
  }
  return failures;
}

function summarizeSwapActivity(): {
  readonly residualSwapBytesAtEnd: number | null;
  readonly residualSwapBytesAtStart: number | null;
  readonly sampleCount: number;
  readonly swapInPagesDelta: number | null;
  readonly swapOutPagesDelta: number | null;
} {
  const first = memorySamples[0]?.host;
  const last = memorySamples.at(-1)?.host;
  return {
    residualSwapBytesAtEnd:
      last === undefined ? null : last.swapTotalBytes - last.swapFreeBytes,
    residualSwapBytesAtStart:
      first === undefined ? null : first.swapTotalBytes - first.swapFreeBytes,
    sampleCount: memorySamples.length,
    swapInPagesDelta:
      first === undefined || last === undefined
        ? null
        : last.swapInPages - first.swapInPages,
    swapOutPagesDelta:
      first === undefined || last === undefined
        ? null
        : last.swapOutPages - first.swapOutPages,
  };
}

function summarizeMemory(
  definitions: readonly StackDefinition[],
): Readonly<Record<StackName, Record<string, unknown>>> {
  return Object.fromEntries(
    definitions.map((definition) => {
      const samples = memorySamples.map(({ elapsedMilliseconds, stacks }) => {
        const stack = stacks[definition.name];
        if (stack === undefined) {
          throw new Error(`Phase 5 memory sample omitted ${definition.name}`);
        }
        return {
          elapsedMilliseconds,
          pssBytes: stack.pssBytes,
          rssBytes: stack.rssBytes,
        };
      });
      const pss = samples
        .map(({ elapsedMilliseconds, pssBytes }) => ({ elapsedMilliseconds, value: pssBytes }))
        .filter(
          (sample): sample is { readonly elapsedMilliseconds: number; readonly value: number } =>
            sample.value !== null,
        );
      return [
        definition.name,
        {
          peakPssBytes: pss.length === samples.length
            ? maximum(pss.map(({ value }) => value))
            : null,
          peakRssBytes: maximum(samples.map(({ rssBytes }) => rssBytes)),
          pssSlopeBytesPerHour: pss.length === samples.length ? slopePerHour(pss) : null,
          rssSlopeBytesPerHour: slopePerHour(
            samples.map(({ elapsedMilliseconds, rssBytes }) => ({
              elapsedMilliseconds,
              value: rssBytes,
            })),
          ),
          samples: samples.length,
        },
      ] as const;
    }),
  ) as unknown as Readonly<Record<StackName, Record<string, unknown>>>;
}

function distribution(values: readonly number[]): Record<string, number | null> {
  if (values.length === 0) return { p50: null, p99: null, samples: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    samples: sorted.length,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function slopePerHour(
  values: readonly { readonly elapsedMilliseconds: number; readonly value: number }[],
): number | null {
  if (values.length < 2) return null;
  const xs = values.map(({ elapsedMilliseconds }) => elapsedMilliseconds / 3_600_000);
  const ys = values.map(({ value }) => value);
  const xMean = sum(xs) / xs.length;
  const yMean = sum(ys) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const x = xs[index] ?? 0;
    const y = ys[index] ?? 0;
    numerator += (x - xMean) * (y - yMean);
    denominator += (x - xMean) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

async function captureHealth(): Promise<HealthEvidence> {
  const [failed, journal] = await Promise.all([
    capture("systemctl", ["--failed", "--no-legend", "--plain"]),
    capture("journalctl", ["-b", "--no-pager"]),
  ]);
  if (failed.exitCode !== 0) throw new Error("systemctl failed-unit capture failed");
  if (journal.exitCode !== 0) throw new Error("current-boot journal capture failed");
  const failedUnits = failed.stdout.split("\n").filter((line) => line.trim().length > 0).length;
  const pattern = /out of memory|oom-kill|killed process|memory cgroup out of memory|resource temporarily unavailable|fork: retry/giu;
  return {
    failedUnits,
    oomOrResourceEvidence: [...journal.stdout.matchAll(pattern)].length,
  };
}

async function capture(command: string, arguments_: readonly string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stdout: `${stdout}${stderr}` });
    });
  });
}

async function requireResponse(
  response: Response,
  label: string,
  ...expectedStatuses: readonly number[]
): Promise<void> {
  if (!expectedStatuses.includes(response.status)) {
    const body = await response.text();
    throw new Error(`${label} returned ${String(response.status)}: ${body.slice(0, 512)}`);
  }
}

function deterministicPayload(bytes: number, session: number, cycle: number): Buffer {
  const output = Buffer.alloc(bytes);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = (index * 31 + session * 17 + cycle * 13) % 256;
  }
  return output;
}

function stackDefinitions(
  args: Arguments,
  manifest: Phase5Manifest,
): readonly StackDefinition[] {
  const ports = (name: StackName): StackPorts => {
    const block = manifest.stacks[name].portBlock;
    const required = (key: string): number => {
      const value = block[key];
      if (value === undefined) throw new Error(`Phase 5 ${name} port block omitted ${key}`);
      return value;
    };
    return {
      firestore: required("firestore"),
      functions: required("functions"),
      storage: required("storage"),
    };
  };
  return args.stack === "official"
    ? [{ directory: args.officialDirectory, name: "official", ports: ports("official") }]
    : [{ directory: args.firesideDirectory, name: "fireside", ports: ports("fireside") }];
}

function emptyCounts(): WorkloadCounts {
  return {
    catalogReads: 0,
    functionDispatches: 0,
    gatewayWrites: 0,
    runAndCaseWrites: 0,
    storageCycles: 0,
    tokenBatches: 0,
    tokenWrites: 0,
  };
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  let smoke = false;
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (key === "--smoke") {
      smoke = true;
      continue;
    }
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Phase 5 soak arguments must be --key value pairs plus optional --smoke");
    }
    parsed.set(key.slice(2), value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = parsed.get(key);
    if (value === undefined || value.length === 0) throw new Error(`--${key} is required`);
    return value;
  };
  const projectId = required("project-id");
  if (projectId !== "demo-twodart-local") {
    throw new Error("Phase 5 soak must use demo-twodart-local");
  }
  const stack = required("stack");
  if (stack !== "official" && stack !== "fireside") {
    throw new Error("Phase 5 soak --stack must be official or fireside");
  }
  return {
    firesideDirectory: path.resolve(required("fireside-dir")),
    officialDirectory: path.resolve(required("official-dir")),
    output: path.resolve(required("output")),
    projectId,
    smoke,
    stack,
  };
}

async function requireAbsent(file: string): Promise<void> {
  try {
    await access(file);
    throw new Error(`Refusing to overwrite Phase 5 evidence: ${file}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function sleepUntil(target: number, signal: AbortSignal): Promise<void> {
  while (Date.now() < target) {
    if (signal.aborted) throw abortError();
    await delay(Math.min(1_000, target - Date.now()));
  }
  if (signal.aborted) throw abortError();
}

async function sleepUntilAnyAbort(
  target: number,
  signals: readonly AbortSignal[],
): Promise<void> {
  while (Date.now() < target) {
    if (signals.some(({ aborted }) => aborted)) throw abortError();
    await delay(Math.min(1_000, target - Date.now()));
  }
  if (signals.some(({ aborted }) => aborted)) throw abortError();
}

function abortError(): Error {
  const error = new Error("Phase 5 soak aborted after a peer failure");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function maximum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}
