import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { FieldValue, Timestamp } from "@google-cloud/firestore";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

test("field transforms use the production commit semantics", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const document = firestore.doc(
    `runs/${randomUUID()}/fireside_conformance/transforms`,
  );
  const replacement = firestore.doc(
    `runs/${randomUUID()}/fireside_conformance/replace-transforms`,
  );

  context.after(async () => {
    await Promise.all([
      document.delete().catch(() => undefined),
      replacement.delete().catch(() => undefined),
    ]);
    await firestore.terminate();
  });

  await replacement.set({ counter: 10, removedByReplace: true });
  await replacement.set({
    counter: FieldValue.increment(2),
    createdByReplace: true,
  });
  assert.deepEqual((await replacement.get()).data(), {
    counter: 2,
    createdByReplace: true,
  });

  await document.set({
    _fireside_expires_at: Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS),
    counter: 1,
    nested: { keep: true, remove: true },
    nonNumber: "replace me",
    removeMe: true,
    scalarArray: "replace me",
    tags: ["a", 1],
    updatedAt: null,
    updatedAtAgain: null,
  });

  const firstWrite = await document.update({
    counter: FieldValue.increment(2.5),
    "nested.remove": FieldValue.delete(),
    removeMe: FieldValue.delete(),
    tags: FieldValue.arrayUnion("b", 1, "b"),
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtAgain: FieldValue.serverTimestamp(),
  });
  const firstSnapshot = await document.get();
  const first = firstSnapshot.data();
  assert.equal(first?.counter, 3.5);
  assert.deepEqual(first?.nested, { keep: true });
  assert.equal(first?.removeMe, undefined);
  assert.deepEqual(first?.tags, ["a", 1, "b"]);
  assert.ok(first?.updatedAt instanceof Timestamp);
  assert.ok(first?.updatedAtAgain instanceof Timestamp);
  assert.equal(first.updatedAt.isEqual(first.updatedAtAgain), true);
  assert.equal(firstSnapshot.updateTime?.isEqual(firstWrite.writeTime), true);
  assert.equal(compareTimestamps(first.updatedAt, firstWrite.writeTime) <= 0, true);

  await document.update({
    missingCounter: FieldValue.increment(3),
    nonNumber: FieldValue.increment(4),
    scalarArray: FieldValue.arrayUnion("x", "x"),
    tags: FieldValue.arrayRemove("a", 1),
  });
  const second = (await document.get()).data();
  assert.equal(second?.missingCounter, 3);
  assert.equal(second?.nonNumber, 4);
  assert.deepEqual(second?.scalarArray, ["x"]);
  assert.deepEqual(second?.tags, ["b"]);
});

function compareTimestamps(left: Timestamp, right: Timestamp): number {
  if (left.seconds !== right.seconds) {
    return left.seconds < right.seconds ? -1 : 1;
  }
  return Math.sign(left.nanoseconds - right.nanoseconds);
}

