import { FieldValue, GeoPoint, Timestamp } from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "./target.ts";

const configuration = resolveTarget(process.env);
if (configuration.name !== "java") {
  throw new Error("export seeding is restricted to the isolated Java emulator");
}

const firestore = createFirestore(configuration);
const root = firestore.collection("fireside_export_fixture");
const reference = root.doc("reference-target");

await Promise.all([
  reference.set({ kind: "reference-target" }),
  root.doc("values").set({
    array: [null, true, 42, 4.25, "array-value"],
    arrayWithComplexValues: [
      Buffer.from([9, 8, 7]),
      Timestamp.fromMillis(-123),
      new GeoPoint(-33.8688, 151.2093),
      reference,
      { insideArray: "map-value" },
    ],
    bytes: Buffer.from([0, 1, 2, 127, 128, 255]),
    emptyArray: [],
    emptyBytes: Buffer.alloc(0),
    emptyMap: {},
    emptyString: "",
    floating: {
      nan: Number.NaN,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      negativeZero: -0,
      positiveInfinity: Number.POSITIVE_INFINITY,
    },
    incremented: FieldValue.increment(3),
    integerBoundaries: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    location: new GeoPoint(3.139, 101.6869),
    map: {
      emptyArray: [],
      emptyMap: {},
      nested: { enabled: true },
      score: 9,
    },
    nullValue: null,
    reference,
    string: "fireside-export-🔥",
    timestamp: Timestamp.fromMillis(1_700_000_000_123),
    vector: FieldValue.vector([1.25, -2.5, 0]),
  }),
  root.doc("large").set({
    payload: "🔥".repeat(40_000),
  }),
  root.doc("parent").collection("children").doc("leaf").set({
    depth: 2,
  }),
]);

await firestore.terminate();
