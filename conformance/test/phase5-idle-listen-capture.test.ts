import assert from "node:assert/strict";
import test from "node:test";
import { Duplex } from "node:stream";
import { decodeListenResponse, idleListenPlan, ownedDocumentNames, parseIdleListenArguments,
  procStartTicks, resumeTokenBytes, instrumentIdleSdkListen,
  createIdleListenReattachObservation } from "../src/suite/capture-phase5-idle-listen.ts";

const valid = ["--host", "127.0.0.1:23000", "--project-id", "demo-idle-listen",
  "--stack", "official", "--case", "churn-forced", "--sdk-root", "/tmp/sdk", "--output", "/tmp/new-capture"];

test("idle Listen diagnostic freezes counts and budgets before any capture", () => {
  assert.equal(idleListenPlan.highLevelSdkVersion, "7.11.6");
  assert.equal(idleListenPlan.unrelatedDocuments, 4100);
  assert.equal(idleListenPlan.batchSize, 1);
  assert.equal(idleListenPlan.cleanupBatchSize, 100);
  assert.equal(idleListenPlan.maximumUnrelatedWriteSeconds, 180);
  assert.deepEqual(idleListenPlan.cases, {
    "idle-control": { unrelatedWrites: false, forceRawLoss: false },
    "churn-natural": { unrelatedWrites: true, forceRawLoss: false },
    "churn-forced": { unrelatedWrites: true, forceRawLoss: true },
  });
  assert.equal(idleListenPlan.idleSecondsAfterWrites, 150);
  assert.equal(idleListenPlan.initialObservationSeconds, 30);
  assert.equal(idleListenPlan.reattachObservationSeconds, 30);
  assert.equal(idleListenPlan.mutationObservationSeconds, 30);
  assert.equal(idleListenPlan.maximumScenarioSeconds, 900);
  assert.equal(idleListenPlan.maximumCleanupSeconds, 120);
  assert.equal(idleListenPlan.rpcTimeoutMilliseconds, 10000);
  assert.equal(idleListenPlan.memorySampleMilliseconds, 1000);
  assert.equal(idleListenPlan.targetId, 23);
});

test("CLI refuses cloud, DNS, ambiguous or workload-changing arguments", () => {
  assert.equal(parseIdleListenArguments(valid).host, "127.0.0.1:23000");
  for (const host of ["firestore.googleapis.com:443", "localhost:8080", "127.0.0.1:0", "127.0.0.1:65536", "http://127.0.0.1:8080"]) {
    assert.throws(() => parseIdleListenArguments(valid.map(value => value === "127.0.0.1:23000" ? host : value)));
  }
  assert.throws(() => parseIdleListenArguments(valid.map(value => value === "demo-idle-listen" ? "twodart-prod" : value)));
  assert.throws(() => parseIdleListenArguments([...valid, "--idle-seconds", "1"]));
  assert.throws(() => parseIdleListenArguments([...valid, "--host", "127.0.0.1:8080"]));
  assert.throws(() => parseIdleListenArguments([...valid, "--server-pid", "-1"]));
  assert.equal(parseIdleListenArguments([...valid, "--server-pid", "123"]).serverPid, 123);
});

test("exact decoded frame bytes, tokens, Unicode and int64 values survive recording", () => {
  const token = Buffer.from([0, 255, 128, 65]);
  const frame = decodeListenResponse({ targetChange: { targetChangeType: "NO_CHANGE", targetIds: [],
    resumeToken: token, readTime: { seconds: "9007199254740993", nanos: 1 } } });
  assert.deepEqual(frame, { targetChange: { targetChangeType: "NO_CHANGE", resumeToken: token.toString("base64"),
    readTime: { seconds: "9007199254740993", nanos: 1 } } });
  assert.deepEqual(resumeTokenBytes(token.toString("base64")), token);
  assert.deepEqual(resumeTokenBytes(new Uint8Array(token)), token);
  assert.equal(resumeTokenBytes(""), null);
  assert.equal(resumeTokenBytes(undefined), null);
  const doc = decodeListenResponse({ documentChange: { document: { name: "synthetic", fields: { text: { stringValue: "火🔥" } } }, targetIds: [23] } });
  assert.match(JSON.stringify(doc), /火🔥/u);
});

