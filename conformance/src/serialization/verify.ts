import assert from "node:assert/strict";
import { canonicalJson, serializationCases, serializationOperations, serializationRepeats, type SerializationObservation } from "./cases.ts";

export interface SerializationCapture {
  readonly cases: unknown;
  readonly repeats: number;
  readonly observations: readonly SerializationObservation[];
}

export function verifySerializationCapture(capture: SerializationCapture): void {
  assert.deepEqual(capture.cases, serializationCases);
  assert.equal(capture.repeats, serializationRepeats);
  assert.equal(capture.observations.length, serializationCases.length * serializationOperations.length);
  for (const testCase of serializationCases) for (const operation of serializationOperations) {
    const matches = capture.observations.filter(item => item.id === testCase.id && item.operation === operation);
    assert.equal(matches.length, 1, `${testCase.id} ${operation}`);
    const reads = matches[0]!.reads;
    assert.equal(reads.length, serializationRepeats);
    const canonical = reads.map(text => canonicalJson(JSON.parse(text)));
    assert.equal(new Set(canonical).size, 1, `${testCase.id} ${operation}: changed field values without writes`);
    assert.equal(new Set(reads).size, 1, `${testCase.id} ${operation}: unstable response field order`);
    if (operation === "sdk-get" || operation.startsWith("browser-")) {
      assert.equal(canonical[0], canonicalJson(testCase.fields), `${testCase.id} ${operation}: SDK value mismatch`);
    }
  }
}

export function compareSerializationCapture(actual: SerializationCapture, oracle: SerializationCapture): void {
  verifySerializationCapture(actual);
  verifySerializationCapture(oracle);
  for (const observed of actual.observations) {
    const expected = oracle.observations.find(item => item.id === observed.id && item.operation === observed.operation)!;
    // Match map values and within-server stability, not Java's incidental key
    // permutation: protobuf maps do not promise a cross-server key order.
    assert.equal(canonicalJson(JSON.parse(observed.reads[0]!)), canonicalJson(JSON.parse(expected.reads[0]!)), `${observed.id} ${observed.operation}: oracle value mismatch`);
  }
}
