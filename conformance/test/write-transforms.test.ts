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

  context.after(async () => {
    await document.delete().catch(() => undefined);
    await firestore.terminate();
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
