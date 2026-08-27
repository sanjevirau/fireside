import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { FieldValue, GeoPoint, Timestamp } from "@google-cloud/firestore";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

test("orderBy follows the production mixed-value order", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const collection = firestore.collection(
    `runs/${randomUUID()}/fireside_conformance`,
  );
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);

  const cases: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly value: unknown;
  }> = [
    { id: "90-null", label: "null", value: null },
    { id: "91-false", label: "false", value: false },
    { id: "92-true", label: "true", value: true },
    { id: "93-nan", label: "nan", value: Number.NaN },
    { id: "94-negative-infinity", label: "negative-infinity", value: Number.NEGATIVE_INFINITY },
    { id: "95-negative", label: "negative", value: -1 },
    { id: "zero-b", label: "negative-zero", value: -0 },
    { id: "zero-a", label: "integer-zero", value: 0 },
    { id: "96-half", label: "half", value: 0.5 },
    { id: "duplicate-b", label: "seven-b", value: 7 },
    { id: "duplicate-a", label: "seven-a", value: 7 },
    { id: "97-infinity", label: "infinity", value: Number.POSITIVE_INFINITY },
    { id: "80-epoch", label: "epoch", value: Timestamp.fromMillis(0) },
    { id: "81-after-epoch", label: "after-epoch", value: Timestamp.fromMillis(1_000) },
    { id: "70-empty-string", label: "empty-string", value: "" },
    { id: "71-upper-a", label: "upper-a", value: "A" },
    { id: "72-lower-a", label: "lower-a", value: "a" },
    { id: "long-b", label: "long-x", value: `${"a".repeat(1_500)}x` },
    { id: "long-a", label: "long-y", value: `${"a".repeat(1_500)}y` },
    { id: "73-fire", label: "fire", value: "🔥" },
    { id: "60-empty-bytes", label: "empty-bytes", value: Buffer.alloc(0) },
    { id: "61-zero-byte", label: "zero-byte", value: Buffer.from([0]) },
    { id: "62-zero-one-bytes", label: "zero-one-bytes", value: Buffer.from([0, 1]) },
    { id: "63-one-byte", label: "one-byte", value: Buffer.from([1]) },
    { id: "50-reference-a", label: "reference-a", value: firestore.doc("reference_targets/a") },
    { id: "51-reference-b", label: "reference-b", value: firestore.doc("reference_targets/b") },
    { id: "40-southwest", label: "southwest", value: new GeoPoint(-90, -180) },
    { id: "41-origin", label: "origin", value: new GeoPoint(0, 0) },
    { id: "30-empty-array", label: "empty-array", value: [] },
    { id: "31-null-array", label: "null-array", value: [null] },
    { id: "32-null-false-array", label: "null-false-array", value: [null, false] },
    { id: "33-false-array", label: "false-array", value: [false] },
    { id: "25-vector-one", label: "vector-one", value: FieldValue.vector([9]) },
    { id: "26-vector-two-zero", label: "vector-two-zero", value: FieldValue.vector([0, 0]) },
    { id: "27-vector-two-one", label: "vector-two-one", value: FieldValue.vector([0, 1]) },
    { id: "20-map-a", label: "map-a", value: { a: null } },
    { id: "21-map-a-b", label: "map-a-b", value: { a: null, b: false } },
    { id: "22-map-b", label: "map-b", value: { b: null } },
  ];

  context.after(async () => {
    const writer = firestore.bulkWriter();
    for (const entry of cases) {
      writer.delete(collection.doc(entry.id));
    }
    await writer.close().catch(() => undefined);
    await firestore.terminate();
  });

  const writer = firestore.bulkWriter();
  for (const entry of cases) {
    writer.set(collection.doc(entry.id), {
      _fireside_expires_at: expiresAt,
      label: entry.label,
      value: entry.value,
    });
  }
  await writer.close();

  const snapshot = await collection.orderBy("value").get();
  const actual = snapshot.docs.map((document) => document.get("label") as string);

  assert.deepEqual(actual, [
    "null",
    "false",
    "true",
    "nan",
    "negative-infinity",
    "negative",
    "integer-zero",
    "negative-zero",
    "half",
    "seven-a",
    "seven-b",
    "infinity",
    "epoch",
    "after-epoch",
    "empty-string",
    "upper-a",
    "lower-a",
    "long-y",
    "long-x",
    "fire",
    "empty-bytes",
    "zero-byte",
    "zero-one-bytes",
    "one-byte",
    "reference-a",
    "reference-b",
    "southwest",
    "origin",
    "empty-array",
    "null-array",
    "null-false-array",
    "false-array",
    "vector-one",
    "vector-two-zero",
    "vector-two-one",
    "map-a",
    "map-a-b",
    "map-b",
  ]);
});

test("integer and double ordering does not lose int64 precision", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(
    `runs/${runId}/fireside_conformance`,
  );
  const parent = `projects/${configuration.projectId}/databases/(default)/documents/runs/${runId}`;
  const expiresAtSeconds = Math.floor((Date.now() + DAY_MILLISECONDS) / 1_000);
  const cases = [
    {
      id: "minimum-b",
      label: "minimum-integer",
      value: { integerValue: "-9223372036854775808" },
    },
    {
      id: "minimum-a",
      label: "minimum-double",
      value: { doubleValue: -9_223_372_036_854_775_808 },
    },
    {
      id: "two-to-53",
      label: "two-to-53-double",
      value: { doubleValue: 9_007_199_254_740_992 },
    },
    {
      id: "two-to-53-plus-one",
      label: "two-to-53-plus-one-integer",
      value: { integerValue: "9007199254740993" },
    },
    {
      id: "maximum-integer",
      label: "maximum-integer",
      value: { integerValue: "9223372036854775807" },
    },
    {
      id: "two-to-63-double",
      label: "two-to-63-double",
      value: { doubleValue: 9_223_372_036_854_775_808 },
    },
  ] as const;

  context.after(async () => {
    const writer = firestore.bulkWriter();
    for (const entry of cases) {
      writer.delete(collection.doc(entry.id));
    }
    await writer.close().catch(() => undefined);
    await Promise.all([
      firestore.terminate(),
      rawFirestore.close(),
    ]).catch(() => undefined);
  });

  await Promise.all(
    cases.map(async (entry) => {
      await rawFirestore.createDocument({
        parent,
        collectionId: "fireside_conformance",
        documentId: entry.id,
        document: {
          fields: {
            _fireside_expires_at: {
              timestampValue: { seconds: expiresAtSeconds, nanos: 0 },
            },
            label: { stringValue: entry.label },
            value: entry.value,
          },
        },
      });
    }),
  );

  const snapshot = await collection.orderBy("value").get();
  assert.deepEqual(
    snapshot.docs.map((document) => document.get("label") as string),
    [
      "minimum-double",
      "minimum-integer",
      "two-to-53-double",
      "two-to-53-plus-one-integer",
      "maximum-integer",
      "two-to-63-double",
    ],
  );
});