test("cleanup names are exclusively within a random owned synthetic namespace", () => {
  const namespace = "_phase5_idle_listen/11111111-1111-4111-8111-111111111111";
  const names = ownedDocumentNames(namespace);
  assert.equal(names.length, 4102);
  assert.equal(new Set(names).size, 4102);
  assert.equal(names[0], namespace);
  assert.equal(names[1], `${namespace}/quiet/target`);
  assert.ok(names.every(name => name === namespace || name.startsWith(`${namespace}/`)));
  assert.throws(() => ownedDocumentNames("presentations/existing"));
});

test("memory identity parsing handles spaces and parentheses in process names", () => {
  const fields: string[] = Array.from({ length: 30 }, (_, index) => index === 19 ? "123456" : "0");
  fields[0] = "S";
  assert.equal(procStartTicks(`42 (server (worker) name) ${fields.join(" ")}`), "123456");
  assert.throws(() => procStartTicks("42 (gone)"));
});

test("raw reattachment outcome freezes before owned cleanup but keeps genuine observed rejection", () => {
  for (const first of ["current", "rejected-or-closed", null] as const) {
    const outcomes: string[] = [];
    const lifecycleEvents: string[] = [];
    const observation = createIdleListenReattachObservation(outcome => outcomes.push(outcome));
    const receive = (event: string, outcome: "current" | "rejected-or-closed"): void => {
      lifecycleEvents.push(event);
      observation.observe(outcome);
    };
    if (first !== null) receive("observed-reattachment", first);
    observation.close(); // CURRENT, rejection, timeout, or abort ends this window.
    observation.close(); // Cleanup may close it again without changing the outcome.
    receive("cleanup-cancel-error", "rejected-or-closed");
    receive("cleanup-end", "rejected-or-closed");
    receive("late-current", "current");
    assert.deepEqual(outcomes, first === null ? [] : [first]);
    assert.deepEqual(lifecycleEvents, [
      ...(first === null ? [] : ["observed-reattachment"]),
      "cleanup-cancel-error", "cleanup-end", "late-current",
    ]);
  }
});

test("SDK observation forwards the exact call and write objects without causing reconnects", () => {
  const calls: unknown[][] = [];
  const writes: unknown[] = [];
  const events: { kind: string; value: unknown }[] = [];
  const stream = new Duplex({ objectMode: true, read() {}, write(chunk, _encoding, done) { writes.push(chunk); done(); } });
  const original = (...values: unknown[]): Duplex => { calls.push(values); return stream; };
  const prototype = { listen: original };
  let next = 0;
  let unexpected = 0;
  const restore = instrumentIdleSdkListen(prototype, { prefix: "synthetic/quiet/", nextStreamId: () => ++next,
    record: (kind, value) => { events.push({ kind, value }); }, unexpectedDocument: () => { unexpected += 1; } });
  const options = { untouched: true };
  assert.equal(prototype.listen(options), stream);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], options);
  const request = { database: "projects/demo-test/databases/(default)", addTarget: { targetId: 23, resumeToken: Buffer.from([0, 255]) } };
  assert.equal(stream.write(request), true);
  assert.equal(writes[0], request);
  stream.emit("data", { targetChange: { targetChangeType: "CURRENT", resumeToken: Buffer.from([0, 255]) } });
  stream.emit("data", { documentChange: { document: { name: "private/outside", fields: { secret: { stringValue: "not-recorded" } } } } });
  stream.emit("error", Error("synthetic terminal error"));
  stream.emit("end");
  stream.emit("close");
  assert.equal(calls.length, 1, "observer does not open a replacement stream");
  assert.equal(unexpected, 1);
  assert.doesNotMatch(JSON.stringify(events), /not-recorded|private\/outside/u);
  assert.deepEqual(events.map(event => event.kind), ["sdk-listen-open", "sdk-listen-request", "sdk-listen-response",
    "sdk-unexpected-document-refused", "sdk-listen-error", "sdk-listen-end", "sdk-listen-close"]);
  restore();
  assert.equal(prototype.listen, original);
  stream.destroy();
});
