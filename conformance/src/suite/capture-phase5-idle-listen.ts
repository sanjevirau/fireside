/** Preparation-only on import. Live capture requires explicit loopback CLI arguments. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Firestore } from "@google-cloud/firestore";
import type { google } from "../../node_modules/@google-cloud/firestore/build/protos/firestore_v1_proto_api.js";
import { createV1Firestore } from "../target.ts";

const proto = createRequire(import.meta.url)("../../node_modules/@google-cloud/firestore/build/protos/firestore_v1_proto_api.js") as
  typeof import("../../node_modules/@google-cloud/firestore/build/protos/firestore_v1_proto_api.js");

const planUrl = new URL("../../fixtures/phase5/idle-listen-diagnostic-plan.json", import.meta.url);
const planBytes = readFileSync(planUrl);
export const idleListenPlan = JSON.parse(planBytes.toString()) as {
  highLevelSdkVersion: string; unrelatedDocuments: number; batchSize: number;
  cleanupBatchSize: number; maximumUnrelatedWriteSeconds: number;
  cases: Record<IdleListenCase, { unrelatedWrites: boolean; forceRawLoss: boolean }>;
  idleSecondsAfterWrites: number; initialObservationSeconds: number;
  reattachObservationSeconds: number; mutationObservationSeconds: number;
  rpcTimeoutMilliseconds: number; maximumScenarioSeconds: number;
  maximumCleanupSeconds: number; memorySampleMilliseconds: number; targetId: number;
};
const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
type RawClient = ReturnType<typeof createV1Firestore>;
type ListenStream = ReturnType<RawClient["listen"]>;
type Response = google.firestore.v1.IListenResponse;
type Write = google.firestore.v1.IWrite;
type RecordEvent = (kind: string, value: unknown) => void;
type IdleListenCase = "idle-control" | "churn-natural" | "churn-forced";

export interface IdleListenArguments {
  readonly host: string; readonly projectId: string; readonly stack: "official" | "fireside";
  readonly sdkRoot: string; readonly output: string; readonly caseName: IdleListenCase; readonly serverPid?: number;
}

export function parseIdleListenArguments(values: readonly string[]): IdleListenArguments {
  const entries = new Map<string, string>();
  const allowed = new Set(["host", "project-id", "stack", "case", "sdk-root", "output", "server-pid"]);
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i]?.replace(/^--/u, "");
    const value = values[i + 1];
    if (!values[i]?.startsWith("--") || name === undefined || !allowed.has(name) ||
        value === undefined || entries.has(name)) throw Error("Unique --name value arguments required");
    entries.set(name, value);
  }
  const required = (key: string): string => {
    const value = entries.get(key);
    if (!value) throw Error(`Missing --${key}`);
    return value;
  };
  const host = required("host");
  const port = /^127\.0\.0\.1:(\d+)$/u.exec(host)?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535) throw Error("Explicit 127.0.0.1:port required; no cloud/DNS endpoint");
  const projectId = required("project-id");
  if (!/^demo-[a-z0-9][a-z0-9-]{0,48}$/u.test(projectId)) throw Error("Synthetic demo- project required");
  const stack = required("stack");
  if (stack !== "official" && stack !== "fireside") throw Error("--stack must be official or fireside");
  const caseName = required("case");
  if (caseName !== "idle-control" && caseName !== "churn-natural" && caseName !== "churn-forced") throw Error("Unknown frozen diagnostic case");
  const sdkRoot = required("sdk-root");
  const output = required("output");
  if (![sdkRoot, output].every(value => path.isAbsolute(value) && !value.includes("\n"))) throw Error("Absolute SDK/output paths required");
  const pid = entries.get("server-pid");
  if (pid !== undefined && (!/^[1-9]\d*$/u.test(pid) || !Number.isSafeInteger(Number(pid)))) throw Error("Invalid server PID");
  return { host, projectId, stack, sdkRoot, output, caseName, ...(pid === undefined ? {} : { serverPid: Number(pid) }) };
}

export function resumeTokenBytes(value: string | Uint8Array | null | undefined): Buffer | null {
  if (value === null || value === undefined) return null;
  const bytes = typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);
  return bytes.length === 0 ? null : bytes;
}

export function decodeListenResponse(response: Response): Record<string, unknown> {
  return proto.google.firestore.v1.ListenResponse.toObject(
    proto.google.firestore.v1.ListenResponse.fromObject(response as Record<string, unknown>),
    { bytes: String, enums: String, longs: String, defaults: false },
  );
}

export function ownedDocumentNames(namespace: string): string[] {
  if (!/^_phase5_idle_listen\/[a-f0-9-]{36}$/u.test(namespace)) throw Error("Invalid owned namespace");
  return [namespace, `${namespace}/quiet/target`, ...Array.from(
    { length: idleListenPlan.unrelatedDocuments }, (_, i) => `${namespace}/unrelated/noise-${String(i).padStart(5, "0")}`,
  )];
}

export function procStartTicks(stat: string): string {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const value = fields[19];
  if (!value || !/^\d+$/u.test(value)) throw Error("Missing process start identity");
  return value;
}

type ListenPrototype = { listen: (...values: unknown[]) => Duplex };

/** Observe, but never manufacture, the high-level SDK's automatic reconnects. */
export function instrumentIdleSdkListen(prototype: ListenPrototype, options: {
  readonly prefix: string; readonly record: RecordEvent;
  readonly nextStreamId: () => number; readonly unexpectedDocument: () => void;
}): () => void {
  const originalListen = prototype.listen;
  prototype.listen = function (...values: unknown[]): Duplex {
    const stream = originalListen.apply(this, values);
    const streamId = options.nextStreamId();
    options.record("sdk-listen-open", { streamId });
    const originalWrite = stream.write;
    stream.write = function (...writeArgs: unknown[]): boolean {
      const request = writeArgs[0] as Record<string, unknown>;
      options.record("sdk-listen-request", { streamId, request: proto.google.firestore.v1.ListenRequest.toObject(
        proto.google.firestore.v1.ListenRequest.fromObject(request), { bytes: String, enums: String, longs: String, defaults: false },
      ) });
      return (originalWrite as (...args: unknown[]) => boolean).apply(this, writeArgs);
    };
    stream.on("data", (response: Response) => {
      const name = response.documentChange?.document?.name ?? response.documentDelete?.document ?? response.documentRemove?.document;
      if (name && !name.startsWith(options.prefix)) {
        options.record("sdk-unexpected-document-refused", { nameSha256: digest(name) });
        options.unexpectedDocument();
        return;
      }
      options.record("sdk-listen-response", { streamId, response: decodeListenResponse(response) });
    });
    stream.on("error", (error: unknown) => options.record("sdk-listen-error", { streamId, error: describeError(error) }));
    stream.on("end", () => options.record("sdk-listen-end", { streamId }));
    stream.on("close", () => options.record("sdk-listen-close", { streamId }));
    return stream;
  };
  return () => { prototype.listen = originalListen; };
}

