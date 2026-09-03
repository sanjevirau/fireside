import assert from "node:assert/strict";
import { queryRuleCases, queryRulesProject } from "./query-rules-cases.ts";
import type { Observation } from "./query-rules-transport.ts";

export interface NativeCapture { cases: typeof queryRuleCases; observations: Observation[] }
export interface BrowserCapture {
  variant: string;
  pageErrors: string[];
  consoleErrors: string[];
  httpFailures: unknown[];
  requestFailures: { url: string; reason: string | null }[];
  observations: {
    id: string; operation: string;
    result: { code: number | string; error?: string; documents?: string[]; count?: string; snapshots?: BrowserSnapshot[] };
  }[];
}
interface BrowserSnapshot {
  documents: string[];
  changes: { type: string; path: string; data: Record<string, unknown> }[];
}

// Verdicts frozen from both exact official JAR captures, not inferred from the
// seed rows. Every other named case is explicitly denied on all three RPCs.
const allowed = new Set([
  "owner-equality", "owner-in-single", "owner-compound-and", "owner-compound-or-safe",
  "owner-empty", "owner-nonmatching-extra-filter", "license-get-allowed",
  "license-in-all-granted", "short-circuit-missing-get", "array-contains-owner",
  "array-any-owner", "range-equality-inside", "range-strict-bound",
  "range-inclusive-bound", "range-safe-in", "not-equal-null", "not-equal-string",
  "not-in-blocked", "limit-allowed", "offset-allowed", "offset-default", "order-desc",
  "get-fixed-path", "exists-fixed-path", "exists-constrained-path",
  "group-recursive-owner", "group-recursive-empty-owner", "nested-collection-owner",
]);
const sorted = (values: string[]) => [...values].sort();
const owned = `projects/${queryRulesProject}/databases/(default)/documents/presentations/owned`;

export function verifyNativeCapture(capture: NativeCapture): void {
  assert.deepEqual(capture.cases, queryRuleCases, "fixture must cover the exact query matrix");
  assert.equal(capture.observations.length, 173);
  for (const testCase of queryRuleCases) {
    const values = capture.observations.filter((value) => value.id === testCase.id && ["RunQuery", "RunAggregationQuery", "Listen"].includes(value.operation));
    assert.deepEqual(values.map((value) => value.operation), ["RunQuery", "RunAggregationQuery", "Listen"], testCase.id);
    for (const value of values) assert.equal(value.code, allowed.has(testCase.id) ? 0 : 7, `${testCase.id} ${value.operation}`);
    const [query, count, listen] = values;
    if (query!.code === 0) {
      assert.deepEqual(sorted(listen!.documents), sorted(query!.documents), testCase.id);
      assert.equal(count!.count, String(query!.documents.length), testCase.id);
    } else {
      for (const value of values) assert.equal(value.documents.length, 0, "denied requests expose no documents");
    }
  }
  const lists = capture.observations.filter((value) => value.operation === "ListDocuments");
  assert.deepEqual(lists.map(({ id, code }) => [id, code]), [["owner-absent", 7], ["owner-empty-unconstrained", 7], ["get-fixed-path", 0], ["limit-allowed", 0]]);
  for (const id of ["owner-empty", "owner-nonmatching-extra-filter", "group-recursive-empty-owner"]) {
    assert.deepEqual(capture.observations.find((value) => value.id === id && value.operation === "RunQuery")!.documents, [], id);
  }
  const changes = capture.observations.filter((value) => value.operation === "ListenChanges");
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.code, 0);
  assert.deepEqual(changes[0]!.checkpoints, [[owned], [owned], []], "official RESET + CURRENT checkpoints retain update and leave events");
}

/** Compare semantic outcomes, not unstable timestamps, session IDs, or wording. */
export function compareNativeCapture(actual: NativeCapture, expected: NativeCapture): void {
  const semantics = (value: NativeCapture) => value.observations.map(({ id, operation, code, documents, count }) => ({ id, operation, code, documents: sorted([...new Set(documents)]), ...(count === undefined ? {} : { count }) }));
  assert.deepEqual(actual.cases, expected.cases);
  assert.deepEqual(semantics(actual), semantics(expected));
  // Servers may represent removal incrementally instead of Java's RESET. The
  // browser comparison below verifies the same observable added/modified/removed.
}

export function verifyBrowserCapture(browser: BrowserCapture, native: NativeCapture): void {
  assert.deepEqual(browser.pageErrors, [], browser.variant);
  assert.deepEqual(browser.httpFailures, [], browser.variant);
  assert.deepEqual(browser.requestFailures.filter(({ url, reason }) => !(reason === "net::ERR_ABORTED" && url.includes("/Listen/channel"))), [], "only our own closed Listen channels may be aborted");
  assert.equal(browser.consoleErrors.some((message) => message.includes("CORS")), false);
  const cases = native.cases.filter((value) => value.offset === undefined);
  assert.equal(browser.observations.length, cases.length * 2 + 1);
  for (const testCase of cases) {
    for (const operation of ["Listen", "RunAggregationQuery"]) {
      const matches = browser.observations.filter((value) => value.id === testCase.id && value.operation === operation);
      assert.equal(matches.length, 1, `${browser.variant} ${testCase.id} ${operation}`);
      const result = matches[0]!.result;
      const oracle = native.observations.find((value) => value.id === testCase.id && value.operation === operation)!;
      assert.equal(result.code, oracle.code === 0 ? 0 : "permission-denied", `${browser.variant} ${testCase.id} ${operation}: ${result.error ?? ""}`);
      if (result.code === 0) {
        if (operation === "Listen") assert.deepEqual(sorted(result.documents!), sorted(oracle.documents), testCase.id);
        else assert.equal(result.count, oracle.count, testCase.id);
      }
    }
  }
  const changeCases = browser.observations.filter((value) => value.operation === "ListenChanges");
  assert.equal(changeCases.length, 1);
  const result = changeCases[0]!.result;
  assert.equal(result.code, 0, result.error ?? "Listen changes must succeed");
  assert.deepEqual(result.snapshots!.map((snapshot) => snapshot.documents), [[owned], [owned], []]);
  assert.deepEqual(result.snapshots!.flatMap((snapshot) => snapshot.changes.map(({ type, data }) => [type, data.updatedAt])), [["added", 2], ["modified", 3], ["removed", 3]]);
}
