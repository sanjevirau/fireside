import assert from "node:assert/strict";

import {
  DocumentReference,
  GeoPoint,
  Timestamp,
  VectorValue,
} from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "./target.ts";

const configuration = resolveTarget(process.env);
if (configuration.name !== "java") {
  throw new Error("export import verification is restricted to the Java emulator");
}

const firestore = createFirestore(configuration);
try {
  const root = firestore.collection("fireside_export_fixture");
  const [collection, valuesSnapshot, largeSnapshot, referenceSnapshot, child] =
    await Promise.all([
      root.get(),
      root.doc("values").get(),
      root.doc("large").get(),
      root.doc("reference-target").get(),
      root.doc("parent").collection("children").doc("leaf").get(),
    ]);

  assert.equal(collection.size, 3);
  assert.equal(valuesSnapshot.exists, true);
  assert.equal(largeSnapshot.exists, true);
  assert.equal(referenceSnapshot.exists, true);
  assert.equal(child.exists, true);

  const values = valuesSnapshot.data();
  assert.notEqual(values, undefined);
  if (values === undefined) {
    throw new Error("values document disappeared after exists check");
  }

  assert.deepEqual(values.emptyArray, []);
  assert.deepEqual(values.array, [null, true, 42, 4.25, "array-value"]);
  assert.equal(Buffer.isBuffer(values.bytes), true);
  assert.deepEqual([...values.bytes], [0, 1, 2, 127, 128, 255]);
  assert.equal(Buffer.isBuffer(values.emptyBytes), true);
  assert.equal(values.emptyBytes.length, 0);
  assert.deepEqual(values.emptyMap, {});
  assert.equal(values.emptyString, "");
  assert.equal(Number.isNaN(values.floating.nan), true);
  assert.equal(values.floating.negativeInfinity, Number.NEGATIVE_INFINITY);
  assert.equal(Object.is(values.floating.negativeZero, -0), true);
  assert.equal(values.floating.positiveInfinity, Number.POSITIVE_INFINITY);
  assert.deepEqual(values.integerBoundaries, [
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ]);
  assert.equal(values.location instanceof GeoPoint, true);
  assert.equal(values.location.isEqual(new GeoPoint(3.139, 101.6869)), true);
  assert.deepEqual(values.map, {
    emptyArray: [],
    emptyMap: {},
    nested: { enabled: true },
    score: 9,
  });
  assert.equal(values.nullValue, null);
  assert.equal(values.reference instanceof DocumentReference, true);
  assert.equal(
    values.reference.path,
    "fireside_export_fixture/reference-target",
  );
  assert.equal(values.string, "fireside-export-🔥");
  assert.equal(values.timestamp instanceof Timestamp, true);
  assert.equal(
    values.timestamp.isEqual(Timestamp.fromMillis(1_700_000_000_123)),
    true,
  );
  assert.equal(values.vector instanceof VectorValue, true);
  assert.deepEqual(values.vector.toArray(), [1.25, -2.5, 0]);

  assert.equal(values.arrayWithComplexValues.length, 5);
  assert.deepEqual([...values.arrayWithComplexValues[0]], [9, 8, 7]);
  assert.equal(
    values.arrayWithComplexValues[1].isEqual(Timestamp.fromMillis(-123)),
    true,
  );
  assert.equal(
    values.arrayWithComplexValues[2].isEqual(
      new GeoPoint(-33.8688, 151.2093),
    ),
    true,
  );
  assert.equal(
    values.arrayWithComplexValues[3].path,
    "fireside_export_fixture/reference-target",
  );
  assert.deepEqual(values.arrayWithComplexValues[4], {
    insideArray: "map-value",
  });

  assert.equal(largeSnapshot.get("payload"), "🔥".repeat(40_000));
  assert.deepEqual(referenceSnapshot.data(), { kind: "reference-target" });
  assert.deepEqual(child.data(), { depth: 2 });
} finally {
  await firestore.terminate();
}