function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return { message: String(error) };
  const value = error as Error & { code?: unknown; details?: unknown };
  return { name: value.name, message: value.message, code: value.code, details: value.details, stack: value.stack };
}

/** Freeze semantic reattachment outcomes independently of later lifecycle events. */
export function createIdleListenReattachObservation(
  recordOutcome: (outcome: "current" | "rejected-or-closed") => void,
): { observe(outcome: "current" | "rejected-or-closed"): void; close(): void } {
  let open = true;
  return {
    observe(outcome) { if (open) recordOutcome(outcome); },
    close() { open = false; },
  };
}

async function observeUntil(predicate: () => boolean, milliseconds: number, signal: AbortSignal): Promise<boolean> {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) return false;
    await delay(Math.min(50, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
  return true;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error(`${label} exceeded ${String(milliseconds)} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function sampleMemory(pid: number, signal: AbortSignal, record: RecordEvent): Promise<void> {
  try {
    const expected = procStartTicks(await readFile(`/proc/${String(pid)}/stat`, "utf8"));
    while (!signal.aborted) {
      const before = procStartTicks(await readFile(`/proc/${String(pid)}/stat`, "utf8"));
      const smaps = await readFile(`/proc/${String(pid)}/smaps_rollup`, "utf8");
      const after = procStartTicks(await readFile(`/proc/${String(pid)}/stat`, "utf8"));
      if (before !== expected || after !== expected) throw Error("Server PID identity changed; memory sampling stopped without signaling");
      if (signal.aborted) return;
      const bytes = (name: string): number => {
        const value = new RegExp(`^${name}:\\s+(\\d+) kB$`, "mu").exec(smaps)?.[1];
        if (value === undefined) throw Error(`Missing ${name} memory field`);
        return Number(value) * 1024;
      };
      record("server-memory", { pid, startTimeTicks: expected, rssBytes: bytes("Rss"), pssBytes: bytes("Pss"), nonAtomicSample: true });
      await delay(idleListenPlan.memorySampleMilliseconds, undefined, { signal });
    }
  } catch (error) { if (!signal.aborted) record("server-memory-unavailable", describeError(error)); }
}

export async function captureIdleListen(args: IdleListenArguments): Promise<boolean> {
  // Validate even programmatic calls; argument parsing alone is not the boundary.
  parseIdleListenArguments(["--host", args.host, "--project-id", args.projectId, "--stack", args.stack,
    "--case", args.caseName, "--sdk-root", args.sdkRoot, "--output", args.output,
    ...(args.serverPid === undefined ? [] : ["--server-pid", String(args.serverPid)])]);
  mkdirSync(args.output, { recursive: false, mode: 0o700 });
  const eventsPath = path.join(args.output, "events.jsonl");
  writeFileSync(eventsPath, "", { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(args.output, "plan.json"), planBytes, { flag: "wx" });
  const started = performance.now();
  let phase = "preparation";
  let sequence = 0;
  let sealed = false;
  const record: RecordEvent = (kind, value) => {
    if (!sealed) appendFileSync(eventsPath, JSON.stringify({
      sequence: ++sequence, at: new Date().toISOString(), elapsedMilliseconds: performance.now() - started, phase, kind, value,
    }) + "\n");
  };
  const changePhase = (name: string): void => { phase = name; record("phase", { name }); };
  const runId = randomUUID();
  const namespace = `_phase5_idle_listen/${runId}`;
  const names = ownedDocumentNames(namespace);
  const casePlan = idleListenPlan.cases[args.caseName];
  const database = `projects/${args.projectId}/databases/(default)`;
  const fullName = (name: string): string => `${database}/documents/${name}`;
  const targetName = `${namespace}/quiet/target`;
  const signal = new AbortController();
  const memorySignal = new AbortController();
  const watchdog = setTimeout(() => signal.abort(Error("Diagnostic scenario deadline exceeded")), idleListenPlan.maximumScenarioSeconds * 1000);
  const memory = args.serverPid === undefined ? Promise.resolve() : sampleMemory(args.serverPid, memorySignal.signal, record);
  let raw: RawClient | undefined;
  let high: Firestore | undefined;
  let unsubscribe: (() => void) | undefined;
  let restoreSdk: (() => void) | undefined;
  let reattachObservation: ReturnType<typeof createIdleListenReattachObservation> | undefined;
  const streams: ListenStream[] = [];
  let ownsNamespace = false;
  let scenarioCompleted = false;
  let cleanupCompleted = false;
  let failure: unknown = null;
  const observed = { rawInitial: false, rawInitialDocument: false, highInitial: false, rawReattachedCurrent: false,
    rawReattachRejectedOrClosed: false, rawMutationDelivered: false, highMutationDelivered: false,
    highErrors: 0, unrelatedDocumentsAcknowledged: 0, initialTokenBase64: null as string | null,
    latestTokenBase64: null as string | null, sdkListenStreams: 0 };
  const attempted = new Set<string>();
  const commit = async (writes: Write[], label: string, timeout = idleListenPlan.rpcTimeoutMilliseconds): Promise<void> => {
    assert.ok(raw);
    record("commit-request", { label, writes });
    try {
      const response = await bounded(raw.commit({ database, writes }, { timeout, retry: null }), timeout + 1000, label);
      record("commit-response", { label, response: JSON.parse(JSON.stringify(response[0])) as unknown });
    } catch (error) { record("commit-error", { label, error: describeError(error), acknowledgementUnknown: true }); throw error; }
  };
  const createWrite = (name: string, fields: Record<string, google.firestore.v1.IValue>): Write => ({
    update: { name: fullName(name), fields: { owner: { stringValue: runId }, ...fields } }, currentDocument: { exists: false },
  });
  try {
    const sdkRequire = createRequire(path.join(args.sdkRoot, "package.json"));
    const metadata = sdkRequire("./package.json") as { name: string; version: string };
    if (metadata.name !== "@google-cloud/firestore" || metadata.version !== idleListenPlan.highLevelSdkVersion) throw Error("Explicit @google-cloud/firestore 7.11.6 package root required");
    const sdk = sdkRequire("./") as typeof import("@google-cloud/firestore");
    const prototype = (sdk as unknown as { v1: { FirestoreClient: { prototype: ListenPrototype } } }).v1.FirestoreClient.prototype;
    restoreSdk = instrumentIdleSdkListen(prototype, { prefix: `${fullName(namespace)}/quiet/`, record,
      nextStreamId: () => ++observed.sdkListenStreams,
      unexpectedDocument: () => signal.abort(Error("SDK response escaped the owned synthetic collection")) });
    const ownRequire = createRequire(import.meta.url);
    const rawVersion = (ownRequire("@google-cloud/firestore/package.json") as { version: string }).version;
    record("configuration", { ...args, runId, namespace, planSha256: digest(planBytes), highLevelSdkVersion: metadata.version,
      highLevelWatchSourceSha256: digest(readFileSync(path.join(args.sdkRoot, "build/src/watch.js"))), nodeVersion: process.version,
      lowLevelSdkVersion: rawVersion, wireRepresentation: "decoded gRPC ListenResponse with bytes as exact base64 and int64 as decimal strings", serverLifecycleManagedExternally: true });
    // No ADC lookup or cloud fallback: both clients are explicitly insecure loopback.
    process.env.FIRESTORE_EMULATOR_HOST = args.host;
    raw = createV1Firestore({ name: args.stack === "official" ? "java" : "fireside", host: args.host, projectId: args.projectId });
    high = new sdk.Firestore({ projectId: args.projectId, host: args.host, ssl: false });
    await commit([createWrite(namespace, { synthetic: { booleanValue: true } })], "claim-namespace");
    ownsNamespace = true;
    attempted.add(namespace);
    attempted.add(targetName);
    await commit([createWrite(targetName, { version: { integerValue: "0" }, text: { stringValue: "quiet 火🔥" } })], "seed-target");
    let latestToken: Buffer | null = null;
    const openRaw = (label: "initial" | "resumed", token?: Buffer): ListenStream => {
      assert.ok(raw);
      const stream = raw.listen({ retry: null, otherArgs: { headers: { "google-cloud-resource-prefix": database } } });
      streams.push(stream);
      record("raw-open", { label });
      stream.on("data", (message: Response) => {
        const documentName = message.documentChange?.document?.name ?? message.documentDelete?.document ?? message.documentRemove?.document;
        if (documentName && !documentName.startsWith(`${fullName(namespace)}/quiet/`)) {
          record("unexpected-document-refused", { nameSha256: digest(documentName) });
          signal.abort(Error("Response escaped the owned synthetic collection"));
          return;
        }
        const response = decodeListenResponse(message);
        record("raw-response", { label, response });
        const tokenBytes = resumeTokenBytes(message.targetChange?.resumeToken);
        if (label === "initial" && tokenBytes !== null) {
          latestToken = tokenBytes;
          observed.initialTokenBase64 ??= tokenBytes.toString("base64");
          observed.latestTokenBase64 = tokenBytes.toString("base64");
        }
        const change = message.targetChange?.targetChangeType;
        if (label === "initial" && message.documentChange?.document?.name === fullName(targetName) &&
            String(message.documentChange.document.fields?.version?.integerValue) === "0") observed.rawInitialDocument = true;
        if (Number(change) === 3 || change === "CURRENT") {
          if (label === "initial") observed.rawInitial = true;
          else reattachObservation?.observe("current");
        }
        if (label === "resumed" && message.targetChange?.cause) reattachObservation?.observe("rejected-or-closed");
        if (label === (casePlan.forceRawLoss ? "resumed" : "initial") && message.documentChange?.document?.name === fullName(targetName) &&
            String(message.documentChange.document.fields?.version?.integerValue) === "1") observed.rawMutationDelivered = true;
      });
      stream.on("error", (error: unknown) => { record("raw-error", { label, error: describeError(error) }); if (label === "resumed") reattachObservation?.observe("rejected-or-closed"); });
      stream.on("end", () => { record("raw-end", { label }); if (label === "resumed") reattachObservation?.observe("rejected-or-closed"); });
      stream.on("close", () => record("raw-close", { label }));
      const request = { database, addTarget: { targetId: idleListenPlan.targetId,
        query: { parent: fullName(namespace), structuredQuery: { from: [{ collectionId: "quiet" }] } },
        ...(token === undefined ? {} : { resumeToken: token }) } };
      record("raw-request", { label, request: { ...request, addTarget: { ...request.addTarget,
        ...(token === undefined ? {} : { resumeToken: token.toString("base64") }) } } });
      stream.write(request);
      return stream;
    };
    changePhase("initial-listeners");
    const initial = openRaw("initial");
    record("high-subscribe", { collection: `${namespace}/quiet` });
    unsubscribe = high.collection(`${namespace}/quiet`).onSnapshot(snapshot => {
      if (snapshot.docs.some(doc => !doc.ref.path.startsWith(`${namespace}/quiet/`))) {
        signal.abort(Error("SDK snapshot escaped the owned synthetic collection")); return;
      }
      record("high-snapshot", { readTime: snapshot.readTime.toDate().toISOString(),
        documents: snapshot.docs.map(doc => ({ path: doc.ref.path, data: doc.data() })),
        changes: snapshot.docChanges().map(change => ({ type: change.type, path: change.doc.ref.path })) });
      if (snapshot.docs.some(doc => doc.ref.path === targetName && doc.get("version") === 0)) observed.highInitial = true;
      if (snapshot.docs.some(doc => doc.ref.path === targetName && doc.get("version") === 1)) observed.highMutationDelivered = true;
    }, error => { observed.highErrors += 1; record("high-error", describeError(error)); });
    if (!await observeUntil(() => observed.rawInitial && observed.rawInitialDocument && observed.highInitial && latestToken !== null && observed.sdkListenStreams > 0,
      idleListenPlan.initialObservationSeconds * 1000, signal.signal)) throw Error("Initial listeners/token not observed within frozen budget");
    changePhase("unrelated-writes");
    const writeDeadline = performance.now() + idleListenPlan.maximumUnrelatedWriteSeconds * 1000;
    for (let offset = 2; casePlan.unrelatedWrites && offset < names.length; offset += idleListenPlan.batchSize) {
      signal.signal.throwIfAborted();
      const remaining = writeDeadline - performance.now();
      if (remaining <= 0) throw Error("Unrelated single-document commits exceeded frozen write budget");
      const batch = names.slice(offset, offset + idleListenPlan.batchSize);
      batch.forEach(name => attempted.add(name));
      await commit(batch.map((name, index) => createWrite(name, { ordinal: { integerValue: String(offset - 2 + index) } })),
        `unrelated-${String(offset - 2)}`, Math.min(idleListenPlan.rpcTimeoutMilliseconds, remaining));
      observed.unrelatedDocumentsAcknowledged += batch.length;
    }
    changePhase("quiet-window-after-writes");
    await delay(idleListenPlan.idleSecondsAfterWrites * 1000, undefined, { signal: signal.signal });
    if (casePlan.forceRawLoss) {
      assert.ok(latestToken);
      const resume = Buffer.from(latestToken);
      changePhase("forced-client-stream-loss");
      record("raw-cancel", { label: "initial", reason: "deliberate client stream loss", latestObservedTokenBase64: resume.toString("base64") });
      initial.cancel();
      changePhase("resume-observation");
      reattachObservation = createIdleListenReattachObservation(outcome => {
        if (outcome === "current") observed.rawReattachedCurrent = true;
        else observed.rawReattachRejectedOrClosed = true;
      });
      try {
        openRaw("resumed", resume);
        await observeUntil(() => observed.rawReattachedCurrent || observed.rawReattachRejectedOrClosed,
          idleListenPlan.reattachObservationSeconds * 1000, signal.signal);
      } finally { reattachObservation.close(); }
      record("reattach-outcome", { ...observed });
    }
    changePhase("target-mutation");
    await commit([{ update: { name: fullName(targetName), fields: { version: { integerValue: "1" } } },
      updateMask: { fieldPaths: ["version"] }, currentDocument: { exists: true } }], "mutate-target");
    await observeUntil(() => observed.rawMutationDelivered && observed.highMutationDelivered,
      idleListenPlan.mutationObservationSeconds * 1000, signal.signal);
    record("mutation-outcome", { ...observed });
    scenarioCompleted = true;
  } catch (error) { failure = describeError(error); record("capture-failure", failure); }
  finally {
    clearTimeout(watchdog);
    reattachObservation?.close();
    changePhase("client-close-and-owned-cleanup");
    unsubscribe?.();
    streams.forEach(stream => stream.cancel());
    const cleanupDeadline = performance.now() + idleListenPlan.maximumCleanupSeconds * 1000;
    try {
      if (ownsNamespace) {
        const cleanup = [...attempted].reverse(); // Parent ownership marker is removed last.
        for (let offset = 0; offset < cleanup.length; offset += idleListenPlan.cleanupBatchSize) {
          const remaining = cleanupDeadline - performance.now();
          if (remaining <= 0) throw Error("Owned cleanup exceeded frozen budget");
          await commit(cleanup.slice(offset, offset + idleListenPlan.cleanupBatchSize).map(name => ({ delete: fullName(name) })),
            `cleanup-${String(offset)}`, Math.min(idleListenPlan.rpcTimeoutMilliseconds, remaining));
        }
        cleanupCompleted = true;
      }
      record("owned-cleanup", { ownsNamespace, cleanupCompleted, attemptedDocuments: attempted.size,
        projectWideDeleteUsed: false, unacknowledgedNamespaceClaimMayRequireExternalInspection: !ownsNamespace && raw !== undefined });
    } catch (error) { record("cleanup-failure", describeError(error)); }
    await Promise.all([
      high === undefined ? undefined : bounded(high.terminate(), idleListenPlan.rpcTimeoutMilliseconds, "high-level terminate").catch(error => record("client-close-error", describeError(error))),
      raw === undefined ? undefined : bounded(raw.close(), idleListenPlan.rpcTimeoutMilliseconds, "raw close").catch(error => record("client-close-error", describeError(error))),
    ]);
    restoreSdk?.();
    memorySignal.abort();
    await bounded(memory, idleListenPlan.rpcTimeoutMilliseconds, "memory sampler close").catch(error => record("memory-close-error", describeError(error)));
    changePhase("finished");
    const result = { schemaVersion: 1, at: new Date().toISOString(), stack: args.stack, host: args.host, projectId: args.projectId,
      namespace, caseName: args.caseName, planSha256: digest(planBytes), scenarioCompleted, cleanupCompleted, observed, failure,
      acceptancePassClaimed: false, oracleComparisonPerformed: false,
      interpretation: "Diagnostic observations only; missing delivery or rejected resume is evidence, not silently repaired." };
    writeFileSync(path.join(args.output, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    sealed = true;
    writeFileSync(path.join(args.output, "checksums.sha256"), ["events.jsonl", "plan.json", "result.json"]
      .map(name => `${digest(readFileSync(path.join(args.output, name)))}  ${name}\n`).join(""), { flag: "wx" });
  }
  return scenarioCompleted && cleanupCompleted;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  captureIdleListen(parseIdleListenArguments(process.argv.slice(2))).then(completed => {
    // Only this diagnostic client exits; externally managed servers are untouched.
    process.exit(completed ? 0 : 1);
  }).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