test("array transforms use production numeric equality", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const documentId = "numeric-equality";
  const parent = `projects/${configuration.projectId}/databases/(default)/documents/runs/${runId}`;
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const name = `${parent}/fireside_conformance/${documentId}`;
  const document = firestore.doc(
    `runs/${runId}/fireside_conformance/${documentId}`,
  );

  context.after(async () => {
    await document.delete().catch(() => undefined);
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await rawFirestore.createDocument({
    parent,
    collectionId: "fireside_conformance",
    documentId,
    document: {
      fields: {
        _fireside_expires_at: {
          timestampValue: {
            seconds: Math.floor((Date.now() + DAY_MILLISECONDS) / 1_000),
            nanos: 0,
          },
        },
        values: {
          arrayValue: {
            values: [
              { integerValue: "1" },
              { doubleValue: Number.NaN },
              { doubleValue: -0 },
            ],
          },
        },
      },
    },
  });

  await rawFirestore.commit({
    database,
    writes: [
      {
        transform: {
          document: name,
          fieldTransforms: [
            {
              fieldPath: "values",
              appendMissingElements: {
                values: [
                  { doubleValue: 1 },
                  { doubleValue: Number.NaN },
                  { doubleValue: 0 },
                  { integerValue: "2" },
                ],
              },
            },
          ],
        },
      },
    ],
  });
  const [afterUnion] = await rawFirestore.getDocument({ name });
  assert.deepEqual(valueKinds(afterUnion.fields?.values?.arrayValue?.values), [
    "integer:1",
    "double:nan",
    "double:-0",
    "integer:2",
  ]);

  await rawFirestore.commit({
    database,
    writes: [
      {
        transform: {
          document: name,
          fieldTransforms: [
            {
              fieldPath: "values",
              removeAllFromArray: {
                values: [
                  { doubleValue: 1 },
                  { doubleValue: Number.NaN },
                  { doubleValue: 0 },
                ],
              },
            },
          ],
        },
      },
    ],
  });
  const [afterRemove] = await rawFirestore.getDocument({ name });
  assert.deepEqual(
    valueKinds(afterRemove.fields?.values?.arrayValue?.values),
    ["integer:2"],
  );
});

test("minimum and maximum transforms preserve production numeric types", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const documentId = "numeric-bounds";
  const parent = `projects/${configuration.projectId}/databases/(default)/documents/runs/${runId}`;
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const name = `${parent}/fireside_conformance/${documentId}`;
  const document = firestore.doc(`runs/${runId}/fireside_conformance/${documentId}`);

  context.after(async () => {
    await document.delete().catch(() => undefined);
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await rawFirestore.createDocument({
    parent,
    collectionId: "fireside_conformance",
    documentId,
    document: {
      fields: {
        maxPromote: { integerValue: "3" },
        minPromote: { doubleValue: 4.5 },
        maxEqual: { integerValue: "3" },
        minEqual: { doubleValue: 3 },
        storedNegativeZero: { doubleValue: -0 },
        maximumNan: { integerValue: "9" },
        minimumNan: { doubleValue: 9 },
        currentNanMaximum: { doubleValue: Number.NaN },
        currentNanMinimum: { doubleValue: Number.NaN },
        maximumPrecise: { integerValue: "9007199254740993" },
        minimumPrecise: { integerValue: "9007199254740993" },
        nonNumeric: { stringValue: "replace me" },
      },
    },
  });

  const [commit] = await rawFirestore.commit({
    database,
    writes: [
      {
        transform: {
          document: name,
          fieldTransforms: [
            { fieldPath: "maxPromote", maximum: { doubleValue: 4.5 } },
            { fieldPath: "minPromote", minimum: { integerValue: "4" } },
            { fieldPath: "maxEqual", maximum: { doubleValue: 3 } },
            { fieldPath: "minEqual", minimum: { integerValue: "3" } },
            { fieldPath: "storedNegativeZero", maximum: { integerValue: "0" } },
            { fieldPath: "maximumNan", maximum: { doubleValue: Number.NaN } },
            { fieldPath: "minimumNan", minimum: { doubleValue: Number.NaN } },
            { fieldPath: "currentNanMaximum", maximum: { integerValue: "1" } },
            { fieldPath: "currentNanMinimum", minimum: { integerValue: "1" } },
            {
              fieldPath: "maximumPrecise",
              maximum: { doubleValue: 9007199254740992 },
            },
            {
              fieldPath: "minimumPrecise",
              minimum: { doubleValue: 9007199254740992 },
            },
            { fieldPath: "nonNumeric", maximum: { integerValue: "7" } },
            { fieldPath: "missing", minimum: { doubleValue: 8.5 } },
          ],
        },
      },
    ],
  });
  const expected = [
    "double:4.5",
    "integer:4",
    "integer:3",
    "double:3",
    "double:-0",
    "double:nan",
    "double:nan",
    "double:nan",
    "double:nan",
    "integer:9007199254740993",
    "double:9007199254740992",
    "integer:7",
    "double:8.5",
  ];
  assert.deepEqual(
    (commit.writeResults?.[0]?.transformResults ?? []).map(numericKind),
    expected,
  );

  const [stored] = await rawFirestore.getDocument({ name });
  assert.deepEqual(
    [
      stored.fields?.maxPromote,
      stored.fields?.minPromote,
      stored.fields?.maxEqual,
      stored.fields?.minEqual,
      stored.fields?.storedNegativeZero,
      stored.fields?.maximumNan,
      stored.fields?.minimumNan,
      stored.fields?.currentNanMaximum,
      stored.fields?.currentNanMinimum,
      stored.fields?.maximumPrecise,
      stored.fields?.minimumPrecise,
      stored.fields?.nonNumeric,
      stored.fields?.missing,
    ].map(numericKind),
    expected,
  );

  await assert.rejects(
    rawFirestore.commit({
      database,
      writes: [
        {
          transform: {
            document: name,
            fieldTransforms: [
              { fieldPath: "invalid", maximum: { stringValue: "not numeric" } },
            ],
          },
        },
      ],
    }),
    (error: unknown) => grpcCode(error) === 3,
  );
});

function grpcCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "number" ? error.code : undefined;
}

function numericKind(value: {
  readonly integerValue?: unknown;
  readonly doubleValue?: number | null;
} | null | undefined): string {
  if (value?.integerValue !== undefined && value.integerValue !== null) {
    return `integer:${String(value.integerValue)}`;
  }
  if (value?.doubleValue !== undefined && value.doubleValue !== null) {
    if (Number.isNaN(value.doubleValue)) {
      return "double:nan";
    }
    if (Object.is(value.doubleValue, -0)) {
      return "double:-0";
    }
    return `double:${String(value.doubleValue)}`;
  }
  return "other";
}

function valueKinds(
  values:
    | ReadonlyArray<{
        readonly integerValue?: unknown;
        readonly doubleValue?: number | null;
      }>
    | null
    | undefined,
): string[] {
  return (values ?? []).map((value) => {
    if (value.integerValue !== undefined && value.integerValue !== null) {
      return `integer:${String(value.integerValue)}`;
    }
    if (value.doubleValue !== undefined && value.doubleValue !== null) {
      if (Number.isNaN(value.doubleValue)) {
        return "double:nan";
      }
      if (Object.is(value.doubleValue, -0)) {
        return "double:-0";
      }
      return `double:${String(value.doubleValue)}`;
    }
    return "other";
  });
}
