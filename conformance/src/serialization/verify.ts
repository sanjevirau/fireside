import assert from "node:assert/strict";
import { canonicalJson, serializationCases, serializationOperations, serializationRepeats, type SerializationObservation } from "./cases.ts";

export interface SerializationCapture {
  readonly cases: unknown;
  readonly repeats: number;
  readonly observations: readonly SerializationObservation[];
}

// Proto3 JSON may either omit an empty repeated/map field or spell it out.
// Preserve each server's exact text for the within-server stability assertion,
// but compare these two representations as the same Firestore Value across
// servers. This deliberately does not normalize non-empty data.
export function normalizeFirestoreValueJson(value: unknown): unknown {
  const normalizeFields = (fields: unknown): unknown => {
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return fields;
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, normalizeValue(field)]));
  };
  const normalizeValue = (input: unknown): unknown => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
    const object = { ...input } as Record<string, unknown>;
    if (object.arrayValue !== null && typeof object.arrayValue === "object" &&
        !Array.isArray(object.arrayValue)) {
      const arrayValue = { ...object.arrayValue } as Record<string, unknown>;
      arrayValue.values = Array.isArray(arrayValue.values)
        ? arrayValue.values.map(normalizeValue)
        : [];
      object.arrayValue = arrayValue;
    }
    if (object.mapValue !== null && typeof object.mapValue === "object" &&
        !Array.isArray(object.mapValue)) {
      const mapValue = { ...object.mapValue } as Record<string, unknown>;
      mapValue.fields = mapValue.fields === undefined ? {} : normalizeFields(mapValue.fields);
      object.mapValue = mapValue;
    }
    return object;
  };
  return normalizeFields(value);
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
    const protobufValues = observed.operation.startsWith("grpc-") || observed.operation === "rest-get";
    const actualValue = JSON.parse(observed.reads[0]!);
    const expectedValue = JSON.parse(expected.reads[0]!);
    assert.equal(
      canonicalJson(protobufValues ? normalizeFirestoreValueJson(actualValue) : actualValue),
      canonicalJson(protobufValues ? normalizeFirestoreValueJson(expectedValue) : expectedValue),
      `${observed.id} ${observed.operation}: oracle value mismatch`,
    );
  }
}
